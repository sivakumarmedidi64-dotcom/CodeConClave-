-- ---------------------------------------------------------------------------
-- CodeConClave — STAGE 26H: server-created payment-link binding + webhook
-- idempotency.
--
-- Extends the existing payment-intent architecture (NOT a parallel subsystem)
-- so a trusted, signed Razorpay webhook can resolve a payment to the exact
-- internal payment intent via server-authoritative identifiers:
--
--   CodeConClave payment_intent
--     -> Razorpay Payment Link ID     (provider_payment_link_id, unique)
--     -> Razorpay reference_id        (provider_reference_id, unique)
--     -> trusted payment.captured/payment_link.paid event
--     -> exact user + plan + amount   (owner_id / plan_id / amount_inr)
--
-- Email is NEVER the binding authority; it may only be a secondary signal.
-- A webhook with no unambiguous server-authoritative match must go to
-- REVIEW/PENDING and must NEVER auto-activate.
--
-- NOTE: static-only migration validated for SQL syntax; runtime Postgres is
-- not available in this environment.
-- ---------------------------------------------------------------------------

ALTER TABLE payment_intents
  ADD COLUMN provider_payment_link_id  text,
  ADD COLUMN provider_reference_id     text;

CREATE UNIQUE INDEX uq_payment_intents_provider_payment_link
  ON payment_intents (provider_payment_link_id)
  WHERE provider_payment_link_id IS NOT NULL;

CREATE UNIQUE INDEX uq_payment_intents_provider_reference
  ON payment_intents (provider_reference_id)
  WHERE provider_reference_id IS NOT NULL;

-- Delivery-level webhook idempotency: Razorpay may redeliver the same event
-- (same event.id) on retry. A unique index on event_id makes a re-delivery a
-- no-op instead of re-processing and risking duplicate entitlement grants.
CREATE TABLE payment_webhook_events (
  event_id      text PRIMARY KEY,
  intent_id     text REFERENCES payment_intents(id),
  event_type    text NOT NULL,
  payload_sha   text,
  handled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_webhook_events_created ON payment_webhook_events (created_at);
