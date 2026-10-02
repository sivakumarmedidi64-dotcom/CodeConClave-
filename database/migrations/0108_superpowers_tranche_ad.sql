-- CodeConClave — Stage 0108 SUPERPOWERS Tranche AD: Feature Store Autopilot,
-- Denormalization Suggester, Relationship Mapper, Anomaly Detector, Compliance Checker.

-- FEATURE-STORE AUTOPILOT (#127) — ML model drift detection + retraining
CREATE TABLE IF NOT EXISTS feature_store_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  model_name           TEXT NOT NULL,
  feature_set          JSONB NOT NULL DEFAULT '[]'::jsonb,
  drift_score          NUMERIC,
  last_trained_at      TIMESTAMPTZ,
  retrain_pr_url       TEXT,
  status               TEXT NOT NULL DEFAULT 'MONITORING' CHECK (status IN ('MONITORING','RETRAINED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE feature_store_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'feature_store_runs_owner' AND tablename = 'feature_store_runs') THEN CREATE POLICY feature_store_runs_owner ON feature_store_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_feature_store_runs_owner ON feature_store_runs(owner_id);

-- DENORMALIZATION SUGGESTER (#128) — query → materialized view suggestion
CREATE TABLE IF NOT EXISTS denorm_suggestions (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  query_text           TEXT NOT NULL,
  source_tables        JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_view       TEXT NOT NULL,
  estimated_improvement NUMERIC,
  status               TEXT NOT NULL DEFAULT 'SUGGESTED' CHECK (status IN ('SUGGESTED','APPLIED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE denorm_suggestions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'denorm_suggestions_owner' AND tablename = 'denorm_suggestions') THEN CREATE POLICY denorm_suggestions_owner ON denorm_suggestions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_denorm_suggestions_owner ON denorm_suggestions(owner_id);

-- RELATIONSHIP MAPPER (#129) — data relationship visualization
CREATE TABLE IF NOT EXISTS relationship_maps (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  source_table         TEXT NOT NULL,
  target_table         TEXT NOT NULL,
  relationship_type    TEXT NOT NULL,
  column_mapping       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               TEXT NOT NULL DEFAULT 'MAPPED' CHECK (status IN ('MAPPED','VERIFIED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE relationship_maps ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'relationship_maps_owner' AND tablename = 'relationship_maps') THEN CREATE POLICY relationship_maps_owner ON relationship_maps USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_relationship_maps_owner ON relationship_maps(owner_id);

-- ANOMALY DETECTOR (#130) — data volume/distribution anomalies
CREATE TABLE IF NOT EXISTS anomaly_scans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  data_source          TEXT NOT NULL,
  anomaly_type         TEXT NOT NULL,
  description          TEXT NOT NULL,
  severity             TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  alerted              BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','ALERTED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE anomaly_scans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anomaly_scans_owner' AND tablename = 'anomaly_scans') THEN CREATE POLICY anomaly_scans_owner ON anomaly_scans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_anomaly_scans_owner ON anomaly_scans(owner_id);

-- COMPLIANCE CHECKER (#131) — PII / retention / consent violations
CREATE TABLE IF NOT EXISTS compliance_reports (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  resource_type        TEXT NOT NULL,
  violation_type       TEXT NOT NULL,
  evidence             TEXT NOT NULL,
  severity             TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status               TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','RESOLVED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE compliance_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'compliance_reports_owner' AND tablename = 'compliance_reports') THEN CREATE POLICY compliance_reports_owner ON compliance_reports USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_compliance_reports_owner ON compliance_reports(owner_id);
