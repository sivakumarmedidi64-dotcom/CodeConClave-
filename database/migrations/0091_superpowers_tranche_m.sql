-- CodeConClave — Stage 0091 SUPERPOWERS Tranche M (Swarm, Zero-Inbox, Night Shift, Release Commander, Firewall Drill)

-- SWARM — parallel tasks with shared Memory Gravity
CREATE TABLE IF NOT EXISTS swarm_runs (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  goal       TEXT NOT NULL,
  context_scope TEXT NOT NULL DEFAULT 'codebase',
  status     TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  task_count INTEGER NOT NULL DEFAULT 5,
  completed_count INTEGER NOT NULL DEFAULT 0,
  shared_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
  results    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE swarm_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'swarm_runs_owner' AND tablename = 'swarm_runs') THEN CREATE POLICY swarm_runs_owner ON swarm_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_swarm_runs_owner ON swarm_runs(owner_id);

-- ZERO-INBOX — triaged notifications + morning digest
CREATE TABLE IF NOT EXISTS zero_inbox_digests (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  period        TEXT NOT NULL,
  total_issues  INTEGER NOT NULL DEFAULT 0,
  fixes_ready   INTEGER NOT NULL DEFAULT 0,
  waiting       INTEGER NOT NULL DEFAULT 0,
  escalations   INTEGER NOT NULL DEFAULT 0,
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE zero_inbox_digests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'zero_inbox_digests_owner' AND tablename = 'zero_inbox_digests') THEN CREATE POLICY zero_inbox_digests_owner ON zero_inbox_digests USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_zero_inbox_digests_owner ON zero_inbox_digests(owner_id);

-- NIGHT SHIFT — off-hours unsupervised task execution
CREATE TABLE IF NOT EXISTS night_shift_runs (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  window_start    TEXT NOT NULL,
  window_end      TEXT NOT NULL,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed    INTEGER NOT NULL DEFAULT 0,
  changes_made    JSONB NOT NULL DEFAULT '[]'::jsonb,
  report          TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','RUNNING','COMPLETED','FAILED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE night_shift_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'night_shift_runs_owner' AND tablename = 'night_shift_runs') THEN CREATE POLICY night_shift_runs_owner ON night_shift_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_night_shift_runs_owner ON night_shift_runs(owner_id);

-- RELEASE COMMANDER — owns the release train
CREATE TABLE IF NOT EXISTS release_captain_runs (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  milestone          TEXT NOT NULL,
  release_branch     TEXT NOT NULL DEFAULT '',
  features_frozen    BOOLEAN NOT NULL DEFAULT false,
  cherry_picks       JSONB NOT NULL DEFAULT '[]'::jsonb,
  hotfix_lanes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollback_drill_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','FEATURE_FROZEN','RELEASED','HOTFIX','ROLLED_BACK')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE release_captain_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'release_captain_runs_owner' AND tablename = 'release_captain_runs') THEN CREATE POLICY release_captain_runs_owner ON release_captain_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_release_captain_runs_owner ON release_captain_runs(owner_id);

-- FIREWALL DRILL — chaos engineering
CREATE TABLE IF NOT EXISTS firewall_drill_runs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  drill_type       TEXT NOT NULL DEFAULT 'comprehensive',
  scenarios        JSONB NOT NULL DEFAULT '[]'::jsonb,
  resilience_score NUMERIC NOT NULL DEFAULT 0,
  fix_list         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','FAILED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE firewall_drill_runs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'firewall_drill_runs_owner' AND tablename = 'firewall_drill_runs') THEN CREATE POLICY firewall_drill_runs_owner ON firewall_drill_runs USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_firewall_drill_runs_owner ON firewall_drill_runs(owner_id);
