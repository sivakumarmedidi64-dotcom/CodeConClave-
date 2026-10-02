-- ---------------------------------------------------------------------------
-- 0051_stage26g_control_plane.sql
-- Stage 26G — Control Plane + Preview Workspace + Plugin Sandbox + Secret
-- Guard + Usage Analytics.
--
-- Additive only. Every tenant table is RLS-enabled with an owner policy.
-- Applied live at 51/51.
-- ---------------------------------------------------------------------------

-- preview_comments: element-anchored comments on a preview version -> task
CREATE TABLE IF NOT EXISTS preview_comments (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES users(id),
  project_id       text NOT NULL REFERENCES projects(id),
  preview_version  integer NOT NULL DEFAULT 0,
  selector         text NOT NULL CHECK (length(selector) <= 300),
  comment          text NOT NULL CHECK (length(comment) <= 4000),
  task_id          text REFERENCES tasks(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE preview_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY preview_comments_owner ON preview_comments
  USING (owner_id = current_setting('app.user_id', true));
CREATE INDEX idx_preview_comments_project ON preview_comments (project_id, created_at DESC);

-- preview_snapshots: before/after build snapshots for the visual diff.
-- Captured automatically on build transitions; never fabricated.
CREATE TABLE IF NOT EXISTS preview_snapshots (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  project_id  text NOT NULL REFERENCES projects(id),
  version     integer NOT NULL,
  state       text NOT NULL,
  build_log   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
ALTER TABLE preview_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY preview_snapshots_owner ON preview_snapshots
  USING (owner_id = current_setting('app.user_id', true));
CREATE INDEX idx_preview_snapshots_project ON preview_snapshots (project_id, created_at DESC);

-- proof_of_work_reports: honest per-task work report (one per task, regenerable).
CREATE TABLE IF NOT EXISTS proof_of_work_reports (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  task_id     text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id  text NOT NULL REFERENCES projects(id),
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, task_id)
);
ALTER TABLE proof_of_work_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY proof_of_work_reports_owner ON proof_of_work_reports
  USING (owner_id = current_setting('app.user_id', true));

-- plugin_sandbox_runs: safe fake-data plugin testing. The output is clearly
-- fake and never the result of a live provider call.
CREATE TABLE IF NOT EXISTS plugin_sandbox_runs (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  plugin_type text NOT NULL,
  action      text NOT NULL,
  input       jsonb,
  output      jsonb NOT NULL,
  ok          boolean NOT NULL,
  latency_ms  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE plugin_sandbox_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY plugin_sandbox_runs_owner ON plugin_sandbox_runs
  USING (owner_id = current_setting('app.user_id', true));
CREATE INDEX idx_plugin_sandbox_runs_owner ON plugin_sandbox_runs (owner_id, created_at DESC);

-- control_policies: risk-based policies (LOW/MEDIUM/HIGH/CRITICAL) that gate
-- actions with a requirement (require_approval or block). Empty table = no
-- custom policy (defaults apply). Unique per (owner, scope, action).
CREATE TABLE IF NOT EXISTS control_policies (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  scope       text NOT NULL CHECK (scope IN ('task','plugin','schedule','automation','agent','global')),
  action      text NOT NULL,
  risk_level  text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  requirement text NOT NULL DEFAULT 'require_approval' CHECK (requirement IN ('require_approval','block')),
  enabled     boolean NOT NULL DEFAULT true,
  config      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, scope, action)
);
ALTER TABLE control_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY control_policies_owner ON control_policies
  USING (owner_id = current_setting('app.user_id', true));

-- kill_switch: stop agents/tasks/schedules/autonomy. GLOBAL overrides all.
-- One row per scope per owner; scopes are independent (toggling TASKS does not
-- affect AGENTS).
CREATE TABLE IF NOT EXISTS kill_switch (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  scope       text NOT NULL CHECK (scope IN ('GLOBAL','AGENTS','TASKS','SCHEDULES','AUTONOMY')),
  active      boolean NOT NULL DEFAULT false,
  reason      text,
  triggered_by text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, scope)
);
ALTER TABLE kill_switch ENABLE ROW LEVEL SECURITY;
CREATE POLICY kill_switch_owner ON kill_switch
  USING (owner_id = current_setting('app.user_id', true));

-- undo_log: only genuinely reversible operations are recorded (payload-driven).
CREATE TABLE IF NOT EXISTS undo_log (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id),
  action_type   text NOT NULL,
  description   text NOT NULL,
  undo_payload  jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','UNDONE','EXPIRED')),
  undone_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE undo_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY undo_log_owner ON undo_log
  USING (owner_id = current_setting('app.user_id', true));
CREATE INDEX idx_undo_log_owner ON undo_log (owner_id, created_at DESC);

-- secret_guard_scans: content-scan ledger. Findings contain type/location/
-- confidence ONLY — never the secret value.
CREATE TABLE IF NOT EXISTS secret_guard_scans (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id),
  target_type text NOT NULL CHECK (target_type IN ('agent_output','file','commit','memory','task_payload')),
  target_ref  text,
  result      text NOT NULL CHECK (result IN ('CLEAN','FINDINGS')),
  findings    jsonb NOT NULL DEFAULT '[]',
  scanned_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE secret_guard_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY secret_guard_scans_owner ON secret_guard_scans
  USING (owner_id = current_setting('app.user_id', true));
CREATE INDEX idx_secret_guard_scans_owner ON secret_guard_scans (owner_id, scanned_at DESC);

-- usage_rollups: per-feature daily cost/usage aggregation (cost-per-feature and
-- ROI source). Keyed by (owner, day, feature, task or __none__).
CREATE TABLE IF NOT EXISTS usage_rollups (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id),
  bucket        date NOT NULL,
  feature       text NOT NULL,
  task_id       text,
  calls         integer NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd      numeric(16,6) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE usage_rollups ENABLE ROW LEVEL SECURITY;
CREATE POLICY usage_rollups_owner ON usage_rollups
  USING (owner_id = current_setting('app.user_id', true));
CREATE INDEX idx_usage_rollups_owner ON usage_rollups (owner_id, bucket DESC);
CREATE UNIQUE INDEX idx_usage_rollups_key
  ON usage_rollups (owner_id, bucket, feature, COALESCE(task_id,'__none__'));