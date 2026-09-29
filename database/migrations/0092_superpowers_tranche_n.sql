-- CodeConClave — Stage 0092 SUPERPOWERS Tranche N (Auto-Divergence, Mirror World, Tribunal)

-- AUTO-DIVERGENCE — spots hand-fixing the coworker can finish, learns from yes/no
CREATE TABLE IF NOT EXISTS divergence_sessions (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  verb          TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT '',
  observed_count INTEGER NOT NULL DEFAULT 1,
  remaining_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPLIED','DISMISSED')),
  accepted      BOOLEAN,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE divergence_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'divergence_sessions_owner' AND tablename = 'divergence_sessions') THEN CREATE POLICY divergence_sessions_owner ON divergence_sessions USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_divergence_sessions_owner ON divergence_sessions(owner_id);

CREATE TABLE IF NOT EXISTS divergence_preferences (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  verb         TEXT NOT NULL,
  affinity     REAL NOT NULL DEFAULT 0.5 CHECK (affinity >= 0 AND affinity <= 1),
  record_count INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE divergence_preferences ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'divergence_preferences_owner' AND tablename = 'divergence_preferences') THEN CREATE POLICY divergence_preferences_owner ON divergence_preferences USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_divergence_preferences_owner ON divergence_preferences(owner_id);

-- MIRROR WORLD — "what if..." runs on a sandboxed clone with real numbers
CREATE TABLE IF NOT EXISTS mirror_world_runs (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  question    TEXT NOT NULL,
  scenario    TEXT NOT NULL CHECK (scenario IN ('traffic','dependency')),
  parameter   REAL NOT NULL,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  error_rate  REAL NOT NULL DEFAULT 0,
  cpu_pct     INTEGER NOT NULL DEFAULT 0,
  memory_mb   INTEGER NOT NULL DEFAULT 0,
  verdict     TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mirror_world_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'mirror_world_runs_owner' AND tablename = 'mirror_world_runs') THEN CREATE POLICY mirror_world_runs_owner ON mirror_world_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_mirror_world_runs_owner ON mirror_world_runs(owner_id);

-- TRIBUNAL — multi-model wisdom, judge is the test suite
CREATE TABLE IF NOT EXISTS tribunal_hearings (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  change      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DELIBERATING' CHECK (status IN ('DELIBERATING','RESOLVED')),
  models      JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidates  JSONB NOT NULL DEFAULT '[]'::jsonb,
  verdict     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tribunal_hearings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tribunal_hearings_owner' AND tablename = 'tribunal_hearings') THEN CREATE POLICY tribunal_hearings_owner ON tribunal_hearings USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_tribunal_hearings_owner ON tribunal_hearings(owner_id);

CREATE TABLE IF NOT EXISTS tribunal_lessons (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  change        TEXT NOT NULL,
  losing_models JSONB NOT NULL DEFAULT '[]'::jsonb,
  lesson        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tribunal_lessons ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tribunal_lessons_owner' AND tablename = 'tribunal_lessons') THEN CREATE POLICY tribunal_lessons_owner ON tribunal_lessons USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_tribunal_lessons_owner ON tribunal_lessons(owner_id);