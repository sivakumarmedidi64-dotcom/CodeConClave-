# FINAL — CONDITIONAL GMAIL/SELF-SERVICE PAYMENT GATE (SAFE PROTOTYPE)

> **Directive:** build the *safest possible* **CONDITIONAL** no-API / no-webhook /
> zero-admin self-service payment flow — fail-closed, customer-friendly, 24/7,
> no admin activation, feature-flagged OFF by default, additive + reversible,
> no deployment, no schema migration, no real payment.
>
> **Honest classification (mandatory):** this is **CONDITIONAL**, NOT
> cryptographically provider-bound. The reference correlation is customer-supplied
> on a shared static link and is enforced, but not provider-bound.

---

## 1. The flow (what a customer experiences)

1. **Sign in** to an authenticated CodeConclave account (email verified).
2. **Create a payment intent** in the app → the app shows a **unique reference**
   like `CCPRO-ABC123` alongside the static Razorpay link.
3. **Customer copies the reference** and pastes it into the Razorpay checkout
   (required — this is the one extra manual step that makes correlation possible).
4. **Pays** on Razorpay (real money via static link, no API key needed).
5. Razorpay emails a receipt to the customer's Gmail (razorpay.com origin,
   DKIM/SPF/DMARC-signed).
6. The **Gmail watchdog rail** (Apps Script + backend) ingests the receipt,
   authenticates its origin, and the existing evidence pipeline matches the
   **exact DB-unique reference** + amount + window + fraud/replay guards.
7. The authoritative `applyDecision` gate transitions `PENDING → ACTIVE`.
8. The self-service "Checking…" endpoint gives the customer honest feedback
   (correlated / still pending / source unavailable) — **no admin needed, 24/7.**

This is the **existing** gmail evidence rail, unchanged. The self-service module
adds an explicit, audited, **email-ownership confirmation** step + a fail-closed
"check your payment" status endpoint, and (when enabled) a one-time account-bound
confirmation token as an ownership affordance. It **never** promotes weak evidence
to ACTIVE and **never** uses a token/email-click as payment proof.

---

## 2. What was implemented (SOURCE_CHANGES = FLAGGED_ONLY)

| Artifact | Purpose | Gated? |
|---|---|---|
| `backend/src/config/env.ts` | Added `AIOS_PAYMENT_SELF_SERVICE` (default `false`), `..._TOKEN_TTL_SECONDS` (1800), `..._MAX_PER_HOUR` (5), `..._MAX_ATTEMPTS` (5) | yes |
| `backend/src/modules/payments/self-service.ts` | NEW coordinator: `selfServiceEnabled()`, `checkPaymentConfirmation()`, `issueOwnershipConfirmationToken()`, `redeemOwnershipConfirmationToken()` — all fail-closed | yes |
| `backend/src/modules/payments/routes.ts` | NEW `/self-service` GET + `/self-service/check|email|activate` POST, mounted under existing `requireAuth` + CSRF in `app.ts` | yes |
| `backend/src/modules/payments/self-service.test.ts` | 12 unit tests covering the required cases | — |

- The existing authoritative engine (`pipeline`, `intents`, `matcher`, `fraud`,
  `activation`, `evidence`, `service`, `gmail-claim`, `demo`) is **untouched** and
  **reused**. No second backend, no architecture redesign, no schema migration.
- When the flag is OFF (default), the new routes are inert; existing payment
  behavior is byte-for-byte unchanged (`FEATURES_REMOVED = 0`).

---

## 3. Fail-closed guarantees (why this is safe)

- **Never trust the client.** No `localStorage`, no `sessionStorage`, no browser
  redirect, no `?paid=true`, no client-supplied `paymentId`/amount/plan, no
  user-entered UTR, no screenshot, no forwarded receipt, no "email ownership
  click" is treated as payment proof. Email ownership ≠ payment proof.
- **Activation only via the authoritative gate.** Both the existing pipeline
  (`applyDecision`) and the self-service redeem path require the evidence policy
  to already yield `ACTIVE` for a trusted source (Gmail-authenticated Razorpay
  receipt + exact DB-unique reference + amount + window + fraud/replay guards).
  REVIEW/PENDING/ambiguous/user-asserted evidence is **never** promoted.
