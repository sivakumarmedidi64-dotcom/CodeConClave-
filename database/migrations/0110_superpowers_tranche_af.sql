-- CodeConClave — Stage 0110 SUPERPOWERS Tranche AF (#148-#152)
-- Speculative Engineering, Self-Evolving Toolchain, Org Simulator,
-- Codebase Physics Engine, Autonomous Tech Debt Market

-- SPECULATIVE ENGINEERING (#148) — explore 3-5 architectural futures in parallel
CREATE TABLE IF NOT EXISTS speculative_engineering_lanes (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  hypothesis           TEXT NOT NULL,
  alternatives         JSONB NOT NULL DEFAULT '[]'::jsonb,
  measured_result      TEXT,
  status               TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MEASURED','DISCARDED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE speculative_engineering_lanes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'speculative_engineering_lanes_owner' AND tablename = 'speculative_engineering_lanes') THEN CREATE POLICY speculative_engineering_lanes_owner ON speculative_engineering_lanes USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_speculative_engineering_lanes_owner ON speculative_engineering_lanes(owner_id);

-- SELF-EVOLVING TOOLCHAIN (#149) — analyze failures, adopt lessons
CREATE TABLE IF NOT EXISTS self_evolving_lessons (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  failure_description  TEXT NOT NULL,
  lesson               TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT '',
  adopted              BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ADOPTED','DISCARDED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE self_evolving_lessons ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'self_evolving_lessons_owner' AND tablename = 'self_evolving_lessons') THEN CREATE POLICY self_evolving_lessons_owner ON self_evolving_lessons USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_self_evolving_lessons_owner ON self_evolving_lessons(owner_id);

-- ORG SIMULATOR (#150) — simulate org changes against historical data
CREATE TABLE IF NOT EXISTS org_simulator_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  scenario             TEXT NOT NULL,
  baseline_metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
  simulation_result    TEXT,
  status               TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','RUNNING','COMPLETED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE org_simulator_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'org_simulator_runs_owner' AND tablename = 'org_simulator_runs') THEN CREATE POLICY org_simulator_runs_owner ON org_simulator_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_org_simulator_runs_owner ON org_simulator_runs(owner_id);

-- CODEBASE PHYSICS ENGINE (#151) — living digital twin, simulate changes
CREATE TABLE IF NOT EXISTS codebase_physics_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  change_description   TEXT NOT NULL,
  impact_metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
  simulation_result    TEXT,
  status               TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','RUNNING','COMPLETED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE codebase_physics_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'codebase_physics_runs_owner' AND tablename = 'codebase_physics_runs') THEN CREATE POLICY codebase_physics_runs_owner ON codebase_physics_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_codebase_physics_runs_owner ON codebase_physics_runs(owner_id);

-- AUTONOMOUS TECH DEBT MARKET (#152) — continuously price tech debt
CREATE TABLE IF NOT EXISTS tech_debt_pricing_items (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  debt_description     TEXT NOT NULL,
  fix_cost_days        INTEGER NOT NULL DEFAULT 0,
  ignore_cost_days     INTEGER NOT NULL DEFAULT 0,
  urgency_score        INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'PRICED' CHECK (status IN ('PRICED','FIX_SCHEDULED','FIXED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tech_debt_pricing_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tech_debt_pricing_items_owner' AND tablename = 'tech_debt_pricing_items') THEN CREATE POLICY tech_debt_pricing_items_owner ON tech_debt_pricing_items USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_tech_debt_pricing_items_owner ON tech_debt_pricing_items(owner_id);
