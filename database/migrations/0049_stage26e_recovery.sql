-- CodeConClave Pro — Stage 26E: Failure Autopsy + Checkpoints + Time Travel.
-- Additive only. Reuses the existing task engine (task_attempts.checkpoint resume),
-- task history (task_attempts/task_steps/tool_calls), audit, memory, Project DNA,
-- workers (watchdog), queue (tasks table polling) and agents (cancelRun).
--
-- Adds:
--   * tasks.paused_at / paused_by / paused_reason + 'PAUSED' status (queue excludes).
--   * task_checkpoints — durable, explicit time-travel snapshots.
--   * task_branches — forks created by rewind/branch (rollback = new branch/state).
--   * failure_autopsies — evidence-backed root-cause reports for failed tasks.
--   * recovery_history — append-only task recovery event timeline.
--   * irreversible_actions — actions rewind must never claim to undo.
-- Applied live at 49/49.

-- ---------------------------------------------------------------- tasks: PAUSED
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_by text,
  ADD COLUMN IF NOT EXISTS paused_reason text;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (
  status IN ('CREATED','PLANNED','WAITING_APPROVAL','RUNNING','TESTING',
             'VERIFIED','COMPLETED','FAILED','TIMED_OUT','CANCELLED',
             'BLOCKED','WAITING_FOR_LOCAL_AGENT','REQUIRES_REVIEW','PAUSED')
);

-- ---------------------------------------------------------------- task checkpoints
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id                   text PRIMARY KEY,
  task_id              text NOT NULL,
  attempt_id           text,
  owner_id             text NOT NULL,
  label                text,
  reason               text,
  stage_index          integer NOT NULL DEFAULT 0,
  task_state           jsonb NOT NULL DEFAULT '{}',
  plan_state           jsonb NOT NULL DEFAULT '{}',
  execution_metadata   jsonb NOT NULL DEFAULT '{}',
  approval_state       jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE task_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_checkpoints_owner ON task_checkpoints
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_task_checkpoints_task ON task_checkpoints (task_id, created_at DESC);
CREATE INDEX idx_task_checkpoints_owner ON task_checkpoints (owner_id);

-- ---------------------------------------------------------------- task branches
CREATE TABLE IF NOT EXISTS task_branches (
  id                 text PRIMARY KEY,
  source_task_id     text NOT NULL,
  checkpoint_id      text,
  branched_task_id   text NOT NULL,
  owner_id           text NOT NULL,
  label              text,
  reason             text,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','FAILED','ABANDONED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
ALTER TABLE task_branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_branches_owner ON task_branches
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_task_branches_source ON task_branches (source_task_id);
CREATE INDEX idx_task_branches_branched ON task_branches (branched_task_id);

-- ---------------------------------------------------------------- failure autopsies
CREATE TABLE IF NOT EXISTS failure_autopsies (
  id                   text PRIMARY KEY,
  task_id              text NOT NULL,
  attempt_id           text,
  owner_id             text NOT NULL,
  status               text NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED','SUPERSEDED')),
  root_cause_code      text NOT NULL DEFAULT 'CAUSE_UNKNOWN',
  root_cause           text,
  confidence           numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  timeline             jsonb NOT NULL DEFAULT '[]',
  attempts             jsonb NOT NULL DEFAULT '[]',
  errors               jsonb NOT NULL DEFAULT '[]',
  dependency_state     jsonb NOT NULL DEFAULT '[]',
  recovery_attempts    jsonb NOT NULL DEFAULT '[]',
  successful_fix       jsonb,
  prevention           jsonb,
  evidence             jsonb NOT NULL DEFAULT '{}',
  memory_id            text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_id)
);
ALTER TABLE failure_autopsies ENABLE ROW LEVEL SECURITY;
CREATE POLICY failure_autopsies_owner ON failure_autopsies
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_failure_autopsies_task ON failure_autopsies (task_id);
CREATE INDEX idx_failure_autopsies_owner ON failure_autopsies (owner_id, created_at DESC);
-- Watchdog: failed/dead-lettered tasks that have not been autopsied yet.
CREATE INDEX idx_failure_autopsies_pending ON failure_autopsies (task_id) WHERE status = 'GENERATED';

-- ---------------------------------------------------------------- recovery history
CREATE TABLE IF NOT EXISTS recovery_history (
  id         text PRIMARY KEY,
  task_id    text NOT NULL,
  owner_id   text NOT NULL,
  event      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  actor      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE recovery_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_history_owner ON recovery_history
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_recovery_history_task ON recovery_history (task_id, created_at);
CREATE INDEX idx_recovery_history_owner ON recovery_history (owner_id, created_at DESC);

-- ---------------------------------------------------------------- irreversible actions
CREATE TABLE IF NOT EXISTS irreversible_actions (
  id            text PRIMARY KEY,
  task_id       text NOT NULL,
  owner_id      text NOT NULL,
  action_type   text NOT NULL,
  description   text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}',
  acknowledged  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE irreversible_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY irreversible_actions_owner ON irreversible_actions
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_irreversible_actions_task ON irreversible_actions (task_id, created_at);