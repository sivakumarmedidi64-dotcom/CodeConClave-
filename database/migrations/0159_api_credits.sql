-- 0159: API Access as prepaid credits.
--   Each verified ₹50,000 API Access payment GRANTS ₹50,000 of credits.
--   Every API call DEBITS its real token cost at the configured rate.
--   At ₹0 the API refuses new calls (402) until the next ₹50,000 top-up.
-- Amounts are integer paise. One grant per payment (unique payment_ref).
-- Owner-only under RLS; writes happen in system scope from the gateway rail.

CREATE TABLE IF NOT EXISTS api_credit_ledger (
  id           text PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('GRANT','DEBIT','ADJUST')),
  amount_paise bigint NOT NULL,
  tokens       integer,
  api_key_id   text,
  request_id   text,
  payment_ref  text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_credit_ledger_owner ON api_credit_ledger (owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_credit_ledger_payment ON api_credit_ledger (payment_ref) WHERE payment_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_credit_balances (
  owner_id      text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_paise bigint NOT NULL DEFAULT 0,
  granted_paise bigint NOT NULL DEFAULT 0,
  spent_paise   bigint NOT NULL DEFAULT 0,
  calls         bigint NOT NULL DEFAULT 0,
  last_topup_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE api_credit_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_credit_ledger_owner ON api_credit_ledger;
CREATE POLICY api_credit_ledger_owner ON api_credit_ledger USING (owner_id = app.uid());

ALTER TABLE api_credit_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_credit_balances_owner ON api_credit_balances;
CREATE POLICY api_credit_balances_owner ON api_credit_balances USING (owner_id = app.uid());
