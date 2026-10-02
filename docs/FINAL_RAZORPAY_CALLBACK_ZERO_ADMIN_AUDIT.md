# Razorpay Callback / Payment-Link Correlation Audit
## NO API · NO WEBHOOK · NO ADMIN · ZERO-ADMIN REQUIREMENT

**Scope:** Determine whether the Razorpay **Payment Link callback** (browser
redirect back to CodeConClave after payment) can, combined with Gmail and a
logged-in user, securely produce **automatic zero-admin activation** — with
**no Razorpay API, no webhook, and no human admin**.

**Investigation only.** No deployment, no real payment, no source-code changes.

---

## 1. Verdict Summary

| Decision | Verdict |
|---|---|
| `CALLBACK_AVAILABLE` | **NO** (for the current static-link deployment) |
| `CALLBACK_SIGNATURE` | **FAIL** (never read/validated in the return path) |
| `PAYMENT_STATUS_VERIFIABLE` | **NO** (callback params alone prove nothing) |
| `PAYMENT_ID_AVAILABLE` | **UNKNOWN / UNUSED** (not parsed) |
| `PAYMENT_LINK_ID_AVAILABLE` | **UNKNOWN / UNUSED** (not parsed) |
| `REFERENCE_ID_AVAILABLE` | **UNKNOWN / UNUSED** (not parsed) |
| `STATIC_LINK_USER_CORRELATION` | **FAIL** (IMPOSSIBLE) |
| `CALLBACK_GMAIL_CORRELATION` | **FAIL** |
| `SERVER_SESSION_BINDING` | **FAIL** (no provider value to bind to) |
| `REFUND_HANDLING` | **FAIL** (NOT_AVAILABLE) |
| `SECURITY` | **FAIL** |
| `ZERO_ADMIN` | **IMPOSSIBLE** |

**`NO_API_NO_WEBHOOK_NO_ADMIN = NOT_POSSIBLE_WITH_CURRENT_STATIC_LINKS`**

---

## 2. Current Payment Flow (source-verified)

### Checkout entry
- `POST /api/v1/payments/sessions` (routes.ts:55) — authenticated; validates
  `planId ∈ {pro, team}`; calls `createPaymentSession` (service.ts:155).
- `POST /api/v1/payments/intents` (intents.ts:90) — the 26H path; stamps a
  unique server reference `CC<PRO|TEAM>-XXXXXX`; attempts an API-created link,
  else falls back to the static per-plan link.

### Return from Razorpay
- UI redirects to `GET /api/v1/payments/sessions/:id/return`
  (routes.ts:87) → `handleReturn(userId, sessionId, req.query.paid ?? req.query.status)`
  (service.ts:292).
- `handleReturn` reads **only** `paid` / `status` query values. If `false`/`cancelled`
  → CANCELLED; otherwise it records a `return` event and calls
  `verifyWithProvider(session)`.
- `verifyWithProvider` (service.ts:266) fetches the Razorpay API **only when
  `RAZORPAY_MODE === 'api'` and real credentials exist**. Without API keys it
  returns `false`, and the session **stays PENDING** — honestly never claiming
  success. **`handleReturn` never activates anything on its own.**

### What the callback actually is
- The **only** `callback_url` CodeConClave ever sets is inside
  `createRazorpayPaymentLinkForIntent` (service.ts:130):
  `callback_url = ${env.API_URL}/api/v1/payments/status`, `callback_method: 'get'`.
- This runs **only** when the Razorpay API is available (`razorpayAuth()`
  non-null). When unavailable (current env: no API keys) the static per-plan
  links are used, which we do **not** configure with a callback.
- `GET /api/v1/payments/status` (routes.ts:138-143) is the **user-facing payment
  status endpoint**, mounted behind `requireAuth` (routes.ts:46). It is **not** a
  Razorpay callback handler: it reads no `razorpay_payment_id`, no
  `razorpay_signature`, no `razorpay_payment_link_id`. It simply returns the
  authenticated user's own intent/entitlement status.

