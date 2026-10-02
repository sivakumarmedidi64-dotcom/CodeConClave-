-- ---------------------------------------------------------------------------
-- CodeConClave — PHASE 4D: Razorpay payment + entitlements hardening.
-- Server-authoritative payment state machine, evidence providers, idempotent
-- entitlements, tenant isolation, approval-gated admin payment actions.
--
-- NOTE: static-only migration. PostgreSQL runtime is NOT available in this
-- environment; this file is validated for SQL syntax only. It must remain
-- idempotent-compatible with the runtime (applied once, never re-run).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- payment_sessions — tenant isolation + idempotency + full state machine.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_sessions
  ADD COLUMN tenant_id text NOT NULL DEFAULT app.uid();

ALTER TABLE payment_sessions
  ADD COLUMN idempotency_key text;

-- Client-supplied idempotency keys must be unique per deployment; the same
-- key always resolves to the same session (dedupe in createPaymentSession).
CREATE UNIQUE INDEX uq_payment_sessions_idempotency_key
  ON payment_sessions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_payment_sessions_tenant_state
  ON payment_sessions (tenant_id, state, created_at DESC);

-- Full server-authoritative state machine (Phase 4D spec):
-- CREATED -> PENDING -> DETECTED -> VERIFYING -> VERIFIED
--            -> ENTITLEMENT_ACTIVE -> COMPLETED
-- Failure: EXPIRED / FAILED / CANCELLED / REJECTED / ACTIVATION_FAILED / REFUNDED
ALTER TABLE payment_sessions
  DROP CONSTRAINT payment_sessions_state_check;

ALTER TABLE payment_sessions
  ADD CONSTRAINT payment_sessions_state_check CHECK (
    state IN (
      'CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'VERIFIED',
      'ENTITLEMENT_ACTIVE', 'COMPLETED',
      'EXPIRED', 'FAILED', 'CANCELLED', 'REJECTED', 'ACTIVATION_FAILED', 'REFUNDED'
    )
  );

-- ---------------------------------------------------------------------------
-- payments — idempotency, activation linkage, payment status states.
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX uq_payments_idempotency_key
  ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Link the capture record to the single entitlement activation it produced.
ALTER TABLE payments
  ADD COLUMN entitlement_id text REFERENCES entitlements(id);

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_status_check CHECK (
    status IN ('PENDING', 'CAPTURED', 'COMPLETED', 'FAILED', 'REFUNDED')
  );

ALTER TABLE payments
  ADD CONSTRAINT payments_provider_check CHECK (provider IN ('razorpay'));

-- ---------------------------------------------------------------------------
-- entitlements — revocation + plan authorization.
-- Exactly-one activation per verified payment is enforced by the unique
-- (user_id, plan_id) constraint combined with idempotent upserts.
-- ---------------------------------------------------------------------------
ALTER TABLE entitlements
  DROP CONSTRAINT entitlements_state_check;

ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_state_check CHECK (
    state IN (
      'FREE', 'PRO_PENDING', 'PRO_VERIFIED', 'PRO_EXPIRED', 'PRO_REFUNDED', 'REVOKED'
    )
  );

ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_plan_check CHECK (
    plan_id IN ('free', 'pro', 'team', 'enterprise')
  );

-- ---------------------------------------------------------------------------
-- payment_events / payment_audit — audit linkage to the capture record.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_events
  ADD COLUMN payment_id text REFERENCES payments(id);

CREATE INDEX idx_payment_events_payment ON payment_events (payment_id);

ALTER TABLE payment_audit
  ADD COLUMN payment_id text REFERENCES payments(id);

CREATE INDEX idx_payment_audit_payment ON payment_audit (payment_id);

-- ---------------------------------------------------------------------------
-- RLS: unchanged from 0015_rls.sql — payment_sessions / payments / entitlements
-- / payment_events / payment_audit all enforce tenant (user) scoping there.
-- The new columns (tenant_id, idempotency_key, payment_id, entitlement_id) are
-- covered by the existing USING clauses; no additional policies are required.
-- tenant_id defaults to app.uid() at insert time so RLS remains consistent.
-- ---------------------------------------------------------------------------