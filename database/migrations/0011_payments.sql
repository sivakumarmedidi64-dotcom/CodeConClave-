-- 0011: payments — payment_sessions, payments, entitlements, payment_events, payment_audit
-- FROZEN: PENDING -> VERIFIED requires independent provider evidence.

CREATE TABLE payment_sessions (
  id                    text PRIMARY KEY,
  user_id               text NOT NULL REFERENCES users(id),
  plan_id               text NOT NULL,
  amount_inr            int NOT NULL,
  currency              text NOT NULL DEFAULT 'INR',
  mode                  text NOT NULL CHECK (mode IN ('PAYMENT_LINK','API','WEBHOOK')),
  state                 text NOT NULL DEFAULT 'PENDING'
                        CHECK (state IN ('PENDING','VERIFIED','FAILED','EXPIRED','REFUNDED','CANCELLED')),
  reference             text,
  provider_payment_id   text,
  provider_order_id     text,
  verification_evidence jsonb,
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_payment_sessions_provider_payment ON payment_sessions (provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX idx_payment_sessions_user_state ON payment_sessions (user_id, state);
CREATE INDEX idx_payment_sessions_state_expires ON payment_sessions (state, expires_at);

CREATE TRIGGER trg_payment_sessions_updated_at
  BEFORE UPDATE ON payment_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
  id                    text PRIMARY KEY,
  session_id            text NOT NULL REFERENCES payment_sessions(id),
  amount_inr            int NOT NULL,
  currency              text NOT NULL DEFAULT 'INR',
  status                text NOT NULL DEFAULT 'PENDING',
  provider              text NOT NULL DEFAULT 'razorpay',
  provider_ref          text UNIQUE,
  paid_at               timestamptz,
  verification_evidence jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE entitlements (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL REFERENCES users(id),
  plan_id             text NOT NULL,
  state               text NOT NULL CHECK (state IN ('FREE','PRO_PENDING','PRO_VERIFIED','PRO_EXPIRED','PRO_REFUNDED')),
  verified_at         timestamptz,
  expires_at          timestamptz,
  payment_session_id  text REFERENCES payment_sessions(id),
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_entitlements_user_plan UNIQUE (user_id, plan_id)
);

CREATE TRIGGER trg_entitlements_updated_at
  BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_events (
  id               text PRIMARY KEY,
  session_id       text REFERENCES payment_sessions(id),
  user_id          text REFERENCES users(id),
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  source           text NOT NULL CHECK (source IN ('WEBHOOK','API','LINK','ADMIN')),
  signature_valid  boolean,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_events_session_created ON payment_events (session_id, created_at);

CREATE TABLE payment_audit (
  id                text PRIMARY KEY,
  session_id        text NOT NULL REFERENCES payment_sessions(id),
  actor_user_id     text REFERENCES users(id),
  action            text NOT NULL,
  detail            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_audit_session ON payment_audit (session_id, created_at);