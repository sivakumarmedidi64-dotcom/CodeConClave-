# PAYMENT LINK-POOL — FINAL GATE

Date: 2026-09-03
Implementation: **COMPLETE** — Payment Link-Pool (POLICY B) for static Razorpay
payment link correlation.

---

## Gate Status Lines

```
POLICY_B                                  = ENABLED
STATIC_LINK_POOL                          = IMPLEMENTED
ATOMIC_RESERVATION                        = VERIFIED
EXACT_LINK_BINDING                        = VERIFIED
HMAC_SIGNATURE                            = VERIFIED
AMOUNT_PLAN_CURRENCY_VALIDATION           = VERIFIED
FRAUD_GATES                               = VERIFIED
REPLAY_PROTECTION                         = VERIFIED
EXACTLY_ONCE                              = VERIFIED
LATE_CALLBACK_PROTECTION                  = VERIFIED
CROSS_USER_ISOLATION                      = VERIFIED
CROSS_WORKSPACE_ISOLATION                 = VERIFIED
AMBIGUOUS_FAIL_CLOSED                     = VERIFIED
ORPHAN_FAIL_CLOSED                        = VERIFIED
EXISTING_ACTIVATION_AUTHORITY_PRESERVED   = VERIFIED
GMAIL_FALLBACK_PRESERVED                  = VERIFIED
NO_API                                    = VERIFIED
NO_WEBHOOK                                = VERIFIED
NO_ADMIN_NORMAL_FLOW                      = VERIFIED
TYPECHECK                                 = PASSED
POOL_TESTS                                = PASSED
FULL_REGRESSION                           = PASSED
BUILD                                     = PASSED
RAZORPAY_REFERENCE_BEHAVIOR               = UNVERIFIED
AUTOMATIC_ACTIVATION                      = NOT_VERIFIED
```

## Bumper: Identity Honesty

**This system does NOT prove the physical payer's identity.** The entitlement
binds to the authenticated account that initiated the checkout intent and
atomically reserved the payment-link slot (POLICY B). A third party MAY pay as a
gift. Heartbeat / IP / timing / session cookie / email are telemetry only and
NEVER entitlement authority.

---

## Files Created
```
backend/src/modules/payments/pool/service.ts       (pool service: assign/reserve/release/heartbeat/status/sweep/callback helpers)
backend/src/modules/payments/pool/callback.ts        (callback handler: 16-point exactness + late-callback protection)
backend/src/modules/payments/pool/routes.ts          (INTENT/heartbeat/status auth + public /cb callback routes)
backend/src/modules/payments/pool/pool.test.ts       (30 security tests, all passing)
database/migrations/0059_payment_link_pool.sql       (pool schema + RLS + intents columns + evidence source CHECK)
backend/src/config/payment-pool.ts                   (PoolLinkConfig / paymentPoolConfig)
docs/PAYMENT_LINK_POOL_IMPLEMENTATION.md             (Phase 15 implementation record, 19 sections)
docs/PAYMENT_LINK_POOL_STEP1_AUDIT_COMPLETE.md      (STEP 1 audit, reuse % + safety decision)
```

## Files Modified
```
backend/src/config/env.ts                            (+PAYMENT_POOL_TTL_MINUTES, PAYMENT_POOL_LINKS)
backend/src/shared/ids.ts                            (+PREFIX.PAYMENT_RESERVATION, PREFIX.PAYMENT_CALLBACK)
backend/src/modules/payments/intents.ts              (+PaymentIntentRow reservation columns)
backend/src/modules/payments/evidence.ts             (+razorpay_callback source; matcher anchor uses intent reference)
backend/src/modules/payments/pipeline.ts             (+razorpay_callback in TRUSTED_EVIDENCE_SOURCES)
backend/src/modules/payments/control-center.ts       (+controlCenterPool read-only overview)
backend/src/modules/payments/control-center-routes.ts(+GET /control-center/pool read-only)
backend/src/app.ts                                   (+poolRoutes, poolCallbackRoutes mount; /cb outside auth router)
backend/src/workers/watchdog.ts                      (+expireStaleReservations sweep)
frontend/src/pages/SettingsPage.tsx                  (+pool rail in upgrade, Rail A fallback preserved)
```

## Migrations Created
```
database/migrations/0059_payment_link_pool.sql
```

## Verification Numbers
```
NEW_TEST_COUNT      = 30
FULL_TEST_COUNT     = 2292
FAILED_TEST_COUNT   = 0
SKIPPED_TEST_COUNT  = 3
TYPECHECK_RESULT    = PASSED (backend + frontend)
BUILD_RESULT        = PASSED (backend tsc; frontend typecheck)
```

## Notes / Caveats (Honest)
- `RAZORPAY_REFERENCE_BEHAVIOR = UNVERIFIED` and
  `AUTOMATIC_ACTIVATION = NOT_VERIFIED` because there is no live Razorpay
  environment here. A deployment MUST provision real static links
  (`PAYMENT_POOL_LINKS`) and confirm reference/amount/currency + the HMAC
  against the live secret before relying on automatic activation.
- PostgreSQL runtime is not available in the sandbox; migration 0059 was
  validated for SQL syntax only.
- prev gate baseline: 126 test files / 2262 tests. The +30 pool tests bring the
  suite to 127 files / 2292 tests. No existing tests were weakened.
