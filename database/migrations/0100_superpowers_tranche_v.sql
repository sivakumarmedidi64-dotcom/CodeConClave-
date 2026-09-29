-- CodeConClave — Stage 0100 SUPERPOWERS Tranche V (Capacity Oracle, Environment Cloner, Runbook Runner, Backup Reality Check, Network X-Ray)

-- CAPACITY ORACLE — predicts resource exhaustion weeks ahead, fix sized and costed
CREATE TABLE IF NOT EXISTS capacity_forecasts (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  component            TEXT NOT NULL,
  capacity             NUMERIC NOT NULL DEFAULT 0,
  usage                NUMERIC NOT NULL DEFAULT 0,
  growth_per_day       NUMERIC NOT NULL DEFAULT 0,
  days_to_exhaustion   INTEGER,
  fix_size             INTEGER NOT NULL DEFAULT 0,
  monthly_cost         NUMERIC NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'OK' CHECK (status IN ('OK','CRITICAL','EXHAUSTED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE capacity_forecasts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'capacity_forecasts_owner' AND tablename = 'capacity_forecasts') THEN CREATE POLICY capacity_forecasts_owner ON capacity_forecasts USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_capacity_forecasts_owner ON capacity_forecasts(owner_id);

-- ENVIRONMENT CLONER — prod → exact dev copy with anonymized data, in minutes
CREATE TABLE IF NOT EXISTS env_clones (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  source         TEXT NOT NULL,
  target         TEXT NOT NULL,
  rows_cloned    INTEGER NOT NULL DEFAULT 0,
  anonymized     BOOLEAN NOT NULL DEFAULT false,
  anonymized_rows INTEGER NOT NULL DEFAULT 0,
  elapsed_minutes INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE env_clones ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'env_clones_owner' AND tablename = 'env_clones') THEN CREATE POLICY env_clones_owner ON env_clones USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_env_clones_owner ON env_clones(owner_id);

-- RUNBOOK RUNNER — every alert → automatically executing runbook; escalates only when confidence drops
CREATE TABLE IF NOT EXISTS runbook_runs (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  alert       TEXT NOT NULL,
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed   INTEGER NOT NULL DEFAULT 0,
  blocked     INTEGER NOT NULL DEFAULT 0,
  confidence  NUMERIC NOT NULL DEFAULT 0.95,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'EXECUTING' CHECK (status IN ('EXECUTING','ESCALATED','RESOLVED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE runbook_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'runbook_runs_owner' AND tablename = 'runbook_runs') THEN CREATE POLICY runbook_runs_owner ON runbook_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_runbook_runs_owner ON runbook_runs(owner_id);

-- BACKUP REALITY CHECK — actually restores backups and verifies the restored system works
CREATE TABLE IF NOT EXISTS backup_checks (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  target       TEXT NOT NULL,
  schedule     TEXT NOT NULL DEFAULT 'daily 0200',
  status       TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','VERIFIED','BROKEN')),
  checks_passed BOOLEAN,
  verdict      TEXT,
  last_check   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE backup_checks ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'backup_checks_owner' AND tablename = 'backup_checks') THEN CREATE POLICY backup_checks_owner ON backup_checks USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_backup_checks_owner ON backup_checks(owner_id);

-- NETWORK X-RAY — every service-to-service call, mapped live; blast radius of any failure
CREATE TABLE IF NOT EXISTS network_edges (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, src, dst)
);
ALTER TABLE network_edges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'network_edges_owner' AND tablename = 'network_edges') THEN CREATE POLICY network_edges_owner ON network_edges USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_network_edges_owner ON network_edges(owner_id);