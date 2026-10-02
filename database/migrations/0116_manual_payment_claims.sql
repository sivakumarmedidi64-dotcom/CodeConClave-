-- ---------------------------------------------------------------------------
-- CodeConClave — MANUAL payment claims + founder approval (UNLOCK_MODE=MANUAL)
--
-- The user pays a Razorpay payment link (Solo ₹999 / Team ₹4,999 / API Access
-- ₹9,999), then submits the REAL Razorpay Payment ID (pay_...) against the
-- AUTHENTICATED payment intent they created at checkout. The founder approves
-- or rejects the claim on the Admin > Payments page. Approval activates the
-- existing entitlement authority inside a single transaction.
--
-- Distinguished from the legacy Gmail zero-admin rail (payment_claims, pcl_):
-- this table stores only REAL provider Payment IDs, binds every claim to the
-- authenticated intent, keeps a server-authoritative amount (client input is
-- never trusted), and moves exactly-once state to APPROVED/REJECTED.
--
-- Additive only. Every tenant table: user_id + RLS + FKs + indexes.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_claim_reviews (
  id                  text PRIMARY KEY,
  user_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email               text NOT NULL CHECK (email <> ''),
  intent_id           text NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  plan_id             text NOT NULL CHECK (plan_id IN ('pro','team','api')),
  purchase_type       text NOT NULL CHECK (purchase_type IN ('solo','team','api_access')),
  amount_inr          integer NOT NULL CHECK (amount_inr >= 0),
  currency            text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  razorpay_payment_id text NOT NULL UNIQUE CHECK (razorpay_payment_id <> ''),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  source              text NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  rejection_reason    text,
  review_locked_at    timestamptz,
  notification_sent_at timestamptz,
  decided_by          text REFERENCES users(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- A rejected claim MUST carry a reason; only REJECTED claims may carry one.
  CONSTRAINT payment_claim_reviews_rejection_consistent
    CHECK ((status = 'REJECTED') = (rejection_reason IS NOT NULL))
);

-- One live (PENDING) claim per user at a time, and one per intent.
CREATE UNIQUE INDEX uq_payment_claim_reviews_user_pending
  ON payment_claim_reviews (user_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX uq_payment_claim_reviews_intent_pending
  ON payment_claim_reviews (intent_id) WHERE status = 'PENDING';

-- Admin "inbox" ordering + per-user history lookup.
CREATE INDEX idx_payment_claim_reviews_status_created
  ON payment_claim_reviews (status, created_at DESC);
CREATE INDEX idx_payment_claim_reviews_user_created
  ON payment_claim_reviews (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS (defense in depth; the backend connects as table owner which bypasses
-- RLS, so application-level authorization remains authoritative — same model
-- as every other tenant table).
--   - a user sees/creates their own claims;
--   - admins (owner/admin rbac_role) may read every claim to run the inbox;
-- ---------------------------------------------------------------------------
ALTER TABLE payment_claim_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_claim_reviews_select ON payment_claim_reviews
  FOR SELECT
  USING (
    user_id = app.uid()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = app.uid() AND u.rbac_role IN ('owner','admin'))
  );

CREATE POLICY payment_claim_reviews_insert ON payment_claim_reviews
  FOR INSERT
  WITH CHECK (user_id = app.uid());

CREATE POLICY payment_claim_reviews_update ON payment_claim_reviews
  FOR UPDATE
  USING (
    user_id = app.uid()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = app.uid() AND u.rbac_role IN ('owner','admin'))
  )
  WITH CHECK (
    user_id = app.uid()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = app.uid() AND u.rbac_role IN ('owner','admin'))
  );