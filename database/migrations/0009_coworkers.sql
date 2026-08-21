-- 0009: coworkers — coworker_runs, coworker_handoffs, coworker_artifacts, artifacts

CREATE TABLE coworker_runs (
  id                    text PRIMARY KEY,
  task_id               text NOT NULL REFERENCES tasks(id),
  coworker_type         text NOT NULL CHECK (coworker_type IN (
                          'ARCHITECT','CODER','SECURITY','TESTER','PERFORMANCE',
                          'RESEARCH','DOCS','REVIEWER','PLANNER')),
  order_index           int NOT NULL,
  state                 text NOT NULL DEFAULT 'QUEUED'
                        CHECK (state IN ('QUEUED','PLANNING','RUNNING','VERIFYING','COMPLETED',
                                         'FAILED','TIMED_OUT','CANCELLED','BLOCKED')),
  input                 jsonb,
  output                jsonb,
  verification_result   text CHECK (verification_result IN ('PASS','FAIL','SKIPPED')),
  error_code            text,
  timeout_ms            int NOT NULL DEFAULT 1800000,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_coworker_pipeline_entry UNIQUE (task_id, coworker_type, order_index)
);

CREATE INDEX idx_coworker_runs_task ON coworker_runs (task_id);

CREATE TRIGGER trg_coworker_runs_updated_at
  BEFORE UPDATE ON coworker_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE coworker_handoffs (
  id               text PRIMARY KEY,
  from_run_id      text NOT NULL REFERENCES coworker_runs(id),
  to_run_id        text NOT NULL REFERENCES coworker_runs(id),
  handoff_summary  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coworker_artifacts (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES coworker_runs(id),
  name          text NOT NULL,
  kind          text NOT NULL,
  content       text,
  storage_key   text,
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_coworker_artifacts_run ON coworker_artifacts (run_id);

-- artifacts (execution group; FK to coworker_runs requires this migration file)
CREATE TABLE artifacts (
  id                text PRIMARY KEY,
  task_id           text REFERENCES tasks(id),
  coworker_run_id   text REFERENCES coworker_runs(id),
  name              text NOT NULL,
  kind              text NOT NULL,
  storage_key       text,
  sha256            text NOT NULL,
  size_bytes        bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_task ON artifacts (task_id);
CREATE INDEX idx_artifacts_coworker_run ON artifacts (coworker_run_id);