- **Cross-user attack blocked.** Each intent's collector only matches a receipt
  whose reference **exactly equals** that intent's own DB-unique reference.
  B typing A's reference into a real payment cannot activate B's account
  (mismatch on B's intent); ambiguity forces REVIEW; no free access.
- **Token hardening (self-service affordance).** One-time, random 32-byte hex,
  stored **hashed** (sha256) in cache, short-lived (default 30 min), bound to
  (authenticated account + intent owner + intent + plan), with rate limiting
  (max per hour) and attempt limiting (max per hour). Reusing an expired or
  consumed token is rejected (`confirmation_expired` / `confirmation_used`).
- **Replay / idempotency.** Token reuse rejected; intent-level exactly-once
  activation via `applyDecision`; concurrent redemption cannot double-activate.

---

## 4. Honest limitations (documented, not hidden)

- **`TRUE_ZERO_ADMIN = CONDITIONAL`.** Requires the customer to **copy the unique
  reference into the Razorpay checkout** (one extra manual step) and the receipt
  echo to be parseable. Not "fully automatic" and not provider-bound.
- **`REFUND_AUTO_REVOCATION = NOT_AVAILABLE`** under no-API/no-webhook. There is
  no trusted refund-event source; the dormant webhook rail will handle
  `payment.refunded` when a webhook is added (API/webhook is the recommended
  long-term upgrade path). The flow does **not** claim auto-refund handling.
- **Live receipt-echo of a customer-typed reference is UNVERIFIED** (no real
  payment performed under this directive). Whether a real static-link Razorpay
  receipt echoes the typed reference in a parseable field is a documented
  assumption; the pipeline's confidence/REVIEW thresholds absorb uncertainty.
- **Reference = customer-supplied correlation with acceptable security** (grade B):
  enforced, but not cryptographically bound to the session.

---

## 5. Automated gate

| Gate | Value |
|---|---|
| `SELF_SERVICE_PAYMENT` | `BUILT_INERT` (flag-gated OFF by default) |
| `GMAIL_AUTHENTICITY` | `PASS` (origin-authenticated razorpay.com receipt) |
| `REFERENCE_MATCH` | `PASS(enforced_exact_dbunique)` |
| `USER_CORRELATION` | `CONDITIONAL` (customer-supplied, not provider-bound) |
| `EMAIL_OWNERSHIP` | `PASS` (ownership affordance only, never proof) |
| `PAYMENT_TRUST` | `CONDITIONAL` |
| `CROSS_USER_PROTECTION` | `PASS` (per-intent exact-reference collector) |
| `REPLAY` | `PASS` (one-time token + intent exactly-once) |
| `IDEMPOTENCY` | `PASS` |
| `REFUND_HANDLING` | `NOT_AVAILABLE` (no API/webhook under this config) |
| `ADMIN_WORK` | `NONE` |
| `CUSTOMER_ACTION` | `COPY_REFERENCE_INTO_CHECKOUT` |
| `AUTO_UNLOCK` | `CONDITIONAL` |
| `TRUE_ZERO_ADMIN` | `CONDITIONAL` |
| `FEATURES_REMOVED` | `0` |
| `SOURCE_CHANGES` | `FLAGGED_ONLY` |
| `DATABASE_CHANGES` | `NONE` |
| `DEPLOYMENT` | `NOT_EXECUTED` |
| `REAL_PAYMENT` | `NOT_PERFORMED` |

---

## 6. Recommended long-term upgrade path (for later, out of scope here)

- Add a Razorpay **webhook** (authorized) → makes correlation **provider-bound**
  (`USER_CORRELATION = STRONG`), enables `REFUND_AUTO_REVOCATION`, and removes the
  customer copy/paste step. This is the cleanest path to `TRUE_ZERO_ADMIN = YES`.

---

## 7. Files touched this turn

- `backend/src/config/env.ts` (additive flags)
- `backend/src/modules/payments/self-service.ts` (new)
- `backend/src/modules/payments/routes.ts` (new `/self-service/*` routes)
- `backend/src/modules/payments/self-service.test.ts` (new tests)
- `docs/FINAL_CONDITIONAL_GMAIL_PAYMENT_SELF_SERVICE_GATE.md` (this report)

**Verification:** `backend` typecheck passes; self-service unit tests pass (12/12);
pre-existing gmail-claim server integration tests pass in isolation (full-suite
timeouts were machine contention on server-spawning tests, not a regression).
No deployment, no migration, no real payment performed.
