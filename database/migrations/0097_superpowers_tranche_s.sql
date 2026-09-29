-- CodeConClave — Stage 0097 SUPERPOWERS Tranche S (Focus Guard, Voice to Task, Requirement X-Ray, Scope Bouncer, User Story Forge)

-- FOCUS GUARD — deep work detected, non-urgent questions held until you surface
CREATE TABLE IF NOT EXISTS focus_guards (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  activity     TEXT NOT NULL,
  intensity    INTEGER NOT NULL DEFAULT 0,
  held         INTEGER NOT NULL DEFAULT 0,
  urgent_out   INTEGER NOT NULL DEFAULT 0,
  digest       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'GUARDED' CHECK (status IN ('GUARDED','RELEASED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE focus_guards ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'focus_guards_owner' AND tablename = 'focus_guards') THEN CREATE POLICY focus_guards_owner ON focus_guards USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_focus_guards_owner ON focus_guards(owner_id);

-- VOICE TO TASK — dictate from your phone, enters the same queue as a typed instruction
CREATE TABLE IF NOT EXISTS voice_tasks (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  script       TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'voice',
  status       TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','STARTED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE voice_tasks ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'voice_tasks_owner' AND tablename = 'voice_tasks') THEN CREATE POLICY voice_tasks_owner ON voice_tasks USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_voice_tasks_owner ON voice_tasks(owner_id);

-- REQUIREMENT X-RAY — the 40 hidden sub-requirements behind every "small" request
CREATE TABLE IF NOT EXISTS requirement_xrays (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  request      TEXT NOT NULL,
  implications JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE requirement_xrays ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'requirement_xrays_owner' AND tablename = 'requirement_xrays') THEN CREATE POLICY requirement_xrays_owner ON requirement_xrays USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_requirement_xrays_owner ON requirement_xrays(owner_id);

-- SCOPE BOUNCER — scope creep detected mid-implementation, flagged with cost
CREATE TABLE IF NOT EXISTS scope_bounces (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  title            TEXT NOT NULL,
  planned_files    INTEGER NOT NULL DEFAULT 0,
  planned_migrations INTEGER NOT NULL DEFAULT 0,
  flagged          INTEGER NOT NULL DEFAULT 0,
  cost             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SETTLED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE scope_bounces ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'scope_bounces_owner' AND tablename = 'scope_bounces') THEN CREATE POLICY scope_bounces_owner ON scope_bounces USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_scope_bounces_owner ON scope_bounces(owner_id);

-- USER STORY FORGE — vague goals into testable stories with executable acceptance criteria
CREATE TABLE IF NOT EXISTS story_forges (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  goal       TEXT NOT NULL,
  story      TEXT NOT NULL,
  tests      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE story_forges ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'story_forges_owner' AND tablename = 'story_forges') THEN CREATE POLICY story_forges_owner ON story_forges USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_story_forges_owner ON story_forges(owner_id);