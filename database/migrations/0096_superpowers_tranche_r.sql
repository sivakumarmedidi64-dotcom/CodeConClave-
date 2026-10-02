-- CodeConClave — Stage 0096 SUPERPOWERS Tranche R (Focus Forge, Clone Killer, Error Translator, Pair Mirror, Meeting-to-Code)

-- FOCUS FORGE — deep work sessions, protected by the machine itself
CREATE TABLE IF NOT EXISTS focus_sessions (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  activity      TEXT NOT NULL,
  intensity     INTEGER NOT NULL DEFAULT 0,
  held          INTEGER NOT NULL DEFAULT 0,
  breached      INTEGER NOT NULL DEFAULT 0,
  digest        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','SILENCED','DONE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE focus_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'focus_sessions_owner' AND tablename = 'focus_sessions') THEN CREATE POLICY focus_sessions_owner ON focus_sessions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_focus_sessions_owner ON focus_sessions(owner_id);

-- CLONE KILLER — semantic dedup: same skeleton, different names
CREATE TABLE IF NOT EXISTS clone_fragments (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  language      TEXT NOT NULL,
  code          TEXT NOT NULL,
  signature     TEXT NOT NULL,
  abstraction   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE clone_fragments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'clone_fragments_owner' AND tablename = 'clone_fragments') THEN CREATE POLICY clone_fragments_owner ON clone_fragments USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_clone_fragments_owner ON clone_fragments(owner_id);

-- ERROR TRANSLATOR — cryptic errors rewritten into one sentence + exact fix
CREATE TABLE IF NOT EXISTS error_translations (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  raw           TEXT NOT NULL,
  line          TEXT,
  sentence      TEXT NOT NULL,
  fix           TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE error_translations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'error_translations_owner' AND tablename = 'error_translations') THEN CREATE POLICY error_translations_owner ON error_translations USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_error_translations_owner ON error_translations(owner_id);

-- PAIR MIRROR — gently suggests the pattern your team prefers, before you finish the line
CREATE TABLE IF NOT EXISTS pair_hints (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  edit          TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  suggestion    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'GIVEN' CHECK (status IN ('GIVEN','ACKNOWLEDGED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pair_hints ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'pair_hints_owner' AND tablename = 'pair_hints') THEN CREATE POLICY pair_hints_owner ON pair_hints USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_pair_hints_owner ON pair_hints(owner_id);

-- MEETING-TO-CODE — requirements stop dying in meeting notes
CREATE TABLE IF NOT EXISTS meeting_extractions (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  title                TEXT NOT NULL,
  transcript           TEXT NOT NULL,
  issues               JSONB NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria  JSONB NOT NULL DEFAULT '[]'::jsonb,
  tasks                JSONB NOT NULL DEFAULT '[]'::jsonb,
  pr_plan              TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE meeting_extractions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'meeting_extractions_owner' AND tablename = 'meeting_extractions') THEN CREATE POLICY meeting_extractions_owner ON meeting_extractions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_meeting_extractions_owner ON meeting_extractions(owner_id);