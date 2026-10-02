-- 0042: Stage 25.5 — multi-agent workspace, main-workspace live preview, plugin center expansion.
-- Adds the 9-provider AI gateway (grok, deepseek, kimi, nemotron, north), agent + run tables,
-- preview sessions, and the marketplace catalogue metadata. RLS-protected like all tenant tables.

-- ---------------------------------------------------------------- 1) AI gateway expansion

ALTER TABLE ai_model_registry ADD COLUMN coding_optimized boolean NOT NULL DEFAULT false;

ALTER TABLE ai_model_registry DROP CONSTRAINT ai_model_registry_provider_id_check;
ALTER TABLE ai_model_registry ADD CONSTRAINT ai_model_registry_provider_id_check
  CHECK (provider_id IN ('anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north'));

ALTER TABLE provider_health DROP CONSTRAINT provider_health_provider_id_check;
ALTER TABLE provider_health ADD CONSTRAINT provider_health_provider_id_check
  CHECK (provider_id IN ('anthropic','openai','google','mistral','grok','deepseek','kimi','nemotron','north'));

-- Verified model IDs (2026-08). Costs are deploy-config seeds to verify against vendor pricing.
INSERT INTO ai_model_registry
  (model_id, provider_id, display_name, tier, compute_class, context_window,
   supports_vision, supports_tools, supports_function_calling,
   input_cost_per_m, output_cost_per_m, entitlement, privacy_class,
   target_latency_ms, health, priority, fallback_list, coding_optimized)
VALUES
  ('grok-4.3', 'grok', 'Grok 4.3', 'CAPABLE', 'B', 1000000,
   true, true, true, 1.25, 2.50, 'FREE', 'STANDARD', 2500, 'UNKNOWN', 20, '["grok-4.6","grok-build-0.1"]', false),
  ('grok-4.6', 'grok', 'Grok 4.6', 'PREMIUM', 'C', 500000,
   true, true, true, 2.00, 6.00, 'PRO', 'STANDARD', 3000, 'UNKNOWN', 10, '["grok-4.3"]', false),
  ('grok-build-0.1', 'grok', 'Grok Build', 'EFFICIENT', 'A', 256000,
   false, true, true, 0.30, 0.60, 'FREE', 'STANDARD', 2000, 'UNKNOWN', 30, '["grok-4.3"]', true),
  ('deepseek-v4-pro', 'deepseek', 'DeepSeek V4 Pro', 'CAPABLE', 'B', 128000,
   false, true, true, 0.28, 0.42, 'FREE', 'STANDARD', 2500, 'UNKNOWN', 22, '["deepseek-v4-flash"]', true),
  ('deepseek-v4-flash', 'deepseek', 'DeepSeek V4 Flash', 'EFFICIENT', 'A', 128000,
   false, true, true, 0.10, 0.30, 'FREE', 'STANDARD', 1800, 'UNKNOWN', 40, '["deepseek-v4-pro"]', false),
  ('kimi-k3', 'kimi', 'Kimi K3', 'PREMIUM', 'C', 1000000,
   true, true, true, 2.00, 6.00, 'PRO', 'STANDARD', 3000, 'UNKNOWN', 12, '["kimi-k2.6"]', false),
  ('kimi-k2.7-code', 'kimi', 'Kimi K2.7 Code', 'CAPABLE', 'B', 256000,
   false, true, true, 0.60, 2.50, 'FREE', 'STANDARD', 2500, 'UNKNOWN', 42, '["kimi-k2.6"]', true),
  ('kimi-k2.7-code-highspeed', 'kimi', 'Kimi K2.7 Code High-Speed', 'EFFICIENT', 'A', 256000,
   false, true, true, 0.75, 3.00, 'FREE', 'STANDARD', 1500, 'UNKNOWN', 46, '["kimi-k2.7-code"]', true),
  ('kimi-k2.6', 'kimi', 'Kimi K2.6', 'CAPABLE', 'B', 256000,
   true, true, true, 0.60, 2.50, 'FREE', 'STANDARD', 3000, 'UNKNOWN', 50, '["kimi-k2.7-code"]', false),
  ('nvidia/nemotron-3.5-lightning-30b-a3b', 'nemotron', 'Nemotron 3.5 Lightning', 'EFFICIENT', 'A', 128000,
   false, true, true, 0.15, 0.60, 'FREE', 'STANDARD', 2000, 'UNKNOWN', 35, '["nvidia/nemotron-3-super-120b-a12b"]', true),
  ('nvidia/nemotron-3-nano-30b-a3b', 'nemotron', 'Nemotron 3 Nano', 'EFFICIENT', 'A', 128000,
   false, true, true, 0.10, 0.40, 'FREE', 'STANDARD', 1800, 'UNKNOWN', 55, '["nvidia/nemotron-3.5-lightning-30b-a3b"]', false),
  ('nvidia/nemotron-3-super-120b-a12b', 'nemotron', 'Nemotron 3 Super', 'CAPABLE', 'B', 128000,
   false, true, true, 0.30, 0.90, 'FREE', 'STANDARD', 2500, 'UNKNOWN', 25, '["nvidia/nemotron-3-ultra-550b-a55b"]', true),
  ('nvidia/nemotron-3-ultra-550b-a55b', 'nemotron', 'Nemotron 3 Ultra', 'PREMIUM', 'C', 256000,
   false, true, true, 0.90, 2.70, 'PRO', 'STANDARD', 3500, 'UNKNOWN', 15, '["nvidia/nemotron-3-super-120b-a12b"]', false),
  ('north-mini-code-1.0', 'north', 'North Mini Code', 'EFFICIENT', 'A', 256000,
   false, true, true, 0.10, 0.20, 'FREE', 'STANDARD', 2000, 'UNKNOWN', 33, '["deepseek-v4-flash"]', true)
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------- 2) multi-agent workspace

