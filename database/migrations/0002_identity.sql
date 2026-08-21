-- 0002: identity — users, sessions, devices, recovery_codes

CREATE TABLE users (
  id                       text PRIMARY KEY,
  email                    text NOT NULL,
  email_verified           boolean NOT NULL DEFAULT false,
  password_hash            text,
  display_name             text,
  avatar_url               text,
  google_sub               text,
  mfa_enabled              boolean NOT NULL DEFAULT false,
  mfa_secret_encrypted     text,
  recovery_codes_hash      text,
  rbac_role                text NOT NULL DEFAULT 'member'
                           CHECK (rbac_role IN ('owner','admin','member')),
  plan_id                  text NOT NULL DEFAULT 'free'
                           CHECK (plan_id IN ('free','pro')),
  entitlement_state        text NOT NULL DEFAULT 'FREE'
                           CHECK (entitlement_state IN ('FREE','PRO_PENDING','PRO_VERIFIED','PRO_EXPIRED','PRO_REFUNDED')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz
);

CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));
CREATE UNIQUE INDEX uq_users_google_sub ON users (google_sub);
CREATE INDEX idx_users_entitlement ON users (entitlement_state);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id),
  token_hash    text NOT NULL UNIQUE,
  device_id     text,
  ip            text,
  user_agent    text,
  state         text NOT NULL DEFAULT 'ACTIVE'
                CHECK (state IN ('ACTIVE','REVOKED','EXPIRED')),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE INDEX idx_sessions_user_state ON sessions (user_id, state);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE devices (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL REFERENCES users(id),
  name                text NOT NULL,
  pairing_code_hash   text UNIQUE,
  state               text NOT NULL DEFAULT 'PENDING_PAIRING'
                      CHECK (state IN ('PENDING_PAIRING','PAIRED','REVOKED')),
  paired_at           timestamptz,
  last_seen_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_user ON devices (user_id);

CREATE TABLE recovery_codes (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id),
  code_hash   text NOT NULL UNIQUE,
  purpose     text NOT NULL DEFAULT 'LOGIN',
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recovery_codes_user ON recovery_codes (user_id);
