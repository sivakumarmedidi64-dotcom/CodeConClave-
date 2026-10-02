-- Stage 26A/26B — agent debates, agent marketplace, decision memory,
-- cross-project pattern memory (opt-in), handoffs.
-- Additive only. Every tenant table: owner_id + RLS + FKs + indexes.

-- ---------------------------------------------------------------- agent debates
CREATE TABLE agent_debates (
  id                 text PRIMARY KEY,
  owner_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt             text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                       'PENDING','IN_DEBATE','JUDGING','COMPLETED','FAILED',
                       'CANCELLED','BLOCKED','WAITING_FOR_APPROVAL','APPROVED','REJECTED')),
  proposer_agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  judge_agent_id     text NOT NULL REFERENCES ai_agents(id),
  winner_agent_id    text REFERENCES ai_agents(id),
  rationale          text,
  max_rounds         int NOT NULL DEFAULT 1 CHECK (max_rounds BETWEEN 1 AND 3),
  round_count        int NOT NULL DEFAULT 0,
  budget_usd         numeric(16,6) NOT NULL DEFAULT 2,
  spent_usd          numeric(16,6) NOT NULL DEFAULT 0,
  deadline_at        timestamptz NOT NULL,
  require_approval   boolean NOT NULL DEFAULT false,
  run_id             text REFERENCES ai_agent_runs(id) ON DELETE SET NULL,
  user_decision      text CHECK (user_decision IN ('APPROVED','REJECTED')),
  error              text,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_debate_proposals (
  id            text PRIMARY KEY,
  debate_id     text NOT NULL REFERENCES agent_debates(id) ON DELETE CASCADE,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id      text NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  agent_name    text NOT NULL,
  role          text NOT NULL,
  model_id      text,
  provider_id   text,
  round         int NOT NULL DEFAULT 1,
  proposal      text,
  evidence      text,
  risks         text,
  tradeoffs     text,
  status        text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','FAILED')),
  error         text,
  cost_usd      numeric(16,6) NOT NULL DEFAULT 0,
  duration_ms   int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_debate_proposal UNIQUE (debate_id, agent_id, round)
);

CREATE INDEX idx_agent_debates_owner ON agent_debates (owner_id, created_at DESC);
CREATE INDEX idx_agent_debate_proposals_debate ON agent_debate_proposals (debate_id);

-- ---------------------------------------------------------------- agent marketplace
CREATE TABLE agent_catalogue (
  id                 text PRIMARY KEY,
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  description        text,
  role               text NOT NULL CHECK (role IN (
                       'ARCHITECT','CODER','DEBUGGER','RESEARCHER','REVIEWER',
                       'TESTER','SECURITY','DEVOPS','UI_UX','DOCUMENTATION')),
  capabilities       jsonb NOT NULL DEFAULT '[]'::jsonb,
  declared_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  min_trust_level    text NOT NULL DEFAULT 'L1' CHECK (min_trust_level IN ('L0','L1','L2','L3','L4')),
  min_plan           text NOT NULL DEFAULT 'free' CHECK (min_plan IN ('free','pro','team','enterprise')),
  version            text NOT NULL DEFAULT '1.0.0',
  enabled            boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE installed_agents (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catalogue_id  text NOT NULL REFERENCES agent_catalogue(id),
  catalogue_slug text NOT NULL,
  agent_id      text NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  version       text NOT NULL,
  status        text NOT NULL DEFAULT 'INSTALLED' CHECK (status IN ('INSTALLED','DISABLED','REMOVED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_installed_agents_active ON installed_agents (owner_id, catalogue_id)
  WHERE status IN ('INSTALLED','DISABLED');
CREATE INDEX idx_installed_agents_owner ON installed_agents (owner_id);

-- ---------------------------------------------------------------- decision memory
CREATE TABLE agent_decisions (
  id                     text PRIMARY KEY,
  owner_id               text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id             text REFERENCES projects(id) ON DELETE SET NULL,
  title                  text NOT NULL,
  decision               text NOT NULL,
  context                text,
  alternatives           jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale              text,
  consequences           jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_conversation_id text REFERENCES conversations(id) ON DELETE SET NULL,
  source_task_id         text REFERENCES tasks(id) ON DELETE SET NULL,
  evidence_ref           text,
  impact                 text NOT NULL DEFAULT 'MEDIUM' CHECK (impact IN ('LOW','MEDIUM','HIGH')),
  superseded_by_id       text REFERENCES agent_decisions(id) ON DELETE SET NULL,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_decisions_owner ON agent_decisions (owner_id, created_at DESC);
CREATE INDEX idx_agent_decisions_project ON agent_decisions (project_id);

CREATE TABLE decision_conflicts (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision_id   text NOT NULL REFERENCES agent_decisions(id) ON DELETE CASCADE,
  request_text  text NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  resolution    text CHECK (resolution IN ('KEEP','REPLACE','EXCEPTION','CANCEL')),
  note          text,
  new_decision_id text REFERENCES agent_decisions(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_decision_conflicts_owner ON decision_conflicts (owner_id, status);

-- ---------------------------------------------------------------- cross-project patterns (opt-in)
ALTER TABLE users ADD COLUMN cross_project_memory_opt_in boolean NOT NULL DEFAULT false;

CREATE TABLE cross_project_patterns (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             text NOT NULL,
  pattern          text NOT NULL,
  tag              text,
  proven           boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cross_project_patterns_owner ON cross_project_patterns (owner_id, tag);

-- ---------------------------------------------------------------- handoffs
CREATE TABLE handoffs (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE SET NULL,
  title      text NOT NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_handoffs_owner ON handoffs (owner_id, created_at DESC);

-- ---------------------------------------------------------------- seed marketplace catalogue
INSERT INTO agent_catalogue (id, slug, name, description, role, capabilities, declared_permissions, min_trust_level, min_plan, version)
VALUES
  ('cat-style-guardian', 'style-guardian', 'Style Guardian', 'Reviews diffs against the project style guide and flags drift.', 'REVIEWER',
   '["code","review"]'::jsonb, '["files.read","tasks.create"]'::jsonb, 'L1', 'free', '1.0.0'),
  ('cat-dependency-watchdog', 'dependency-watchdog', 'Dependency Watchdog', 'Probes dependencies one at a time and reports upgrade risk.', 'DEVOPS',
   '["devops","research"]'::jsonb, '["tasks.create","plugins.use"]'::jsonb, 'L2', 'pro', '1.0.0'),
  ('cat-flake-hunter', 'flake-hunter', 'Flake Hunter', 'Detects intermittent test failures and opens investigation tasks.', 'TESTER',
   '["test","research"]'::jsonb, '["tasks.create","files.read"]'::jsonb, 'L2', 'pro', '1.0.0'),
  ('cat-doc-weaver', 'doc-weaver', 'Doc Weaver', 'Keeps runbooks and handoffs in sync with recent changes.', 'DOCUMENTATION',
   '["docs"]'::jsonb, '["files.read"]'::jsonb, 'L1', 'free', '1.0.0')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------- RLS
ALTER TABLE agent_debates ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_debates_owner ON agent_debates
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE agent_debate_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_debate_proposals_owner ON agent_debate_proposals
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE installed_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY installed_agents_owner ON installed_agents
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE agent_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_decisions_owner ON agent_decisions
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE decision_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY decision_conflicts_owner ON decision_conflicts
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE cross_project_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY cross_project_patterns_owner ON cross_project_patterns
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY handoffs_owner ON handoffs
  USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());