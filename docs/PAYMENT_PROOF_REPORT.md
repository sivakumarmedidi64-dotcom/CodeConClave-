# PAYMENT PROOF REPORT (npm run prove:payment)

Status: **ALL 16 INVARIANTS PASS** (backend, vitest, in-memory DB harness).

The payment link-pool rail is now backed by a single all-or-nothing proof
runner. One invariant fails -> the whole run exits non-zero. Nothing is
skipped to fake green, and the final invariant (I16) asserts that all 15
preceding invariants actually ran and passed.

## Command

```
cd backend
npm run prove:payment
```

## Result (fresh run)

```
INVARIANT 1  | SEED_FRESH                        | PASS
INVARIANT 2  | SEED_IDEMPOTENT                   | PASS
INVARIANT 3  | SINGLE_RESERVATION                | PASS
INVARIANT 4  | AMOUNT_MISMATCH                   | PASS
INVARIANT 5  | INR_ONLY                          | PASS
INVARIANT 6  | FORGED_SIGNATURE                  | PASS
INVARIANT 7  | REPLAY_BLOCKED                    | PASS
INVARIANT 8  | LATE_CALLBACK_SAFE                | PASS
INVARIANT 9  | AMBIGUOUS_FAILS_CLOSED            | PASS
INVARIANT 10 | BROWSER_CLOSE_NO_AUTO_GRANT       | PASS
INVARIANT 11 | EXACTLY_ONCE_SOLE_AUTHORITY       | PASS
INVARIANT 12 | CROSS_USER_ISOLATION              | PASS
INVARIANT 13 | NO_SELF_GRANT                     | PASS
INVARIANT 14 | WATCHTOWER_GLOBAL_READONLY       | PASS
INVARIANT 15 | SECRET_HYGIENE                    | PASS
INVARIANT 16 | NO_FAKES                         | PASS
```

## Invariant Table

| # | Key | Proves |
|---|-----|--------|
| I1 | SEED_FRESH | A fresh DB is automatically provisioned by the seeder on boot (no more ALL_LINKS_BUSY_TRY_AGAIN). |
| I2 | SEED_IDEMPOTENT | Reseeding never duplicates pool rows (upsert by link_index). |
| I3 | SINGLE_RESERVATION | 100 concurrent assigns against a one-link pool -> exactly 1 reserves, 99 fail closed. |
| I4 | AMOUNT_MISMATCH | A callback whose link amount drifts off the authoritative price never activates. |
| I5 | INR_ONLY | Non-INR entries are never seeded; a USD callback fails closed (currency_mismatch). |
| I6 | FORGED_SIGNATURE | A tampered HMAC grants nothing, is recorded, and the raw signature is never stored. |
| I7 | REPLAY_BLOCKED | Re-delivering an accepted payment_id can never re-activate (ledger + evidence gates). |
| I8 | LATE_CALLBACK_SAFE | A expires -> B reserves the freed link -> A's late callback fails closed, B untouched. |
| I9 | AMBIGUOUS_FAILS_CLOSED | Evidence that cannot be trusted never grants (fraud/duplicate fail-closed). |
| I10 | BROWSER_CLOSE_NO_AUTO_GRANT | Abandoned reservation never auto-grants; link re-assignable after expiry. |
| I11 | EXACTLY_ONCE_SOLE_AUTHORITY | Pool module never CALLS/IMPORTS applyDecision; activation.ts is the sole grant authority. |
| I12 | CROSS_USER_ISOLATION | Non-owners can never view or activate another user's intent (owner-scoped getIntent fail-closed). |
| I13 | NO_SELF_GRANT | No payment route writes eligibility/entitlement outside the authoritative rail. |
| I14 | WATCHTOWER_GLOBAL_READONLY | Watchtower is READ-ONLY and GLOBALLY UNSCOPED: every one of C1-C7 executes (no identity filter in any query), global evidence-integrity signals (replay/duplicate/ambiguous) fail closed, no alert destination -> nothing is skipped, alertSent=false and exactly one ALERT_DESTINATION_UNCONFIGURED warning is emitted. |
| I15 | SECRET_HYGIENE | Raw signature/secret never lands in callback result, ledger, or audit payloads. |
| I16 | NO_FAKES | All 15 invariants actually ran and passed; nothing skipped. |

## What It Drives

The suite drives the REAL modules (`seeder`, pool `service`, `callback`,
pipeline, `watchtower`) against an in-memory DB harness that mirrors the
pool's reservation/unique-index semantics (including skip-locked candidate
selection and the `uq_pool_reservation_live_link` /
`uq_pool_reservation_live_intent` unique-violation behavior). Only infra
boundaries are mocked: `db`, `audit`, `notify`, `outbox`, `logger`.

## Companion Runs

- `npx vitest run src/modules/payments/pool/seeder.test.ts` — seeder fresh-DB
  provisioning + idempotency + INR/amount gates + **real-link format tolerance**
  (Finding 4: long/unusual ids, HTTPS-with-query URL, whitespace normalization,
  per-link amount preservation, placeholder warning, invalid URL/empty id/non-INR
  rejection): **25/25 PASS**.
- `npx vitest run src/modules/payments/pool/pool.test.ts
  src/modules/payments/pool/self-service.test.ts` — reservation/callback suites.
- `npx vitest run src/modules/payments/gmail-claim.test.ts
  src/modules/payments/gmail-claim-hardening.test.ts` — **20/20 PASS** (route
  tests share ONE assembled-app server boot).
- `npx vitest run src/modules/payments/pool/watchtower.test.ts` —
  **7/7 PASS** (globally unscoped C1-C7; no-destination still runs everything +
  single ALERT_DESTINATION_UNCONFIGURED warning; STATE_UNREADABLE; read-only).
- `npm run typecheck` (backend) — clean.

## Round 2 status (all green)

- `npm run prove:payment` — **16/16 PASS, exit 0** (I14 re-proves the
  globally-unscoped watchtower).
- Backend full suite `npm test` — **145/145 files, 2688 passed, 8 skipped,
  0 failed** (CPU-contention root cause fixed: fork pool capped + one shared
  app boot for gmail-claim route tests).
- Frontend full suite — **396/396 PASS** (ReviewListPage hunk counts read from
  the list wrapper).
- Backend + frontend `npm run typecheck` and `npm run build` — clean.