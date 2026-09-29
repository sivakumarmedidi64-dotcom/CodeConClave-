# LIVE TEST CHECKLIST (human-controlled; agent STOPS before any transaction)

Status: **PLANNED — NOT EXECUTED.** Nothing on this list has been run against
a real Razorpay account. This repo mandate forbids live provider calls, real
₹ transactions, and fabricated "live verification" results.

Purpose: give a human operator the exact manual steps to prove the payment
link-pool rail against a real Razorpay key, one deterministic checkout at a
time. The agent's role ends immediately before step 0: **the human runs every
step, including the ₹1 transaction.**

## Preconditions (human)

- [ ] `.env`/deployment has real `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`
      (API secret, not webhook secret).
- [ ] `PAYMENT_POOL_LINKS` contains REAL static payment links (not placeholders)
      with per-link `index` (≥1, sequential), `paymentUrl`, `referenceId`
      (`CCPOOL-<NNN>`), `amount` (INR, paise), `currency: 'INR'`, `plan`,
      `callbackPath` (`/cb/<index>`), `paymentLinkId`, `enabled: true`.
- [ ] `PAYMENT_WATCHTOWER_ALERT_EMAIL` set to an ops email that accepts outbox
      email (delivery via existing SMTP config). The watchtower is globally
      unscoped — no owner IDs gate what it inspects. With no address it still
      runs every check and emits `ALERT_DESTINATION_UNCONFIGURED`.
- [ ] Server boot log shows `PAYMENT_POOL_SEEDED` and no loud assert failure.
- [ ] Control-center pool page renders `configured == active == seeded`.

## Preview (no money moves)

1. [ ] `cd backend && npm run prove:payment` → all 16 INVARIANT lines PASS.
2. [ ] `npx vitest run src/modules/payments/pool/seeder.test.ts
       src/modules/payments/pool/pool.test.ts
       src/modules/payments/pool/self-service.test.ts
       src/modules/payments/control-center/control-center.test.ts
       src/modules/payments/pool/watchtower.test.ts
       src/modules/payments/gmail-claim.test.ts
       src/modules/payments/gmail-claim-hardening.test.ts` → all PASS.
3. [ ] `npm run db:seed:pool` → prints `PAYMENT_POOL_SEEDED`; rerun → idempotent
       (seeded 0, updated 0).

## Single live checkout (HUMAN; ₹1 real money, once)

4. [ ] Create one test user (A). Start checkout for `pro`.
5. [ ] Confirm A is redirected to a real Razorpay payment URL and the toast
       shows INR amount + reserved-slot semantics.
6. [ ] Pay ₹1 via a test payment method. Note the generated
       `razorpay_payment_id`.
7. [ ] Confirm the browser lands on `/cb/<index>` and the callback ledger row
       `payment_pool_callbacks` shows `accepted`.
8. [ ] Confirm `payment_intents` (A's intent) → ACTIVE, and an entitlement row
       exists for A with origin `razorpay_callback` / plan `pro`.
9. [ ] Confirm the control-center pool page shows the link still active and the
       reservation FULFILLED.
10. [ ] Re-deliver the same callback URL (replay): confirm outcome `duplicate`,
       no second activation, no second entitlement.

## Negative paths (HUMAN; same user or test user B)

11. [ ] Callback with a tampered signature → `invalid_signature`, no grant.
12. [ ] Callback for a link whose `amount` was changed in config → `amount_mismatch`.
13. [ ] Pay a link, then expire its reservation via
       `PAYMENT_POOL_TTL_MINUTES=0` + watchdog, then send the late callback →
       `reservation_expired`, fail closed.
14. [ ] Trigger the watchtower by breaking a check intentionally (e.g. a link
       `is_active = false` while `PAYMENT_WATCHTOWER_ALERT_EMAIL` is set) →
       confirm the alert EMAIL is delivered to that address and every C1–C7
       check still runs (global, read-only scan).
15. [ ] Confirm no callback response, log line, audit detail, or control-center
       payload contains the raw signature or the API secret.

## Sign-off

- [ ] Record below (human-only): link index used, payment id, callback outcome,
      entitlement row id, date, operator id.
- [ ] If ANY step differs from the expected outcome, STOP and open an issue;
      do not silently patch the checklist.