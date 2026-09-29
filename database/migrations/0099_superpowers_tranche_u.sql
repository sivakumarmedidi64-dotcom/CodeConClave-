-- CodeConClave — Stage 0099 SUPERPOWERS Tranche U (Challenge Mode, Ask My Codebase Live, Cost Badge, Cost Thermometer, Drift Police)

-- CHALLENGE MODE — one product idea built to production quality in 24h, defended decision by decision
CREATE TABLE IF NOT EXISTS product_challenges (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  idea       TEXT NOT NULL,
  tracks     JSONB NOT NULL DEFAULT '[]'::jsonb,
  defense    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE product_challenges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'product_challenges_owner' AND tablename = 'product_challenges') THEN CREATE POLICY product_challenges_owner ON product_challenges USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_product_challenges_owner ON product_challenges(owner_id);

-- ASK MY CODEBASE LIVE — public read-only Q&A link on the project, auto-expiring
CREATE TABLE IF NOT EXISTS codebase_shares (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  project        TEXT NOT NULL,
  pitch          TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL,
  question_count INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'LIVE' CHECK (status IN ('LIVE','EXPIRED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE codebase_shares ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'codebase_shares_owner' AND tablename = 'codebase_shares') THEN CREATE POLICY codebase_shares_owner ON codebase_shares USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_codebase_shares_owner ON codebase_shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_codebase_shares_token ON codebase_shares(token);

-- COST BADGE — every PR carries its infra cost delta ("+~$120/month at current traffic")
CREATE TABLE IF NOT EXISTS cost_estimates (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  context    TEXT NOT NULL,
  component  TEXT NOT NULL CHECK (component IN ('feature','scale','storage')),
  units      NUMERIC NOT NULL DEFAULT 0,
  traffic    TEXT NOT NULL DEFAULT '',
  delta      NUMERIC NOT NULL DEFAULT 0,
  badge      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cost_estimates ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cost_estimates_owner' AND tablename = 'cost_estimates') THEN CREATE POLICY cost_estimates_owner ON cost_estimates USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_cost_estimates_owner ON cost_estimates(owner_id);

-- COST THERMOMETER — a live read of the infra spend trend across PRs
CREATE TABLE IF NOT EXISTS cost_thermometers (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  total_delta NUMERIC NOT NULL DEFAULT 0,
  temperature TEXT NOT NULL DEFAULT 'cool' CHECK (temperature IN ('cool','warm','hot','boiling')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cost_thermometers ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cost_thermometers_owner' AND tablename = 'cost_thermometers') THEN CREATE POLICY cost_thermometers_owner ON cost_thermometers USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_cost_thermometers_owner ON cost_thermometers(owner_id);

-- DRIFT POLICE — actual cloud state vs IaC state, reconciled or filed as precise fixes
CREATE TABLE IF NOT EXISTS drift_reports (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  drifts     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLEAN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE drift_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'drift_reports_owner' AND tablename = 'drift_reports') THEN CREATE POLICY drift_reports_owner ON drift_reports USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_drift_reports_owner ON drift_reports(owner_id);