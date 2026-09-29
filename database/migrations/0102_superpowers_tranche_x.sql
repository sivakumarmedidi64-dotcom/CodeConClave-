-- CodeConClave — Stage 0102 SUPERPOWERS Tranche X (Incident Orchestrator, Network Policy Enforcer, Framework Bridge, Language Ferry, Monolith Surgeon)

-- INCIDENT ORCHESTRATOR — log spike → agent investigates → postmortem drafted → candidate fix PR
CREATE TABLE IF NOT EXISTS incident_orch_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  incident             TEXT NOT NULL,
  log_spike            TEXT NOT NULL,
  agent_investigation  TEXT,
  postmortem_draft     TEXT,
  fix_pr_url           TEXT,
  status               TEXT NOT NULL DEFAULT 'INVESTIGATING' CHECK (status IN ('INVESTIGATING','POSTMORTEM_DRAFTED','FIX_PROPOSED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE incident_orch_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'incident_orch_runs_owner' AND tablename = 'incident_orch_runs') THEN CREATE POLICY incident_orch_runs_owner ON incident_orch_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_incident_orch_runs_owner ON incident_orch_runs(owner_id);

-- NETWORK POLICY ENFORCER — every network call from agents runs against a policy
CREATE TABLE IF NOT EXISTS network_policies (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  agent_name       TEXT NOT NULL,
  allowed_domains  JSONB NOT NULL DEFAULT '[]'::jsonb,
  rate_limit       INTEGER NOT NULL DEFAULT 100,
  calls_made       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXHAUSTED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE network_policies ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'network_policies_owner' AND tablename = 'network_policies') THEN CREATE POLICY network_policies_owner ON network_policies USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_network_policies_owner ON network_policies(owner_id);

-- FRAMEWORK BRIDGE — incremental framework migration while keeping app shippable
CREATE TABLE IF NOT EXISTS framework_bridges (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  source_framework  TEXT NOT NULL,
  target_framework  TEXT NOT NULL,
  steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps_applied     INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','APPLYING','READY','VERIFIED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE framework_bridges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'framework_bridges_owner' AND tablename = 'framework_bridges') THEN CREATE POLICY framework_bridges_owner ON framework_bridges USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_framework_bridges_owner ON framework_bridges(owner_id);

-- LANGUAGE FERRY — cross-language rewrite with behavioral test harnesses proving equivalence
CREATE TABLE IF NOT EXISTS language_ferries (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  source_language   TEXT NOT NULL,
  target_language   TEXT NOT NULL,
  source_code       TEXT NOT NULL,
  target_code       TEXT,
  test_harness      JSONB NOT NULL DEFAULT '[]'::jsonb,
  tests_passed      INTEGER NOT NULL DEFAULT 0,
  total_tests       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RUNNING','VERIFIED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE language_ferries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'language_ferries_owner' AND tablename = 'language_ferries') THEN CREATE POLICY language_ferries_owner ON language_ferries USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_language_ferries_owner ON language_ferries(owner_id);

-- MONOLITH SURGEON — extracts services from monoliths, identifies cleanest cut line, stubs seams
CREATE TABLE IF NOT EXISTS monolith_surgeries (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  monolith_name       TEXT NOT NULL,
  cut_line            TEXT NOT NULL,
  services            JSONB NOT NULL DEFAULT '[]'::jsonb,
  services_extracted  INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','EXTRACTING','DONE')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE monolith_surgeries ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'monolith_surgeries_owner' AND tablename = 'monolith_surgeries') THEN CREATE POLICY monolith_surgeries_owner ON monolith_surgeries USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_monolith_surgeries_owner ON monolith_surgeries(owner_id);