### Gmail/Apps Script watchdog
- `sweepPendingIntentEvidence` (service.ts:602) drives `refreshIntentEvidence`
  (pipeline.ts:187) for PENDING/REVIEW intents. Evidence is normalized by
  `gmailSource().collect` (evidence.ts:271), gated by `isAuthenticRazorpayMail`
  (evidence.ts:247) and the **strict `ref === reference`** binding
  (evidence.ts:305-307). Reference-less receipts are dropped (never activate).
- `isAuthenticRazorpayMail` requires the direct-mail Authentication-Results to
  show `dkim=pass` (razorpay.com), or `spf=pass`, or `dmarc=pass` — for direct
  mail into the merchant mailbox, **not** for callback params.

---

## 3. Callback Parameters — DO NOT ASSUME

Razorpay Payment Link callbacks (`callback_method=get`) can append query
parameters such as `razorpay_payment_id`, `razorpay_payment_link_id`,
`razorpay_payment_link_reference_id`, `razorpay_order_id`, `razorpay_signature`,
`payment_link_status`, `amount`. However:

- **CodeConClave does not read any of them.** `handleReturn` reads only
  `paid`/`status` (service.ts:292); `/api/v1/payments/status` reads none.
- With `callback_method: 'get'`, any such values arrive as **URL query string**
  → client-controllable, forgeable by any logged-in user hitting the callback
  URL with invented parameters.
- With `callback_method: 'post'` the body is a form-encoded page redirect — still
  client-delivered, still not server-trusted here.

**Determination:**
- `PAYMENT_ID_AVAILABLE = UNKNOWN` (Razorpay may send it; CodeConClave does not
  extract or use it)
- `PAYMENT_LINK_ID_AVAILABLE = UNKNOWN` (same)
- `REFERENCE_ID_AVAILABLE = UNKNOWN` (same; static links have no per-user value)

---

## 4. Callback Signature

- The browser callback **may** carry `razorpay_signature` for payment links;
  Razorpay's docs direct **server-side confirmation** to webhooks/API.
- CodeConClave **never reads or validates `razorpay_signature` in the
  callback/return path.** The only signature verification in the codebase is the
  **webhook** HMAC (routes.ts:305-319), which is **not enabled** (no
  `RAZORPAY_WEBHOOK_SECRET`) and, per prior sessions, the live route returns
  404 "Webhook not configured".
- Even a valid callback signature would **not by itself prove payment captured /
  correct amount**, because a redirect callback is client-delivered; Razorpay's
  documentation distinguishes callbacks from webhooks and says payment tracking
  should use webhooks.

**`CALLBACK_SIGNATURE = FAIL`** — no signature authenticating the redirect is
validated; and the redirect cannot prove capture/status regardless.

---

## 5. Static Payment Links — User Correlation FAILS

- PRO = ₹999 `https://rzp.io/rzp/sAgHIpxS`; TEAM = ₹4999
  `https://rzp.io/rzp/3ioXlCxd` — **shared** links, reused by all users of a plan.
- `paymentLinkForPlan` (service.ts:57) returns the per-plan static link; intents
  set `provider_payment_link_id = NULL` and `provider_reference_id = NULL` when
  the API is unavailable (intents.ts:110-117).
- A shared static link has its own Razorpay `plink_…` id and may have a
  `reference_id`, but it is **the same for every user** → identifying WHICH link
  was used tells us only the **plan**, not the **user**.
- **Scenario User A and User B, same Pro static link:** the backend receives
  only "the shared Pro link was paid." It cannot decide `payment → User A`
  rather than `payment → User B`.

**`STATIC_LINK_USER_CORRELATION = FAIL (IMPOSSIBLE)`**

---

## 6. Callback + Gmail Combination — FAIL

Proposed: callback gives `payment_id`; Gmail gives a receipt; user is logged in.

