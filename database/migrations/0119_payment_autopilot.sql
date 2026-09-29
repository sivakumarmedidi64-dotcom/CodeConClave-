-- ---------------------------------------------------------------------------
-- CodeConClave — PAYMENT AUTOPILOT (UNLOCK_MODE=AUTOPILOT)
--
-- Runtime-switchable unlock mode + autopilot-sourced review claims.
--
-- 1. payment_unlock_settings: singleton runtime override of UNLOCK_MODE. The
--    env var is the boot default; this table allows an admin to FLIP the mode
--    at runtime (enable/disable AUTOPILOT) without redeploying, validated by
--    the backend against the autopilot readiness prerequisites. A row with
--    unlock_mode='MANUAL' is the kill switch (fail-closed default).
--
-- 2. payment_claim_reviews.source CHECK is extended from 'manual' to
--    ('manual','autopilot') so unverifiable autopilot events can be queued
--    into the founder's review inbox (fallback -> manual review queue).
--
-- 3. payment_evidence.source CHECK added 'razorpay_autopilot' (a trusted
--    source label) so an autopilot auto-verification is auditable by source in
--    the evidence table.
--
-- Additive only. Reversible via the DOWN section (see migrate runner).
-- ---------------------------------------------------------------------------

-- ---- 1. singleton runtime unlock mode --------------------------------------
CREATE TABLE payment_unlock_settings (
  id          text PRIMARY KEY CHECK (id = 'singleton'),
  unlock_mode text NOT NULL CHECK (unlock_mode IN ('MANUAL','AUTOPILOT')),
  changed_by  text,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- The singleton row may be pre-seeded (opt-in: no row = env default only).
-- INSERT with DO NOTHING so a fresh DB never silently flips a deployed mode.
-- (Only an explicit admin enable writes the row; see autopilot/service.ts.)

-- ---- 2. extend claim source CHECK ------------------------------------------
-- 0116 created the table with `CHECK (source = 'manual')`. Drop the constraint
-- and re-add with autopilot allowed (idempotent for re-runs). The inline
-- unnamed constraint is auto-named payment_claim_reviews_source_check.
ALTER TABLE payment_claim_reviews DROP CONSTRAINT IF EXISTS payment_claim_reviews_source_check;
ALTER TABLE payment_claim_reviews
  ADD CONSTRAINT payment_claim_reviews_source_check
  CHECK (source IN ('manual','autopilot'));

-- ---- 3. extend evidence source CHECK with razorpay_autopilot ----------------
-- 0059 set the source CHECK to hook razorpay_callback into the 26H registry;
-- the autopilot verification rail is an equally trusted, config-gated source.
ALTER TABLE payment_evidence
  DROP CONSTRAINT IF EXISTS payment_evidence_source_check;
ALTER TABLE payment_evidence
  ADD CONSTRAINT payment_evidence_source_check
  CHECK (source IN ('gmail','gmail_imap','ocr','razorpay_api','razorpay_webhook','razorpay_callback','razorpay_autopilot','manual'));

-- ---- 4. index recent autopilot-sourced evidence for admin surfacing ---------
CREATE INDEX IF NOT EXISTS idx_payment_evidence_source_created
  ON payment_evidence (source, created_at DESC);