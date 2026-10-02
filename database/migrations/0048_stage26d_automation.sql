-- CodeConClave Pro — Stage 26D: Event Automation + Smart Escalation + Workflow Recipes.
-- Additive only. Reuses the existing task engine / queue / workers / watchdog /
-- agent system / plugin system / approvals / notifications / audit.
-- Applied live at 48/48.

-- ---------------------------------------------------------------- automation rules
CREATE TABLE IF NOT EXISTS automation_rules (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL,
  name            text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','DISABLED')),
  event_source    text NOT NULL CHECK (event_source IN ('schedule','task_completed','github','plugin','deployment','webhook')),
  event_type      text NOT NULL,
  conditions      jsonb NOT NULL DEFAULT '{}',
  actions         jsonb NOT NULL DEFAULT '[]',
  recipe_id       text,
  project_id      text,
  trigger_mode    text NOT NULL DEFAULT 'auto' CHECK (trigger_mode IN ('auto','manual')),
  require_approval boolean NOT NULL DEFAULT false,
  max_runs_per_hour integer NOT NULL DEFAULT 10 CHECK (max_runs_per_hour > 0),
  cooldown_ms     bigint NOT NULL DEFAULT 60000 CHECK (cooldown_ms >= 0),
  run_count       integer NOT NULL DEFAULT 0,
  run_count_reset_at timestamptz NOT NULL DEFAULT now(),
  last_run_at     timestamptz,
  last_run_status text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY automation_rules_owner ON automation_rules
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_automation_rules_owner ON automation_rules (owner_id);
CREATE INDEX idx_automation_rules_event ON automation_rules (event_source, event_type);
CREATE INDEX idx_automation_rules_status ON automation_rules (status) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------- automation runs (history + per-rule idempotency)
CREATE TABLE IF NOT EXISTS automation_runs (
  id            text PRIMARY KEY,
  automation_id text NOT NULL,
  owner_id      text NOT NULL,
  event_source  text NOT NULL,
  event_type    text NOT NULL,
  event_id      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('PENDING','RUNNING','WAITING_FOR_APPROVAL','COMPLETED','FAILED','BLOCKED','CANCELLED','SKIPPED')),
  trigger_mode  text NOT NULL DEFAULT 'auto',
  result        jsonb NOT NULL DEFAULT '{}',
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  approval_id   text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, event_id)
);
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY automation_runs_owner ON automation_runs
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_automation_runs_owner ON automation_runs (owner_id, created_at DESC);
CREATE INDEX idx_automation_runs_automation ON automation_runs (automation_id, created_at DESC);

-- ---------------------------------------------------------------- event log (global replay/dedupe protection)
CREATE TABLE IF NOT EXISTS event_log (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL,
  source     text NOT NULL,
  event_id   text NOT NULL,
  event_type text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','SKIPPED','FAILED','REJECTED')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, event_id)
);
ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_log_owner ON event_log
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_event_log_owner ON event_log (owner_id, created_at DESC);
CREATE INDEX idx_event_log_created ON event_log (created_at) WHERE status IN ('RECEIVED','FAILED');

-- ---------------------------------------------------------------- workflow recipes (system + user templates)
CREATE TABLE IF NOT EXISTS workflow_recipes (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL,
  name         text NOT NULL,
  description  text,
  event_source text NOT NULL,
  event_type   text NOT NULL,
  conditions   jsonb NOT NULL DEFAULT '{}',
  template     jsonb NOT NULL DEFAULT '[]',
  system       boolean NOT NULL DEFAULT false,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workflow_recipes ENABLE ROW LEVEL SECURITY;
-- System recipes are read-only templates visible to every tenant; user recipes
-- stay strictly owner-scoped. Writes on system rows are impossible (no owner).
CREATE POLICY workflow_recipes_read ON workflow_recipes
  USING (owner_id = current_setting('app.user_id', true)::text OR (system = true AND owner_id = 'system'));
CREATE INDEX idx_workflow_recipes_owner ON workflow_recipes (owner_id);

-- ---------------------------------------------------------------- webhook secrets (event auth + tenant resolve)
CREATE TABLE IF NOT EXISTS webhook_secrets (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL,
  source     text NOT NULL CHECK (source IN ('github','sentry','plugin','deployment','webhook')),
  name       text NOT NULL,
  secret_hash text NOT NULL,            -- sha256(secret) for bearer-style auth
  hmac_key   text NOT NULL,             -- encrypted raw secret used for HMAC signature verification
  repo       text,                      -- optional github owner/repo binding
  enabled    boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, source, name)
);
ALTER TABLE webhook_secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_secrets_owner ON webhook_secrets
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_webhook_secrets_owner ON webhook_secrets (owner_id);

-- ---------------------------------------------------------------- escalation extensions (smart escalation)
-- Reuses the Stage 26C escalations table; adds automation/task targeting,
-- an explicit trigger reason and known cost so the decision UI can render
-- context / evidence / attempts / error / options / recommendation / risk / cost.
ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS automation_id text,
  ADD COLUMN IF NOT EXISTS task_id text,
  ADD COLUMN IF NOT EXISTS trigger_reason text,
  ADD COLUMN IF NOT EXISTS cost_usd numeric;
CREATE INDEX IF NOT EXISTS idx_escalations_automation ON escalations (automation_id);
CREATE INDEX IF NOT EXISTS idx_escalations_task ON escalations (task_id);