- The Gmail rail requires the **exact server-issued `CC<PRO|TEAM>-XXXXXX`
  reference** and authentic razorpay.com origin (`evidence.ts:305-307`,
  `isAuthenticRazorpayMail`). A static-link receipt has **no reference**, so it
  is dropped — it cannot be correlated to the exact user (evidence.ts:192-195).
- The callback `payment_id` is an unverified client value; nothing binds it to
  that user's Gmail receipt. `payer email ≠ CodeConClave identity`
  (aliases, shared mail, forwarding).
- "The values look consistent" is exactly the trap the design forbids: three
  client-controllable inputs that merely agree prove nothing.

**`CALLBACK_GMAIL_CORRELATION = FAIL`** for `payment → user → plan → amount`.

---

## 7. Server-Side Session Binding — FAIL

The server can (and already does) create a `pending_payment_session` /
`payment_intent` before checkout, stamped with a unique user-bound `reference`.
But to bind a later Razorpay return to that session, the provider must echo a
value that uniquely identifies it:

- With API-created links, Razorpay echoes `reference_id`/`notes` — a strong
  binding exists (future path, `razorpay_webhook`/`razorpay_api`). **API not
  available here.**
- With the **static shared links**, the provider does **not** echo the session's
  unique reference back → the redirect carries no server-authoritative value
  that maps to this session/user. The backend cannot cryptographically or
  authoritatively prove which session a given callback payment belongs to.

**`SERVER_SESSION_BINDING = FAIL`** — the provider does not currently return a
value that uniquely identifies the pre-created session when static links are
used.

---

## 8. Customer Email — Not Sufficient

The callback/redirect and receipts can show a **payer email**, but it is not
trusted as a CodeConClave identity binding: different payer email, shared email,
aliases, forwarding, and "another user's payment" all break the mapping, and the
email is client-delivered (not independently verified by a provider call).
`evidence.ts`/`pipeline.ts` deliberately **never bind by email alone**. Email is
**not** sufficient for this design.

---

## 9. Payment Status — INSUFFICIENT

Callback params alone **cannot** prove captured / successful / correct amount /
correct plan **without** querying the Razorpay API or receiving a signed webhook.
The current code agrees: `handleReturn` keeps the session PENDING without
provider evidence; `verifyWithProvider` requires API mode.

**`CALLBACK_PAYMENT_VERIFICATION = INSUFFICIENT`**

---

## 10. Refund / Reversal — NOT_AVAILABLE

Without the Razorpay API/webhook, refunds are not auto-detected. Webhook refund
handling exists (routes.ts:394-425) but is **inert** (no secret, returns 404).
The current no-API/no-webhook architecture **cannot** automatically detect and
revoke access for a later refund.

**`AUTO_REFUND_REVOCATION = NOT_AVAILABLE`**

---

## 11. Security Attack Cases (source-level)

| Attack | Result against this design |
|---|---|
| Forged callback (invented `razorpay_payment_id`/`payment_link_id`/`reference_id` query) | **Succeeds** — params never validated |
| Modified query parameter | **Succeeds** — no integrity check on redirect |
| Fake email / amount / plan values | **Succeeds** — client-delivered, not provider-verified |
| Replayed callback | **Succeeds** — no signature/nonce on redirect |
| Another customer's payment ID | **Succeeds** — not cross-verified |
| Duplicate payment | Not prevented (no provider idempotency on callback) |
| Refunded payment | **Succeeds** — no auto-revocation |
| Shared static-link ambiguity (A vs B) | **Succeeds inherently** — cannot disambiguate |

The active webhook path defends against these (signature + idempotency +
amount/plan + provider reference resolution, routes.ts:296-488) but is
**disabled**. Without it, callback-only is forgeable end-to-end.

---

## 12. Flow Comparison

scores: ✅ strong · ⚠️ weak · ❌ absent

