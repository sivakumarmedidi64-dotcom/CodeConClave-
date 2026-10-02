-- Stage 26C — scheduled autonomous tasks + Goal Mode.
-- Additive only. Every tenant table: owner_id + RLS + FKs + indexes.
-- The scheduler reuses the existing task engine: each schedule run materializes
-- as real task rows (via ai_agents startRun), so the existing queue/worker/
-- watchdog remain the single execution path. schedule_runs.schedule_id +
-- scheduled_for is the idempotency key — exactly one business execution per
-- occurrence even if the scheduler tick fires twice.

-- ---------------------------------------------------------------- scheduled tasks
CREATE TABLE scheduled_tasks (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE SET NULL,
  agent_id          text NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  title             text NOT NULL,
  description       text,
  recurrence        text NOT NULL DEFAULT 'DAILY' CHECK (recurrence IN ('ONCE','HOURLY','DAILY','WEEKLY','MONTHLY','CRON')),
  cron_expression   text CHECK (cron_expression IS NULL OR cron_expression <> ''),
  timezone          text NOT NULL DEFAULT 'UTC' CHECK (timezone <> ''),
  run_at            text NOT NULL DEFAULT '09:00' CHECK (run_at <> ''),
  run_on_days       jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled           boolean NOT NULL DEFAULT true,
  execution_mode    text NOT NULL DEFAULT 'CLOUD' CHECK (execution_mode IN ('CLOUD','LOCAL_ONLY','HYBRID')),
  missed_run_policy text NOT NULL DEFAULT 'RUN_ON_RECOVERY' CHECK (missed_run_policy IN ('RUN_ON_RECOVERY','SKIP_STALE','RUN_ONCE')),
  next_run_at       timestamptz NOT NULL,
  last_run_at       timestamptz,
  last_run_status   text,
  run_count         int NOT NULL DEFAULT 0,
  require_approval  boolean NOT NULL DEFAULT false,
  timeout_ms        int NOT NULL DEFAULT 900000 CHECK (timeout_ms BETWEEN 60000 AND 86400000),
  max_attempts      int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  notify_on_completion boolean NOT NULL DEFAULT false,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_scheduled_cron CHECK (recurrence <> 'CRON' OR cron_expression IS NOT NULL)
);
CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks (enabled, next_run_at);
CREATE INDEX idx_scheduled_tasks_owner ON scheduled_tasks (owner_id, created_at DESC);

-- ---------------------------------------------------------------- schedule run instances
CREATE TABLE schedule_runs (
  id            text PRIMARY KEY,
  schedule_id   text NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN (
                  'SCHEDULED','DUE','CLAIMED','ENQUEUED','RUNNING','COMPLETED',
                  'FAILED','BLOCKED','MISSED','RECOVERED','SKIPPED',
                  'WAITING_FOR_APPROVAL','WAITING_FOR_LOCAL_AGENT','CANCELLED')),
  task_id       text REFERENCES tasks(id) ON DELETE SET NULL,
  agent_run_id  text REFERENCES ai_agent_runs(id) ON DELETE SET NULL,
  reason        text,
  error         text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_schedule_run UNIQUE (schedule_id, scheduled_for)
);
CREATE INDEX idx_schedule_runs_schedule ON schedule_runs (schedule_id, status);
CREATE INDEX idx_schedule_runs_owner ON schedule_runs (owner_id, created_at DESC);
CREATE INDEX idx_schedule_runs_task ON schedule_runs (task_id);

-- ---------------------------------------------------------------- goals
CREATE TABLE goals (
  id                 text PRIMARY KEY,
  owner_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id         text REFERENCES projects(id) ON DELETE SET NULL,
  title              text NOT NULL,
  objective          text NOT NULL,
  success_criteria   jsonb NOT NULL DEFAULT '[]'::jsonb,
  constraints        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                       'DRAFT','PLANNING','PLAN_READY','WAITING_FOR_APPROVAL',
                       'RUNNING','PAUSED','BLOCKED','WAITING_FOR_HUMAN_DECISION',
                       'COMPLETED','FAILED','CANCELLED')),
  plan               jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress           jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb,
  blockers           jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_usd         numeric(16,6) NOT NULL DEFAULT 5 CHECK (budget_usd > 0),
  spent_usd          numeric(16,6) NOT NULL DEFAULT 0,
  deadline_at        timestamptz,
  estimated_cost_usd numeric(16,6),
  require_approval   boolean NOT NULL DEFAULT true,
  approved_at        timestamptz,
  error              text,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_goals_owner ON goals (owner_id, status, created_at DESC);
CREATE INDEX idx_goals_project ON goals (project_id);

-- Link executed tasks back to the goal (additive column on the existing engine).
ALTER TABLE tasks ADD COLUMN goal_id text REFERENCES goals(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_goal ON tasks (goal_id);

-- ---------------------------------------------------------------- goal activity log
CREATE TABLE goal_activities (
  id         text PRIMARY KEY,
  goal_id    text NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_goal_activities_goal ON goal_activities (goal_id, created_at DESC);

-- ---------------------------------------------------------------- escalations
CREATE TABLE escalations (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id           text REFERENCES goals(id) ON DELETE CASCADE,
  schedule_id       text REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  issue             text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempted_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  options           jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation    text,
  risk              text NOT NULL DEFAULT 'MEDIUM' CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','EXPIRED','CANCELLED')),
  user_decision     text CHECK (user_decision IN ('APPROVE','REJECT','EDIT_PLAN','RETRY','PAUSE','CANCEL')),
  decision_note     text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_escalation_target CHECK (goal_id IS NOT NULL OR schedule_id IS NOT NULL)
);
CREATE INDEX idx_escalations_owner ON escalations (owner_id, status, created_at DESC);
CREATE INDEX idx_escalations_goal ON escalations (goal_id);
CREATE INDEX idx_escalations_schedule ON escalations (schedule_id);

-- ---------------------------------------------------------------- RLS
ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduled_tasks_owner ON scheduled_tasks
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE schedule_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY schedule_runs_owner ON schedule_runs
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY goals_owner ON goals
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE goal_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY goal_activities_owner ON goal_activities
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY escalations_owner ON escalations
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());