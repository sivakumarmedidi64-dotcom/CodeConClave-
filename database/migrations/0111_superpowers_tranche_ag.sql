-- CodeConClave — Stage 0111 SUPERPOWERS Tranche AG (#153/#154/#156/#157)
-- AMBIENT CODING, INTENT MARKETPLACE, POST-HUMAN HANDOFF, SELF-PLAY ADVERSARIAL TRAINING

-- AMBIENT CODING (#153) — paste an error anywhere, it answers
CREATE TABLE IF NOT EXISTS ambient_sessions (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  trigger_text         TEXT NOT NULL,
  context_path         TEXT NOT NULL DEFAULT '',
  response             TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ANSWERED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ambient_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'ambient_sessions_owner' AND tablename = 'ambient_sessions') THEN CREATE POLICY ambient_sessions_owner ON ambient_sessions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_ambient_sessions_owner ON ambient_sessions(owner_id);

-- INTENT MARKETPLACE (#154) — publish intents, agents bid, you pick
CREATE TABLE IF NOT EXISTS intent_bids (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  intent_text          TEXT NOT NULL,
  agent_name           TEXT NOT NULL DEFAULT '',
  approach             TEXT NOT NULL DEFAULT '',
  impact_score         INTEGER NOT NULL DEFAULT 0,
  confidence           REAL NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','SELECTED','WITHDRAWN')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE intent_bids ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'intent_bids_owner' AND tablename = 'intent_bids') THEN CREATE POLICY intent_bids_owner ON intent_bids USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_intent_bids_owner ON intent_bids(owner_id);

-- POST-HUMAN HANDOFF (#156) — agent continues when human sleeps
CREATE TABLE IF NOT EXISTS post_human_handoffs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  branch_name          TEXT NOT NULL,
  last_thought         TEXT NOT NULL,
  agent_continuation   TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONTINUED','REVIEWED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE post_human_handoffs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'post_human_handoffs_owner' AND tablename = 'post_human_handoffs') THEN CREATE POLICY post_human_handoffs_owner ON post_human_handoffs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_post_human_handoffs_owner ON post_human_handoffs(owner_id);

-- SELF-PLAY ADVERSARIAL TRAINING (#157) — agents attack and defend your codebase
CREATE TABLE IF NOT EXISTS self_play_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  attack_vector        TEXT NOT NULL,
  defense_used         TEXT NOT NULL DEFAULT '',
  vulnerability_found  TEXT NOT NULL DEFAULT '',
  severity             TEXT NOT NULL DEFAULT 'NONE' CHECK (severity IN ('NONE','LOW','MEDIUM','HIGH','CRITICAL')),
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE self_play_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'self_play_runs_owner' AND tablename = 'self_play_runs') THEN CREATE POLICY self_play_runs_owner ON self_play_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_self_play_runs_owner ON self_play_runs(owner_id);
