-- ---------------------------------------------------------------------------
-- CodeConClave — 0135 SUPERPOWERS CHAIN CONVERGENCE.
--
-- WHY THIS EXISTS (read before judging this 2500-line file):
--   The production schema_migrations ledger records migrations 0079..0112 as
--   applied, but NONE of the 162 tables those migrations declare were ever
--   created on the production database (the ledger was seeded historically
--   while the schema effects were not). Because migrateUp skips anything the
--   ledger already names, the real DDL for 0079..0112 could never reach the
--   production database again.
--
--   This file re-declares the entire 0079..0112 chain IDEMPOTENTLY:
--     CREATE TABLE IF NOT EXISTS, CREATE INDEX [UNIQUE] IF NOT EXISTS,
--     and DROP POLICY IF EXISTS + CREATE POLICY for every top-level policy.
--   Dollar-quoted DO $$...$$ guards from the original files are preserved
--   verbatim (they were already idempotent). Running it:
--     * on a fresh or verify database  -> every statement no-ops
--     * on the production database     -> creates exactly the 162 missing
--       tables with the same columns, indexes, RLS enablement, and owner
--       policies the original chain declares.
--   Additive, non-destructive, safe on any database in the chain.
--
--   Provenance: verbatim statements from 0079..0112 after the three
--   idempotency transforms above. Statement splitting is quote/dollar-quote/
--   comment aware. Verified by (1) applying cleanly to the freshly-migrated
--   verify database (all no-op) and (2) applying to production (creates the
--   missing tables, no errors). This dependency-ordered replay mirrors the
--   original chain, so cross-file FK references resolve exactly as they do on
--   a fresh migrate.
-- ---------------------------------------------------------------------------

-- ===== 0079_superpowers.sql (converged) =====

