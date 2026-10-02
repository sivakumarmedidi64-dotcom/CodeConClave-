-- ---------------------------------------------------------------------------
-- CodeConClave — API ACCESS product + payment identity hardening.
--
-- 1) users.plan_id CHECK extended. The previous CHECK ('free','pro') made every
--    Team activation (plan_id='team') a DB constraint violation — Team grants
--    were silently impossible at the storage layer. Extend to the current plan
--    set. ('api' and 'enterprise' are permitted for future add-ons; API Access
--    itself never writes users.plan_id — it is an add-on entitlement.)
-- 2) payment_intents.plan_id CHECK extended with 'api' and an explicit
--    purchase_type column added. Purchase identity NEVER comes from amount or
--    link id (Team and API Access share the ₹4999 link) — it comes from the
--    server-authoritative intent plan + purchase_type (solo / team / api_access).
-- 3) payment_link_pool / payment_link_reservations plan CHECKs extended with
--    'api' so the pool can hold API Access links bound by plan.
-- 4) entitlements plan CHECK extended with 'api' (add-on entitlement).
-- 5) payment_link_pool.payment_link_id UNIQUE (partial) — one live Razorpay
--    payment-link id may exist in the catalogue at most once, so a callback can
--    never be redirected to a different pool entry.
-- ---------------------------------------------------------------------------

-- 1) users plan CHECK ------------------------------------------------
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_plan_id_check;
ALTER TABLE users
  ADD CONSTRAINT users_plan_id_check
  CHECK (plan_id IN ('free','pro','team','api','enterprise'));

-- 2) payment_intents: plan + explicit purchase identity ------------------
ALTER TABLE payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_plan_id_check;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_plan_id_check
  CHECK (plan_id IN ('pro','team','api'));

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS purchase_type text;

UPDATE payment_intents
   SET purchase_type = CASE plan_id
                        WHEN 'pro'  THEN 'solo'
                        WHEN 'team' THEN 'team'
                        WHEN 'api'  THEN 'api_access'
                        ELSE NULL END
 WHERE purchase_type IS NULL;

ALTER TABLE payment_intents
  ALTER COLUMN purchase_type SET NOT NULL;
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_purchase_type_check
  CHECK (purchase_type IN ('solo','team','api_access'));

-- 3) pool catalogue + reservations plan CHECKs ---------------------------
ALTER TABLE payment_link_pool
  DROP CONSTRAINT IF EXISTS payment_link_pool_plan_check;
ALTER TABLE payment_link_pool
  ADD CONSTRAINT payment_link_pool_plan_check
  CHECK (plan IN ('pro','team','api'));

ALTER TABLE payment_link_reservations
  DROP CONSTRAINT IF EXISTS payment_link_reservations_plan_check;
ALTER TABLE payment_link_reservations
  ADD CONSTRAINT payment_link_reservations_plan_check
  CHECK (plan IN ('pro','team','api'));

-- 4) entitlements plan CHECK ---------------------------------------------
ALTER TABLE entitlements
  DROP CONSTRAINT IF EXISTS entitlements_plan_check;
ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_plan_check
  CHECK (plan_id IN ('free','pro','team','enterprise','api'));

-- 5) unique payment_link_id in the pool catalogue -------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_pool_link_payment_link_id
  ON payment_link_pool (payment_link_id)
  WHERE payment_link_id IS NOT NULL;