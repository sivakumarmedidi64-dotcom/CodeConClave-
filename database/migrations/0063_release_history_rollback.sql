-- 0063: PKG-21 Deployment History + Rollback + Release Evidence.
-- Additive. Introduces ONE immutable deployments record (release identity +
-- verification evidence + status) and ONE rollback_runs ledger (every rollback
-- attempt). Builds ON TOP of the existing deployment-wizard / runtime / environment
-- layers by reference (planId/profileId/verifyId). NEVER stores secrets.

-- Immutable deployment / release record.
CREATE TABLE IF NOT EXISTS deployments (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(id),
  workspace_id text,
  environment  text NOT NULL DEFAULT 'development'
               CHECK (environment IN ('development','staging','production')),
  status       text NOT NULL DEFAULT 'PLANNED',
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_env     ON deployments (environment, status);

-- Ledger of every rollback attempt (authorization + target + result + evidence).
CREATE TABLE IF NOT EXISTS rollback_runs (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES projects(id),
  workspace_id text,
  environment  text NOT NULL,
  current_deployment_id text NOT NULL,
  target_deployment_id  text,
  status       text NOT NULL DEFAULT 'REQUESTED',
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_rollback_runs_project ON rollback_runs (project_id, created_at DESC);
