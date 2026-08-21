-- 0036: PHASE 14 — production notifications + billing/ops hardening.
-- Outbox delivery state (error classification, idempotency) + digest deliveries.
-- No duplicate payment/entitlement tables: billing UX reads the existing
-- payment_sessions / entitlements / payment_events / payment_audit schema.

-- ---------------------------------------------------------------------------
-- outbox_events: delivery failure state + idempotency key.
-- last_error carries the classified provider error (class + message) of the
-- last failed attempt; dedupe_key makes enqueue idempotent per event so the
-- same logical event can never be delivered twice.
-- ---------------------------------------------------------------------------

ALTER TABLE outbox_events
  ADD COLUMN last_error text,
  ADD COLUMN dedupe_key text;

CREATE UNIQUE INDEX idx_outbox_dedupe_key
  ON outbox_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- digest_deliveries: server-side digest foundation. One row per
-- (owner, frequency, period) — the UNIQUE constraint is the idempotency
-- guard: a daily/weekly period is never delivered twice. Evidence is the
-- real persisted aggregate; summary_text is deterministic unless the AI
-- gateway produced an evidence-only narrative (ai_generated).
-- ---------------------------------------------------------------------------

CREATE TABLE digest_deliveries (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frequency    text NOT NULL CHECK (frequency IN ('daily','weekly')),
  period_key   text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_text text NOT NULL,
  ai_generated boolean NOT NULL DEFAULT false,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_digest_deliveries UNIQUE (owner_id, frequency, period_key)
);

CREATE INDEX idx_digest_deliveries_owner ON digest_deliveries (owner_id, frequency, delivered_at DESC);

ALTER TABLE digest_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY digest_deliveries_owner ON digest_deliveries
  USING (owner_id = app.uid());