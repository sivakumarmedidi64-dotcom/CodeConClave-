-- ---------------------------------------------------------------------------
-- CodeConClave — PAYMENT LINK-POOL: permanent link consumption (SPEC §24)
--
-- One payment link = one successful purchase. Once a reservation is fulfilled,
-- the pool link MUST be permanently non-allocatable. This is tracked with a
-- `consumed_at` timestamp on the pool row itself (NOT just is_active, which the
-- seeder converges from config and would otherwise resurrect the link at boot).
--
-- Implementation contract:
--   * assignLink only ever selects rows WHERE is_active = true AND consumed_at IS NULL
--   * finalizeReservation stamps consumed_at = now() when the reservation flips FULFILLED
--   * the seeder preserves consumed rows (never flips consumed_at -> NULL, and
--     treats a consumed link as permanently disabled regardless of config)
--
-- Additive only. No existing rows are disturbed.
-- ---------------------------------------------------------------------------

-- Consumed-at is a single tombstone: NULL while still allocatable, set once a
-- payment for that link has been fulfilled.
ALTER TABLE payment_link_pool
  ADD COLUMN consumed_at timestamptz;

-- Backfill: any link whose reservation history already reached FULFILLED is
-- treated as consumed immediately (data may already exist before this deploy).
-- FULFILLED is terminal in this codebase; is_active is permanently cleared for
-- those links so no future assign can hand them out again.
UPDATE payment_link_pool l
   SET consumed_at = r.min_fulfilled_at,
       is_active   = false
  FROM (
    SELECT r.link_index, min(r.fulfilled_at) AS min_fulfilled_at
      FROM payment_link_reservations r
     WHERE r.status = 'FULFILLED' AND r.fulfilled_at IS NOT NULL
     GROUP BY r.link_index
  ) r
 WHERE l.link_index = r.link_index;

-- Fast lookup for "is this link still allocatable?" at assign time.
CREATE INDEX idx_payment_link_pool_allocatable
  ON payment_link_pool (link_index)
  WHERE is_active = true AND consumed_at IS NULL;