# PAYMENT LINK-POOL (POLICY B) — Implementation

Status: **IMPLEMENTED** (backend + tests + frontend integration).

This document is the authoritative record of the static Payment Link-Pool
correlation rail. It pairs with:
- `PAYMENT_LINK_POOL_STEP1_AUDIT_COMPLETE.md` — the STEP 1 audit (reuse % and
  per-file decision).
- `PAYMENT_ARCHITECTURE_RECONCILIATION.md` / `PAYMENT_LINK_POOL_FEASIBILITY.md` /
  `FINAL_PRECREATED_LINK_POOL_FEASIBILITY.md` — earlier design feasibility work.
- `database/migrations/0059_payment_link_pool.sql` — the schema.

---

## 1. Executive Summary

CodeConClave now supports **automatic, 24x7 payment activation** using a pool
of **static Razorpay payment links** — with **no Razorpay API**, **no webhook**,
and **no admin in the normal flow** (all three providers/behaviors are
unavailable in this environment; static payment links are available).

POLICY B binds the entitlement to the **authenticated account that initiated
the checkout intent and atomically reserved the link slot**. The physical payer
may be a third party (gift), and **this system NEVER claims to prove the
physical payer's identity**.

## 2. Scope & Non-Goals

**In scope**
- A static pre-created pool of Razorpay payment links (`payment_link_pool`).
- Atomic, TTL'd link→intent reservation (`payment_link_reservations`).
- A callback handler that binds the provider's browser-redirect callback
  (HMAC-verified) to its **exact** reservation and intent.
- Reuse of the existing trusted evidence pipeline and **activation.ts as the
  SOLE grant authority**.
- Read-only observability in the private control center.

**Out of scope / explicitly NOT claimed**
- Zhis system does NOT prove the physical payer's identity.
- No Razorpay API / webhook usage.
- No manual admin activation in the normal flow.
- No "most-recent-intent-wins" behavior.
- No removal or weakening of Rail A (Gmail evidence) — it remains a fallback.

## 3. Policy Model (POLICY B)

The account that `authenticated`, created the checkout `intent`, and
`atomically reserved` a payment-link slot is the account entitled to receive
the resulting entitlement. A third party MAY pay the link as a gift. Once a
reserved link is paid and the callback is fully validated against that exact
reservation, the reserved account is entitled — without ever asserting the
payer's real-world identity.

The following are treated only as **telemetry**, never entitlement authority:
heartbeat, IP, timing, session cookie, and email. Honest documentation of this
boundary is part of the security contract.

## 4. Flow

1. **Checkout** — the authenticated user requests a plan (`pro`/`team`).
   `assignLink` picks a live, plan-matching link and atomically inserts a
   `RESERVED` reservation for a new/reused intent, bounded by the TTL.
2. **Link reservation** — the intent is bound to
   `pool_link_index` + `pool_reference_id` (immutable), plus telemetry
   (`session_id`, `client_ip`, `heartbeat_last`).
3. **Pay** — the user (or gift payer) pays the static link URL.
4. **Callback** — Razorpay redirects `GET /cb/:linkIndex`. The handler runs the
   full exactness validation (below), then routes through the trusted
   `razorpay_callback` evidence source → `applyDecision` (activation.ts) →
   entitlement.
5. **Merge/Observe** — the watchdog expires stale reservations; the control
   center reports pool health read-only.

## 5. Atomic Link Reservation & Concurrency

`assignLink`:
- Selects a candidate link with `SELECT ... FOR UPDATE SKIP LOCKED` (avoids two
  concurrent assigns on the same row).
- Inserts the reservation; the partial unique indexes
  `uq_pool_reservation_live_link` (one live per link) and
  `uq_pool_reservation_live_intent` (one live per intent) make a double
  reservation impossible at the DB level. On unique-violation the code moves to
  the next candidate.
- Raised `AppError.unavailable('ALL_LINKS_BUSY_TRY_AGAIN')` -> HTTP **503** when
  every live link is already reserved.

## 6. Reservation TTL & Expiry

