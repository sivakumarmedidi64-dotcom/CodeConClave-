-- 0061: PKG-19 Browser + Runtime Development — executions, background tasks,
-- console/network capture boundaries, smoke-test foundation.

-- Runtime executions (F34/F90 expansion): server-side controlled, policy-gated,
-- time-boxed command runs with lifecycle states.
CREATE TABLE IF NOT EXISTS runtime_executions (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  project_id  text NOT NULL REFERENCES projects(id),
  kind        text NOT NULL DEFAULT 'RUN' CHECK (kind IN ('RUN','BUILD','TEST','LINT','TYPECHECK','DEV_SERVER','CUSTOM')),
  command     text NOT NULL,
  cwd         text,
  status      text NOT NULL DEFAULT 'STARTED'
              CHECK (status IN ('STARTED','RUNNING','COMPLETED','FAILED','TIMED_OUT','CANCELLED','STOPPED','BLOCKED')),
  exit_code   int,
  timed_out   boolean NOT NULL DEFAULT false,
  cancelled   boolean NOT NULL DEFAULT false,
  blocked     boolean NOT NULL DEFAULT false,
  output      text NOT NULL DEFAULT '',
  error       text,
  duration_ms int,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runtime_exec_project ON runtime_executions (project_id);
CREATE INDEX idx_runtime_exec_owner  ON runtime_executions (owner_id);
CREATE INDEX idx_runtime_exec_status ON runtime_executions (status);
CREATE INDEX idx_runtime_exec_created ON runtime_executions (created_at DESC);

-- Background development tasks (F90): build/test/lint/typecheck/dev-server/watch.
CREATE TABLE IF NOT EXISTS runtime_background_tasks (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id),
  project_id    text NOT NULL REFERENCES projects(id),
  label         text NOT NULL,
  kind          text NOT NULL DEFAULT 'CUSTOM',
  command       text NOT NULL,
  cwd           text,
  status        text NOT NULL DEFAULT 'STARTING'
                CHECK (status IN ('STARTING','RUNNING','COMPLETED','FAILED','TIMED_OUT','CANCELLED','STOPPED','BLOCKED')),
  pid           int,
  exit_code     int,
  latest_output text NOT NULL DEFAULT '',
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runtime_bg_project ON runtime_background_tasks (project_id);
CREATE INDEX idx_runtime_bg_owner   ON runtime_background_tasks (owner_id);
CREATE INDEX idx_runtime_bg_status  ON runtime_background_tasks (status);

-- Browser console capture boundary (F38): only-ever-evidence-forwarded-into.
CREATE TABLE IF NOT EXISTS runtime_console_events (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  project_id  text NOT NULL REFERENCES projects(id),
  level       text NOT NULL DEFAULT 'log'
              CHECK (level IN ('log','info','warn','error','debug','uncaught')),
  message     text NOT NULL,
  stack       text,
  source_url  text,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runtime_console_project ON runtime_console_events (project_id);
CREATE INDEX idx_runtime_console_level   ON runtime_console_events (level);
CREATE INDEX idx_runtime_console_ts      ON runtime_console_events (ts DESC);

-- Network/runtime capture boundary (F38/F49): frontend->backend request metadata
-- with redaction (never sensitive bodies by default, tokens/cookies stripped).
CREATE TABLE IF NOT EXISTS runtime_network_events (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id),
  project_id text NOT NULL REFERENCES projects(id),
  method     text NOT NULL,
  url_path   text NOT NULL,
  status     int,
  duration_ms int,
  ok         boolean,
  state      text NOT NULL DEFAULT 'PENDING'
             CHECK (state IN ('PENDING','SUCCESS','CLIENT_ERROR','SERVER_ERROR','TIMED_OUT','NETWORK_ERROR','BLOCKED')),
  request_id text,
  ts         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runtime_network_project ON runtime_network_events (project_id);
CREATE INDEX idx_runtime_network_status  ON runtime_network_events (status);
CREATE INDEX idx_runtime_network_ts      ON runtime_network_events (ts DESC);

-- Smoke-test foundation: config-driven, per-run results.
CREATE TABLE IF NOT EXISTS runtime_smoke_runs (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  project_id  text NOT NULL REFERENCES projects(id),
  name        text NOT NULL DEFAULT 'smoke',
  status      text NOT NULL DEFAULT 'RUNNING'
              CHECK (status IN ('RUNNING','PASS','FAIL','UNAVAILABLE','PARTIAL')),
  total       int NOT NULL DEFAULT 0,
  passed      int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  unavailable int NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE TABLE IF NOT EXISTS runtime_smoke_results (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id),
  project_id    text NOT NULL REFERENCES projects(id),
  run_id        text NOT NULL REFERENCES runtime_smoke_runs(id),
  name          text NOT NULL,
  method        text NOT NULL DEFAULT 'GET',
  url           text NOT NULL,
  expected_status int,
  status        text NOT NULL DEFAULT 'NOT_RUN'
                CHECK (status IN ('NOT_RUN','PASS','FAIL','BLOCKED','UNAVAILABLE')),
  duration_ms   int,
  evidence      text NOT NULL DEFAULT '',
  failure_reason text,
  started_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_runtime_smoke_project ON runtime_smoke_runs (project_id);
CREATE INDEX idx_runtime_smoke_results_run ON runtime_smoke_results (run_id);
