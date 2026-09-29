-- CodeConClave — Stage 0103 SUPERPOWERS Tranche Y (DB Brain Surgeon, Test Converter, Legacy Wrapper, Dependency Bridge, Performance Migration)

-- DB BRAIN SURGEON — zero-downtime schema changes: expand/migrate/contract cycles with dual-writes
CREATE TABLE IF NOT EXISTS db_brain_surgeries (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  table_name           TEXT NOT NULL,
  cycle                TEXT NOT NULL DEFAULT 'EXPAND' CHECK (cycle IN ('EXPAND','MIGRATE','CONTRACT')),
  dual_write_active    BOOLEAN NOT NULL DEFAULT false,
  backfill_verified    BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','DUAL_WRITE','CONTRACTING','DONE','ROLLED_BACK')),
  rollback_plan        TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE db_brain_surgeries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'db_brain_surgeries_owner' AND tablename = 'db_brain_surgeries') THEN CREATE POLICY db_brain_surgeries_owner ON db_brain_surgeries USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_db_brain_surgeries_owner ON db_brain_surgeries(owner_id);

-- TEST CONVERTER — migrate tests between frameworks and prove coverage matches
CREATE TABLE IF NOT EXISTS test_conversions (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  source_framework     TEXT NOT NULL,
  target_framework     TEXT NOT NULL,
  source_test_path     TEXT NOT NULL,
  target_test_path     TEXT NOT NULL,
  coverage_match       BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','CONVERTING','VERIFYING','DONE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE test_conversions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'test_conversions_owner' AND tablename = 'test_conversions') THEN CREATE POLICY test_conversions_owner ON test_conversions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_test_conversions_owner ON test_conversions(owner_id);

-- LEGACY WRAPPER — modern interface on top of COBOL, mainframes, old APIs
CREATE TABLE IF NOT EXISTS legacy_wrappers (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  legacy_system        TEXT NOT NULL,
  interface_type       TEXT NOT NULL,
  endpoint             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE legacy_wrappers ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'legacy_wrappers_owner' AND tablename = 'legacy_wrappers') THEN CREATE POLICY legacy_wrappers_owner ON legacy_wrappers USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_legacy_wrappers_owner ON legacy_wrappers(owner_id);

-- DEPENDENCY BRIDGE — automated major dependency version migrations with breaking change detection
CREATE TABLE IF NOT EXISTS dependency_bridges (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  package_name         TEXT NOT NULL,
  from_version         TEXT NOT NULL,
  to_version           TEXT NOT NULL,
  breaking_changes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_verified      BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','MIGRATING','VERIFYING','DONE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dependency_bridges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dependency_bridges_owner' AND tablename = 'dependency_bridges') THEN CREATE POLICY dependency_bridges_owner ON dependency_bridges USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_dependency_bridges_owner ON dependency_bridges(owner_id);

-- PERF MIGRATION — sync→async, CPU-bound→distributed, monolithic→cached with before/after proof
CREATE TABLE IF NOT EXISTS perf_migrations (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  source_pattern       TEXT NOT NULL,
  target_pattern       TEXT NOT NULL,
  before_score         NUMERIC NOT NULL DEFAULT 0,
  after_score          NUMERIC,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','MIGRATING','REPORTING','DONE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE perf_migrations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'perf_migrations_owner' AND tablename = 'perf_migrations') THEN CREATE POLICY perf_migrations_owner ON perf_migrations USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_perf_migrations_owner ON perf_migrations(owner_id);
