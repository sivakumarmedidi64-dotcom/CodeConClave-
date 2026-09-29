-- 0065: PKG-23 Memory-Powered Coding.
-- Additive. Adds developer-facing coding memory records ON TOP of the existing
-- persistent memory system (memories), workspace state, runtime execution records
-- and release/deployment records — it does NOT create a second memory database.
--
-- dev_preferences   : explicit/inferred/unknown developer preferences with
--                     precedence (explicit overrides inferred, never silently).
-- dev_patterns      : evidence-backed learned development patterns (C-4
--                     Cross-Cowork Pattern Learning). A pattern only becomes a
--                     rule with sufficient evidence or explicit confirmation —
--                     never from a single observation. app/confirm counters.
-- dev_bug_incidents : recurring-bug association (evidence-backed links to the
--                     historical runtime/execution/smoke/deployment evidence that
--                     supports each occurrence). No fabricated causality.
-- memorycoding_links: evidence-backed connection records (e.g. deployment ->
--                     rollback -> subsequent fix, runtime failure -> fix) used by
--                     deployment memory / test+runtime memory. Nothing is invented.
--
-- All tables are owner_scoped AND project/team scoped; never persisted with
-- secrets (callers MUST redact before insert via the code-redaction guard).

-- Developer preferences with explicit/inferred classification.
CREATE TABLE IF NOT EXISTS dev_preferences (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL,
  project_id    text REFERENCES projects(id),
  category      text NOT NULL,
  key           text NOT NULL,
  value         jsonb NOT NULL,
  classification text NOT NULL DEFAULT 'INFERRED'
                 CHECK (classification IN ('EXPLICIT','INFERRED','UNKNOWN')),
  confidence    numeric(6,3) NOT NULL DEFAULT 0.5,
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, project_id, category, key)
);
CREATE INDEX IF NOT EXISTS idx_dev_prefs_owner ON dev_preferences (owner_id, updated_at DESC);

-- Evidence-backed learned development patterns (Cross-Cowork Pattern Learning).
CREATE TABLE IF NOT EXISTS dev_patterns (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL,
  project_id    text REFERENCES projects(id),
  name          text NOT NULL,
  description   text NOT NULL,
  category      text,
  evidence_count integer NOT NULL DEFAULT 0,
  confirm_count  integer NOT NULL DEFAULT 0,
  reject_count   integer NOT NULL DEFAULT 0,
  confidence    numeric(6,3) NOT NULL DEFAULT 0,
  source        text NOT NULL DEFAULT 'OBSERVED',
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','SUPERSEDED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dev_patterns_owner ON dev_patterns (owner_id, evidence_count DESC, updated_at DESC);

-- Recurring bug / debugging-memory association records.
CREATE TABLE IF NOT EXISTS dev_bug_incidents (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL,
  project_id    text NOT NULL REFERENCES projects(id),
  title         text NOT NULL,
  symptom_key   text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  occurrences   integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','FIXED','SUPERSEDED')),
  diagnosis     text,
  fix_summary   text,
  test_ref      text,
  deploy_ref    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dev_bug_owner ON dev_bug_incidents (owner_id, project_id, symptom_key);

-- Evidence-backed connection records for deployment memory / test+runtime memory.
CREATE TABLE IF NOT EXISTS memorycoding_links (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL,
  project_id    text NOT NULL REFERENCES projects(id),
  kind          text NOT NULL CHECK (kind IN
                 ('DEPLOYMENT_ROLLBACK','ROLLBACK_TARGET','DEPLOYMENT_FIX',
                  'RUNTIME_FIX','TEST_RELATED','BUG_RELATED')),
  from_ref      text NOT NULL,
  to_ref        text NOT NULL,
  evidence      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mclink_owner ON memorycoding_links (owner_id, project_id, kind, created_at DESC);
