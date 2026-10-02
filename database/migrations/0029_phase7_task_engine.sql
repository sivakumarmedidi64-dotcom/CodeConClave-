-- 0029: phase7 task engine — retries, dead-letter queue, dependencies, plans,
-- parallel orchestration, artifact verification refs.
-- NOTE: this repo validates migrations statically only (no live PostgreSQL).

ALTER TABLE tasks
  ADD COLUMN priority              int NOT NULL DEFAULT 0,
  ADD COLUMN failure_reason        text,
  ADD COLUMN recovery_status       text NOT NULL DEFAULT 'NONE'
           CHECK (recovery_status IN ('NONE','RETRYING','DEAD_LETTERED','RECOVERED')),
  ADD COLUMN retry_count           int NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at       timestamptz,
  ADD COLUMN dead_letter_at        timestamptz,
  ADD COLUMN requires_review_reason text;

CREATE INDEX idx_tasks_claim ON tasks (status, priority DESC, created_at);

-- task dependencies (kind = 'finish'): a task only claims when every dependency
-- is COMPLETED; a failed dependency blocks the dependent.
CREATE TABLE task_dependencies (
  id                  text PRIMARY KEY,
  task_id             text NOT NULL REFERENCES tasks(id),
  depends_on_task_id  text NOT NULL REFERENCES tasks(id),
  kind                text NOT NULL DEFAULT 'finish' CHECK (kind IN ('finish')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_task_dependency UNIQUE (task_id, depends_on_task_id)
);

CREATE INDEX idx_task_dependencies_task ON task_dependencies (task_id);
CREATE INDEX idx_task_dependencies_dep ON task_dependencies (depends_on_task_id);

-- dead-letter queue: tasks that exhausted retries. Moved here atomically by the
-- engine; recovery re-queues the task.
CREATE TABLE task_dlq (
  id            text PRIMARY KEY,
  task_id       text NOT NULL UNIQUE REFERENCES tasks(id),
  project_id    text NOT NULL REFERENCES projects(id),
  owner_id      text NOT NULL REFERENCES users(id),
  title         text NOT NULL,
  reason        text NOT NULL,
  error_code    text,
  error_detail  text,
  attempts      int NOT NULL DEFAULT 0,
  moved_at      timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_dlq_owner ON task_dlq (owner_id, moved_at DESC);

-- structured persisted plans (Planner output). entries carry coworker type,
-- input, parallel group, required tools, risk, acceptance criteria.
CREATE TABLE plans (
  id                   text PRIMARY KEY,
  task_id              text NOT NULL UNIQUE REFERENCES tasks(id),
  goal                 text NOT NULL,
  status               text NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','COMPLETED','ABANDONED')),
  risk_level           text CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  estimated_work       text,
  acceptance_criteria  jsonb,
  expected_artifacts   jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_plans_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE plan_entries (
  id                   text PRIMARY KEY,
  plan_id              text NOT NULL REFERENCES plans(id),
  order_index          int NOT NULL,
  coworker_type        text NOT NULL CHECK (coworker_type IN (
                         'ARCHITECT','CODER','SECURITY','TESTER','PERFORMANCE',
                         'RESEARCH','DOCS','REVIEWER','PLANNER')),
  input                jsonb,
  parallel_group       int,
  depends_on           jsonb,
  required_tools       jsonb,
  risk                 text CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  acceptance_criteria  text,
  expected_artifacts   jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_plan_entries UNIQUE (plan_id, order_index)
);

CREATE INDEX idx_plan_entries_plan ON plan_entries (plan_id);

-- artifact center refs: attempt + verification for auditability.
ALTER TABLE coworker_artifacts
  ADD COLUMN attempt_id   text REFERENCES task_attempts(id),
  ADD COLUMN verification text CHECK (verification IN ('PASS','FAIL','SKIPPED'));

-- parallel orchestration bookkeeping on coworker runs.
ALTER TABLE coworker_runs
  ADD COLUMN parallel_group int;
