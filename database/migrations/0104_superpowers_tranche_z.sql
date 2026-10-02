-- CodeConClave — Stage 0104 SUPERPOWERS Tranche Z (Schema Migration Wizard, API Version Bridge, Data Migration Orchestrator, Configuration Migration, Design Police)

-- SCHEMA MIGRATION WIZARD — database schema evolution made safe and reversible
--
-- NAMING: this wizard table is named schema_migration_plans and NOT schema_migrations.
-- `schema_migrations` is the single authoritative ledger owned by
-- backend/src/database/migrate.ts with shape (name, sha256, applied_at).
-- The two collided: `CREATE TABLE IF NOT EXISTS` silently no-op'd against the
-- ledger, then the policy below failed on the missing `owner_id` column, which
-- aborted the whole migration loop and made every migration from 0104 onward
-- unreachable. Renaming the wizard table removes the collision permanently.
CREATE TABLE IF NOT EXISTS schema_migration_plans (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  table_name       TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('expand','backfill','contract')),
  sql_up           TEXT NOT NULL,
  sql_down         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','EXPANDING','BACKFILLING','CONTRACTING','COMPLETED','ROLLED_BACK')),
  rolled_back_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schema_migration_plans ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'schema_migration_plans_owner' AND tablename = 'schema_migration_plans') THEN CREATE POLICY schema_migration_plans_owner ON schema_migration_plans USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_schema_migration_plans_owner ON schema_migration_plans(owner_id);

-- API VERSION BRIDGE — safely evolves APIs supporting multiple versions concurrently
CREATE TABLE IF NOT EXISTS api_version_bridges (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  old_version       TEXT NOT NULL,
  new_version       TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  mapping           JSONB NOT NULL DEFAULT '[]'::jsonb,
  deprecation_date  TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEPRECATED','REMOVED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE api_version_bridges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'api_version_bridges_owner' AND tablename = 'api_version_bridges') THEN CREATE POLICY api_version_bridges_owner ON api_version_bridges USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_api_version_bridges_owner ON api_version_bridges(owner_id);

-- DATA MIGRATION ORCHESTRATOR — large data transformations with verification and rollback
CREATE TABLE IF NOT EXISTS data_migrations (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  source_table    TEXT NOT NULL,
  target_table    TEXT NOT NULL,
  transform_rule  TEXT NOT NULL,
  sample_size     INTEGER NOT NULL DEFAULT 100,
  rows_affected   INTEGER NOT NULL DEFAULT 0,
  verified        BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','SAMPLED','RUNNING','VERIFIED','FAILED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE data_migrations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'data_migrations_owner' AND tablename = 'data_migrations') THEN CREATE POLICY data_migrations_owner ON data_migrations USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_data_migrations_owner ON data_migrations(owner_id);

-- CONFIGURATION MIGRATION — refactors config systems incrementally with traffic splits
CREATE TABLE IF NOT EXISTS config_migrations (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  config_keys       JSONB NOT NULL DEFAULT '[]'::jsonb,
  traffic_split_pct INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','MIGRATING','COMPLETED','ROLLED_BACK')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE config_migrations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'config_migrations_owner' AND tablename = 'config_migrations') THEN CREATE POLICY config_migrations_owner ON config_migrations USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_config_migrations_owner ON config_migrations(owner_id);

-- DESIGN POLICE — every screen compared to design system, violations auto-fixed
CREATE TABLE IF NOT EXISTS design_police_reports (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  screen_path      TEXT NOT NULL,
  violations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  component_misuse JSONB NOT NULL DEFAULT '[]'::jsonb,
  spacing_issues   JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_issues     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','FIXED','IGNORED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE design_police_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'design_police_reports_owner' AND tablename = 'design_police_reports') THEN CREATE POLICY design_police_reports_owner ON design_police_reports USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_design_police_reports_owner ON design_police_reports(owner_id);
