-- CodeConClave — Stage 0107 SUPERPOWERS Tranche AC: Component Catalogue, Query Whisperer,
-- Data Doctor, Schema Time Machine, Pipeline Watcher

-- COMPONENT CATALOGUE (#122) — auto-generated living component library
CREATE TABLE IF NOT EXISTS component_catalogue_entries (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  component_name       TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  props                JSONB NOT NULL DEFAULT '[]'::jsonb,
  states               JSONB NOT NULL DEFAULT '[]'::jsonb,
  accessibility_notes  TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'PARSED' CHECK (status IN ('PARSED','PUBLISHED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE component_catalogue_entries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'component_catalogue_entries_owner' AND tablename = 'component_catalogue_entries') THEN CREATE POLICY component_catalogue_entries_owner ON component_catalogue_entries USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_component_catalogue_entries_owner ON component_catalogue_entries(owner_id);

-- QUERY WHISPERER (#123) — SQL/ORM query explanation and rewriting
CREATE TABLE IF NOT EXISTS query_whisperer_plans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  query_text           TEXT NOT NULL,
  execution_plan       TEXT NOT NULL DEFAULT '',
  rewritten_query      TEXT NOT NULL DEFAULT '',
  improvement_pct      NUMERIC NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'EXPLAINED' CHECK (status IN ('EXPLAINED','REWRITTEN')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE query_whisperer_plans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'query_whisperer_plans_owner' AND tablename = 'query_whisperer_plans') THEN CREATE POLICY query_whisperer_plans_owner ON query_whisperer_plans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_query_whisperer_plans_owner ON query_whisperer_plans(owner_id);

-- DATA DOCTOR (#124) — data integrity validation
CREATE TABLE IF NOT EXISTS data_doctor_scans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  scan_name            TEXT NOT NULL,
  target_table         TEXT NOT NULL,
  issues_found         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               TEXT NOT NULL DEFAULT 'SCAN_RUN' CHECK (status IN ('SCAN_RUN','ISSUES_FLAGGED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE data_doctor_scans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'data_doctor_scans_owner' AND tablename = 'data_doctor_scans') THEN CREATE POLICY data_doctor_scans_owner ON data_doctor_scans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_data_doctor_scans_owner ON data_doctor_scans(owner_id);

-- SCHEMA TIME MACHINE (#125) — point-in-time schema + data reconstruction
CREATE TABLE IF NOT EXISTS schema_time_machine_snapshots (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  schema_name          TEXT NOT NULL,
  schema_definition    TEXT NOT NULL DEFAULT '',
  snapshot_label       TEXT NOT NULL DEFAULT '',
  restored_from        TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'CAPTURED' CHECK (status IN ('CAPTURED','RESTORED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schema_time_machine_snapshots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'schema_time_machine_snapshots_owner' AND tablename = 'schema_time_machine_snapshots') THEN CREATE POLICY schema_time_machine_snapshots_owner ON schema_time_machine_snapshots USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_schema_time_machine_snapshots_owner ON schema_time_machine_snapshots(owner_id);

-- PIPELINE WATCHER (#126) — ETL/data job monitoring: freshness SLAs, silent failures, volume anomalies
CREATE TABLE IF NOT EXISTS pipeline_watcher_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  pipeline_name        TEXT NOT NULL,
  sla_minutes          NUMERIC NOT NULL DEFAULT 0,
  anomalies            JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','ANOMALY_DETECTED','SLA_FLAGGED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pipeline_watcher_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'pipeline_watcher_runs_owner' AND tablename = 'pipeline_watcher_runs') THEN CREATE POLICY pipeline_watcher_runs_owner ON pipeline_watcher_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_pipeline_watcher_runs_owner ON pipeline_watcher_runs(owner_id);
