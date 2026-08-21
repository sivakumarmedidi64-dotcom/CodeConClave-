-- 0019: phase 1 — identity authorization hardening.
-- Adds the VIEWER role everywhere roles are checked, links sessions to
-- devices (device revocation cascades), persists suspicious-session flags,
-- records device revocation time, and stores Google OAuth connections
-- (refresh tokens AES-256-GCM at rest, never exposed).

-- ---------------------------------------------------------------------------
-- RBAC: VIEWER role (users, project_members, team_members)
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT users_rbac_role_check;
ALTER TABLE users ADD CONSTRAINT users_rbac_role_check
  CHECK (rbac_role IN ('owner','admin','member','viewer'));

ALTER TABLE project_members DROP CONSTRAINT project_members_role_check;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_check
  CHECK (role IN ('owner','admin','member','viewer'));

ALTER TABLE team_members DROP CONSTRAINT team_members_role_check;
ALTER TABLE team_members ADD CONSTRAINT team_members_role_check
  CHECK (role IN ('owner','admin','member','viewer'));

-- ---------------------------------------------------------------------------
-- Sessions: device association + suspicious-session flags + sweep index
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD CONSTRAINT fk_sessions_device
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;

ALTER TABLE sessions ADD COLUMN risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Sweep-friendly index for expiry retention (state + expires_at).
CREATE INDEX idx_sessions_expires_state ON sessions (state, expires_at);

-- ---------------------------------------------------------------------------
-- Devices: revocation timestamp (lifecycle completeness)
-- ---------------------------------------------------------------------------
ALTER TABLE devices ADD COLUMN revoked_at timestamptz;

-- ---------------------------------------------------------------------------
-- Google OAuth connections: refresh tokens encrypted at rest, server-side
-- authority only. Never exposed via any API.
-- ---------------------------------------------------------------------------
CREATE TABLE google_connections (
  id                       text PRIMARY KEY,
  user_id                  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_sub               text NOT NULL UNIQUE,
  scopes                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  refresh_token_encrypted  text,
  access_token_encrypted   text,
  token_expires_at         timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_google_connections_user ON google_connections (user_id);

CREATE TRIGGER trg_google_connections_updated_at
  BEFORE UPDATE ON google_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE google_connections ENABLE ROW LEVEL SECURITY;
-- Reads are user-scoped; server (table owner) performs all writes.
CREATE POLICY google_connections_self ON google_connections
  USING (user_id = app.uid()) WITH CHECK (true);