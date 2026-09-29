-- CodeConClave — Stage 0098 SUPERPOWERS Tranche T (Impact Radar, Churn Detective, Onboarding Simulator, Zero-to-Prod Mode, Policy Copilot)

-- IMPACT RADAR — after every release, code changes correlated with product metrics
CREATE TABLE IF NOT EXISTS impact_radar (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  area       TEXT NOT NULL,
  metric     TEXT NOT NULL,
  delta      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE impact_radar ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'impact_radar_owner' AND tablename = 'impact_radar') THEN CREATE POLICY impact_radar_owner ON impact_radar USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_impact_radar_owner ON impact_radar(owner_id);

-- CHURN DETECTIVE — the exact code paths where users give up
CREATE TABLE IF NOT EXISTS churn_events (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  locale      TEXT NOT NULL,
  action      TEXT NOT NULL,
  signal      TEXT NOT NULL CHECK (signal IN ('rage_click','error_loop','form_abandoned')),
  occurrences INTEGER NOT NULL DEFAULT 1,
  fix_draft   TEXT,
  status      TEXT NOT NULL DEFAULT 'WATCHED' CHECK (status IN ('WATCHED','DRAFTED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE churn_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'churn_events_owner' AND tablename = 'churn_events') THEN CREATE POLICY churn_events_owner ON churn_events USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_churn_events_owner ON churn_events(owner_id);

-- ONBOARDING SIMULATOR — a confused new hire role-played before a human hits the gotchas
CREATE TABLE IF NOT EXISTS onboarding_sims (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  profile    TEXT NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 5,
  steps      JSONB NOT NULL DEFAULT '[]'::jsonb,
  tickets    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'PLAYING' CHECK (status IN ('PLAYING','COMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE onboarding_sims ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'onboarding_sims_owner' AND tablename = 'onboarding_sims') THEN CREATE POLICY onboarding_sims_owner ON onboarding_sims USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_onboarding_sims_owner ON onboarding_sims(owner_id);

-- ZERO-TO-PROD MODE — one product idea → full approved pipeline to production
CREATE TABLE IF NOT EXISTS zero_to_prod (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  idea       TEXT NOT NULL,
  stages     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE zero_to_prod ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'zero_to_prod_owner' AND tablename = 'zero_to_prod') THEN CREATE POLICY zero_to_prod_owner ON zero_to_prod USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_zero_to_prod_owner ON zero_to_prod(owner_id);

-- POLICY COPILOT — plain-English engineering policies compiled into enforced agent permissions
CREATE TABLE IF NOT EXISTS policy_copilots (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  policy      TEXT NOT NULL,
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE policy_copilots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'policy_copilots_owner' AND tablename = 'policy_copilots') THEN CREATE POLICY policy_copilots_owner ON policy_copilots USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_policy_copilots_owner ON policy_copilots(owner_id);