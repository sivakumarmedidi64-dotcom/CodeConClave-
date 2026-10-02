-- Stage — user API key provisioning.
-- CodeConClave issues per-user API keys so projects/clients can call the
-- platform AI programmatically. Only the SHA-256 hash is stored server-side
-- (the raw secret is shown exactly once at creation), mirroring session tokens.
-- Additive only. Every tenant table: owner_id + RLS + FKs + indexes.

CREATE TABLE user_api_keys (
  id            text PRIMARY KEY,
  owner_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (name <> ''),
  key_hash      text NOT NULL UNIQUE CHECK (key_hash <> ''),
  key_prefix    text NOT NULL CHECK (key_prefix <> ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoke_reason text
);
CREATE INDEX idx_user_api_keys_owner ON user_api_keys (owner_id, created_at DESC);
CREATE INDEX idx_user_api_keys_hash ON user_api_keys (key_hash);