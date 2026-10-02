-- ---------------------------------------------------------------------------
-- CodeConClave — Gmail claim rail: zero-admin automatic payment activation.
--
-- One-time claim tokens for the Gmail-detected payment flow:
--   Apps Script detects Razorpay email → HMAC-signed payload → backend
--   validates → creates claim token → emails payer → payer clicks → activated.
--
-- The claim row is the only new state; everything else reuses the existing
-- payment_intents + entitlements architecture.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_claims (
  id              text PRIMARY KEY,
  intent_id       text NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  owner_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id         text NOT NULL,
  amount_inr      integer NOT NULL,
  payer_email     text NOT NULL,
  payment_id      text,
  reference       text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'PENDING',
  activated_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_claims_owner ON payment_claims (owner_id);
CREATE INDEX idx_payment_claims_token ON payment_claims (token_hash);
CREATE INDEX idx_payment_claims_status ON payment_claims (status, expires_at);
CREATE INDEX idx_payment_claims_payment_id ON payment_claims (payment_id) WHERE payment_id IS NOT NULL;
