-- CodeConClave â€” Stage 0095 SUPERPOWERS Tranche Q (Regression Time Machine, Knowledge Diffusion, Human-AI Fusion Scoring, Rubber Duck Mode, Code Translator)

-- REGRESSION TIME MACHINE â€” every regression a module ever caused, with the fix that worked
CREATE TABLE IF NOT EXISTS regression_timelines (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  module           TEXT NOT NULL,
  events           JSONB NOT NULL DEFAULT '[]'::jsonb,
  regression_count INTEGER NOT NULL DEFAULT 0,
  fix_rate         INTEGER NOT NULL DEFAULT 0,
  summary          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE regression_timelines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'regression_timelines_owner' AND tablename = 'regression_timelines') THEN CREATE POLICY regression_timelines_owner ON regression_timelines USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_regression_timelines_owner ON regression_timelines(owner_id);

-- KNOWLEDGE DIFFUSION â€” one engineer's breakthrough becomes everyone's baseline
CREATE TABLE IF NOT EXISTS knowledge_diffusions (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  topic        TEXT NOT NULL,
  lesson       TEXT NOT NULL,
  area         TEXT NOT NULL,
  agents       JSONB NOT NULL DEFAULT '[]'::jsonb,
  reaches      INTEGER NOT NULL DEFAULT 0,
  retrievals   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'SEEDED' CHECK (status IN ('SEEDED','DIFFUSED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE knowledge_diffusions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'knowledge_diffusions_owner' AND tablename = 'knowledge_diffusions') THEN CREATE POLICY knowledge_diffusions_owner ON knowledge_diffusions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_knowledge_diffusions_owner ON knowledge_diffusions(owner_id);

-- HUMAN-AI FUSION SCORING â€” where value comes from, quantified
CREATE TABLE IF NOT EXISTS fusion_scores (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  "window"      TEXT NOT NULL,
  human_points  INTEGER NOT NULL DEFAULT 0,
  agent_points  INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  human_share   INTEGER NOT NULL DEFAULT 0,
  label         TEXT NOT NULL DEFAULT 'balanced',
  verdict       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE fusion_scores ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'fusion_scores_owner' AND tablename = 'fusion_scores') THEN CREATE POLICY fusion_scores_owner ON fusion_scores USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_fusion_scores_owner ON fusion_scores(owner_id);

-- RUBBER DUCK MODE â€” Socratic questions until YOU find the answer
CREATE TABLE IF NOT EXISTS duck_sessions (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  problem     TEXT NOT NULL,
  turns       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'SEARCHING' CHECK (status IN ('SEARCHING','FOUND')),
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE duck_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'duck_sessions_owner' AND tablename = 'duck_sessions') THEN CREATE POLICY duck_sessions_owner ON duck_sessions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_duck_sessions_owner ON duck_sessions(owner_id);

-- CODE TRANSLATOR â€” your code, explained in the language you think in
CREATE TABLE IF NOT EXISTS code_translations (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  source_lang   TEXT NOT NULL,
  target_lang   TEXT NOT NULL,
  source        TEXT NOT NULL,
  summary       TEXT NOT NULL,
  steps         JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'TRANSLATED',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE code_translations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'code_translations_owner' AND tablename = 'code_translations') THEN CREATE POLICY code_translations_owner ON code_translations USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_code_translations_owner ON code_translations(owner_id);