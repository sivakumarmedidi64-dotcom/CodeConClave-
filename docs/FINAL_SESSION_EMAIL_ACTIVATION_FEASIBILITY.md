# Session-Bound Email Activation — Feasibility Audit
## Static Razorpay Links · NO API · NO WEBHOOK · NO ADMIN · NO SCHEMA CHANGE

**Scope:** Determine whether a session-bound **email activation** flow (user
logs in → pending intent → pays static link → return → email link → ACTIVE) can
be made **secure** given static shared links and **no Razorpay API / webhook /
admin**.

**Investigation only.** No deploy, no real payment, no source/schema changes.

---

## 1. Verdict Summary

| Decision | Verdict |
|---|---|
| `SESSION_BINDING` | **PASS** (session→user→plan→amount binding exists) |
| `EMAIL_OWNERSHIP` | **PASS** (email token proves email control only) |
| `PAYMENT_PROOF` | **FAIL** (no trusted payment signal without API/webhook) |
| `PAYMENT_USER_CORRELATION` | **FAIL** (IMPOSSIBLE with shared static links) |
| `STATIC_LINK_CORRELATION` | **FAIL** (IMPOSSIBLE) |
| `PAYMENT_BYPASS_PROTECTION` | **PASS** (current code holds PENDING; but any email-click design must NOT activate) |
| `REPLAY_PROTECTION` | **PASS** (token exactly-once infra exists) |
| `REFUND_HANDLING` | **NOT_AVAILABLE** |
| `NO_SCHEMA_CHANGE` | **YES** (achievable without schema change) |
| `ZERO_ADMIN` | **IMPOSSIBLE** (for auto-activation without trusted signal) |
| `NO_API_NO_WEBHOOK` | **IMPOSSIBLE** (for secure payment-backed activation) |

**`SESSION_EMAIL_ACTIVATION_WITH_STATIC_LINKS = NOT_A_PAYMENT_PROOF`**
**`NO_API_NO_WEBHOOK_NO_ADMIN = NOT_POSSIBLE`**

---

## 2. Return Handler — What Trustworthy Info Reaches Backend

Source facts (verified in routes.ts / service.ts):

- `GET /api/v1/payments/sessions/:id/return` (routes.ts:87) →
  `handleReturn(userId, sessionId, req.query.paid ?? req.query.status)`.
- `handleReturn` (service.ts:292) reads **only** `paid` / `status`. On
  `false`/`cancelled` → CANCELLED. Otherwise it records a `return` event and
  calls `verifyWithProvider(session)`.
- `verifyWithProvider` (service.ts:266) queries the Razorpay API **only when
  `RAZORPAY_MODE === 'api'` and real credentials exist**; otherwise returns
  `false` and **state stays PENDING**. The handler never activates on its own.

**Trustworthy payment information reaching the backend = NONE.**
- No amount, no plan, no payment id, no signature from the static-link return is
  treated as authority. The only values present (`paid`, `status` query params)
  are explicitly **not trusted** (they are client-controllable).
- The `callback_url` set in code (service.ts:130) applies only to API-created
  links (API mode, not available) and points at `/api/v1/payments/status`, which
  is the user's own status endpoint, not a payment-verification handler.

**Determination:** after a static-link return the backend has **no independent
provider-generated value** that proves a real captured payment.

---

## 3. Session Binding — PASS (but irrelevant to payment proof)

The server already creates a user-bound pending intent/session before checkout:
- `createPaymentIntent` (intents.ts:90) stamps a **unique** server reference
  `CC<PRO|TEAM>-XXXXXX`, server-authoritative `plan_id` + `amount_inr`
  (`PLAN_PRICES_INR`), expiry.
- `createPaymentSession` (service.ts:155) binds `user_id → plan_id →
  amount_inr → reference`.

So `session_id → user_id → plan → amount` binding **exists and is correct**
`SESSION_BINDING = PASS`.

**But:** the binding is one-directional (session → user/plan/amount). To prove
payment we need a **provider value arriving after payment that maps back to that
specific session**. With **static shared links**: `provider_payment_link_id =
NULL`, `provider_reference_id = NULL` (intents.ts:110-117 when API is down). The
provider returns **no value** that uniquely identifies the pending session.

**`SESSION_BINDING_CANNOT_PROVE_PAYMENT = YES`** — the pre-payment session
binding cannot be closed by any provider value under static links.

