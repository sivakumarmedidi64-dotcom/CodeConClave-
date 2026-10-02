-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche E): foresight & intelligence cluster.
--
--   TURBO              (feature 16): perf findings with BEFORE/AFTER proof —
--                     a finding is never recorded without both benchmarks.
--   CHRONOS            (feature 17): "why does this codebase work this way?"
--                     answered from stored decision records (reasoning + the
--                     assumptions in force at the decision point).
--   PATTERN PROPHET    (feature 24): team solution-shapes learned once, then
--                     pre-applied to matching triggers; approvals tracked.
--   DECISION REAPER    (feature 25): decisions carry assumptions + author +
--                     date; reaped when an assumption flips or age expires.
--   WHY-WIKI           (feature 28): every non-obvious line gets a linked,
--                     auto-maintained "why" entry with its sourcing.
--
-- Owned rows + RLS identical to 0079/0080/0081/0082 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE performance_findings (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target            text NOT NULL,
  title             text NOT NULL,
  diagnosis         text,
  benchmark_before  numeric(12,3) NOT NULL,
  benchmark_after   numeric(12,3) NOT NULL,
  improvement_pct   numeric(8,2) NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','FIXED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_perf_findings_owner ON performance_findings (owner_id, status, created_at DESC);

ALTER TABLE performance_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY performance_findings_owner ON performance_findings USING (owner_id = app.uid());

CREATE TABLE decision_records (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  area              text NOT NULL,
  subject           text NOT NULL,
  decision          text NOT NULL,
  reasoning         text NOT NULL,
  author            text NOT NULL,
  assumptions       jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','RECONSIDERING','SUPERSEDED')),
  reconsider_ticket text,
  decided_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_decision_records_owner_area ON decision_records (owner_id, area, decided_at DESC);

ALTER TABLE decision_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY decision_records_owner ON decision_records USING (owner_id = app.uid());

CREATE TABLE pattern_signatures (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  trigger_type      text NOT NULL CHECK (trigger_type IN ('SCHEMA_CHANGE','ENDPOINT_ADD','NEW_MODULE','DEPENDENCY_UPGRADE')),
  trigger           text NOT NULL,
  steps             jsonb NOT NULL DEFAULT '[]',
  usage_count       integer NOT NULL DEFAULT 0,
  certified         boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'ENABLED'
                    CHECK (status IN ('ENABLED','DISABLED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pattern_signatures_owner_trigger ON pattern_signatures (owner_id, trigger_type);

ALTER TABLE pattern_signatures ENABLE ROW LEVEL SECURITY;
CREATE POLICY pattern_signatures_owner ON pattern_signatures USING (owner_id = app.uid());

CREATE TABLE why_links  (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  file_path         text NOT NULL,
  line              integer,
  reason            text NOT NULL,
  source_type       text NOT NULL,
  source_ref        text,
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','DETACHED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_why_links_owner_file ON why_links (owner_id, file_path);

ALTER TABLE why_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY why_links_owner ON why_links USING (owner_id = app.uid());