-- CodeConClave — Stage 0112 SUPERPOWERS Tranche AH (#158-#162)
-- Nutrition Label, Universal Reproduction, Refactor Market,
-- Dogfood Mode, Demo Link

-- NUTRITION LABEL (#158) — health label: freshness, risk, debt, coverage, security, velocity
CREATE TABLE IF NOT EXISTS nutrition_labels (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  repo_name            TEXT NOT NULL,
  freshness            INTEGER NOT NULL DEFAULT 0,
  risk                 INTEGER NOT NULL DEFAULT 0,
  debt                 INTEGER NOT NULL DEFAULT 0,
  coverage             INTEGER NOT NULL DEFAULT 0,
  security             INTEGER NOT NULL DEFAULT 0,
  velocity             INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE nutrition_labels ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'nutrition_labels_owner' AND tablename = 'nutrition_labels') THEN CREATE POLICY nutrition_labels_owner ON nutrition_labels USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_nutrition_labels_owner ON nutrition_labels(owner_id);

-- UNIVERSAL REPRODUCTION (#159) — reconstruct exact customer state, reproduce bugs
CREATE TABLE IF NOT EXISTS universal_repro_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  bug_description      TEXT NOT NULL,
  version              TEXT NOT NULL,
  data_state           TEXT NOT NULL DEFAULT '',
  flags                JSONB NOT NULL DEFAULT '[]'::jsonb,
  device               TEXT NOT NULL DEFAULT '',
  network              TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'ATTEMPTED' CHECK (status IN ('ATTEMPTED','CONFIRMED')),
  result               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE universal_repro_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'universal_repro_runs_owner' AND tablename = 'universal_repro_runs') THEN CREATE POLICY universal_repro_runs_owner ON universal_repro_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_universal_repro_runs_owner ON universal_repro_runs(owner_id);

-- AUTONOMOUS REFACTOR MARKET (#160) — propose, benchmark, queue refactors
CREATE TABLE IF NOT EXISTS refactor_proposals (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  description          TEXT NOT NULL,
  file_path            TEXT NOT NULL,
  benchmark_before     INTEGER NOT NULL DEFAULT 0,
  benchmark_after      INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','QUEUED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE refactor_proposals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'refactor_proposals_owner' AND tablename = 'refactor_proposals') THEN CREATE POLICY refactor_proposals_owner ON refactor_proposals USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_refactor_proposals_owner ON refactor_proposals(owner_id);

-- DOGFOOD MODE (#161) — agents file issues, fix CI, write docs
CREATE TABLE IF NOT EXISTS dogfood_tasks (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  category             TEXT NOT NULL,
  assignee             TEXT,
  status               TEXT NOT NULL DEFAULT 'FILED' CHECK (status IN ('FILED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dogfood_tasks ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dogfood_tasks_owner' AND tablename = 'dogfood_tasks') THEN CREATE POLICY dogfood_tasks_owner ON dogfood_tasks USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_dogfood_tasks_owner ON dogfood_tasks(owner_id);

-- DEMO LINK (#162) — public read-only "ask my codebase anything" link, auto-expires
CREATE TABLE IF NOT EXISTS demo_links (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  url                  TEXT NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  expired_at           TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE demo_links ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'demo_links_owner' AND tablename = 'demo_links') THEN CREATE POLICY demo_links_owner ON demo_links USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_demo_links_owner ON demo_links(owner_id);
