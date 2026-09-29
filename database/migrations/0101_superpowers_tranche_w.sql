-- CodeConClave — Stage 0101 SUPERPOWERS Tranche W (Infra Architect, Regression Radar)
-- Shadow Deploy, Release Commander, Regression Timeline already have tables from prior tranches.

-- INFRA ARCHITECT — plain-English infra request → validated Terraform diff
CREATE TABLE IF NOT EXISTS infra_architect_plans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  request              TEXT NOT NULL,
  resource_type        TEXT NOT NULL DEFAULT 'generic',
  estimated_changes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  iac_diff             TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','VALIDATED','APPLIED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE infra_architect_plans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'infra_architect_plans_owner' AND tablename = 'infra_architect_plans') THEN CREATE POLICY infra_architect_plans_owner ON infra_architect_plans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_infra_architect_plans_owner ON infra_architect_plans(owner_id);

-- REGRESSION RADAR — every regression this module ever caused + fix that worked
CREATE TABLE IF NOT EXISTS regression_radar_entries (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  module               TEXT NOT NULL,
  issue_description    TEXT NOT NULL,
  root_cause           TEXT NOT NULL DEFAULT '',
  fix_description      TEXT NOT NULL DEFAULT '',
  fix_worked           BOOLEAN NOT NULL DEFAULT false,
  severity             TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  reported_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  fixed_at             TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE regression_radar_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'regression_radar_entries_owner' AND tablename = 'regression_radar_entries') THEN CREATE POLICY regression_radar_entries_owner ON regression_radar_entries USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_regression_radar_entries_owner ON regression_radar_entries(owner_id);
CREATE INDEX IF NOT EXISTS idx_regression_radar_entries_module ON regression_radar_entries(owner_id, module);