TTL = `PAYMENT_POOL_TTL_MINUTES` (default 15). The watchdog
(`expireStaleReservations`, integrated into `workers/watchdog.ts`'s `sweepOnce`
loop, SWEEP_MS 15s) conditionally transitions `RESERVED -> EXPIRED` and clears
the intent's reservation binding. Expiry is **irreversible/immutable**:
a late callback for an expired reservation resolves to that EXPIRED reservation
and **fails closed** — it can never activate the current reservation or intent.

## 7. Callback Signature Verification

The callback is unauthenticated at the router level; **authentication is the
HMAC signature**. Verification uses `node:crypto` `createHmac('sha256',
RAZORPAY_KEY_SECRET)` and `timingSafeEqual` (never string equality). The message
is the callback identity —
`${razorpay_payment_link_reference_id}:${razorpay_payment_id}`. RAZORPAY_KEY_SECRET
is the **API secret**, not the webhook secret.

## 8. Callback Validation (16-point)

For `GET /cb/:linkIndex`, the handler, in order:
1. HMAC signature valid.
2. link index is an integer ≥ 1.
3. payment_id present.
4. payment_id not already processed (replay guard via callback ledger
   `payment_pool_callbacks`).
5. link index maps to an enabled pool record.
6. payment_link_id matches the pool record (if provided).
7. reference_id matches the pool record (if provided).
8. payment_link_status is acceptable.
9. an exact reservation exists for the pool link's reference.
10. reservation is still valid (not EXPIRED/RELEASED/FULFILLED) and belongs to
    the exact link.
