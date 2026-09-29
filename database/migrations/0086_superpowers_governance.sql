-- ---------------------------------------------------------------------------
-- CodeConClave — Superpowers (Tranche H): self-governance & quality cluster.
--
--   RED CELL              (feature 30): static vulnerability scan that confirms
--                          which findings are actually exploitable and ranks
--                          them by confirmed risk — a short to-do list instead
--                          of a wall of "possible vulnerability" noise.
--   COVERAGE SENTINEL     (feature 31): diffs coverage, generates tests for the
--                          uncovered branches, then rejects its own hollow
--                          tests (no assertion, no target exercise) before any
--                          padding can be shipped.
--   DIPLOMAT              (feature 32): keeps every dependency current and CVE
--                          patched; each upgrade attempt runs against a test
--                          suite — pass is surfaced, break is rolled back with
--                          a report on exactly what broke.
--   CONTRACT WARDEN       (feature 37): published API contracts verified
--                          against implementation at proposal time; breaking
--                          changes caught in the producer repo, and consumers
--                          checked for compatibility, not in production.
--   DEPENDENCY CARTOGRAPHER (feature 47): the social tree of every dependency —
--                          maintainer count, release cadence, funding status,
--                          alternatives — surfacing real (transitive) risk
--                          before a package is ever adopted.
--
-- Owned rows + RLS identical to 0079..0085 (app.uid() scoping).
-- ---------------------------------------------------------------------------

CREATE TABLE red_cell_findings (
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

CREATE INDEX idx_red_cell_findings_owner ON red_cell_findings (owner_id, risk_score DESC);

ALTER TABLE red_cell_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY red_cell_findings_owner ON red_cell_findings USING (owner_id = app.uid());

CREATE TABLE coverage_scans (
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

CREATE INDEX idx_coverage_scans_owner ON coverage_scans (owner_id, created_at DESC);

ALTER TABLE coverage_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY coverage_scans_owner ON coverage_scans USING (owner_id = app.uid());

CREATE TABLE diplomat_dependencies (
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

CREATE INDEX idx_diplomat_deps_owner ON diplomat_dependencies (owner_id, freshness);

ALTER TABLE diplomat_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY diplomat_dependencies_owner ON diplomat_dependencies USING (owner_id = app.uid());

CREATE TABLE diplomat_upgrades (
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

CREATE INDEX idx_diplomat_upgrades_owner ON diplomat_upgrades (owner_id, created_at DESC);

ALTER TABLE diplomat_upgrades ENABLE ROW LEVEL SECURITY;
CREATE POLICY diplomat_upgrades_owner ON diplomat_upgrades USING (owner_id = app.uid());

CREATE TABLE api_contracts (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  version           text NOT NULL,
  endpoints         jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name, version)
);

CREATE INDEX idx_api_contracts_owner ON api_contracts (owner_id, name);

ALTER TABLE api_contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_contracts_owner ON api_contracts USING (owner_id = app.uid());

CREATE TABLE contract_checks (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id       text NOT NULL REFERENCES api_contracts(id) ON DELETE CASCADE,
  verdict           text NOT NULL
                    CHECK (verdict IN ('COMPLIANT','NON_BREAKING_DRIFT','BREAKING')),
  breaking_issues   jsonb NOT NULL DEFAULT '[]',
  warning_issues    jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_contract_checks_owner ON contract_checks (owner_id, contract_id);

ALTER TABLE contract_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_checks_owner ON contract_checks USING (owner_id = app.uid());

CREATE TABLE dependency_insights (
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

CREATE INDEX idx_dependency_insights_owner ON dependency_insights (owner_id, risk_level);

ALTER TABLE dependency_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY dependency_insights_owner ON dependency_insights USING (owner_id = app.uid());