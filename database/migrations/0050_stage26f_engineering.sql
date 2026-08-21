-- CodeConClave Pro — Stage 26F: Engineering Agent Swarm.
-- Additive only. Reuses the existing task engine, approvals, audit, memory,
-- workers, agents (startRun/cancelRun), recovery (autopsy/recovery_history),
-- notifications and shared constants. No second task engine, no fake CI.
--
-- Adds:
--   * review_swarms + review_findings — multi-agent PR review (Architect,
--     Reviewer, Security, Tester) with evidence-backed, severity/confidence
--     graded findings; independent role runs; partial-failure honest states.
--   * dependency_upgrades — one-dependency-at-a-time upgrade machine with
--     explicit inspect→modify→install→test→build→analyze→accept/rollback
--     transitions; rollback is a first-class recorded action.
--   * flake_records — flaky test analysis (intermittent / timing / environment
--     / concurrency / unclassified) that only ever creates investigation
--     tasks; it never deletes or skips tests.
--   * ci_runs — self-healing CI: failure intake, log diagnosis, fix proposal,
--     approval gate, fix application, retest; destructive merges rejected.
-- Applied live at 50/50.

-- ---------------------------------------------------------------- PR review swarm
CREATE TABLE IF NOT EXISTS review_swarms (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL,
  project_id    text NOT NULL,
  pr_ref        text NOT NULL,
  target_ref    text,
  title         text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','RUNNING','COMPLETED','PARTIAL','FAILED')),
  roles         jsonb NOT NULL DEFAULT '[]',
  files         jsonb NOT NULL DEFAULT '[]',
  task_id       text,
  verdict       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE review_swarms ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_swarms_owner ON review_swarms
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_review_swarms_owner ON review_swarms (owner_id, created_at DESC);
CREATE INDEX idx_review_swarms_project ON review_swarms (project_id);

CREATE TABLE IF NOT EXISTS review_findings (
  id             text PRIMARY KEY,
  swarm_id       text NOT NULL,
  owner_id       text NOT NULL,
  role           text NOT NULL
                 CHECK (role IN ('ARCHITECT','REVIEWER','SECURITY','TESTER')),
  severity       text NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW','INFO')),
  category       text NOT NULL,
  title          text NOT NULL,
  description    text NOT NULL,
  file_path      text,
  line_start     integer,
  line_end       integer,
  evidence       jsonb NOT NULL DEFAULT '[]',
  confidence     numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  recommendation text,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACCEPTED','DISMISSED')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE review_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY review_findings_owner ON review_findings
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_review_findings_swarm ON review_findings (swarm_id, created_at);
CREATE INDEX idx_review_findings_owner ON review_findings (owner_id);

-- ---------------------------------------------------------------- dependency upgrades
CREATE TABLE IF NOT EXISTS dependency_upgrades (
  id               text PRIMARY KEY,
  owner_id         text NOT NULL,
  project_id       text NOT NULL,
  package_name     text NOT NULL,
  from_version     text NOT NULL,
  to_version       text NOT NULL,
  manifest_path    text NOT NULL,
  status           text NOT NULL DEFAULT 'INSPECTING'
                   CHECK (status IN ('INSPECTING','MODIFYING','INSTALLING','TESTING',
                                     'BUILDING','ANALYZING','ACCEPTED','ROLLED_BACK','FAILED')),
  diff             jsonb,
  install_output   text,
  test_summary     text,
  build_summary    text,
  analysis         jsonb,
  task_id          text,
  approval_id      text,
  rollback_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dependency_upgrades ENABLE ROW LEVEL SECURITY;
CREATE POLICY dependency_upgrades_owner ON dependency_upgrades
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_dependency_upgrades_owner ON dependency_upgrades (owner_id, created_at DESC);
CREATE INDEX idx_dependency_upgrades_project ON dependency_upgrades (project_id, status);

-- ---------------------------------------------------------------- flaky test records
CREATE TABLE IF NOT EXISTS flake_records (
  id                   text PRIMARY KEY,
  owner_id             text NOT NULL,
  project_id           text NOT NULL,
  test_id              text NOT NULL,
  test_name            text NOT NULL,
  runs_seen            integer NOT NULL DEFAULT 0,
  failures_seen        integer NOT NULL DEFAULT 0,
  classification       text NOT NULL DEFAULT 'UNCLASSIFIED'
                       CHECK (classification IN ('INTERMITTENT','TIMING','ENVIRONMENT',
                                                 'CONCURRENCY','UNCLASSIFIED')),
  pattern              text,
  evidence             jsonb NOT NULL DEFAULT '[]',
  confidence           numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  investigation_task_id text,
  status               text NOT NULL DEFAULT 'REPORTED'
                       CHECK (status IN ('REPORTED','INVESTIGATING','RESOLVED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE flake_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY flake_records_owner ON flake_records
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_flake_records_owner ON flake_records (owner_id, created_at DESC);
CREATE INDEX idx_flake_records_project ON flake_records (project_id, classification);

-- ---------------------------------------------------------------- self-healing CI runs
CREATE TABLE IF NOT EXISTS ci_runs (
  id             text PRIMARY KEY,
  owner_id       text NOT NULL,
  project_id     text NOT NULL,
  pipeline       text NOT NULL,
  commit_ref     text NOT NULL,
  log_ref        text,
  log_summary    text,
  status         text NOT NULL DEFAULT 'FAILED'
                 CHECK (status IN ('FAILED','FIX_PROPOSED','WAITING_FOR_APPROVAL',
                                   'FIX_APPLIED','RETEST_PASSED','RETEST_FAILED','FIX_REJECTED')),
  diagnosis      jsonb,
  fix_proposal   jsonb,
  task_id        text,
  approval_id    text,
  retest_summary text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ci_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ci_runs_owner ON ci_runs
  USING (owner_id = current_setting('app.user_id', true)::text);
CREATE INDEX idx_ci_runs_owner ON ci_runs (owner_id, created_at DESC);
CREATE INDEX idx_ci_runs_project ON ci_runs (project_id, status);