CREATE TABLE ai_agents (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN (
                    'ARCHITECT','CODER','DEBUGGER','RESEARCHER','REVIEWER',
                    'TESTER','SECURITY','DEVOPS','UI_UX','DOCUMENTATION')),
  objective       text,
  capabilities    jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_provider  text,
  model_id        text,
  max_tasks_per_run int NOT NULL DEFAULT 10 CHECK (max_tasks_per_run BETWEEN 1 AND 20),
  max_retries     int NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
  status          text NOT NULL DEFAULT 'IDLE' CHECK (status IN (
                    'IDLE','THINKING','RUNNING','WAITING_FOR_APPROVAL',
                    'WAITING_FOR_DEPENDENCY','COMPLETED','FAILED','BLOCKED')),
  current_run_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_agent_runs (
  id              text PRIMARY KEY,
  agent_id        text NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text REFERENCES projects(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'IDLE' CHECK (status IN (
                    'IDLE','THINKING','RUNNING','WAITING_FOR_APPROVAL',
                    'WAITING_FOR_DEPENDENCY','COMPLETED','FAILED','BLOCKED')),
  objective       text,
  current_task_id text,
  total_tasks     int NOT NULL DEFAULT 0,
  completed_tasks int NOT NULL DEFAULT 0,
  failed_tasks    int NOT NULL DEFAULT 0,
  retries_used    int NOT NULL DEFAULT 0,
  budget_usd      numeric(16,6) NOT NULL DEFAULT 5,
  spent_usd       numeric(16,6) NOT NULL DEFAULT 0,
  deadline_at     timestamptz,
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_current_run_fkey
  FOREIGN KEY (current_run_id) REFERENCES ai_agent_runs(id);

ALTER TABLE tasks ADD COLUMN agent_run_id text REFERENCES ai_agent_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_ai_agents_owner ON ai_agents (owner_id);
CREATE INDEX idx_ai_agents_status ON ai_agents (status);
CREATE INDEX idx_ai_agent_runs_agent_created ON ai_agent_runs (agent_id, created_at DESC);
CREATE INDEX idx_ai_agent_runs_owner_created ON ai_agent_runs (owner_id, created_at DESC);
CREATE INDEX idx_ai_agent_runs_status ON ai_agent_runs (status);
CREATE INDEX idx_tasks_agent_run ON tasks (agent_run_id);

CREATE TRIGGER trg_ai_agents_updated_at
  BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- 3) main-workspace live preview

CREATE TABLE preview_sessions (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state       text NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (state IN (
                'BUILDING','UPDATING','READY','ERROR','OFFLINE','NOT_CONFIGURED')),
  build_log   jsonb NOT NULL DEFAULT '[]'::jsonb,
  error       text,
  task_id     text REFERENCES tasks(id) ON DELETE SET NULL,
  version     int NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_preview_sessions_project UNIQUE (project_id)
);

CREATE INDEX idx_preview_sessions_owner ON preview_sessions (owner_id);

CREATE TRIGGER trg_preview_sessions_updated_at
  BEFORE UPDATE ON preview_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- 4) plugin center expansion

