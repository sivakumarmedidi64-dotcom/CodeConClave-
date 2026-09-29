-- CodeConClave — Razorpay API reconciliation fallback (webhook recovery rail).
--
-- Tracks the bounded backoff schedule and outcome for PENDING intents whose
-- signed webhook may have been delayed, missed or retry-exhausted. The API
-- rail NEVER activates directly: verification always funnels through the
-- existing autopilot intervention window (payment_auto_approvals) and its
-- unique-constraint guards, so webhook-first, API-first and simultaneous
-- orderings resolve to exactly ONE activation.
CREATE TABLE IF NOT EXISTS payment_reconciliation (
  intent_id           text PRIMARY KEY REFERENCES payment_intents(id) ON DELETE CASCADE,
  attempt             int NOT NULL DEFAULT 1,
  state               text NOT NULL DEFAULT 'SCHEDULED'
                      CHECK (state IN ('SCHEDULED','VERIFIED','EXHAUSTED','AMBIGUOUS')),
  verified_payment_id text,
  last_attempt_at     timestamptz,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_due
  ON payment_reconciliation (next_attempt_at) WHERE state = 'SCHEDULED';

CREATE TRIGGER trg_payment_reconciliation_updated_at
  BEFORE UPDATE ON payment_reconciliation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();