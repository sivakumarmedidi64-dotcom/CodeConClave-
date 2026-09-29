-- CodeConClave — Stage 0109 SUPERPOWERS Tranche AE
-- Query Optimizer (#132), Cross-Team Contract Mesh (#138), Org Health Dashboard (#143),
-- Retention Predictor (#145), Hiring Assistant (#146)

-- QUERY OPTIMIZER
CREATE TABLE IF NOT EXISTS query_optimizer_plans (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  query_text             TEXT NOT NULL,
  original_latency_ms    NUMERIC NOT NULL DEFAULT 0,
  optimized_query        TEXT,
  optimized_latency_ms   NUMERIC,
  equivalence_proven     BOOLEAN NOT NULL DEFAULT false,
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPTIMIZED','EQUIVALENCE_PROVEN')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE query_optimizer_plans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'query_optimizer_plans_owner' AND tablename = 'query_optimizer_plans') THEN CREATE POLICY query_optimizer_plans_owner ON query_optimizer_plans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_query_optimizer_plans_owner ON query_optimizer_plans(owner_id);

-- CROSS-TEAM CONTRACT MESH
CREATE TABLE IF NOT EXISTS cross_team_contracts (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  team_a                 TEXT NOT NULL,
  team_b                 TEXT NOT NULL,
  api_contract           TEXT NOT NULL,
  shared_library         TEXT NOT NULL,
  version                TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BREACH_FLAGGED')),
  breach_reason          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cross_team_contracts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cross_team_contracts_owner' AND tablename = 'cross_team_contracts') THEN CREATE POLICY cross_team_contracts_owner ON cross_team_contracts USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_cross_team_contracts_owner ON cross_team_contracts(owner_id);

-- ORG HEALTH DASHBOARD
CREATE TABLE IF NOT EXISTS org_health_reports (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  bus_factor_score       NUMERIC NOT NULL DEFAULT 0,
  review_bottleneck_score NUMERIC NOT NULL DEFAULT 0,
  coverage_score         NUMERIC NOT NULL DEFAULT 0,
  incident_count         NUMERIC NOT NULL DEFAULT 0,
  debt_score             NUMERIC NOT NULL DEFAULT 0,
  velocity_trend         TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COMPUTED')),
  computed_metrics       JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE org_health_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'org_health_reports_owner' AND tablename = 'org_health_reports') THEN CREATE POLICY org_health_reports_owner ON org_health_reports USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_org_health_reports_owner ON org_health_reports(owner_id);

-- RETENTION PREDICTOR
CREATE TABLE IF NOT EXISTS retention_predictors (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  employee_name          TEXT NOT NULL,
  signal_type            TEXT NOT NULL,
  risk_score             NUMERIC NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','FLAGGED')),
  intervention_plan      TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE retention_predictors ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'retention_predictors_owner' AND tablename = 'retention_predictors') THEN CREATE POLICY retention_predictors_owner ON retention_predictors USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_retention_predictors_owner ON retention_predictors(owner_id);

-- HIRING ASSISTANT
CREATE TABLE IF NOT EXISTS hiring_assistants (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  candidate_name         TEXT NOT NULL,
  interview_score        NUMERIC,
  take_home_score        NUMERIC,
  calibrated_score       NUMERIC,
  team_average           NUMERIC,
  status                 TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SCORED')),
  recommendation         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE hiring_assistants ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hiring_assistants_owner' AND tablename = 'hiring_assistants') THEN CREATE POLICY hiring_assistants_owner ON hiring_assistants USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_hiring_assistants_owner ON hiring_assistants(owner_id);
