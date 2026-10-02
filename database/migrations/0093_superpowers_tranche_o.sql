-- CodeConClave — Stage 0093 SUPERPOWERS Tranche O (Root Cause Oracle, Ghost Writer, Time Traveler, Code Court, Silence Breaker)

-- ROOT CAUSE ORACLE — symptom -> causal chain -> true origin
CREATE TABLE IF NOT EXISTS causal_chains (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  symptom     TEXT NOT NULL,
  chain       JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence  REAL NOT NULL DEFAULT 0,
  ruled_out   JSONB NOT NULL DEFAULT '[]'::jsonb,
  verdict     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE causal_chains ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'causal_chains_owner' AND tablename = 'causal_chains') THEN CREATE POLICY causal_chains_owner ON causal_chains USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_causal_chains_owner ON causal_chains(owner_id);

-- GHOST WRITER — parallel shadow implementation with A/B benchmark
CREATE TABLE IF NOT EXISTS ghost_writes (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  module        TEXT NOT NULL,
  alternative   TEXT NOT NULL,
  branch        TEXT NOT NULL,
  verdict       TEXT,
  latency_before  INTEGER,
  latency_after   INTEGER,
  throughput_before INTEGER,
  throughput_after  INTEGER,
  complexity_delta INTEGER NOT NULL DEFAULT 0,
  maintenance_delta INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'DRAFTED' CHECK (status IN ('DRAFTED','BENCHMARKED','SHIPPED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ghost_writes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'ghost_writes_owner' AND tablename = 'ghost_writes') THEN CREATE POLICY ghost_writes_owner ON ghost_writes USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_ghost_writes_owner ON ghost_writes(owner_id);

-- TIME TRAVELER — reconstructed historical context with diff
CREATE TABLE IF NOT EXISTS time_travel_snapshots (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  ref         TEXT NOT NULL,
  file        TEXT NOT NULL,
  code        TEXT NOT NULL,
  tests       JSONB NOT NULL DEFAULT '[]'::jsonb,
  dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasoning   TEXT NOT NULL DEFAULT '',
  diff        JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE time_travel_snapshots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'time_travel_snapshots_owner' AND tablename = 'time_travel_snapshots') THEN CREATE POLICY time_travel_snapshots_owner ON time_travel_snapshots USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_time_travel_snapshots_owner ON time_travel_snapshots(owner_id);

-- CODE COURT — prosecutor vs defense vs judge, verdict becomes a decision record
CREATE TABLE IF NOT EXISTS code_court_cases (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  proposal    TEXT NOT NULL,
  arguments   JSONB NOT NULL DEFAULT '[]'::jsonb,
  verdict     TEXT NOT NULL,
  ruling      TEXT NOT NULL,
  reasoning   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'RULED' CHECK (status IN ('DELIBERATING','RULED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE code_court_cases ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'code_court_cases_owner' AND tablename = 'code_court_cases') THEN CREATE POLICY code_court_cases_owner ON code_court_cases USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_code_court_cases_owner ON code_court_cases(owner_id);

-- SILENCE BREAKER — stalls found and unblocked
CREATE TABLE IF NOT EXISTS stall_breakouts (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  task         TEXT NOT NULL,
  stalled_days INTEGER NOT NULL DEFAULT 0,
  diagnosis    TEXT NOT NULL,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'MONITORED' CHECK (status IN ('MONITORED','UNBLOCKED','ESCALATED','REASSIGNED','RESOLVED')),
  resolution   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE stall_breakouts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'stall_breakouts_owner' AND tablename = 'stall_breakouts') THEN CREATE POLICY stall_breakouts_owner ON stall_breakouts USING (owner_id = app.uid()); END IF; END $$;
CREATE INDEX IF NOT EXISTS idx_stall_breakouts_owner ON stall_breakouts(owner_id);