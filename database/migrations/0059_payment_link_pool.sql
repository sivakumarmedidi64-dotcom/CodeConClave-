-- ---------------------------------------------------------------------------
-- CodeConClave — PAYMENT LINK-POOL (POLICY B).
--
-- Static Payment Link-Pool for automatic, 24x7, no-API/no-webhook/no-admin
-- payment activation under POLICY B:
--
--   The CodeConClave account that authenticated, created the checkout intent,
--   and atomically reserved the payment-link slot is the account entitled to
--   receive the resulting entitlement. A third party MAY pay as a gift.
--
--   This system does NOT claim cryptographic proof of the physical payer's
--   identity. Heartbeat / IP / timing / session cookie / email are telemetry
--   only and NEVER entitlement authority.
--
-- Components:
--   1. payment_link_pool   — the pre-created static Razorpay link catalogue.
--   2. payment_link_reservations — atomic, TTL'd assignment link<->intent.
--   3. payment_pool_callbacks    — deduped, replay-protected callback ledger.
--   4. payment_intents columns   — reservation telemetry + binding.
--   5. payment_evidence.source CHECK extended with 'razorpay_callback'.
--
-- Reservation rules:
--   - only is_active links may be assigned
--   - only one LIVE reservation per link (atomic conditional UPDATE is the guard)
--   - reservation TTL = 15 minutes
--   - an expired reservation is irreversibly INVALID; the link is NOT reused in
--     a way that could let a late callback activate a newer reservation.
--     Binding is by immutable link_index + link_reference_id; a callback always
--     binds to its exact reservation's intent (OLD CALLBACK != NEW RESERVATION).
--
-- NOTE: static-only migration. PostgreSQL runtime is NOT available; validated
-- for SQL syntax only.
-- ---------------------------------------------------------------------------

-- 1) Pool catalogue ----------------------------------------------------------
CREATE TABLE payment_link_pool (
  link_index        int PRIMARY KEY CHECK (link_index >= 1),
  payment_link_id   text,
  razorpay_url      text NOT NULL,
  reference_id      text UNIQUE NOT NULL,
  amount            int NOT NULL,
  currency          text NOT NULL DEFAULT 'INR',
  plan              text NOT NULL CHECK (plan IN ('pro','team')),
  callback_path     text UNIQUE NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 2) Reservations (atomic assignment) ---------------------------------------
-- Reservation_status: RESERVED -> FULFILLED | EXPIRED | RELEASED
-- A RESERVED link is bound to exactly one intent via intent_link_ref (which is
-- set to the pool link's immutable reference_id). Late-callback protection is
-- enforced at the app layer by matching the callback's reference/link to this
-- exact reservation + its intent.
CREATE TABLE payment_link_reservations (
  id                  text PRIMARY KEY,
  link_index          int NOT NULL REFERENCES payment_link_pool(link_index),
  intent_id           text NOT NULL REFERENCES payment_intents(id),
  user_id             text NOT NULL REFERENCES users(id),
  workspace_id        text,
  plan                text NOT NULL CHECK (plan IN ('pro','team')),
  amount_inr          int NOT NULL,
  currency            text NOT NULL DEFAULT 'INR',
  link_reference_id   text NOT NULL,
  status              text NOT NULL DEFAULT 'RESERVED'
                      CHECK (status IN ('RESERVED','FULFILLED','EXPIRED','RELEASED')),
  session_id          text,
  client_ip           text,
  heartbeat_last      timestamptz,
  reserved_at         timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  fulfilled_at        timestamptz,
  payment_id          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One live reservation per link AND one live reservation per intent.
CREATE UNIQUE INDEX uq_pool_reservation_live_link
  ON payment_link_reservations (link_index)
  WHERE status = 'RESERVED';

CREATE UNIQUE INDEX uq_pool_reservation_live_intent
  ON payment_link_reservations (intent_id)
  WHERE status = 'RESERVED';

-- A single payment_id may fulfil at most one reservation.
CREATE UNIQUE INDEX uq_pool_reservation_payment
  ON payment_link_reservations (payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX idx_pool_reservations_status_expires
  ON payment_link_reservations (status, expires_at);

CREATE TRIGGER trg_payment_link_reservations_updated_at
  BEFORE UPDATE ON payment_link_reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3) Callback ledger (replay protection) ------------------------------------
-- Dedupe by payment_id. Also records ambiguous/orphaned outcomes truthfully.
CREATE TABLE payment_pool_callbacks (
  id                text PRIMARY KEY,
  link_index        int REFERENCES payment_link_pool(link_index),
  payment_id        text NOT NULL,
  payment_link_id   text,
  reference_id      text,
  link_status       text,
  signature_sha     text,
  signature_valid   boolean NOT NULL,
  outcome           text NOT NULL
                    CHECK (outcome IN
                      ('accepted','duplicate','invalid_signature','bad_link_index',
                       'link_disabled','link_id_mismatch','reference_mismatch',
                       'bad_status','no_reservation','reservation_expired',
                       'reservation_released','reservation_fulfilled',
                       'intent_plan_mismatch','amount_mismatch','currency_mismatch',
                       'ownership_revoked','fraud_blocked','orphaned','ambiguous')),
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_pool_callbacks_payment ON payment_pool_callbacks (payment_id);

-- 4) payment_intents reservation binding + telemetry -------------------------
ALTER TABLE payment_intents
  ADD COLUMN pool_link_index      int,
  ADD COLUMN pool_reference_id    text,
  ADD COLUMN reservation_status   text,
  ADD COLUMN reservation_expires_at timestamptz,
  ADD COLUMN reservation_fulfilled_at timestamptz,
  ADD COLUMN reservation_locked_at timestamptz,
  ADD COLUMN pool_session_id      text,
  ADD COLUMN pool_client_ip       text,
  ADD COLUMN pool_heartbeat_last  timestamptz;

CREATE INDEX idx_payment_intents_pool_link
  ON payment_intents (pool_link_index) WHERE pool_link_index IS NOT NULL;

-- 5) Extend evidence source CHECK with razorpay_callback ---------------------
ALTER TABLE payment_evidence
  DROP CONSTRAINT IF EXISTS payment_evidence_source_check;
ALTER TABLE payment_evidence
  ADD CONSTRAINT payment_evidence_source_check
  CHECK (source IN ('gmail','ocr','razorpay_api','razorpay_webhook','razorpay_callback','manual'));

-- ---------------------------------------------------------------------------
-- RLS (pattern of 0015_rls.sql): system/service tables (pool + callbacks) are
-- accessed server-side (SYSTEM scope); reservations are owner-visible.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_link_pool ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_link_pool_service ON payment_link_pool USING (true);

ALTER TABLE payment_link_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_link_reservations_owner ON payment_link_reservations
  USING (user_id = app.uid());

ALTER TABLE payment_pool_callbacks ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_pool_callbacks_service ON payment_pool_callbacks USING (true);