CREATE TABLE IF NOT EXISTS proof_claims (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  task_id       text,
  claim         text NOT NULL,
  subject       text,
  evidence_kind text NOT NULL DEFAULT 'NONE'
                CHECK (evidence_kind IN ('TEST_RUN','BENCHMARK','LOG','ARTIFACT','SCREENSHOT','NONE')),
  evidence_ref  text,
  verdict       text NOT NULL DEFAULT 'UNVERIFIED'
                CHECK (verdict IN ('VERIFIED','PARTIAL','UNVERIFIED')),
  why_trace     jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proof_claims_owner ON proof_claims (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proof_claims_task ON proof_claims (task_id);

ALTER TABLE proof_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS proof_claims_owner ON proof_claims;
CREATE POLICY proof_claims_owner ON proof_claims USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS echo_lessons (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  module_scope  text NOT NULL DEFAULT 'GLOBAL',
  label         text NOT NULL,
  lesson        text NOT NULL,
  source        text NOT NULL DEFAULT 'CORRECTION'
                CHECK (source IN ('CORRECTION','OVERRIDE','REVIEW')),
  applied_count integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_echo_lessons_owner_scope ON echo_lessons (owner_id, module_scope, created_at DESC);

ALTER TABLE echo_lessons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS echo_lessons_owner ON echo_lessons;
CREATE POLICY echo_lessons_owner ON echo_lessons USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS warden_policies (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       text REFERENCES projects(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  forbidden_imports jsonb NOT NULL DEFAULT '[]',
  required_imports jsonb NOT NULL DEFAULT '[]',
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warden_policies_owner ON warden_policies (owner_id, created_at DESC);

ALTER TABLE warden_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warden_policies_owner ON warden_policies;
CREATE POLICY warden_policies_owner ON warden_policies USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS spec_entries (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text REFERENCES projects(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('ENDPOINT','ENV_VAR','SLA')),
  name            text NOT NULL,
  expectation     text,
  status          text NOT NULL DEFAULT 'UNCHECKED'
                  CHECK (status IN ('UNCHECKED','OK','DRIFT')),
  evidence        jsonb NOT NULL DEFAULT '{}',
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spec_entries_owner ON spec_entries (owner_id, created_at DESC);

ALTER TABLE spec_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS spec_entries_owner ON spec_entries;
CREATE POLICY spec_entries_owner ON spec_entries USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS task_checkpoint_manifests (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id       text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  label         text,
  manifest      jsonb NOT NULL DEFAULT '{}',
  forked_from   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoint_manifests_owner_task ON task_checkpoint_manifests (owner_id, task_id, created_at DESC);

ALTER TABLE task_checkpoint_manifests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_checkpoints_owner ON task_checkpoint_manifests;

DROP POLICY IF EXISTS task_checkpoint_manifests_owner ON task_checkpoint_manifests;
CREATE POLICY task_checkpoint_manifests_owner ON task_checkpoint_manifests USING (owner_id = app.uid());

-- ===== 0080_superpowers_live.sql (converged) =====

CREATE TABLE IF NOT EXISTS agent_events (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  task_id       text NOT NULL,
  run_id        text,
  seq           bigserial NOT NULL,
  kind          text NOT NULL
                CHECK (kind IN ('task_created','file_changed','comment','checkpoint_created','fix_requested','intent_detected')),
  path          text,
  patch         text,
  payload       jsonb NOT NULL DEFAULT '{}',
  source_uid    text,                
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_owner_task ON agent_events (owner_id, task_id, seq);

CREATE INDEX IF NOT EXISTS idx_agent_events_owner_seq ON agent_events (owner_id, seq);

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_events_owner ON agent_events;
CREATE POLICY agent_events_owner ON agent_events USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS fix_tickets (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  source        text NOT NULL
                CHECK (source IN ('ci_failure','sentry_error','preview_broken','deploy_failed','manual')),
  issue         text NOT NULL,
  ref           text,                
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','IN_REPRODUCTION','FIX_PROPOSED','PR_OPENED','RESOLVED','SUPERSEDED')),
  title         text,
  error_snippet text,
  pr_url        text,
  proof_claim_id text REFERENCES proof_claims(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fix_tickets_owner ON fix_tickets (owner_id, status, created_at DESC);

ALTER TABLE fix_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fix_tickets_owner ON fix_tickets;
CREATE POLICY fix_tickets_owner ON fix_tickets USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS intent_drafts (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  file          text NOT NULL,
  intent        text NOT NULL,           
  language      text NOT NULL DEFAULT 'javascript',
  generated     jsonb NOT NULL DEFAULT '{}',   
  comment_marker text,                   
  status        text NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','APPLIED','DISMISSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intent_drafts_owner ON intent_drafts (owner_id, status, created_at DESC);

ALTER TABLE intent_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intent_drafts_owner ON intent_drafts;
CREATE POLICY intent_drafts_owner ON intent_drafts USING (owner_id = app.uid());

-- ===== 0081_fresh_eyes.sql (converged) =====

CREATE TABLE IF NOT EXISTS fresh_eyes_reviews (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    text REFERENCES projects(id) ON DELETE CASCADE,
  task_id       text,
  file          text,
  input         text NOT NULL,                
  findings      jsonb NOT NULL DEFAULT '[]',  
  verdict       text NOT NULL
                CHECK (verdict IN ('CLEAN', 'FLAGGED')),
  outside_perspective text NOT NULL,          
  inside_perspective  text,                   
  proof_claim_id text REFERENCES proof_claims(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fresh_eyes_owner ON fresh_eyes_reviews (owner_id, status, created_at DESC);

ALTER TABLE fresh_eyes_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fresh_eyes_reviews_owner ON fresh_eyes_reviews;
CREATE POLICY fresh_eyes_reviews_owner ON fresh_eyes_reviews USING (owner_id = app.uid());

-- ===== 0082_superpowers_intel.sql (converged) =====

CREATE TABLE IF NOT EXISTS replay_sessions (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  task_id           text NOT NULL,
  base_seq          bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','ARCHIVED')),
  note              text,
  forked_from_task  text,
  forked_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replay_sessions_owner ON replay_sessions (owner_id, created_at DESC);

ALTER TABLE replay_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS replay_sessions_owner ON replay_sessions;
CREATE POLICY replay_sessions_owner ON replay_sessions USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS risk_scores (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target_type       text NOT NULL CHECK (target_type IN ('FILE','FUNCTION','MODULE')),
  target_path       text NOT NULL,
  complexity_score  numeric(5,2) NOT NULL,
  churn_score       numeric(5,2) NOT NULL,
  failure_links     integer NOT NULL DEFAULT 0,
  risk_score        numeric(5,2) NOT NULL,
  risk_band         text NOT NULL CHECK (risk_band IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  reasons           jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, target_type, target_path)
);

CREATE INDEX IF NOT EXISTS idx_risk_scores_owner_band ON risk_scores (owner_id, risk_band);

ALTER TABLE risk_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS risk_scores_owner ON risk_scores;
CREATE POLICY risk_scores_owner ON risk_scores USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS anomaly_scans (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target_type       text NOT NULL CHECK (target_type IN ('CODE','TEST','DOC')),
  target_path       text,
  verdict           text NOT NULL CHECK (verdict IN ('CLEAN','FLAGGED')),
  findings          jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_scans_owner ON anomaly_scans (owner_id, status, created_at DESC);

ALTER TABLE anomaly_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anomaly_scans_owner ON anomaly_scans;
CREATE POLICY anomaly_scans_owner ON anomaly_scans USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS standup_reports (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  report_date       date NOT NULL,
  summary           jsonb NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PUBLISHED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, report_date)
);

ALTER TABLE standup_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS standup_reports_owner ON standup_reports;
CREATE POLICY standup_reports_owner ON standup_reports USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS health_signals (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  scope             text NOT NULL DEFAULT 'PROJECT',
  verdict           text NOT NULL CHECK (verdict IN ('GREEN','YELLOW','RED')),
  components        jsonb NOT NULL DEFAULT '{}',
  evidence          jsonb NOT NULL DEFAULT '[]',
  computed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, scope)
);

ALTER TABLE health_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS health_signals_owner ON health_signals;
CREATE POLICY health_signals_owner ON health_signals USING (owner_id = app.uid());

-- ===== 0083_superpowers_foresight.sql (converged) =====

CREATE TABLE IF NOT EXISTS performance_findings (
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

CREATE INDEX IF NOT EXISTS idx_perf_findings_owner ON performance_findings (owner_id, status, created_at DESC);

ALTER TABLE performance_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS performance_findings_owner ON performance_findings;
CREATE POLICY performance_findings_owner ON performance_findings USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS decision_records (
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

CREATE INDEX IF NOT EXISTS idx_decision_records_owner_area ON decision_records (owner_id, area, decided_at DESC);

ALTER TABLE decision_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS decision_records_owner ON decision_records;
CREATE POLICY decision_records_owner ON decision_records USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS pattern_signatures (
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

CREATE INDEX IF NOT EXISTS idx_pattern_signatures_owner_trigger ON pattern_signatures (owner_id, trigger_type);

ALTER TABLE pattern_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pattern_signatures_owner ON pattern_signatures;
CREATE POLICY pattern_signatures_owner ON pattern_signatures USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS why_links  (
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

CREATE INDEX IF NOT EXISTS idx_why_links_owner_file ON why_links (owner_id, file_path);

ALTER TABLE why_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS why_links_owner ON why_links;
CREATE POLICY why_links_owner ON why_links USING (owner_id = app.uid());

-- ===== 0084_superpowers_security.sql (converged) =====

CREATE TABLE IF NOT EXISTS flake_investigations (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target            text NOT NULL,
  source            text,
  category          text NOT NULL
                    CHECK (category IN ('TIME_DEPENDENCE','RANDOM_SEED','ORDER_DEPENDENCE','NETWORK_RELIANCE','UNKNOWN')),
  evidence          text,
  root_cause        text,
  fix               text,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','FIXED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flake_investigations_owner ON flake_investigations (owner_id, status, created_at DESC);

ALTER TABLE flake_investigations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flake_investigations_owner ON flake_investigations;
CREATE POLICY flake_investigations_owner ON flake_investigations USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS package_evaluations (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  name              text NOT NULL,
  published_days_ago integer NOT NULL DEFAULT 0,
  last_commit_days_ago integer NOT NULL DEFAULT 0,
  maintainer_count  integer NOT NULL DEFAULT 0,
  has_install_script boolean NOT NULL DEFAULT false,
  author_unknown    boolean NOT NULL DEFAULT false,
  verdict           text NOT NULL CHECK (verdict IN ('APPROVE','SANDBOX','BLOCK')),
  reasons           jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

ALTER TABLE package_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS package_evaluations_owner ON package_evaluations;
CREATE POLICY package_evaluations_owner ON package_evaluations USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS pii_findings (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target_path       text NOT NULL,
  location_type     text NOT NULL
                    CHECK (location_type IN ('STORAGE','LOG_SINK','API_RESPONSE','DATABASE')),
  pii_types         jsonb NOT NULL DEFAULT '[]',
  content_sample    text,
  status            text NOT NULL DEFAULT 'TRACKED'
                    CHECK (status IN ('TRACKED','REMEDIATED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pii_findings_owner ON pii_findings (owner_id, status);

ALTER TABLE pii_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pii_findings_owner ON pii_findings;
CREATE POLICY pii_findings_owner ON pii_findings USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS secret_incidents (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  secret_name       text NOT NULL,
  detection_source  text NOT NULL
                    CHECK (detection_source IN ('COMMIT','LOG','TICKET','ENV','SCREENSHOT')),
  first_seen        timestamptz NOT NULL DEFAULT now(),
  systems_affected  jsonb NOT NULL DEFAULT '[]',
  exposure_notes    text,
  rotation_status   text NOT NULL DEFAULT 'PENDING'
                    CHECK (rotation_status IN ('PENDING','ROTATED')),
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','RESOLVED')),
  rotated_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_secret_incidents_owner ON secret_incidents (owner_id, status);

ALTER TABLE secret_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS secret_incidents_owner ON secret_incidents;
CREATE POLICY secret_incidents_owner ON secret_incidents USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS injection_events (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  surface           text NOT NULL
                    CHECK (surface IN ('ISSUE','WEBPAGE','DEPENDENCY','PDF','LOG','COMMENT')),
  content_snapshot  text,
  methods           jsonb NOT NULL DEFAULT '[]',
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','NEUTRALIZED','IGNORED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_injection_events_owner ON injection_events (owner_id, status, created_at DESC);

ALTER TABLE injection_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS injection_events_owner ON injection_events;
CREATE POLICY injection_events_owner ON injection_events USING (owner_id = app.uid());

-- ===== 0085_superpowers_memory.sql (converged) =====

CREATE TABLE IF NOT EXISTS postmortems (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  incident_id       text,
  title             text NOT NULL,
  summary           text NOT NULL,
  timeline          text,
  root_cause        text NOT NULL,
  fix               text NOT NULL,
  prevention        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, incident_id)
);

CREATE INDEX IF NOT EXISTS idx_postmortems_owner ON postmortems (owner_id, created_at DESC);

ALTER TABLE postmortems ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS postmortems_owner ON postmortems;
CREATE POLICY postmortems_owner ON postmortems USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS ontology_terms (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_name    text NOT NULL,
  aliases           jsonb NOT NULL DEFAULT '[]',
  definition        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, canonical_name)
);

ALTER TABLE ontology_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ontology_terms_owner ON ontology_terms;
CREATE POLICY ontology_terms_owner ON ontology_terms USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS ontology_violations (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id           text NOT NULL REFERENCES ontology_terms(id) ON DELETE CASCADE,
  source_type       text NOT NULL
                    CHECK (source_type IN ('CODE','DOCS','API','UI_COPY')),
  location          text NOT NULL,
  used_term         text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ontology_violations_owner ON ontology_violations (owner_id, status);

ALTER TABLE ontology_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ontology_violations_owner ON ontology_violations;
CREATE POLICY ontology_violations_owner ON ontology_violations USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS codebase_answers (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question          text NOT NULL,
  answer            text NOT NULL,
  evidence_sources  jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_codebase_answers_owner ON codebase_answers (owner_id, created_at DESC);

ALTER TABLE codebase_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS codebase_answers_owner ON codebase_answers;
CREATE POLICY codebase_answers_owner ON codebase_answers USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS file_origin_insights (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  file_path         text NOT NULL,
  function_name     text NOT NULL,
  first_seen_commit text NOT NULL,
  first_seen_date   timestamptz,
  author            text NOT NULL,
  pr_summary        text,
  context           text,
  depth             integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, file_path, function_name)
);

CREATE INDEX IF NOT EXISTS idx_file_origin_insights_owner ON file_origin_insights (owner_id, file_path);

ALTER TABLE file_origin_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS file_origin_insights_owner ON file_origin_insights;
CREATE POLICY file_origin_insights_owner ON file_origin_insights USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS skill_signals (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  developer         text NOT NULL,
  skill             text NOT NULL,
  domain            text NOT NULL DEFAULT 'GENERAL',
  weight            integer NOT NULL DEFAULT 1,
  source            text NOT NULL
                    CHECK (source IN ('COMMIT','REVIEW','CORRECTION')),
  evidence_ref      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, developer, skill, source)
);

CREATE INDEX IF NOT EXISTS idx_skill_signals_owner ON skill_signals (owner_id, skill);

ALTER TABLE skill_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS skill_signals_owner ON skill_signals;
CREATE POLICY skill_signals_owner ON skill_signals USING (owner_id = app.uid());

-- ===== 0086_superpowers_governance.sql (converged) =====

CREATE TABLE IF NOT EXISTS red_cell_findings (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  target            text NOT NULL,
  category          text NOT NULL
                    CHECK (category IN ('SQL_INJECTION','XSS','CODE_INJECTION','COMMAND_INJECTION','HARDCODED_SECRET','UNSAFE_EVAL')),
  severity          text NOT NULL
                    CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  confirmed         boolean NOT NULL DEFAULT false,
  risk_score        integer NOT NULL DEFAULT 0,
  code_snippet      text,
  suggestion        text,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','ACKNOWLEDGED','CLEARED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_red_cell_findings_owner ON red_cell_findings (owner_id, risk_score DESC);

ALTER TABLE red_cell_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS red_cell_findings_owner ON red_cell_findings;
CREATE POLICY red_cell_findings_owner ON red_cell_findings USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS coverage_scans (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  files_scanned     integer NOT NULL DEFAULT 0,
  gap_count         integer NOT NULL DEFAULT 0,
  generated_targets jsonb NOT NULL DEFAULT '[]',
  accepted_tests    jsonb NOT NULL DEFAULT '[]',
  rejected_targets  integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'GENERATED'
                    CHECK (status IN ('GENERATED','ACCEPTED','REJECTED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_scans_owner ON coverage_scans (owner_id, created_at DESC);

ALTER TABLE coverage_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coverage_scans_owner ON coverage_scans;
CREATE POLICY coverage_scans_owner ON coverage_scans USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS diplomat_dependencies (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_name      text NOT NULL,
  current_version   text NOT NULL,
  latest_version    text NOT NULL,
  cves              jsonb NOT NULL DEFAULT '[]',
  breaking_changes  text,
  freshness         text NOT NULL DEFAULT 'CURRENT'
                    CHECK (freshness IN ('CURRENT','OUTDATED','AHEAD')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, package_name)
);

CREATE INDEX IF NOT EXISTS idx_diplomat_deps_owner ON diplomat_dependencies (owner_id, freshness);

ALTER TABLE diplomat_dependencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS diplomat_dependencies_owner ON diplomat_dependencies;
CREATE POLICY diplomat_dependencies_owner ON diplomat_dependencies USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS diplomat_upgrades (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dependency_id     text NOT NULL REFERENCES diplomat_dependencies(id) ON DELETE CASCADE,
  from_version      text NOT NULL,
  to_version        text NOT NULL,
  cve_count         integer NOT NULL DEFAULT 0,
  test_outcome      text NOT NULL
                    CHECK (test_outcome IN ('PASS','FAIL')),
  status            text NOT NULL
                    CHECK (status IN ('SURFACED','ROLLED_BACK')),
  breakage_report   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_diplomat_upgrades_owner ON diplomat_upgrades (owner_id, created_at DESC);

ALTER TABLE diplomat_upgrades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS diplomat_upgrades_owner ON diplomat_upgrades;
CREATE POLICY diplomat_upgrades_owner ON diplomat_upgrades USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS api_contracts (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  version           text NOT NULL,
  endpoints         jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_api_contracts_owner ON api_contracts (owner_id, name);

ALTER TABLE api_contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_contracts_owner ON api_contracts;
CREATE POLICY api_contracts_owner ON api_contracts USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS contract_checks (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id       text NOT NULL REFERENCES api_contracts(id) ON DELETE CASCADE,
  verdict           text NOT NULL
                    CHECK (verdict IN ('COMPLIANT','NON_BREAKING_DRIFT','BREAKING')),
  breaking_issues   jsonb NOT NULL DEFAULT '[]',
  warning_issues    jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_checks_owner ON contract_checks (owner_id, contract_id);

ALTER TABLE contract_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contract_checks_owner ON contract_checks;
CREATE POLICY contract_checks_owner ON contract_checks USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS dependency_insights (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_name      text NOT NULL,
  profile           jsonb NOT NULL DEFAULT '{}',
  risk_score        integer NOT NULL DEFAULT 0,
  risk_level        text NOT NULL
                    CHECK (risk_level IN ('CRITICAL','HIGH','MODERATE','LOW')),
  recommendations   jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, package_name)
);

CREATE INDEX IF NOT EXISTS idx_dependency_insights_owner ON dependency_insights (owner_id, risk_level);

ALTER TABLE dependency_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dependency_insights_owner ON dependency_insights;
CREATE POLICY dependency_insights_owner ON dependency_insights USING (owner_id = app.uid());

-- ===== 0087_superpowers_governance2.sql (converged) =====

CREATE TABLE IF NOT EXISTS adversarial_runs (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  change_ref        text NOT NULL,
  verdict           text NOT NULL DEFAULT 'PASS'
                    CHECK (verdict IN ('PASS','BLOCKED')),
  findings          jsonb NOT NULL DEFAULT '[]',
  generated_attacks jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adversarial_runs_owner ON adversarial_runs (owner_id, created_at DESC);

ALTER TABLE adversarial_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adversarial_runs_owner ON adversarial_runs;
CREATE POLICY adversarial_runs_owner ON adversarial_runs USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS mutation_sweeps (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  targets           integer NOT NULL DEFAULT 0,
  sensitive         integer NOT NULL DEFAULT 0,
  hollow            integer NOT NULL DEFAULT 0,
  accepted          jsonb NOT NULL DEFAULT '[]',
  rejected          jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mutation_sweeps_owner ON mutation_sweeps (owner_id, created_at DESC);

ALTER TABLE mutation_sweeps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mutation_sweeps_owner ON mutation_sweeps;
CREATE POLICY mutation_sweeps_owner ON mutation_sweeps USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS shadow_runs (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  release_ref       text NOT NULL,
  mirrored          integer NOT NULL DEFAULT 0,
  mismatches        integer NOT NULL DEFAULT 0,
  verdict           text NOT NULL DEFAULT 'PASS'
                    CHECK (verdict IN ('PASS','BLOCKED')),
  mismatches_detail jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_runs_owner ON shadow_runs (owner_id, created_at DESC);

ALTER TABLE shadow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shadow_runs_owner ON shadow_runs;
CREATE POLICY shadow_runs_owner ON shadow_runs USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS privilege_flags (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        text REFERENCES projects(id) ON DELETE CASCADE,
  principal         text NOT NULL,
  resource          text NOT NULL,
  action            text NOT NULL,
  scope             text NOT NULL,
  severity          text NOT NULL
                    CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  minimal_rewrite   text NOT NULL,
  status            text NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','SHRUNK')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_privilege_flags_owner ON privilege_flags (owner_id, status);

ALTER TABLE privilege_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS privilege_flags_owner ON privilege_flags;
CREATE POLICY privilege_flags_owner ON privilege_flags USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS sandbox_policies (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name        text NOT NULL,
  egress_allowlist  jsonb NOT NULL DEFAULT '[]',
  fs_jail_root      text NOT NULL,
  credentials_vault boolean NOT NULL DEFAULT true,
  syscall_logging   boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_policies_owner ON sandbox_policies (owner_id, agent_name);

ALTER TABLE sandbox_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sandbox_policies_owner ON sandbox_policies;
CREATE POLICY sandbox_policies_owner ON sandbox_policies USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS sandbox_actions (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id         text NOT NULL REFERENCES sandbox_policies(id) ON DELETE CASCADE,
  run_ref           text NOT NULL,
  kind              text NOT NULL
                    CHECK (kind IN ('NETWORK_CALL','FILE_ACCESS','CREDENTIAL_READ','SYS_CALL')),
  target            text NOT NULL,
  decision          text NOT NULL
                    CHECK (decision IN ('ALLOWED','BLOCKED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sandbox_actions_owner ON sandbox_actions (owner_id, run_ref);

ALTER TABLE sandbox_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sandbox_actions_owner ON sandbox_actions;
CREATE POLICY sandbox_actions_owner ON sandbox_actions USING (owner_id = app.uid());

-- ===== 0088_superpowers_team.sql (converged) =====

CREATE TABLE IF NOT EXISTS bus_factor_alarms (
  id                  text PRIMARY KEY,
  owner_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id          text REFERENCES projects(id) ON DELETE CASCADE,
  module              text NOT NULL,
  total_contributors  integer NOT NULL,
  active_contributors integer NOT NULL,
  span_days           integer NOT NULL,
  severity            text NOT NULL
                      CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  knowledge_transfer  jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','CLEARED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bus_factor_alarms_owner ON bus_factor_alarms (owner_id, status);

ALTER TABLE bus_factor_alarms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bus_factor_alarms_owner ON bus_factor_alarms;
CREATE POLICY bus_factor_alarms_owner ON bus_factor_alarms USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS review_assignments (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       text REFERENCES projects(id) ON DELETE CASCADE,
  module           text NOT NULL,
  selected_reviewer text NOT NULL,
  expertise_score  integer NOT NULL,
  open_load        integer NOT NULL DEFAULT 0,
  ranking          jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_assignments_owner ON review_assignments (owner_id, created_at DESC);

ALTER TABLE review_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_assignments_owner ON review_assignments;
CREATE POLICY review_assignments_owner ON review_assignments USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS pairing_schedules (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text REFERENCES projects(id) ON DELETE CASCADE,
  task            text NOT NULL,
  complexity      text NOT NULL
                  CHECK (complexity IN ('SIMPLE','MODERATE','COMPLEX','CRITICAL')),
  senior          text NOT NULL,
  junior          text NOT NULL,
  pairing_reason  jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'SCHEDULED'
                  CHECK (status IN ('SCHEDULED','ACCEPTED','COMPLETED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pairing_schedules_owner ON pairing_schedules (owner_id, status);

ALTER TABLE pairing_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pairing_schedules_owner ON pairing_schedules;
CREATE POLICY pairing_schedules_owner ON pairing_schedules USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS onboarding_roadmaps (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  text REFERENCES projects(id) ON DELETE CASCADE,
  role        text NOT NULL,
  team        text NOT NULL,
  seniority   text NOT NULL
              CHECK (seniority IN ('JUNIOR','MID','SENIOR')),
  days        integer NOT NULL DEFAULT 5,
  tasks       jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_roadmaps_owner ON onboarding_roadmaps (owner_id, created_at DESC);

ALTER TABLE onboarding_roadmaps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_roadmaps_owner ON onboarding_roadmaps;
CREATE POLICY onboarding_roadmaps_owner ON onboarding_roadmaps USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS async_decisions (
  id              text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      text REFERENCES projects(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text NOT NULL,
  options         jsonb NOT NULL DEFAULT '[]',
  evidence        jsonb NOT NULL DEFAULT '[]',
  voters          jsonb NOT NULL DEFAULT '[]',
  votes           jsonb NOT NULL DEFAULT '[]',
  dissents        jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','DECIDED','CLOSED')),
  resolved_option text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_async_decisions_owner ON async_decisions (owner_id, status);

ALTER TABLE async_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS async_decisions_owner ON async_decisions;
CREATE POLICY async_decisions_owner ON async_decisions USING (owner_id = app.uid());

-- ===== 0089_superpowers_team2.sql (converged) =====

CREATE TABLE IF NOT EXISTS knowledge_exports (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person      text NOT NULL,
  scope       text NOT NULL DEFAULT 'FULL'
              CHECK (scope IN ('FULL','ESSENTIAL')),
  modules     jsonb NOT NULL DEFAULT '[]',
  decisions   jsonb NOT NULL DEFAULT '[]',
  corrections jsonb NOT NULL DEFAULT '[]',
  digest      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_exports_owner ON knowledge_exports (owner_id, created_at DESC);

ALTER TABLE knowledge_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_exports_owner ON knowledge_exports;
CREATE POLICY knowledge_exports_owner ON knowledge_exports USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS review_load_plans (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  text REFERENCES projects(id) ON DELETE CASCADE,
  item_count  integer NOT NULL DEFAULT 0,
  assigned    integer NOT NULL DEFAULT 0,
  plan        jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_load_plans_owner ON review_load_plans (owner_id, created_at DESC);

ALTER TABLE review_load_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_load_plans_owner ON review_load_plans;
CREATE POLICY review_load_plans_owner ON review_load_plans USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS performance_digests (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person      text NOT NULL,
  period      text NOT NULL,
  metrics     jsonb NOT NULL DEFAULT '{}',
  score       integer NOT NULL DEFAULT 0,
  tier        text NOT NULL,
  narrative   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_performance_digests_owner ON performance_digests (owner_id, person);

ALTER TABLE performance_digests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS performance_digests_owner ON performance_digests;
CREATE POLICY performance_digests_owner ON performance_digests USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS team_cost_attributions (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team        text NOT NULL,
  period      text NOT NULL,
  task        text NOT NULL,
  resource    text NOT NULL,
  cost_usd    numeric NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  share       numeric NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_cost_attributions_owner ON team_cost_attributions (owner_id, team);

ALTER TABLE team_cost_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_cost_attributions_owner ON team_cost_attributions;
CREATE POLICY team_cost_attributions_owner ON team_cost_attributions USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS equity_scores (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period            text NOT NULL,
  name              text NOT NULL,
  visible           integer NOT NULL DEFAULT 0,
  invisible         integer NOT NULL DEFAULT 0,
  invisible_share   numeric NOT NULL DEFAULT 0,
  tier              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equity_scores_owner ON equity_scores (owner_id, period);

ALTER TABLE equity_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS equity_scores_owner ON equity_scores;
CREATE POLICY equity_scores_owner ON equity_scores USING (owner_id = app.uid());

-- ===== 0090_superpowers_autonomy.sql (converged) =====

CREATE TABLE IF NOT EXISTS autopilot_runs (
  id          text PRIMARY KEY,
  owner_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal        text NOT NULL,
  node_count  integer NOT NULL DEFAULT 0,
  executed    integer NOT NULL DEFAULT 0,
  retries     integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'COMPLETE'
              CHECK (status IN ('COMPLETE','FAILED')),
  summary     text NOT NULL DEFAULT '',
  diff        text NOT NULL DEFAULT '',
  test_results jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_runs_owner ON autopilot_runs (owner_id, created_at DESC);

ALTER TABLE autopilot_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopilot_runs_owner ON autopilot_runs;
CREATE POLICY autopilot_runs_owner ON autopilot_runs USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS phoenix_cycles (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pipeline     text NOT NULL,
  commit       text NOT NULL,
  failure      text NOT NULL,
  env          jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'REPRODUCED'
               CHECK (status IN ('REPRODUCED','FIX_READY','SUITE_GREEN','PR_OPENED')),
  fix          text,
  suite_result text,
  pr_number    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phoenix_cycles_owner ON phoenix_cycles (owner_id, pipeline);

ALTER TABLE phoenix_cycles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS phoenix_cycles_owner ON phoenix_cycles;
CREATE POLICY phoenix_cycles_owner ON phoenix_cycles USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS launch_releases (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      text NOT NULL,
  bump         text NOT NULL DEFAULT 'none'
               CHECK (bump IN ('major','minor','patch','none')),
  notes        text NOT NULL DEFAULT '',
  changes      jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'PLANNED'
               CHECK (status IN ('PLANNED','DEPLOYED','ROLLED_BACK')),
  deployed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_launch_releases_owner ON launch_releases (owner_id, created_at DESC);

ALTER TABLE launch_releases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS launch_releases_owner ON launch_releases;
CREATE POLICY launch_releases_owner ON launch_releases USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS autopsy_incidents (
  id             text PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  incident       text NOT NULL,
  window_seconds integer NOT NULL DEFAULT 900,
  status         text NOT NULL DEFAULT 'DRAFTED'
                 CHECK (status IN ('DRAFTED','PROPOSED','RESOLVED')),
  suspects       jsonb NOT NULL DEFAULT '[]',
  timeline       jsonb NOT NULL DEFAULT '[]',
  confidence     numeric NOT NULL DEFAULT 0,
  postmortem     text NOT NULL DEFAULT '',
  proposed_fix   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autopsy_incidents_owner ON autopsy_incidents (owner_id, created_at DESC);

ALTER TABLE autopsy_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopsy_incidents_owner ON autopsy_incidents;
CREATE POLICY autopsy_incidents_owner ON autopsy_incidents USING (owner_id = app.uid());

CREATE TABLE IF NOT EXISTS self_heal_scans (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  diff              text NOT NULL,
  matched_signature text,
  score             integer NOT NULL DEFAULT 0,
  likely_fix        text,
  action            text NOT NULL
                    CHECK (action IN ('PREEMPTED','CLEAN')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_self_heal_scans_owner ON self_heal_scans (owner_id, created_at DESC);

ALTER TABLE self_heal_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS self_heal_scans_owner ON self_heal_scans;
CREATE POLICY self_heal_scans_owner ON self_heal_scans USING (owner_id = app.uid());

-- ===== 0091_superpowers_tranche_m.sql (converged) =====

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

-- ===== 0092_superpowers_tranche_n.sql (converged) =====

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

-- ===== 0093_superpowers_tranche_o.sql (converged) =====

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

-- ===== 0094_superpowers_tranche_p.sql (converged) =====

CREATE TABLE IF NOT EXISTS institutional_exports (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  engineer    TEXT NOT NULL,
  exports     JSONB NOT NULL DEFAULT '{}'::jsonb,
  highlights  JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DRAFTED' CHECK (status IN ('DRAFTED','PACKAGED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE institutional_exports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'institutional_exports_owner' AND tablename = 'institutional_exports') THEN CREATE POLICY institutional_exports_owner ON institutional_exports USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_institutional_exports_owner ON institutional_exports(owner_id);

CREATE TABLE IF NOT EXISTS context_compressions (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  topic        TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  density      INTEGER NOT NULL DEFAULT 0,
  summary      TEXT NOT NULL,
  citations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE context_compressions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'context_compressions_owner' AND tablename = 'context_compressions') THEN CREATE POLICY context_compressions_owner ON context_compressions USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_context_compressions_owner ON context_compressions(owner_id);

CREATE TABLE IF NOT EXISTS concept_gap_scans (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  concept        TEXT NOT NULL,
  aliases        JSONB NOT NULL DEFAULT '[]'::jsonb,
  locations      JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_count   INTEGER NOT NULL DEFAULT 0,
  unification    TEXT NOT NULL,
  migration_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'FOUND' CHECK (status IN ('FOUND','UNIFYING','RESOLVED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE concept_gap_scans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'concept_gap_scans_owner' AND tablename = 'concept_gap_scans') THEN CREATE POLICY concept_gap_scans_owner ON concept_gap_scans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_concept_gap_scans_owner ON concept_gap_scans(owner_id);

CREATE TABLE IF NOT EXISTS negotiation_drafts (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  requirement    TEXT NOT NULL,
  conflict       TEXT NOT NULL DEFAULT '',
  interpretations JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended    TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED')),
  resolution     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE negotiation_drafts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'negotiation_drafts_owner' AND tablename = 'negotiation_drafts') THEN CREATE POLICY negotiation_drafts_owner ON negotiation_drafts USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_negotiation_drafts_owner ON negotiation_drafts(owner_id);

CREATE TABLE IF NOT EXISTS memory_exports (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  components   JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats        JSONB NOT NULL DEFAULT '[]'::jsonb,
  archive_ref  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'EXPORTED' CHECK (status IN ('EXPORTED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memory_exports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'memory_exports_owner' AND tablename = 'memory_exports') THEN CREATE POLICY memory_exports_owner ON memory_exports USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_memory_exports_owner ON memory_exports(owner_id);

-- ===== 0095_superpowers_tranche_q.sql (converged) =====

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

-- ===== 0096_superpowers_tranche_r.sql (converged) =====

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

-- ===== 0097_superpowers_tranche_s.sql (converged) =====

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

-- ===== 0098_superpowers_tranche_t.sql (converged) =====

CREATE TABLE IF NOT EXISTS impact_radar (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  area       TEXT NOT NULL,
  metric     TEXT NOT NULL,
  delta      INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE impact_radar ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'impact_radar_owner' AND tablename = 'impact_radar') THEN CREATE POLICY impact_radar_owner ON impact_radar USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_impact_radar_owner ON impact_radar(owner_id);

CREATE TABLE IF NOT EXISTS churn_events (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  locale      TEXT NOT NULL,
  action      TEXT NOT NULL,
  signal      TEXT NOT NULL CHECK (signal IN ('rage_click','error_loop','form_abandoned')),
  occurrences INTEGER NOT NULL DEFAULT 1,
  fix_draft   TEXT,
  status      TEXT NOT NULL DEFAULT 'WATCHED' CHECK (status IN ('WATCHED','DRAFTED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE churn_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'churn_events_owner' AND tablename = 'churn_events') THEN CREATE POLICY churn_events_owner ON churn_events USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_churn_events_owner ON churn_events(owner_id);

CREATE TABLE IF NOT EXISTS onboarding_sims (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  profile    TEXT NOT NULL,
  difficulty INTEGER NOT NULL DEFAULT 5,
  steps      JSONB NOT NULL DEFAULT '[]'::jsonb,
  tickets    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'PLAYING' CHECK (status IN ('PLAYING','COMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE onboarding_sims ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'onboarding_sims_owner' AND tablename = 'onboarding_sims') THEN CREATE POLICY onboarding_sims_owner ON onboarding_sims USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_onboarding_sims_owner ON onboarding_sims(owner_id);

CREATE TABLE IF NOT EXISTS zero_to_prod (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  idea       TEXT NOT NULL,
  stages     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE zero_to_prod ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'zero_to_prod_owner' AND tablename = 'zero_to_prod') THEN CREATE POLICY zero_to_prod_owner ON zero_to_prod USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_zero_to_prod_owner ON zero_to_prod(owner_id);

CREATE TABLE IF NOT EXISTS policy_copilots (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  policy      TEXT NOT NULL,
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE policy_copilots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'policy_copilots_owner' AND tablename = 'policy_copilots') THEN CREATE POLICY policy_copilots_owner ON policy_copilots USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_policy_copilots_owner ON policy_copilots(owner_id);

-- ===== 0099_superpowers_tranche_u.sql (converged) =====

CREATE TABLE IF NOT EXISTS product_challenges (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  idea       TEXT NOT NULL,
  tracks     JSONB NOT NULL DEFAULT '[]'::jsonb,
  defense    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE product_challenges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'product_challenges_owner' AND tablename = 'product_challenges') THEN CREATE POLICY product_challenges_owner ON product_challenges USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_product_challenges_owner ON product_challenges(owner_id);

CREATE TABLE IF NOT EXISTS codebase_shares (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  project        TEXT NOT NULL,
  pitch          TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL,
  question_count INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'LIVE' CHECK (status IN ('LIVE','EXPIRED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE codebase_shares ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'codebase_shares_owner' AND tablename = 'codebase_shares') THEN CREATE POLICY codebase_shares_owner ON codebase_shares USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_codebase_shares_owner ON codebase_shares(owner_id);

CREATE INDEX IF NOT EXISTS idx_codebase_shares_token ON codebase_shares(token);

CREATE TABLE IF NOT EXISTS cost_estimates (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  context    TEXT NOT NULL,
  component  TEXT NOT NULL CHECK (component IN ('feature','scale','storage')),
  units      NUMERIC NOT NULL DEFAULT 0,
  traffic    TEXT NOT NULL DEFAULT '',
  delta      NUMERIC NOT NULL DEFAULT 0,
  badge      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cost_estimates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cost_estimates_owner' AND tablename = 'cost_estimates') THEN CREATE POLICY cost_estimates_owner ON cost_estimates USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_cost_estimates_owner ON cost_estimates(owner_id);

CREATE TABLE IF NOT EXISTS cost_thermometers (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  total_delta NUMERIC NOT NULL DEFAULT 0,
  temperature TEXT NOT NULL DEFAULT 'cool' CHECK (temperature IN ('cool','warm','hot','boiling')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cost_thermometers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cost_thermometers_owner' AND tablename = 'cost_thermometers') THEN CREATE POLICY cost_thermometers_owner ON cost_thermometers USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_cost_thermometers_owner ON cost_thermometers(owner_id);

CREATE TABLE IF NOT EXISTS drift_reports (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  drifts     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLEAN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE drift_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'drift_reports_owner' AND tablename = 'drift_reports') THEN CREATE POLICY drift_reports_owner ON drift_reports USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_drift_reports_owner ON drift_reports(owner_id);

-- ===== 0100_superpowers_tranche_v.sql (converged) =====

CREATE TABLE IF NOT EXISTS capacity_forecasts (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  component            TEXT NOT NULL,
  capacity             NUMERIC NOT NULL DEFAULT 0,
  usage                NUMERIC NOT NULL DEFAULT 0,
  growth_per_day       NUMERIC NOT NULL DEFAULT 0,
  days_to_exhaustion   INTEGER,
  fix_size             INTEGER NOT NULL DEFAULT 0,
  monthly_cost         NUMERIC NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'OK' CHECK (status IN ('OK','CRITICAL','EXHAUSTED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE capacity_forecasts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'capacity_forecasts_owner' AND tablename = 'capacity_forecasts') THEN CREATE POLICY capacity_forecasts_owner ON capacity_forecasts USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_capacity_forecasts_owner ON capacity_forecasts(owner_id);

CREATE TABLE IF NOT EXISTS env_clones (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  source         TEXT NOT NULL,
  target         TEXT NOT NULL,
  rows_cloned    INTEGER NOT NULL DEFAULT 0,
  anonymized     BOOLEAN NOT NULL DEFAULT false,
  anonymized_rows INTEGER NOT NULL DEFAULT 0,
  elapsed_minutes INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE env_clones ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'env_clones_owner' AND tablename = 'env_clones') THEN CREATE POLICY env_clones_owner ON env_clones USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_env_clones_owner ON env_clones(owner_id);

CREATE TABLE IF NOT EXISTS runbook_runs (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  alert       TEXT NOT NULL,
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed   INTEGER NOT NULL DEFAULT 0,
  blocked     INTEGER NOT NULL DEFAULT 0,
  confidence  NUMERIC NOT NULL DEFAULT 0.95,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'EXECUTING' CHECK (status IN ('EXECUTING','ESCALATED','RESOLVED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE runbook_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'runbook_runs_owner' AND tablename = 'runbook_runs') THEN CREATE POLICY runbook_runs_owner ON runbook_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_runbook_runs_owner ON runbook_runs(owner_id);

CREATE TABLE IF NOT EXISTS backup_checks (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  target       TEXT NOT NULL,
  schedule     TEXT NOT NULL DEFAULT 'daily 0200',
  status       TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','VERIFIED','BROKEN')),
  checks_passed BOOLEAN,
  verdict      TEXT,
  last_check   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE backup_checks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'backup_checks_owner' AND tablename = 'backup_checks') THEN CREATE POLICY backup_checks_owner ON backup_checks USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_backup_checks_owner ON backup_checks(owner_id);

CREATE TABLE IF NOT EXISTS network_edges (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, src, dst)
);

ALTER TABLE network_edges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'network_edges_owner' AND tablename = 'network_edges') THEN CREATE POLICY network_edges_owner ON network_edges USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_network_edges_owner ON network_edges(owner_id);

-- ===== 0101_superpowers_tranche_w.sql (converged) =====

CREATE TABLE IF NOT EXISTS infra_architect_plans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  request              TEXT NOT NULL,
  resource_type        TEXT NOT NULL DEFAULT 'generic',
  estimated_changes    JSONB NOT NULL DEFAULT '[]'::jsonb,
  iac_diff             TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','VALIDATED','APPLIED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE infra_architect_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'infra_architect_plans_owner' AND tablename = 'infra_architect_plans') THEN CREATE POLICY infra_architect_plans_owner ON infra_architect_plans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_infra_architect_plans_owner ON infra_architect_plans(owner_id);

CREATE TABLE IF NOT EXISTS regression_radar_entries (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  module               TEXT NOT NULL,
  issue_description    TEXT NOT NULL,
  root_cause           TEXT NOT NULL DEFAULT '',
  fix_description      TEXT NOT NULL DEFAULT '',
  fix_worked           BOOLEAN NOT NULL DEFAULT false,
  severity             TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  reported_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  fixed_at             TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE regression_radar_entries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'regression_radar_entries_owner' AND tablename = 'regression_radar_entries') THEN CREATE POLICY regression_radar_entries_owner ON regression_radar_entries USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_regression_radar_entries_owner ON regression_radar_entries(owner_id);

CREATE INDEX IF NOT EXISTS idx_regression_radar_entries_module ON regression_radar_entries(owner_id, module);

-- ===== 0102_superpowers_tranche_x.sql (converged) =====

CREATE TABLE IF NOT EXISTS incident_orch_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  incident             TEXT NOT NULL,
  log_spike            TEXT NOT NULL,
  agent_investigation  TEXT,
  postmortem_draft     TEXT,
  fix_pr_url           TEXT,
  status               TEXT NOT NULL DEFAULT 'INVESTIGATING' CHECK (status IN ('INVESTIGATING','POSTMORTEM_DRAFTED','FIX_PROPOSED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE incident_orch_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'incident_orch_runs_owner' AND tablename = 'incident_orch_runs') THEN CREATE POLICY incident_orch_runs_owner ON incident_orch_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_incident_orch_runs_owner ON incident_orch_runs(owner_id);

CREATE TABLE IF NOT EXISTS network_policies (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  agent_name       TEXT NOT NULL,
  allowed_domains  JSONB NOT NULL DEFAULT '[]'::jsonb,
  rate_limit       INTEGER NOT NULL DEFAULT 100,
  calls_made       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXHAUSTED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE network_policies ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'network_policies_owner' AND tablename = 'network_policies') THEN CREATE POLICY network_policies_owner ON network_policies USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_network_policies_owner ON network_policies(owner_id);

CREATE TABLE IF NOT EXISTS framework_bridges (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  source_framework  TEXT NOT NULL,
  target_framework  TEXT NOT NULL,
  steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps_applied     INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','APPLYING','READY','VERIFIED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE framework_bridges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'framework_bridges_owner' AND tablename = 'framework_bridges') THEN CREATE POLICY framework_bridges_owner ON framework_bridges USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_framework_bridges_owner ON framework_bridges(owner_id);

CREATE TABLE IF NOT EXISTS language_ferries (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  source_language   TEXT NOT NULL,
  target_language   TEXT NOT NULL,
  source_code       TEXT NOT NULL,
  target_code       TEXT,
  test_harness      JSONB NOT NULL DEFAULT '[]'::jsonb,
  tests_passed      INTEGER NOT NULL DEFAULT 0,
  total_tests       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RUNNING','VERIFIED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE language_ferries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'language_ferries_owner' AND tablename = 'language_ferries') THEN CREATE POLICY language_ferries_owner ON language_ferries USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_language_ferries_owner ON language_ferries(owner_id);

CREATE TABLE IF NOT EXISTS monolith_surgeries (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  monolith_name       TEXT NOT NULL,
  cut_line            TEXT NOT NULL,
  services            JSONB NOT NULL DEFAULT '[]'::jsonb,
  services_extracted  INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','EXTRACTING','DONE')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE monolith_surgeries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'monolith_surgeries_owner' AND tablename = 'monolith_surgeries') THEN CREATE POLICY monolith_surgeries_owner ON monolith_surgeries USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_monolith_surgeries_owner ON monolith_surgeries(owner_id);

-- ===== 0103_superpowers_tranche_y.sql (converged) =====

CREATE TABLE IF NOT EXISTS db_brain_surgeries (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  table_name           TEXT NOT NULL,
  cycle                TEXT NOT NULL DEFAULT 'EXPAND' CHECK (cycle IN ('EXPAND','MIGRATE','CONTRACT')),
  dual_write_active    BOOLEAN NOT NULL DEFAULT false,
  backfill_verified    BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','DUAL_WRITE','CONTRACTING','DONE','ROLLED_BACK')),
  rollback_plan        TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE db_brain_surgeries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'db_brain_surgeries_owner' AND tablename = 'db_brain_surgeries') THEN CREATE POLICY db_brain_surgeries_owner ON db_brain_surgeries USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_db_brain_surgeries_owner ON db_brain_surgeries(owner_id);

CREATE TABLE IF NOT EXISTS test_conversions (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  source_framework     TEXT NOT NULL,
  target_framework     TEXT NOT NULL,
  source_test_path     TEXT NOT NULL,
  target_test_path     TEXT NOT NULL,
  coverage_match       BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','CONVERTING','VERIFYING','DONE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE test_conversions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'test_conversions_owner' AND tablename = 'test_conversions') THEN CREATE POLICY test_conversions_owner ON test_conversions USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_test_conversions_owner ON test_conversions(owner_id);

CREATE TABLE IF NOT EXISTS legacy_wrappers (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  legacy_system        TEXT NOT NULL,
  interface_type       TEXT NOT NULL,
  endpoint             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE legacy_wrappers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'legacy_wrappers_owner' AND tablename = 'legacy_wrappers') THEN CREATE POLICY legacy_wrappers_owner ON legacy_wrappers USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_legacy_wrappers_owner ON legacy_wrappers(owner_id);

CREATE TABLE IF NOT EXISTS dependency_bridges (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  package_name         TEXT NOT NULL,
  from_version         TEXT NOT NULL,
  to_version           TEXT NOT NULL,
  breaking_changes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_verified      BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','MIGRATING','VERIFYING','DONE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dependency_bridges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dependency_bridges_owner' AND tablename = 'dependency_bridges') THEN CREATE POLICY dependency_bridges_owner ON dependency_bridges USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_dependency_bridges_owner ON dependency_bridges(owner_id);

CREATE TABLE IF NOT EXISTS perf_migrations (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  source_pattern       TEXT NOT NULL,
  target_pattern       TEXT NOT NULL,
  before_score         NUMERIC NOT NULL DEFAULT 0,
  after_score          NUMERIC,
  status               TEXT NOT NULL DEFAULT 'PLANNING' CHECK (status IN ('PLANNING','MIGRATING','REPORTING','DONE')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE perf_migrations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'perf_migrations_owner' AND tablename = 'perf_migrations') THEN CREATE POLICY perf_migrations_owner ON perf_migrations USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_perf_migrations_owner ON perf_migrations(owner_id);

-- ===== 0104_superpowers_tranche_z.sql (converged) =====

CREATE TABLE IF NOT EXISTS schema_migration_plans (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  table_name       TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('expand','backfill','contract')),
  sql_up           TEXT NOT NULL,
  sql_down         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','EXPANDING','BACKFILLING','CONTRACTING','COMPLETED','ROLLED_BACK')),
  rolled_back_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE schema_migration_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'schema_migration_plans_owner' AND tablename = 'schema_migration_plans') THEN CREATE POLICY schema_migration_plans_owner ON schema_migration_plans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_schema_migration_plans_owner ON schema_migration_plans(owner_id);

CREATE TABLE IF NOT EXISTS api_version_bridges (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  old_version       TEXT NOT NULL,
  new_version       TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  mapping           JSONB NOT NULL DEFAULT '[]'::jsonb,
  deprecation_date  TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEPRECATED','REMOVED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE api_version_bridges ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'api_version_bridges_owner' AND tablename = 'api_version_bridges') THEN CREATE POLICY api_version_bridges_owner ON api_version_bridges USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_api_version_bridges_owner ON api_version_bridges(owner_id);

CREATE TABLE IF NOT EXISTS data_migrations (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  source_table    TEXT NOT NULL,
  target_table    TEXT NOT NULL,
  transform_rule  TEXT NOT NULL,
  sample_size     INTEGER NOT NULL DEFAULT 100,
  rows_affected   INTEGER NOT NULL DEFAULT 0,
  verified        BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','SAMPLED','RUNNING','VERIFIED','FAILED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE data_migrations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'data_migrations_owner' AND tablename = 'data_migrations') THEN CREATE POLICY data_migrations_owner ON data_migrations USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_data_migrations_owner ON data_migrations(owner_id);

CREATE TABLE IF NOT EXISTS config_migrations (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  config_keys       JSONB NOT NULL DEFAULT '[]'::jsonb,
  traffic_split_pct INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','MIGRATING','COMPLETED','ROLLED_BACK')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE config_migrations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'config_migrations_owner' AND tablename = 'config_migrations') THEN CREATE POLICY config_migrations_owner ON config_migrations USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_config_migrations_owner ON config_migrations(owner_id);

CREATE TABLE IF NOT EXISTS design_police_reports (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  screen_path      TEXT NOT NULL,
  violations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  component_misuse JSONB NOT NULL DEFAULT '[]'::jsonb,
  spacing_issues   JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_issues     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','FIXED','IGNORED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE design_police_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'design_police_reports_owner' AND tablename = 'design_police_reports') THEN CREATE POLICY design_police_reports_owner ON design_police_reports USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_design_police_reports_owner ON design_police_reports(owner_id);

-- ===== 0105_superpowers_tranche_aa.sql (converged) =====

CREATE TABLE IF NOT EXISTS state_matrix_runs (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  component     TEXT NOT NULL,
  states_tested JSONB NOT NULL DEFAULT '[]'::jsonb,
  passed        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  failures      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','PASSED','FAILED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE state_matrix_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'state_matrix_runs_owner' AND tablename = 'state_matrix_runs') THEN CREATE POLICY state_matrix_runs_owner ON state_matrix_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_state_matrix_runs_owner ON state_matrix_runs(owner_id);

CREATE TABLE IF NOT EXISTS pixel_diffs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  baseline_url         TEXT NOT NULL,
  current_url          TEXT NOT NULL,
  total_pixels_changed INTEGER NOT NULL DEFAULT 0,
  layout_breaking      BOOLEAN NOT NULL DEFAULT false,
  semantic_change      BOOLEAN NOT NULL DEFAULT false,
  threshold_px         INTEGER NOT NULL DEFAULT 2,
  verdict              TEXT NOT NULL DEFAULT 'CLEAN' CHECK (verdict IN ('CLEAN','WARNING','BREAKING')),
  diff_regions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pixel_diffs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'pixel_diffs_owner' AND tablename = 'pixel_diffs') THEN CREATE POLICY pixel_diffs_owner ON pixel_diffs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_pixel_diffs_owner ON pixel_diffs(owner_id);

CREATE TABLE IF NOT EXISTS motion_audits (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  animation_name   TEXT NOT NULL,
  fps              NUMERIC NOT NULL DEFAULT 0,
  duration_ms      NUMERIC NOT NULL DEFAULT 0,
  issues           JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_severity TEXT NOT NULL DEFAULT 'NONE' CHECK (overall_severity IN ('NONE','LOW','MEDIUM','HIGH')),
  status           TEXT NOT NULL DEFAULT 'AUDITED' CHECK (status IN ('AUDITED','FLAGGED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE motion_audits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'motion_audits_owner' AND tablename = 'motion_audits') THEN CREATE POLICY motion_audits_owner ON motion_audits USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_motion_audits_owner ON motion_audits(owner_id);

CREATE TABLE IF NOT EXISTS a11y_runs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  target_url       TEXT NOT NULL,
  pages_scanned    INTEGER NOT NULL DEFAULT 0,
  navigation_path  JSONB NOT NULL DEFAULT '[]'::jsonb,
  issues           JSONB NOT NULL DEFAULT '[]'::jsonb,
  issue_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'NAVIGATING' CHECK (status IN ('NAVIGATING','COMPLETED','BLOCKED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE a11y_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'a11y_runs_owner' AND tablename = 'a11y_runs') THEN CREATE POLICY a11y_runs_owner ON a11y_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_a11y_runs_owner ON a11y_runs(owner_id);

CREATE TABLE IF NOT EXISTS localization_scans (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  project          TEXT NOT NULL,
  locales          JSONB NOT NULL DEFAULT '[]'::jsonb,
  strings_scanned  INTEGER NOT NULL DEFAULT 0,
  issues           JSONB NOT NULL DEFAULT '[]'::jsonb,
  issue_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'SCANNING' CHECK (status IN ('SCANNING','COMPLETED','HAS_ISSUES')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE localization_scans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'localization_scans_owner' AND tablename = 'localization_scans') THEN CREATE POLICY localization_scans_owner ON localization_scans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_localization_scans_owner ON localization_scans(owner_id);

-- ===== 0106_superpowers_tranche_ab.sql (converged) =====

CREATE TABLE IF NOT EXISTS dead_components (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component_name   TEXT NOT NULL,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','REMOVED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dead_components ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dead_components_owner' AND tablename = 'dead_components') THEN CREATE POLICY dead_components_owner ON dead_components USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_dead_components_owner ON dead_components(owner_id);

CREATE TABLE IF NOT EXISTS responsive_generations (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  breakpoints      JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_layout TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE responsive_generations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'responsive_generations_owner' AND tablename = 'responsive_generations') THEN CREATE POLICY responsive_generations_owner ON responsive_generations USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_responsive_generations_owner ON responsive_generations(owner_id);

CREATE TABLE IF NOT EXISTS interaction_specs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  description      TEXT NOT NULL,
  states           JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'DEFINED' CHECK (status IN ('DEFINED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE interaction_specs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'interaction_specs_owner' AND tablename = 'interaction_specs') THEN CREATE POLICY interaction_specs_owner ON interaction_specs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_interaction_specs_owner ON interaction_specs(owner_id);

CREATE TABLE IF NOT EXISTS form_builds (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  form_name        TEXT NOT NULL,
  fields           JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_code   TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE form_builds ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'form_builds_owner' AND tablename = 'form_builds') THEN CREATE POLICY form_builds_owner ON form_builds USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_form_builds_owner ON form_builds(owner_id);

CREATE TABLE IF NOT EXISTS theme_violations (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  component        TEXT NOT NULL,
  violation_type   TEXT NOT NULL,
  severity         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','FIXED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE theme_violations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'theme_violations_owner' AND tablename = 'theme_violations') THEN CREATE POLICY theme_violations_owner ON theme_violations USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_theme_violations_owner ON theme_violations(owner_id);

-- ===== 0107_superpowers_tranche_ac.sql (converged) =====

CREATE TABLE IF NOT EXISTS component_catalogue_entries (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  component_name       TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  props                JSONB NOT NULL DEFAULT '[]'::jsonb,
  states               JSONB NOT NULL DEFAULT '[]'::jsonb,
  accessibility_notes  TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'PARSED' CHECK (status IN ('PARSED','PUBLISHED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE component_catalogue_entries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'component_catalogue_entries_owner' AND tablename = 'component_catalogue_entries') THEN CREATE POLICY component_catalogue_entries_owner ON component_catalogue_entries USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_component_catalogue_entries_owner ON component_catalogue_entries(owner_id);

CREATE TABLE IF NOT EXISTS query_whisperer_plans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  query_text           TEXT NOT NULL,
  execution_plan       TEXT NOT NULL DEFAULT '',
  rewritten_query      TEXT NOT NULL DEFAULT '',
  improvement_pct      NUMERIC NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'EXPLAINED' CHECK (status IN ('EXPLAINED','REWRITTEN')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE query_whisperer_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'query_whisperer_plans_owner' AND tablename = 'query_whisperer_plans') THEN CREATE POLICY query_whisperer_plans_owner ON query_whisperer_plans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_query_whisperer_plans_owner ON query_whisperer_plans(owner_id);

CREATE TABLE IF NOT EXISTS data_doctor_scans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  scan_name            TEXT NOT NULL,
  target_table         TEXT NOT NULL,
  issues_found         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               TEXT NOT NULL DEFAULT 'SCAN_RUN' CHECK (status IN ('SCAN_RUN','ISSUES_FLAGGED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE data_doctor_scans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'data_doctor_scans_owner' AND tablename = 'data_doctor_scans') THEN CREATE POLICY data_doctor_scans_owner ON data_doctor_scans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_data_doctor_scans_owner ON data_doctor_scans(owner_id);

CREATE TABLE IF NOT EXISTS schema_time_machine_snapshots (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  schema_name          TEXT NOT NULL,
  schema_definition    TEXT NOT NULL DEFAULT '',
  snapshot_label       TEXT NOT NULL DEFAULT '',
  restored_from        TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'CAPTURED' CHECK (status IN ('CAPTURED','RESTORED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE schema_time_machine_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'schema_time_machine_snapshots_owner' AND tablename = 'schema_time_machine_snapshots') THEN CREATE POLICY schema_time_machine_snapshots_owner ON schema_time_machine_snapshots USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_schema_time_machine_snapshots_owner ON schema_time_machine_snapshots(owner_id);

CREATE TABLE IF NOT EXISTS pipeline_watcher_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  pipeline_name        TEXT NOT NULL,
  sla_minutes          NUMERIC NOT NULL DEFAULT 0,
  anomalies            JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','ANOMALY_DETECTED','SLA_FLAGGED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pipeline_watcher_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'pipeline_watcher_runs_owner' AND tablename = 'pipeline_watcher_runs') THEN CREATE POLICY pipeline_watcher_runs_owner ON pipeline_watcher_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_pipeline_watcher_runs_owner ON pipeline_watcher_runs(owner_id);

-- ===== 0108_superpowers_tranche_ad.sql (converged) =====

CREATE TABLE IF NOT EXISTS feature_store_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  model_name           TEXT NOT NULL,
  feature_set          JSONB NOT NULL DEFAULT '[]'::jsonb,
  drift_score          NUMERIC,
  last_trained_at      TIMESTAMPTZ,
  retrain_pr_url       TEXT,
  status               TEXT NOT NULL DEFAULT 'MONITORING' CHECK (status IN ('MONITORING','RETRAINED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE feature_store_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'feature_store_runs_owner' AND tablename = 'feature_store_runs') THEN CREATE POLICY feature_store_runs_owner ON feature_store_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_feature_store_runs_owner ON feature_store_runs(owner_id);

CREATE TABLE IF NOT EXISTS denorm_suggestions (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  query_text           TEXT NOT NULL,
  source_tables        JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_view       TEXT NOT NULL,
  estimated_improvement NUMERIC,
  status               TEXT NOT NULL DEFAULT 'SUGGESTED' CHECK (status IN ('SUGGESTED','APPLIED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE denorm_suggestions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'denorm_suggestions_owner' AND tablename = 'denorm_suggestions') THEN CREATE POLICY denorm_suggestions_owner ON denorm_suggestions USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_denorm_suggestions_owner ON denorm_suggestions(owner_id);

CREATE TABLE IF NOT EXISTS relationship_maps (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  source_table         TEXT NOT NULL,
  target_table         TEXT NOT NULL,
  relationship_type    TEXT NOT NULL,
  column_mapping       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               TEXT NOT NULL DEFAULT 'MAPPED' CHECK (status IN ('MAPPED','VERIFIED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE relationship_maps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'relationship_maps_owner' AND tablename = 'relationship_maps') THEN CREATE POLICY relationship_maps_owner ON relationship_maps USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_relationship_maps_owner ON relationship_maps(owner_id);

CREATE TABLE IF NOT EXISTS anomaly_scans (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  data_source          TEXT NOT NULL,
  anomaly_type         TEXT NOT NULL,
  description          TEXT NOT NULL,
  severity             TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  alerted              BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','ALERTED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE anomaly_scans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anomaly_scans_owner' AND tablename = 'anomaly_scans') THEN CREATE POLICY anomaly_scans_owner ON anomaly_scans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_anomaly_scans_owner ON anomaly_scans(owner_id);

CREATE TABLE IF NOT EXISTS compliance_reports (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  resource_type        TEXT NOT NULL,
  violation_type       TEXT NOT NULL,
  evidence             TEXT NOT NULL,
  severity             TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status               TEXT NOT NULL DEFAULT 'FLAGGED' CHECK (status IN ('FLAGGED','RESOLVED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE compliance_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'compliance_reports_owner' AND tablename = 'compliance_reports') THEN CREATE POLICY compliance_reports_owner ON compliance_reports USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_compliance_reports_owner ON compliance_reports(owner_id);

-- ===== 0109_superpowers_tranche_ae.sql (converged) =====

CREATE TABLE IF NOT EXISTS query_optimizer_plans (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  query_text             TEXT NOT NULL,
  original_latency_ms    NUMERIC NOT NULL DEFAULT 0,
  optimized_query        TEXT,
  optimized_latency_ms   NUMERIC,
  equivalence_proven     BOOLEAN NOT NULL DEFAULT false,
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPTIMIZED','EQUIVALENCE_PROVEN')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE query_optimizer_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'query_optimizer_plans_owner' AND tablename = 'query_optimizer_plans') THEN CREATE POLICY query_optimizer_plans_owner ON query_optimizer_plans USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_query_optimizer_plans_owner ON query_optimizer_plans(owner_id);

CREATE TABLE IF NOT EXISTS cross_team_contracts (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  team_a                 TEXT NOT NULL,
  team_b                 TEXT NOT NULL,
  api_contract           TEXT NOT NULL,
  shared_library         TEXT NOT NULL,
  version                TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BREACH_FLAGGED')),
  breach_reason          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cross_team_contracts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cross_team_contracts_owner' AND tablename = 'cross_team_contracts') THEN CREATE POLICY cross_team_contracts_owner ON cross_team_contracts USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_cross_team_contracts_owner ON cross_team_contracts(owner_id);

CREATE TABLE IF NOT EXISTS org_health_reports (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  bus_factor_score       NUMERIC NOT NULL DEFAULT 0,
  review_bottleneck_score NUMERIC NOT NULL DEFAULT 0,
  coverage_score         NUMERIC NOT NULL DEFAULT 0,
  incident_count         NUMERIC NOT NULL DEFAULT 0,
  debt_score             NUMERIC NOT NULL DEFAULT 0,
  velocity_trend         TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COMPUTED')),
  computed_metrics       JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE org_health_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'org_health_reports_owner' AND tablename = 'org_health_reports') THEN CREATE POLICY org_health_reports_owner ON org_health_reports USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_org_health_reports_owner ON org_health_reports(owner_id);

CREATE TABLE IF NOT EXISTS retention_predictors (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  employee_name          TEXT NOT NULL,
  signal_type            TEXT NOT NULL,
  risk_score             NUMERIC NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','FLAGGED')),
  intervention_plan      TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE retention_predictors ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'retention_predictors_owner' AND tablename = 'retention_predictors') THEN CREATE POLICY retention_predictors_owner ON retention_predictors USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_retention_predictors_owner ON retention_predictors(owner_id);

CREATE TABLE IF NOT EXISTS hiring_assistants (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  candidate_name         TEXT NOT NULL,
  interview_score        NUMERIC,
  take_home_score        NUMERIC,
  calibrated_score       NUMERIC,
  team_average           NUMERIC,
  status                 TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SCORED')),
  recommendation         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hiring_assistants ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hiring_assistants_owner' AND tablename = 'hiring_assistants') THEN CREATE POLICY hiring_assistants_owner ON hiring_assistants USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_hiring_assistants_owner ON hiring_assistants(owner_id);

-- ===== 0110_superpowers_tranche_af.sql (converged) =====

CREATE TABLE IF NOT EXISTS speculative_engineering_lanes (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  hypothesis           TEXT NOT NULL,
  alternatives         JSONB NOT NULL DEFAULT '[]'::jsonb,
  measured_result      TEXT,
  status               TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MEASURED','DISCARDED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE speculative_engineering_lanes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'speculative_engineering_lanes_owner' AND tablename = 'speculative_engineering_lanes') THEN CREATE POLICY speculative_engineering_lanes_owner ON speculative_engineering_lanes USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_speculative_engineering_lanes_owner ON speculative_engineering_lanes(owner_id);

CREATE TABLE IF NOT EXISTS self_evolving_lessons (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  failure_description  TEXT NOT NULL,
  lesson               TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT '',
  adopted              BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ADOPTED','DISCARDED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE self_evolving_lessons ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'self_evolving_lessons_owner' AND tablename = 'self_evolving_lessons') THEN CREATE POLICY self_evolving_lessons_owner ON self_evolving_lessons USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_self_evolving_lessons_owner ON self_evolving_lessons(owner_id);

CREATE TABLE IF NOT EXISTS org_simulator_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  scenario             TEXT NOT NULL,
  baseline_metrics    JSONB NOT NULL DEFAULT '{}'::jsonb,
  simulation_result    TEXT,
  status               TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','RUNNING','COMPLETED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE org_simulator_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'org_simulator_runs_owner' AND tablename = 'org_simulator_runs') THEN CREATE POLICY org_simulator_runs_owner ON org_simulator_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_org_simulator_runs_owner ON org_simulator_runs(owner_id);

CREATE TABLE IF NOT EXISTS codebase_physics_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  change_description   TEXT NOT NULL,
  impact_metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
  simulation_result    TEXT,
  status               TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','RUNNING','COMPLETED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE codebase_physics_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'codebase_physics_runs_owner' AND tablename = 'codebase_physics_runs') THEN CREATE POLICY codebase_physics_runs_owner ON codebase_physics_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_codebase_physics_runs_owner ON codebase_physics_runs(owner_id);

CREATE TABLE IF NOT EXISTS tech_debt_pricing_items (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  debt_description     TEXT NOT NULL,
  fix_cost_days        INTEGER NOT NULL DEFAULT 0,
  ignore_cost_days     INTEGER NOT NULL DEFAULT 0,
  urgency_score        INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'PRICED' CHECK (status IN ('PRICED','FIX_SCHEDULED','FIXED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tech_debt_pricing_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tech_debt_pricing_items_owner' AND tablename = 'tech_debt_pricing_items') THEN CREATE POLICY tech_debt_pricing_items_owner ON tech_debt_pricing_items USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_tech_debt_pricing_items_owner ON tech_debt_pricing_items(owner_id);

-- ===== 0111_superpowers_tranche_ag.sql (converged) =====

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

-- ===== 0112_superpowers_tranche_ah.sql (converged) =====

CREATE TABLE IF NOT EXISTS nutrition_labels (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  repo_name            TEXT NOT NULL,
  freshness            INTEGER NOT NULL DEFAULT 0,
  risk                 INTEGER NOT NULL DEFAULT 0,
  debt                 INTEGER NOT NULL DEFAULT 0,
  coverage             INTEGER NOT NULL DEFAULT 0,
  security             INTEGER NOT NULL DEFAULT 0,
  velocity             INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE nutrition_labels ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'nutrition_labels_owner' AND tablename = 'nutrition_labels') THEN CREATE POLICY nutrition_labels_owner ON nutrition_labels USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_nutrition_labels_owner ON nutrition_labels(owner_id);

CREATE TABLE IF NOT EXISTS universal_repro_runs (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  bug_description      TEXT NOT NULL,
  version              TEXT NOT NULL,
  data_state           TEXT NOT NULL DEFAULT '',
  flags                JSONB NOT NULL DEFAULT '[]'::jsonb,
  device               TEXT NOT NULL DEFAULT '',
  network              TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'ATTEMPTED' CHECK (status IN ('ATTEMPTED','CONFIRMED')),
  result               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE universal_repro_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'universal_repro_runs_owner' AND tablename = 'universal_repro_runs') THEN CREATE POLICY universal_repro_runs_owner ON universal_repro_runs USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_universal_repro_runs_owner ON universal_repro_runs(owner_id);

CREATE TABLE IF NOT EXISTS refactor_proposals (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  description          TEXT NOT NULL,
  file_path            TEXT NOT NULL,
  benchmark_before     INTEGER NOT NULL DEFAULT 0,
  benchmark_after      INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','QUEUED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE refactor_proposals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'refactor_proposals_owner' AND tablename = 'refactor_proposals') THEN CREATE POLICY refactor_proposals_owner ON refactor_proposals USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_refactor_proposals_owner ON refactor_proposals(owner_id);

CREATE TABLE IF NOT EXISTS dogfood_tasks (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  category             TEXT NOT NULL,
  assignee             TEXT,
  status               TEXT NOT NULL DEFAULT 'FILED' CHECK (status IN ('FILED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dogfood_tasks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'dogfood_tasks_owner' AND tablename = 'dogfood_tasks') THEN CREATE POLICY dogfood_tasks_owner ON dogfood_tasks USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_dogfood_tasks_owner ON dogfood_tasks(owner_id);

CREATE TABLE IF NOT EXISTS demo_links (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  url                  TEXT NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  expired_at           TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE demo_links ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'demo_links_owner' AND tablename = 'demo_links') THEN CREATE POLICY demo_links_owner ON demo_links USING (owner_id = app.uid()); END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_demo_links_owner ON demo_links(owner_id);
