-- 0062: PKG-20 Integrated Terminal + Environment Safety.
-- Extends the existing PKG-19 runtime_executions history with environment + cwd
-- metadata (no new execution engine), and adds per-project environment state +
-- auditable environment-switch history.

-- Add environment + working-directory context to the existing execution history.
ALTER TABLE runtime_executions
  ADD COLUMN IF NOT EXISTS environment text,
  ADD COLUMN IF NOT EXISTS cwd text;

-- Per-project active environment (DEVELOPMENT/STAGING/PRODUCTION) plus the last
-- validation snapshot. Stores NAMES + statuses only, never secret values.
CREATE TABLE IF NOT EXISTS environment_state (
  project_id       text PRIMARY KEY REFERENCES projects(id),
  owner_id         text NOT NULL REFERENCES users(id),
  environment      text NOT NULL DEFAULT 'development'
                   CHECK (environment IN ('development','staging','production')),
  validation_state text NOT NULL DEFAULT 'UNVERIFIED',
  missing_vars     jsonb NOT NULL DEFAULT '[]'::jsonb,
  invalid_vars     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_env_state_owner ON environment_state (owner_id);

-- Auditable environment-switch history (never stores secret values).
CREATE TABLE IF NOT EXISTS environment_switches (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  owner_id   text NOT NULL REFERENCES users(id),
  from_env   text,
  to_env     text NOT NULL,
  reason     text,
  confirmed  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_env_switches_project ON environment_switches (project_id);
CREATE INDEX idx_env_switches_owner   ON environment_switches (owner_id);