ALTER TABLE plugins DROP CONSTRAINT plugins_plugin_type_check;
ALTER TABLE plugins ADD CONSTRAINT plugins_plugin_type_check
  CHECK (plugin_type IN ('github','google','resend','slack','teams','discord',
    'notion','linear','jira','figma','sentry','cloudflare','supabase',
    'vercel','render','vscode','webhook'));

ALTER TABLE plugins ADD COLUMN category text NOT NULL DEFAULT 'development' CHECK (category IN (
  'development','productivity','communication','project_management','design',
  'cloud','data','monitoring'));
ALTER TABLE plugins ADD COLUMN popular boolean NOT NULL DEFAULT false;
ALTER TABLE plugins ADD COLUMN required_permissions jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE plugins SET category = 'development', popular = true,
  required_permissions = '["read","write"]' WHERE plugin_type = 'github';
UPDATE plugins SET category = 'productivity', popular = true,
  required_permissions = '["read","write","send"]' WHERE plugin_type = 'google';
UPDATE plugins SET category = 'communication', popular = true,
  required_permissions = '["read","send"]' WHERE plugin_type = 'slack';
UPDATE plugins SET category = 'development', popular = true,
  required_permissions = '["read","write"]' WHERE plugin_type = 'vercel';
UPDATE plugins SET category = 'development', popular = false,
  required_permissions = '["read"]' WHERE plugin_type = 'vscode';
UPDATE plugins SET category = 'development', popular = false,
  required_permissions = '["send","read"]' WHERE plugin_type = 'webhook';
UPDATE plugins SET category = 'communication', popular = false,
  required_permissions = '["read","send"]' WHERE plugin_type = 'resend';

INSERT INTO plugins (plugin_type, name, description, capabilities, category, popular, required_permissions) VALUES
  ('teams', 'Microsoft Teams', 'Post and read messages in Microsoft Teams channels (adapter required).', '["messages","channels"]', 'communication', false, '["read","send"]'),
  ('discord', 'Discord', 'Post and read messages in Discord servers (adapter required).', '["messages","channels"]', 'communication', false, '["read","send"]'),
  ('notion', 'Notion', 'Read and update Notion pages and databases (adapter required).', '["documents"]', 'productivity', true, '["read","write"]'),
  ('linear', 'Linear', 'Read and create Linear issues and projects with typed actions.', '["issues","projects"]', 'project_management', true, '["read","create","update"]'),
  ('jira', 'Jira', 'Read and update Jira issues and sprints (adapter required).', '["issues","projects"]', 'project_management', false, '["read","create","update"]'),
  ('figma', 'Figma', 'Read Figma files and components (adapter required).', '["design"]', 'design', false, '["read"]'),
  ('sentry', 'Sentry', 'Read issues and events from Sentry (adapter required).', '["monitoring"]', 'monitoring', false, '["read"]'),
  ('cloudflare', 'Cloudflare', 'Manage Workers, DNS and KV deployments (adapter required).', '["deployments"]', 'cloud', true, '["read","write"]'),
  ('supabase', 'Supabase', 'Read and write Supabase project data (adapter required).', '["database"]', 'data', false, '["read","write"]'),
  ('render', 'Render', 'Deploy and monitor Render services (adapter required).', '["deployments"]', 'cloud', false, '["read","write"]')
ON CONFLICT (plugin_type) DO NOTHING;

-- ---------------------------------------------------------------- 5) RLS — tenant isolation for the new tables

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_agents_owner ON ai_agents
  USING (owner_id = app.uid())
  WITH CHECK (owner_id = app.uid());

ALTER TABLE ai_agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_agent_runs_owner ON ai_agent_runs
  USING (owner_id = app.uid())
  WITH CHECK (owner_id = app.uid());

ALTER TABLE preview_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY preview_sessions_owner ON preview_sessions
  USING (owner_id = app.uid())
  WITH CHECK (owner_id = app.uid());