11. intent exists (owned by the reservation's user).
12. intent.plan matches the pool link plan.
13. intent amount matches the pool link amount.
14. currency matches.
15. ownership (reservation.user == intent.owner); fraud gates (reuses `checkFraud`).
16. payment_id has not already produced evidence.

Failures map to distinct, honest outcomes: `bad_link_index`, `link_disabled`,
`link_id_mismatch`, `reference_mismatch`, `bad_status`, `orphaned`,
`reservation_expired`, `reservation_released`, `reservation_fulfilled`,
`intent_plan_mismatch`, `amount_mismatch`, `currency_mismatch`,
`ownership_revoked`, `fraud_blocked`, `ambiguous`, `duplicate`,
`invalid_signature`.

## 9. Late-Callback Protection (OLD CALLBACK ≠ NEW RESERVATION)

Binding is by the **immutable** `link_index` + `link_reference_id`. A callback
always resolves to the reservation live at payment time via the link reference.
There is **no "most-recent-intent-wins"** logic. Scenario verified by test:
A reserves and expires → B reserves → A's late callback resolves to A's EXPIRED
reservation and fails closed, leaving B untouched. `releaseLink` also clears the
old intent's binding so a stale callback can't resolve to a newer intent.

## 10. Replay & Exactly-Once

- The callback ledger `payment_pool_callbacks` keyed by `payment_id` makes a
  replayed callback a terminal `duplicate` no-op.
- Activation itself is exactly-once via activation.ts's conditional
  `PENDING/REVIEW -> ACTIVE` UPDATE (race guard): a concurrent double-apply loses
  the race and never double-activates / never double-grants.

## 11. Entitlement Authority

**activation.ts `applyDecision` is the SOLE grant authority.** The pool module
and callback handler NEVER call `applyDecision` directly and never write an
ACTIVE intent or entitlement. They only feed the trusted `razorpay_callback`
evidence source into `ingestEvidence`, which routes to `applyDecision`. Rail A
(Gmail) and the pipeline remain the second-entitlement-authority-free path.

## 12. Trusted Evidence Source

`razorpay_callback` is registered in `evidence.ts` (availability gated by
`env.RAZORPAY_KEY_SECRET`) and added to `TRUSTED_EVIDENCE_SOURCES` in
`pipeline.ts`, so a fully validated pool callback is treated as a trusted
provider rail and may reach ACTIVE — unlike OCR/manual sources which are forced
to REVIEW and can never grant.

Important correctness note: the matcher's anchor signal is
`reference === intent.reference`. The static pool link's `reference_id` is
pool-scoped/shared (`CCPOOL-<NNN>`) and never equals the per-user intent
reference. Because the callback layer has already proven, via reservation
binding + plan/amount/currency/ownership + fraud, that the payment belongs to
the bound intent, `razorpayCallbackSource.collect` uses the **intent's** own
reference as the evidence reference (passed in as `intentReference`). Without
this, the considered rail could never reach ACTIVE despite an exact, verified
binding. This is documented in the evidence.ts source.

## 13. Fraud & Privacy Net

- `checkFraud` (existing) is reused for duplicate payment id, reference reuse,
  amount/plan mismatch, payer anomaly, and velocity.
- Blocking flags (`duplicate_payment_id`, `screenshot_replay`, `reference_reuse`,
  `amount_mismatch`, `plan_mismatch`) force REVIEW, never ACTIVE.
- Ambiguous and orphaned callbacks fail closed (no entitlement).
- No secret is ever returned to clients (control-center responses contain no
  tokens/credentials/raw payloads).

## 14. API Surface

- `POST /api/pay/pool/intent` (authenticated) — create intent + reserve link.
- `POST /api/pay/pool/heartbeat` (authenticated) — telemetry refresh (no
  entitlement).
- `GET /api/pay/pool/status/:intentId` (authenticated + ownership) — status.
- `GET /cb/:linkIndex` (unauthenticated, HMAC-verified) — provider callback,
  mounted OUTSIDE the auth-gated router (like `paymentWebhookRoutes` /
  `gmailClaimRoutes`).
- `GET /api/v1/payments/control-center/pool` (founder/admin) — read-only pool
  health. No activate/grant control.

## 15. Schema (migration 0059)

- `payment_link_pool` — static link catalogue (link_index, payment_link_id,
  razorpay_url, unique reference_id, amount, currency, plan, unique
  callback_path, is_active).
- `payment_link_reservations` — RESERVED/FULFILLED/EXPIRED/RELEASED; partial
  unique indexes per link, per intent, and per payment_id; `set_updated_at`
  trigger; RLS owner-visible.
- `payment_pool_callbacks` — dedupe/replay ledger; outcome CHECK; unique on
  payment_id.
- `payment_intents` — added `pool_link_index`, `pool_reference_id`,
  `reservation_status`, `reservation_expires_at`, `reservation_locked_at`,
  `reservation_fulfilled_at`, `pool_session_id`, `pool_client_ip`,
  `pool_heartbeat_last`.
- `payment_evidence.source` CHECK extended with `razorpay_callback`.
- RLS per the `0015_rls.sql` pattern.

## 16. Config

`backend/src/config/payment-pool.ts`:
- `enabled` (default true when `RAZORPAY_KEY_SECRET` present).
- `size` (default 50), `reservationTtlMinutes` (default 15).
- Placeholder `CCPOOL-<NNN>` reference scheme (**UNVERIFIED** — a deployment must
  populate real static links via `PAYMENT_POOL_LINKS` before use).
- `RAZORPAY_REFERENCE_BEHAVIOR = UNVERIFIED`.

`env.ts` grew `PAYMENT_POOL_TTL_MINUTES` (default 15) and optional
`PAYMENT_POOL_LINKS` (JSON deployment-time catalogue). `ids.ts` grew
`PREFIX.PAYMENT_RESERVATION` (`pvr`) and `PREFIX.PAYMENT_CALLBACK` (`pcb`).

### 16.1 Provisioning & Startup Self-Check (Seeder) — actual behavior

The pool is **provisioned from `PAYMENT_POOL_LINKS` by `seedPaymentPool`
(`backend/src/modules/payments/pool/seeder.ts`)**, not by `payment-pool.ts`
(which only derives config defaults). Each entry is parsed **per-link**:

```
{ index, paymentUrl, referenceId, amount, currency, plan, callbackPath, paymentLinkId, enabled }
```

- **INR-only**: any entry whose `currency` is not `INR` is skipped (never
  seeded). Amounts/currency/plan are stored per link and are the authoritative
  source for callback plan/amount/currency validation.
- **Real-link format tolerance (structural only)**: referenceId and
  callbackPath must be non-empty; paymentUrl must parse as a URL with an
  http(s) scheme (HTTPS required for real provider links; `CCPOOL-*`
  placeholders are exempt so dev/test is never blocked); whitespace around all
  configured values is trimmed before storing; per-link amount is preserved
  verbatim. No length/charset/prefix pattern is imposed on provider
  identifiers — a structurally valid but unusual id is accepted as-is.
- **Placeholder warning (non-failing)**: any catalogue link using the
  `CCPOOL-*` scheme (or an entirely placeholder catalogue) triggers an
  aggregate `PLACEHOLDER_LINKS` warning from the seeder and a
  `PLACEHOLDER_WARNING` from the startup check — real Razorpay links are not
  configured. This never fails seeding and never blocks dev/test.
- **Idempotent upsert**: `link_index` is the identity; reseeding updates
  existing rows instead of duplicating.
- **Manual provisioning**: `npm run db:seed:pool` seeds/updates from the
  current `PAYMENT_POOL_LINKS` and prints `PAYMENT_POOL_SEEDED`.
- **Startup seeding**: `seedPaymentPool` runs at server boot so a fresh DB is
  provisioned before the first checkout (answers the historical
  ALL_LINKS_BUSY_TRY_AGAIN-on-fresh-DB failure).
- **Boot self-check**: after seeding, `assertPoolUsable` fails the server
  loudly (never a silent paywall) if the pool is misconfigured — with the
  single exemption that a pool explicitly disabled via `intentionallyDisabled`
  reports `configured` but is not required to have seeded links.
- **No auto-creation at runtime**: the module never invents or fabricates
  Razorpay links. A deployment MUST supply real, provisioned static links in
  `PAYMENT_POOL_LINKS` before enabling automatic activation; seed entries are
  placeholders only and are `UNVERIFIED` against the live provider.

## 17. Frontend Integration

Integrated into the real billing flow (`frontend/src/pages/SettingsPage.tsx`,
`upgrade`): it first tries `POST /api/pay/pool/intent`; on a returned
`paymentUrl` it redirects there (with the amount/currency/plan toast). If the
pool is disabled or all links busy, it **falls back to the existing Rail A
session flow** (unchanged). No parallel fake UI was created. The toast notes the
reserved slot semantics but never claims payer identity; the callback-driven
entitlement status is reported by the existing server-authoritative status UI.

## 18. Testing (regression status)

- `backend/src/modules/payments/pool/pool.test.ts` + `self-service.test.ts` +
  `control-center.test.ts` — **61/61 PASS** (DB-mocked; no provider/network).
  Covers: 503 all-busy, atomic single reservation, ownership heartbeat,
  cross-user status, invalid signature, bad link index, duplicate payment_id
  replay, blank payment_id, disabled link, link_id mismatch, reference
  mismatch, bad status, orphaned fail-closed, reservation
  expired/released/fulfilled fail-closed, plan/amount/currency mismatch,
  ownership mismatch, prior-fulfillment fail-closed, trusted-source gating,
  verify-signature timing-safe HMAC, and late-callback
  (A expires → B reserves → A late callback).
- `seeder.test.ts` — **25/25 PASS** (fresh-DB provisioning, idempotent reseed,
  100-concurrent single-link reservation, INR/amount gates, and real-link
  format tolerance: long/unusual identifiers, HTTPS-with-query URL,
  whitespace normalization, per-link amount preservation, non-failing
  placeholder warning, and structural rejection of invalid URL / empty id /
  non-INR currency).
- `gmail-claim.test.ts` + `gmail-claim-hardening.test.ts` — **20/20 PASS**
  (the 3 route-level tests share ONE assembled-app server boot instead of one
  boot per test — removes cold boot cost that previously tripped timeouts).
- `watchtower.test.ts` — **7/7 PASS** (globally unscoped C1–C7 with no
  identity filtering; missing alert destination still runs every check +
  exactly one `ALERT_DESTINATION_UNCONFIGURED` warning; STATE_UNREADABLE;
  read-only invariant).
- `src/scripts/prove-payment.test.ts` (`npm run prove:payment`) —
  **16/16 PASS**, all-or-nothing (I14 re-proves the globally-unscoped,
  read-only watchtower). See `PAYMENT_PROOF_REPORT.md`.
- **Full backend suite** (`npm test`, vitest): **145 files, 2688 passed,
  8 skipped, 0 failed.** The earlier CPU-contention failures were root-caused:
  vitest default-fork-one-worker-per-core (12 cold forks at once) starved the
  timing-sensitive perf-17 smoke and gmail-claim's per-test app boots. Fixed by
  capping the fork pool (maxWorkers=4) and consolidating the gmail-claim route
  tests onto a single shared server boot — assertions and deadlines unchanged.
- **typecheck** (backend + frontend) clean; **build** clean (backend tsc,
  frontend vite).
- Frontend suite: **71/71 files, 396/396 PASS.** The pre-existing
  `ReviewListPage` failure was a page bug: hunk counts were read from the inner
  `review` payload instead of the list wrapper (server returns
  `totalHunks/acceptedHunks/rejectedHunks` at the wrapper level). Fixed with a
  wrapper-first, snake/camel-tolerant read.

## 19. Security Notes / Honest Status

- **Verified:**
  - Pool enabled only when `RAZORPAY_KEY_SECRET` present.
  - Automatic startup provisioning by the seeder from `PAYMENT_POOL_LINKS`
    (INR-only, per-link amount/currency/plan, idempotent upsert by
    `link_index`; `npm run db:seed:pool` for manual reseeding).
  - Boot self-check `assertPoolUsable` fails the server loudly on
    misconfiguration (intentionally-disabled pool exempted); emits a
    **non-failing PLACEHOLDER_WARNING** when only `CCPOOL-*` dev/test
    placeholders are configured (real links not present — seeding is NOT
    failing, dev/test is NOT blocked).
  - Real-link validation is STRUCTURAL only: non-empty identifiers, required
    fields, positive amount == authoritative plan price, INR currency, URL
    parses (HTTPS for real provider links; `CCPOOL-*` placeholders exempt).
    No length/charset/prefix assumptions are made about provider identifiers.
  - HMAC signature + timing-safe comparison.
  - Atomic reservation via unique partial indexes + skip-locked.
  - Exact link/index/reference/amount/currency/plan binding.
  - Replay protection (ledger) + exactly-once activation.
  - Late-callback protection (immutable link binding; no most-recent-wins).
  - Cross-user / cross-workspace isolation (ownership checks).
  - Ambiguous & orphaned callbacks fail closed.
  - `activation.ts` is the SOLE entitlement authority.
  - Read-only, **globally unscoped** payment watchtower (C1–C7; includes a
    global replay/duplicate/ambiguous-evidence integrity check). It has NO
    identity-based filtering — inspection spans all users/workspaces/projects
    (tenancy isolation is preserved for user-facing APIs). The only
    configurable piece is the alert DESTINATION
    (`PAYMENT_WATCHTOWER_ALERT_EMAIL`, sent via the existing outbox/SMTP). When
    unset, all checks still run and are fully recorded, no alert is sent, and
    exactly one `ALERT_DESTINATION_UNCONFIGURED` warning is emitted.
  - Rail A (Gmail) preserved as fallback.
  - No API, no webhook, no admin in normal flow.
- **NOT automatically verified at deploy:**
  - RAZORPAY_REFERENCE_BEHAVIOR = **UNVERIFIED** — real static links must be
    provisioned (`PAYMENT_POOL_LINKS`) and the reference/amount/currency must be
    confirmed against the live provider.
  - AUTOMATIC_ACTIVATION depends on real, pre-created static links being
    provisioned and the callback HMAC confirming against the live secret.

---

### Does this prove the physical payer's identity?

**No.** The entitlement binds to the authenticated account's reserved intent.
The payer of the static link is never cryptographically identified as that
account. This is POLICY B by design and is stated explicitly and repeatedly.