---

## 4. Email Activation — Proves Email Ownership, NOT Payment

- Existing email token infra (`email_verifications`, verification.ts:58-132)
  stores `token_hash`, `expires_at`, `used_at`, marks `USED` — robust
  **exactly-once email-ownership proof**.
- An activation **email click proves `EMAIL_OWNERSHIP = YES`**
  (and that the HTTP client holds an unexpired, single-use token).
- It proves **`PAYMENT_OCCURRED = NO`** — nothing about a real Razorpay
  payment. The prompt's rule is correct: the two must never be equated.

**`EMAIL_OWNERSHIP = PASS`; `PAYMENT_PROOF = FAIL`.**

---

## 5. Static Link Multi-User Test — IMPOSSIBLE

Scenario: User A and User B both use the same Pro ₹999 static link
(`rzp.io/rzp/sAgHIpxS`).

- The link is **shared**; its `plink_…` id / reference identifies only the plan
  link, not a payer account.
- After the return, the backend has **no per-user provider value** (Section 3).
- The activation email proves only that the clicker owns the account email —
  **not** that A rather than B paid.

Without API/webhook/admin there is **no signal** that maps "payment" to A vs B.

**`STATIC_LINK_USER_CORRELATION = IMPOSSIBLE`** and
**`PAYMENT_USER_CORRELATION = FAIL`**.

---

## 6. Free / Fake Activation Test — Must Be NO_ACTIVE_ENTITLEMENT

Attack: user logs in → chooses Pro → never pays → visits `/payment/return` →
clicks email activation.

- Current code already **refuses** to activate: `handleReturn` stays PENDING
  with no provider evidence (service.ts:304-306); activation only flows through
  `verifySession`/the trusted pipeline (`razorpay_webhook`/`razorpay_api`/gmail
  with exact reference), never from a return GET or an email click.
- `TRUSTED_EVIDENCE_SOURCES = {gmail, razorpay_api, razorpay_webhook}`
  (pipeline.ts:55); **email activation is not a trusted payment source**, and
  must never be wired to grant ACTIVE.

**Rule:** If the proposed design ever made "return + email click" grant ACTIVE,
it is a `PAYMENT_BYPASS = UNSAFE`. The secure design keeps such a session
PENDING forever/expires it. `PAYMENT_BYPASS_PROTECTION = PASS` only while the
email click grants nothing more than email ownership.

---

## 7. Replay Test — Exactly-Once

- Email/token infra is exactly-once (`email_verifications.USED` + `used_at`,
  verification.ts). Reusing the same activation URL fails.
- Payment-side: the trusted pipeline has **idempotency + replay guards**
  (webhook event dedupe routes.ts:341-353; `sha256` signal replay guard
  pipeline.ts:114-131; one entitlement per user+plan).
- **BUT** with static links and no verified payment, "one payment must not
  activate multiple accounts" **cannot be enforced**, because the backend never
  learns which account the payment belongs to. Replay protection on the *token*
  works; replay protection on *payment→account* is **not** achievable.

`REPLAY_PROTECTION = PASS` for tokens/activation; **FAIL** for
payment→account correlation (static links).

---

## 8. Refund Test — NOT_AVAILABLE

Refund: SUCCESS → ACTIVE → later refunded.

- Webhook refund handling exists (routes.ts:394-425) but is **inert** (no
  `RAZORPAY_WEBHOOK_SECRET`; live route 404).
- Without API/webhook the backend **cannot reliably detect a refund** and
  auto-revoke.

**`AUTO_REFUND_REVOCATION = NOT_AVAILABLE`** — do not claim otherwise.

---

## 9. Rate Limiting

- The codebase has rate-limit middleware (`RATE_LIMIT_*`, env.ts) and the
  email-verification token uses opaque `token_hash` with `USED`/expiry.
- Return-endpoint and token-guessing protections are implementable **without
  schema change** (Redis `cache.incr`, `email_verifications` exactly-once).
- These are **hygiene controls**, not payment proof; they cannot substitute for
  a trusted payment signal.

---

## 10. Redis — Acceptable for Tokens Only

A Redis activation-token record (`token_hash/email/user_id/plan/expiry/used_at/
payment_binding`) is fine, but:
- Redis proves **token issuance**, not **payment occurred**.
- Per the requirement, the token must be issued **only after verified payment
  evidence exists**. Under static links that evidence does not exist, so a
  `payment_binding` field would be empty/false → no secure token can be issued
  for auto-activation.

