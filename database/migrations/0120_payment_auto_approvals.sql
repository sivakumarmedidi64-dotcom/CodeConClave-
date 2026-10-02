-- CodeConClave — PAYMENT AUTOPILOT INTERVENTION WINDOW (FOUNDER CONTROL).
--
-- AUTOPILOT: a signed-webhook verified payment does not activate instantly.
-- It lands in this durable table as PENDING_APPROVAL — a server-side,
-- persisted 2-second intervention window (PAYMENT_AUTO_APPROVAL_MS). During
-- that window the founder can STOP/HOLD the auto-approval (idempotent, via
-- payment_auto_approvals.state); if nobody acts, the in-process sweep
-- transitions the row to AUTO_APPROVED and runs the SAME trusted activation
-- authority (pipeline.ingestEvidence -> applyDecision -> activateEntitlement).
--
-- Guarantees:
--   * durable: survives restarts (the sweep resumes by created_at);
--   * exactly-once: the PENDING_APPROVAL -> AUTO_APPROVED transition is an
--     atomic guarded UPDATE (one sweep wins); a payment_id is UNIQUE so a
--     re-delivered/replayed webhook can never schedule a second approval;
--   * fail-closed: STOP before the window ends moves the intent to REVIEW and
--     queues a founder review; an already-AUTO_APPROVED activation can never
--     be rolled back by STOP.
CREATE TABLE IF NOT EXISTS payment_auto_approvals (
  id            text PRIMARY KEY,
  intent_id     text NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  payment_id    text NOT NULL UNIQUE,
  plan_id       text NOT NULL,
  purchase_type text NOT NULL,
  amount_inr    integer NOT NULL,
  payer_email   text,
  owner_id      text NOT NULL,
  -- The resolver-normalized signal payload re-fed to the trusted pipeline at
  -- approval time ({ paymentId, amountInr, payerEmail, paidAt }).
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  state         text NOT NULL DEFAULT 'PENDING_APPROVAL'
                CHECK (state IN ('PENDING_APPROVAL', 'AUTO_APPROVED', 'STOPPED')),
  decided_by    text,
  stop_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  stopped_at    timestamptz,
  tenant_id     text
);

CREATE INDEX IF NOT EXISTS ix_payment_auto_approvals_state_created
  ON payment_auto_approvals (state, created_at);

CREATE INDEX IF NOT EXISTS ix_payment_auto_approvals_intent
  ON payment_auto_approvals (intent_id);