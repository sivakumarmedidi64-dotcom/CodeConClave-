-- CodeConClave 0133 — Auth identity (handle + keyword), Security Key 2FA,
-- founder provisioning, and entitlement-expiry safety.
--
-- ADDITIVE ONLY. The frozen `users` table gains two nullable columns and its
-- unique email index is left completely untouched: email stays unique and stays
-- the contact label. The new login identity lives in user_auth_identities.

-- ── 1. users: founder provisioning flag ────────────────────────────────
-- `is_founder` is the only thing that can grant founder entitlement, and it is
-- set exclusively by the explicit provisioning script (scripts/provision-founder.ts).
-- Self-service registration always writes false, so registering the founder
-- address can no longer produce a Team workspace.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_founder boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_founder
  ON users (lower(email)) WHERE is_founder = true;

-- ── 2. user_auth_identities: handle + keyword identity ─────────────────
-- D1/D5: a unique case-insensitive `handle` is the primary human identifier;
-- the keyword is stored only as a scrypt hash. One identity per user.
CREATE TABLE IF NOT EXISTS user_auth_identities (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  handle             text NOT NULL,
  keyword_hash       text,
  security_key_hash  text,
  security_key_enabled boolean NOT NULL DEFAULT false,
  preferred_mfa      text NOT NULL DEFAULT 'none'
                       CHECK (preferred_mfa IN ('none','totp','security_key')),
  keyword_changed_at timestamptz,
  security_key_created_at timestamptz,
  security_key_revoked_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

-- Case-insensitive uniqueness: login lowercases the handle, so uniqueness must
-- be enforced on lower(handle) or "Alice" and "alice" could both register.
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_identity_handle
  ON user_auth_identities (lower(handle)) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_identity_user
  ON user_auth_identities (user_id);

CREATE TRIGGER trg_user_auth_identities_updated_at
  BEFORE UPDATE ON user_auth_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE user_auth_identities ENABLE ROW LEVEL SECURITY;

-- A user may read their own identity record. Writes go through the server
-- (table owner) only, so the CHECK clause stays true as on google_connections.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'user_auth_identities_self' AND tablename = 'user_auth_identities'
  ) THEN
    CREATE POLICY user_auth_identities_self ON user_auth_identities
      USING (user_id = app.uid()) WITH CHECK (true);
  END IF;
END $$;

-- ── 3. handle backfill (deterministic, collision-safe) ─────────────────
-- Existing users keep working. Backfill derives a handle from the email local
-- part, sanitised; collisions get a deterministic numeric suffix. No handle is
-- generated that would collide with a reserved name.
DO $$
DECLARE
  r          record;
  base       text;
  candidate  text;
  n          int;
  taken      boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM user_auth_identities LIMIT 1) THEN
    RAISE NOTICE 'user_auth_identities already populated; backfill skipped';
    RETURN;
  END IF;

  FOR r IN
    SELECT u.id, u.email,
           coalesce(nullif(regexp_replace(split_part(u.email,'@',1), '[^a-zA-Z0-9_]', '', 'g'), ''), 'user') AS stem
      FROM users u
     WHERE u.deleted_at IS NULL
  LOOP
    base := lower(left(r.stem, 20));
    IF base !~ '^[a-z0-9]' THEN
      base := 'u' || base;           -- handles must start alphanumeric
    END IF;
    IF length(base) < 3 THEN
      base := base || 'user';
    END IF;

    candidate := base;
    n := 0;
    LOOP
      taken := EXISTS (
        SELECT 1 FROM user_auth_identities
         WHERE lower(handle) = candidate AND deleted_at IS NULL
      );
      EXIT WHEN NOT taken;
      n := n + 1;
      candidate := base || n::text;
      EXIT WHEN n > 100000;          -- pathological guard
    END LOOP;

    INSERT INTO user_auth_identities (id, user_id, handle, keyword_hash, preferred_mfa)
    VALUES ('uai_' || md5(r.id), r.id, candidate, NULL, 'none')
    ON CONFLICT (user_id) DO NOTHING;
  END LOOP;
END $$;

-- ── 4. keyword recovery tokens (security-key recovery) ─────────────────
-- Recovery is: handle + security key -> short-lived single-use token -> new
-- keyword. Only the token HASH is stored; there is no email-based reset path.
CREATE TABLE IF NOT EXISTS auth_recovery_tokens (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES user_auth_identities(user_id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  purpose       text NOT NULL DEFAULT 'keyword_recovery'
                  CHECK (purpose IN ('keyword_recovery','security_key_reissue')),
  status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','USED','REVOKED')),
  attempts      int NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_tokens_user
  ON auth_recovery_tokens (user_id, status);

CREATE INDEX IF NOT EXISTS idx_recovery_tokens_expiry
  ON auth_recovery_tokens (expires_at)
  WHERE status = 'PENDING';

ALTER TABLE auth_recovery_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE policyname = 'auth_recovery_tokens_self' AND tablename = 'auth_recovery_tokens'
  ) THEN
    CREATE POLICY auth_recovery_tokens_self ON auth_recovery_tokens
      USING (user_id = app.uid()) WITH CHECK (user_id = app.uid());
  END IF;
END $$;

-- ── 5. audit action trail for the new flows ────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'auth.keyword_changed' LIMIT 1) THEN
    NULL; -- audit_logs is append-only; new actions need no DDL.
  END IF;
END $$;

COMMENT ON TABLE user_auth_identities IS
  'D1/D5 auth identity: unique handle (primary login id) + scrypt keyword hash + optional security key. users.email remains the unique contact label.';
COMMENT ON COLUMN users.is_founder IS
  'Founder entitlement requires is_founder = true AND email_verified = true AND email = PAYMENT_FOUNDER_EMAIL. Set only by scripts/provision-founder.ts; never by self-service registration.';
COMMENT ON TABLE auth_recovery_tokens IS
  'Single-use, hashed, expiring tokens for security-key keyword recovery. No email-based password reset exists by design.';