---

## 11. No Database Schema Change — YES (structurally, but useless)

The desired email-activation *mechanics* can reuse existing tables/entities
(`payment_intents`, `email_verifications`, `payment_claims`/Redis) without a
schema change. **`NO_SCHEMA_CHANGE = YES`.**

**However** schema is not the blocker. The blocker is **absence of a trusted
payment signal and a per-user provider binding** — no schema change can create
one. So "no schema change" is satisfied but does not make the flow secure.

---

## 12. Flow Comparison

score: ✅ strong · ⚠️ partial · ❌ absent/impossible

| Design | SECURITY | UX | ZERO_ADMIN | PAY_VERIF | USER_CORR | REFUND | SCALABLE | CURRENT_FEAS |
|---|---|---|---|---|---|---|---|---|
| **A** sessionStorage + return + email | ❌ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ (unsafe) |
| **B** server session + return + email | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ |
| **C** server session + Gmail + email | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ | ❌ (static no ref) |
| **D** pre-created unique link + Gmail + email | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ | ❌ (needs API per-link) |
| **E** API dynamic link + email | ✅ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ | ❌ (no API) |
| **F** API + signed webhook + email | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (no API/webhook) |

C: Gmail requires the **exact server reference** (evidence.ts:305) — static
links carry none, so Gmail cannot correlate a shared-link receipt to a user.
D requires per-user link creation (API). Only E/F provide a **trusted payment
signal + exact user binding**.

---

## 13. Most Important Question

Under the exact constraints:
```
NO RAZORPAY API
NO RAZORPAY WEBHOOK
NO ADMIN
STATIC SHARED PAYMENT LINKS
NO DATABASE SCHEMA CHANGE
```
Can **any** version of session-bound email activation safely produce
`real payment → exact user → verified → ACTIVE`?

**NO.**

There is **no independent trusted payment signal** available. Every candidate is
either client-supplied (return query params, sessionStorage, paymentId the user
submits) or lacks a per-user provider binding (shared static link → no
`reference_id`/`link_id` correlated to an account). Real Razorpay truth requires
the **API (fetch by payment id/link id)** or a **signed webhook (HMAC from
Razorpay)**. Email activation proves email ownership only.

**`SESSION_EMAIL_ACTIVATION_WITH_STATIC_LINKS = NOT_A_PAYMENT_PROOF`**
**`NO_API_NO_WEBHOOK_NO_ADMIN = NOT_POSSIBLE`**

---

## 14. Final Report

```
SESSION_BINDING            = PASS (server pre-binds session→user→plan→amount)
EMAIL_OWNERSHIP            = PASS (email token proves only email control)
PAYMENT_PROOF              = FAIL (no trusted signal without API/webhook)
PAYMENT_USER_CORRELATION   = FAIL
STATIC_LINK_CORRELATION    = FAIL (IMPOSSIBLE with shared links)
PAYMENT_BYPASS_PROTECTION  = PASS (only while email click grants nothing;
                            any return+email-click=ACTIVE would be UNSAFE)
REPLAY_PROTECTION          = PASS (tokens/exactly-once); FAIL for payment→account
REFUND_HANDLING            = NOT_AVAILABLE
NO_SCHEMA_CHANGE           = YES (mechanics reuse existing entities; not the blocker)
ZERO_ADMIN                 = IMPOSSIBLE (for secure auto-activation)
NO_API_NO_WEBHOOK          = IMPOSSIBLE

FINAL_RECOMMENDATION = Enable Razorpay API (RAZORPAY_KEY_ID/KEY_SECRET) and a signed
                       webhook (RAZORPAY_WEBHOOK_SECRET) to run flows E/F: per-user
                       dynamic links carrying the intent reference_id + signed-webhook
                       auto-activation (+ optional Gmail fallback). Email activation may
                       then serve as a UX confirmation step, NEVER as payment proof.
                       Until then keep the honest behavior: static-link returns stay
                       PENDING; nothing auto-activates; do NOT wire email clicks to ACTIVE.

REAL_PAYMENT = NOT_PERFORMED
DEPLOYMENT   = BLOCKED
SOURCE_CHANGES = NONE
```

No secrets exposed. No deploy, no real payment, no source/schema changes. STOP.
