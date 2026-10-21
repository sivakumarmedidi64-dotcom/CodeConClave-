-- 0158: Execution pipeline v3 — the verifiable engine.
--   pipeline_runs          one row per objective: hashes, locked budget, the ONE
--                          role that ran, status, proof hash and sealed receipt.
--   pipeline_events        the run's hash-linked stage log (parent hash on every
--                          event, append-only) — reloads rebuild state from it.
--   pipeline_answer_cache  sealed answers keyed by question + file + DNA version
--                          + budget tier + history; a hit streams with 0 tokens.
-- All owner-only under RLS.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       text,
  conversation_id  text,
  task_id          text,
  device_id        text,
  question_hash    text NOT NULL,
  file_hash        text NOT NULL,
  dna_version      text NOT NULL,
  cache_key        text NOT NULL,
  budget_tier      text NOT NULL,
  budget_tokens    integer NOT NULL,
  tokens_used      integer NOT NULL DEFAULT 0,
  lane             text,
  risk             text,
  role             text,
  driver           text,
  contract_version text,
  status           text NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING','KNOWN','VERIFIED','UNVERIFIED','CACHED','DENIED','ESCALATED','NEEDS_BUDGET','HALTED','FAILED')),
  attempts         integer NOT NULL DEFAULT 0,
  proof_hash       text,
  head_hash        text,
  receipt          jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sealed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_owner_created ON pipeline_runs (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_owner_status ON pipeline_runs (owner_id, status);

CREATE TABLE IF NOT EXISTS pipeline_events (
  run_id      text NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  stage       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  parent_hash text NOT NULL,
  event_hash  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS pipeline_answer_cache (
  cache_key  text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id     text,
  final_text text NOT NULL,
  receipt    jsonb NOT NULL,
  hits       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pipeline_cache_expiry ON pipeline_answer_cache (expires_at);

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_runs_owner ON pipeline_runs;
CREATE POLICY pipeline_runs_owner ON pipeline_runs USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());

ALTER TABLE pipeline_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_events_owner ON pipeline_events;
CREATE POLICY pipeline_events_owner ON pipeline_events
  USING (EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = run_id AND r.owner_id = app.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = run_id AND r.owner_id = app.uid()));

ALTER TABLE pipeline_answer_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_answer_cache_owner ON pipeline_answer_cache;
CREATE POLICY pipeline_answer_cache_owner ON pipeline_answer_cache USING (owner_id = app.uid()) WITH CHECK (owner_id = app.uid());