| Flow | PAYMENT_TRUST | USER_CORR | ZERO_ADMIN | SECURITY | REFUND | SCALABILITY | CURRENT_AVAIL |
|---|---|---|---|---|---|---|---|
| **A** client `POST /api/activate` (email/plan/ref) | ❌ | ❌ | ⚠️(no admin) | ❌ | ❌ | ✅ | ✅ but **rejected** |
| **B** callback-only | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ✅ (runs) |
| **C** callback + Gmail | ⚠️→❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| **D** static link + session + Gmail | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ⚠️ |
| **E** API-created dynamic Payment Link | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ❌ (no API) |
| **F** signed webhook + dynamic link | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (no webhook) |
| **G** API + signed webhook + Gmail fallback | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (current) |

Only **E/F/G** — which require the **Razorpay API and/or webhook** — achieve
trusted PAYMENT_TRUST + USER_CORRELATION at scale. The current static-only
stack (A–D) cannot.

---

## 13. Critical Decision

Can **any** version of:

```
NO API + NO WEBHOOK + NO ADMIN + EXISTING STATIC PAYMENT LINKS + CALLBACK/GMAIL
```

securely produce automatic user activation?

**NO.**

The blocking problems are structural, not incremental:
1. Static shared links provide **no per-user provider value** → the backend
   cannot correlate a payment to a specific account
   (`STATIC_LINK_USER_CORRELATION = IMPOSSIBLE`).
2. The callback is a **client-delivered redirect**; its params and any signature
   are not validated, and Razorpay requires webhook/API for server-side truth
   (`CALLBACK_SIGNATURE = FAIL`, `CALLBACK_PAYMENT_VERIFICATION = INSUFFICIENT`).
3. Without API/webhook, the backend cannot independently verify capture/amount,
   cannot detect refunds (`REFUND_HANDLING = FAIL`), and cannot auto-activate
   (`ZERO_ADMIN = IMPOSSIBLE`).

No amount of combining callback + Gmail + a logged-in session fixes these
because every signal is either user-supplied or lacks a unique provider binding.

**`NO_API_NO_WEBHOOK_NO_ADMIN = NOT_POSSIBLE_WITH_CURRENT_STATIC_LINKS`**

The one reliable zero-admin path is **E / F / G** (Razorpay **API + signed
webhook**, optionally Gmail fallback), all gated on real Razorpay
`RAZORPAY_KEY_ID/KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`. Until those exist,
the backend's honest behavior (stay PENDING, no auto-activation, no fake
success) is correct and must remain.

---

## 14. Final Report

```
CALLBACK_AVAILABLE            = NO (static-link deployment; API-only callback_url unset/unused)
CALLBACK_SIGNATURE            = FAIL (never read/validated in the return path)
PAYMENT_STATUS_VERIFIABLE     = NO
PAYMENT_ID_AVAILABLE          = UNKNOWN (may be sent; not parsed/used)
PAYMENT_LINK_ID_AVAILABLE     = UNKNOWN (may be sent; not parsed/used)
REFERENCE_ID_AVAILABLE        = UNKNOWN (may be sent; not parsed/used)
STATIC_LINK_USER_CORRELATION  = FAIL (IMPOSSIBLE with shared links)
CALLBACK_GMAIL_CORRELATION    = FAIL
SERVER_SESSION_BINDING        = FAIL (no provider value binds static-link return to session)
REFUND_HANDLING               = FAIL (AUTO_REFUND_REVOCATION = NOT_AVAILABLE)
SECURITY                      = FAIL
ZERO_ADMIN                    = IMPOSSIBLE

FINAL_RECOMMENDATION          = WAIT_FOR_RAZORPAY_CAPABILITY: enable Razorpay API
                                (RAZORPAY_KEY_ID/KEY_SECRET) and signed webhook
                                (RAZORPAY_WEBHOOK_SECRET) to build flow E/F/G with
                                API-created dynamic links + per-user reference_id
                                + signed webhook auto-activation (+ optional Gmail
                                fallback). Do NOT ship callback/static-link trust.

REAL_PAYMENT                  = NOT_PERFORMED
DEPLOYMENT                    = BLOCKED
SOURCE_CHANGES                = NONE
```

No secrets were exposed. No deployment, no real payment, no source changes were
made. STOP.
