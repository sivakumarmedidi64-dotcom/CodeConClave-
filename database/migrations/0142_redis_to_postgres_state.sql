-- ---------------------------------------------------------------------------
-- 0142_redis_to_postgres_state.sql
-- PostgreSQL replacements for Redis-backed correctness/security state.
--
-- The production queue, sessions, scheduled tasks, worker leases, storage and
-- entitlement data are already PostgreSQL-backed and are deliberately NOT
-- duplicated here. This migration adds storage ONLY for the state that Redis
-- currently holds exclusively:
--
--   auth_rate_counters          fixed-window counters/buckets (global/auth/chat
--                               limits, identity attempts, MFA attempt budgets,
--                               OTP per-email + per-IP hourly caps, API-key
--                               window + daily budgets, verification hourly
--                               cap, demo/self-service hourly caps and attempt
--                               budgets)
--   auth_last_seen              cooldown markers (OTP resend interval,
--                               verification resend interval, session
--                               last-seen write throttle)
--   auth_challenge_uses         single-use burn for MFA / security-key
--                               challenge nonces (replay protection)
--   api_key_concurrency         in-flight slot accounting with stale recovery
--   payment_demo_activations    durable demo activation record (single-use)
--   payment_self_service_tokens durable self-service confirmation record
--
-- OTP codes (email_otps) and email verification tokens (email_verifications)
-- already exist and already hold the authoritative single-use lifecycle, so no
-- duplicate table is created for them — only their throttle state moves here.
--
-- Every statement is CREATE ... IF NOT EXISTS. No DROP, no DELETE, no column
-- replacement, no rewrite of existing rows: this is additive only and safe to
-- apply to the live schema.
--
-- These tables are never exposed to client-supplied queries; they are written
-- only by server middleware/workers. Ownership columns are absent by design,
-- matching the existing system-table treatment (audit_logs, outbox_events).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Generalized fixed-window counter / bucket.
--
-- One row per bucket key. `expires_at` is stamped on the FIRST increment only
-- and is never extended by later increments, which reproduces Redis
-- INCR + first-write PEXPIRE exactly: the window is fixed at the first request
-- and cannot be stretched by hammering the endpoint.
--
-- Atomicity: a single INSERT ... ON CONFLICT DO UPDATE statement, so the
-- increment and the window decision happen under one row lock. Concurrent
-- increments from N backend instances serialize on that row and each observes a
-- distinct value; no lost updates and no read-modify-write race.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_rate_counters (
  bucket_key        text PRIMARY KEY CHECK (bucket_key <> ''),
  count             bigint NOT NULL DEFAULT 1 CHECK (count >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Cleanup drives off this index; never a full-table scan.
CREATE INDEX IF NOT EXISTS idx_auth_rate_counters_expires_at
  ON auth_rate_counters (expires_at);

-- ---------------------------------------------------------------------------
-- 2. Last-seen / cooldown markers.
--
-- Distinct from a counter: the operation is a conditional "claim the cooldown",
-- not an increment. `acquireLastSeen` updates only when the previous marker is
-- older than the caller's minimum interval, so the update itself is the
-- throttle decision and two instances cannot both win the same cooldown.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_last_seen (
  scope_key  text PRIMARY KEY CHECK (scope_key <> ''),
  seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_last_seen_expires_at
  ON auth_last_seen (expires_at);

-- ---------------------------------------------------------------------------
-- 3. Single-use MFA / security-key challenge burn.
--
-- Insertion IS the consume. `INSERT ... ON CONFLICT DO NOTHING RETURNING`
-- hands a row to exactly one caller; every concurrent or later replay receives
-- nothing and is rejected. This is the direct PostgreSQL equivalent of the
-- current atomic Redis INCR on `authid:mfa-challenge:<nonce>` (first caller
-- sees 1, everyone after sees > 1), but it no longer depends on a store that can
-- silently degrade to per-process memory.
--
-- A store/database failure must still propagate: identity.ts treats an
-- unverifiable challenge as fatal rather than treating it as fresh.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_challenge_uses (
  nonce       text PRIMARY KEY CHECK (nonce <> ''),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_challenge_uses_expires_at
  ON auth_challenge_uses (expires_at);

-- ---------------------------------------------------------------------------
-- 4. API-key in-flight concurrency.
--
-- Acquire is one conditional upsert that enforces the cap atomically: when the
-- live count is already at or above the cap the WHERE clause suppresses the
-- update and the statement returns no row, so the caller is refused. Release is
-- a single atomic decrement (never the current read-modify-write), so slots
-- cannot leak under concurrent release.
--
-- `expires_at` is the stale-holder safety net: a process that dies without
-- releasing its slots has its row treated as empty once the TTL lapses,
-- preserving the existing 120-second recovery behaviour.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_key_concurrency (
  key_id     text PRIMARY KEY REFERENCES user_api_keys(id) ON DELETE CASCADE,
  active     integer NOT NULL DEFAULT 0 CHECK (active >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- 5. Demo activation records.
--
-- Replaces a JSON blob in Redis with real columns. `token_hash` is the SHA-256
-- of the emailed token; the raw token is never persisted. The status CHECK is
-- pinned to the existing DemoStatus values, `payment_verification_method` stays
-- 'DEMO_REDIRECT', and `is_real_payment` is constrained to false so a demo row
-- can never be read as real payment evidence.
--
-- Exactly-once is a conditional UPDATE (status = 'DEMO_PENDING' AND not
-- expired), which closes the read-then-write race the cache implementation has.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_demo_activations (
  token_hash                  text PRIMARY KEY CHECK (token_hash <> ''),
  session_id                  text,
  user_id                     text REFERENCES users(id) ON DELETE CASCADE,
  email                       text NOT NULL,
  plan                        text NOT NULL CHECK (plan IN ('pro', 'team')),
  amount_inr                  integer NOT NULL CHECK (amount_inr >= 0),
  status                      text NOT NULL DEFAULT 'DEMO_PENDING'
                              CHECK (status IN ('DEMO_PENDING', 'DEMO_ACTIVATED')),
  payment_verification_method text NOT NULL DEFAULT 'DEMO_REDIRECT',
  is_real_payment             boolean NOT NULL DEFAULT false CHECK (is_real_payment = false),
  issued_at                   timestamptz NOT NULL DEFAULT now(),
  expires_at                  timestamptz NOT NULL,
  used_at                     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_payment_demo_activations_expires_at
  ON payment_demo_activations (expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_demo_activations_user
  ON payment_demo_activations (user_id, issued_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Self-service payment confirmation records.
--
-- Same shape and same guarantees as the demo record: hashed token only,
-- single-use PENDING -> USED transition performed by one conditional UPDATE,
-- restart-safe because the record is durable rather than TTL-in-memory.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_self_service_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash <> ''),
  user_id    text REFERENCES users(id) ON DELETE CASCADE,
  intent_id  text,
  plan_id    text,
  amount_inr integer NOT NULL CHECK (amount_inr >= 0),
  status     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'USED')),
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_payment_self_service_tokens_expires_at
  ON payment_self_service_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_self_service_tokens_user
  ON payment_self_service_tokens (user_id, issued_at DESC);
