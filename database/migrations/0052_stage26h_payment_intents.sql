-- ---------------------------------------------------------------------------
-- CodeConClave — STAGE 26H: payment intents + evidence rail + entitlement.
-- Razorpay stays the provider. This migration adds the intent/evidence/
-- reconciliation/digest tables that power the confidence-based activation
-- pipeline. Screenshots/OCR are evidence inputs — never authority.
--
-- NOTE: static-only migration. PostgreSQL runtime is NOT available in this
-- environment; this file is validated for SQL syntax only.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_intents (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id),
  plan_id           text NOT NULL CHECK (plan_id IN ('pro','team')),
  amount_inr        int NOT NULL,
  currency          text NOT NULL DEFAULT 'INR',
  reference         text NOT NULL,
  payment_link      text NOT NULL,
  mode              text NOT NULL DEFAULT 'PAYMENT_LINK',
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','REVIEW','ACTIVE','GRACE','EXPIRED','REFUNDED','REVOKED','CHARGEBACK')),
  confidence        numeric(4,3) NOT NULL DEFAULT 0,
  decision          text CHECK (decision IN ('ACTIVE','REVIEW','PENDING')),
  thresholds_used   jsonb,
  fraud_flags       jsonb,
  expires_at        timestamptz NOT NULL,
  grace_until       timestamptz,
  activated_at      timestamptz,
  evidence_summary  jsonb,
  tenant_id         text NOT NULL DEFAULT app.uid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_intents_reference UNIQUE (reference)
);

CREATE INDEX idx_payment_intents_owner_status ON payment_intents (owner_id, status, created_at DESC);
CREATE INDEX idx_payment_intents_status_expires ON payment_intents (status, expires_at);

CREATE TRIGGER trg_payment_intents_updated_at
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Evidence rail: normalized signals only. Source CHECK matches the adapter
-- registry (PaymentEvidenceSource). sha256 dedupes screenshots/payloads
-- (replay guard); provider_payment_id is globally unique (duplicate-ID guard).
CREATE TABLE payment_evidence (
  id                    text PRIMARY KEY,
  intent_id             text REFERENCES payment_intents(id),
  owner_id              text NOT NULL REFERENCES users(id),
  source                text NOT NULL
                        CHECK (source IN ('gmail','ocr','razorpay_api','razorpay_webhook','manual')),
  provider_payment_id   text,
  utr                   text,
  reference             text,
  amount_inr            int,
  payer_email           text,
  paid_at               timestamptz,
  sha256                text NOT NULL,
  signals               jsonb NOT NULL,
  matched               boolean NOT NULL DEFAULT false,
  fraud_flags           jsonb,
  tenant_id             text NOT NULL DEFAULT app.uid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_evidence_sha UNIQUE (sha256)
);

CREATE UNIQUE INDEX uq_payment_evidence_provider_payment
  ON payment_evidence (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX idx_payment_evidence_intent ON payment_evidence (intent_id, created_at);
CREATE INDEX idx_payment_evidence_owner ON payment_evidence (owner_id, created_at);

CREATE TABLE payment_reconciliations (
  id            text PRIMARY KEY,
  run_by        text REFERENCES users(id),
  intents       int NOT NULL,
  evidence      int NOT NULL,
  entitlements  int NOT NULL,
  drift         jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'COMPLETED'
                CHECK (status IN ('COMPLETED','COMPLETED_WITH_DRIFT','FAILED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_reconciliations_created ON payment_reconciliations (created_at DESC);

CREATE TABLE payment_digests (
  id            text PRIMARY KEY,
  bucket        text NOT NULL,
  period_days   int NOT NULL,
  stats         jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_digests_bucket UNIQUE (bucket)
);

-- ---------------------------------------------------------------------------
-- RLS (pattern of 0015_rls.sql): owner-scoped with tenant fallback.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_intents_owner ON payment_intents
  USING (owner_id = app.uid() OR tenant_id = app.uid())
  WITH CHECK (owner_id = app.uid());

ALTER TABLE payment_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_evidence_owner ON payment_evidence
  USING (owner_id = app.uid() OR tenant_id = app.uid())
  WITH CHECK (owner_id = app.uid());

ALTER TABLE payment_reconciliations ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_reconciliations_owner ON payment_reconciliations
  USING (run_by = app.uid());

ALTER TABLE payment_digests ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_digests_owner ON payment_digests
  USING (true);