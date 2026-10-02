-- 0008: execution — tasks, task_attempts, task_steps, tool_calls, approvals
-- NOTE: artifacts lives in 0009 (it references coworker_runs).

CREATE TABLE tasks (
  id                   text PRIMARY KEY,
  project_id           text NOT NULL REFERENCES projects(id),
  conversation_id      text REFERENCES conversations(id),
  owner_id             text NOT NULL REFERENCES users(id),
  title                text NOT NULL,
  description          text,
  plan                 text,
  status               text NOT NULL DEFAULT 'CREATED'
                       CHECK (status IN ('CREATED','PLANNED','WAITING_APPROVAL','RUNNING','TESTING',
                                         'VERIFIED','COMPLETED','FAILED','TIMED_OUT','CANCELLED',
                                         'BLOCKED','WAITING_FOR_LOCAL_AGENT','REQUIRES_REVIEW')),
  risk_level           text NOT NULL DEFAULT 'MEDIUM'
                       CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  required_approval    boolean NOT NULL DEFAULT false,
  approval_id          text,
  coworker_pipeline    jsonb,
  execution_mode       text NOT NULL DEFAULT 'CLOUD'
                       CHECK (execution_mode IN ('CLOUD','LOCAL','HYBRID')),
  timeout_ms           int NOT NULL DEFAULT 600000,
  started_at           timestamptz,
  completed_at         timestamptz,
  failed_at            timestamptz,
  error_code           text,
  error_detail         text,
  attempt_count        int NOT NULL DEFAULT 0,
  max_attempts         int NOT NULL DEFAULT 3,
  last_heartbeat_at    timestamptz,
  watchdog_checked_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_owner_status ON tasks (owner_id, status);
CREATE INDEX idx_tasks_project ON tasks (project_id);
CREATE INDEX idx_tasks_updated ON tasks (updated_at);
CREATE INDEX idx_tasks_status_updated ON tasks (status, updated_at);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE task_attempts (
  id               text PRIMARY KEY,
  task_id          text NOT NULL REFERENCES tasks(id),
  attempt_number   int NOT NULL,
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz,
  result           text CHECK (result IN ('SUCCESS','FAILURE','TIMEOUT','CANCELLED')),
  error_code       text,
  output_summary   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_task_attempts UNIQUE (task_id, attempt_number)
);

CREATE TABLE task_steps (
  id             text PRIMARY KEY,
  task_id        text NOT NULL REFERENCES tasks(id),
  attempt_id     text REFERENCES task_attempts(id),
  kind           text NOT NULL,
  title          text NOT NULL,
  status         text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','SKIPPED')),
  detail         jsonb,
  output         text,
  error_code     text,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_steps_task ON task_steps (task_id);

CREATE TABLE approvals (
  id           text PRIMARY KEY,
  task_id      text REFERENCES tasks(id),
  owner_id     text NOT NULL REFERENCES users(id),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_level   text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','REVOKED')),
  decision     text CHECK (decision IN ('APPROVE','REJECT')),
  decided_by   text REFERENCES users(id),
  decided_at   timestamptz,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_approvals_owner_status ON approvals (owner_id, status);
CREATE INDEX idx_approvals_status_expires ON approvals (status, expires_at);

CREATE TABLE tool_calls (
  id            text PRIMARY KEY,
  task_id       text REFERENCES tasks(id),
  step_id       text REFERENCES task_steps(id),
  tool_name     text NOT NULL,
  input         jsonb NOT NULL,
  output        jsonb,
  risk_level    text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status        text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','EXECUTED','DENIED','FAILED','ROLLED_BACK')),
  approval_id   text REFERENCES approvals(id),
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_calls_task ON tool_calls (task_id);
CREATE INDEX idx_tool_calls_status ON tool_calls (status);

-- tasks.approval_id -> approvals; created after approvals exists.
ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_approval
  FOREIGN KEY (approval_id) REFERENCES approvals(id);