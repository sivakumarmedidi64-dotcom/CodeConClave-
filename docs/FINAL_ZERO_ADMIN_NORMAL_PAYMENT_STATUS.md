# FINAL ZERO-ADMIN NORMAL PAYMENT STATUS

**Date:** 2026-08-31
**Scope:** Solve ONLY the normal payment problem (customer pays → server trustedly confirms → correct user bound → plan+amount verified → entitlement ACTIVE, no admin).
**Method:** Proven from actual code in `backend/src/modules/payments/` — not assumed.
**Constraints honored:** No code modified. No deploy. No real payment. No secrets exposed. No infra changes. No unrelated redesign.

---

## 1. Trusted Verification Rails — Inspected (code-proven)

Source: `backend/src/modules/payments/evidence.ts` (capability detection), `service.ts`, `routes.ts`, `pipeline.ts`.

| Rail | Detection | Production state (letter/env) | Available? |
|------|-----------|-------------------------------|------------|
| **Razorpay API** | `apiDetectorAvailable()` = `RAZORPAY_KEY_ID` && `RAZORPAY_KEY_SECRET` (evidence.ts:47) | both vars **ABSENT** | **UNAVAILABLE** |
| **Razorpay Webhook** | `webhookDetectorAvailable()` = `RAZORPAY_WEBHOOK_SECRET` && `RAZORPAY_WEBHOOK_ENABLED==='true'` (evidence.ts:51) | vars **ABSENT** | **UNAVAILABLE** |
| **Gmail (OAuth)** | `gmailDetectorAvailable()` = GMAIL_OAUTH_* / GOOGLE_CLIENT_* (evidence.ts:196) | OAuth **configured** | **AVAILABLE** |
| **Manual / OCR** | user-asserted; forced `REVIEW` by `effectiveMatch` (pipeline.ts:66) | — | not a trusted rail |

**RAZORPAY_API = UNAVAILABLE**
**RAZORPAY_WEBHOOK = UNAVAILABLE**
**GMAIL = AVAILABLE**
**OTHER_TRUSTED_RAIL = NO** (reconciliation.ts reports drift only, never verifies/fixes)

---

## 2. How a Payment Is Trustedly Correlated to a User (code)

The **only** activation path is a `TRUSTED_EVIDENCE_SOURCES` source (`pipeline.ts:55` = `{gmail, razorpay_api, razorpay_webhook}`) flowing through:
`collect()` → `signalSha256()` dedupe → `checkFraud()` → `scoreEvidence()` → `applyDecision()` → `activateEntitlement()`.

The user-binding anchor is the **server-issued unique intent reference** `CC{PLAN}-XXXXXX`
(`intents.ts:79-88`). The matcher requires that reference to match the intent (`matcher.ts:45-47`,
weight +0.45) to reach ACTIVE (threshold 0.8, env default `PAYMENT_CONFIDENCE_ACTIVE`). Without the
reference anchor, max confidence is 0.25+0.10+0.10+0.10 = **0.55 < 0.8** → never ACTIVE.

Where does the reference come from physically in the payment?
- **Gmail rail** (`evidence.ts:304-307`): requires the Razorpay receipt to contain the exact
  `CC{PLAN}-XXXXXX` reference. Strict binding — a reference-less receipt is dropped
  (`service.ts` mailbox-sweep doc: "reference-less static-link receipts are dropped upstream").
- The reference is injected into a payment ONLY when the link was **created per-intent via the
  Razorpay API** with that `reference_id` (`createRazorpayPaymentLinkForIntent`, service.ts:110-153;
  intents.ts:109-118).

---

## 3. The Blocker — Current Capabilities (proven)

With no API credentials, `createRazorpayPaymentLinkForIntent` returns null (service.ts:116) and the
intent falls back to the **static per-plan link** (`paymentLinkForPlan`, service.ts:57-60;
intents.ts:109).

A static link is **shared across all users**. Paying it produces a Razorpay receipt/email with
**no per-user reference**. Consequences, proven from code:

1. **Gmail rail cannot bind it** — no `CC{PLAN}-XXXXXX` reference present → dropped (evidence.ts:307).
2. **Razorpay API rail is off** — no creds → `razorpayApiSource.unavailable()`.
3. **Webhook rail is off** — no creds + `WEBHOOK_ENABLED` not true → `razorpayWebhookSource.unavailable()`.
4. Therefore **no trusted source can resolve a normal static-link payment to exactly one user**.
5. A client-return / redirect (`handleReturn`, service.ts:292) can NOT reach VERIFIED without
   provider evidence — `validateProviderEvidence` requires an `API`/`WEBHOOK` source and a provider
   payment id (evidence.ts:69-96), which a client can never provide.

**Conclusion (code-proven, not assumed):**
**ZERO_ADMIN_WITH_CURRENT_RAZORPAY_CAPABILITIES = NOT_POSSIBLE**
**ADMIN_FREE_NORMAL_PAYMENT = BLOCKED**

---

## 4. Security / Correctness Properties Still Hold (verified from code)

| Property | Proof | Status |
|----------|-------|--------|
| **Client bypass** | Evidence only enters via `validateProviderEvidence` (needs API/WEBHOOK + provider id) + `effectiveMatch` forces manual/ocr to REVIEW (pipeline.ts:66). Client redirect/query/callback cannot reach activation. | **BLOCKED** |
| **Static link safe** | Static-link intents stay PENDING; reference-less receipts dropped; `handleReturn` never claims success without provider evidence. | **SAFE** |
| **Gmail** | Available, but only as evidence for reference-bound intents; this env cannot produce reference-bound links (no API). | **BLOCKED (for normal payments)** / **SECONDARY** |
| **Plan validation** | `PLAN_PRICES_INR` server map (service.ts:41); intent stores `plan_id`+`amount_inr` (intents.ts); plan_mismatch flag on ref-encoded plan (fraud.ts:65-70). | **PASS** |
| **Amount validation** | `verifySession` rejects non-matching amount (service.ts:322-335); webhook amount gate (routes.ts:449); matcher amount weight (matcher.ts:48). | **PASS** |
| **Idempotency** | Session idempotency_key reuse (service.ts:163-169); webhook `payment_webhook_events` dedupe by event.id (routes.ts:341-353); `ON CONFLICT (provider_ref) DO NOTHING` (service.ts:351); exactly-once ACTIVE transition (activation.ts:112-123). | **PASS** |
| **Replay protection** | `signalSha256` dedupe (pipeline.ts:110-131); `duplicate_payment_id`/`screenshot_replay`/`reference_reuse` fraud flags (fraud.ts). | **PASS** |

**Fraud/mismatch → REVIEW, never ACTIVE:** `fraud.blocked` or `REVIEW` decision always lands in
REVIEW (activation.ts:60-95); trusted-but-unmatched evidence is recorded, not activated.

---

## 5. Minimum Required External Capability (ranked — request the least)

Exactly ONE additional capability unblocks normal zero-admin payments, because it injects the
trusted per-user reference into a real payment link:

**1. RAZORPAY API (`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`)** — RECOMMENDED (minimum).
- `createRazorpayPaymentLinkForIntent` (already written, service.ts:110) creates a **unique
  per-intent link** carrying the reference in `reference_id`/`notes`. A normal customer payment via
  that link then contains the reference.
- Completion can be confirmed by the API-source poll (`razorpayApiSource`, evidence.ts:340) →
  trusted → ACTIVE. No admin. No webhook needed.

**2. SIGNED RAZORPAY WEBHOOK** — the push rail (routes.ts:287) also resolves per-intent links
`provider_reference_id`/`provider_payment_link_id`. But it still needs the **API to mint the
per-intent link**; without it, a shared static link has no unique reference to resolve. Webhook
alone (no API) does **not** unblock normal payments.

**3. API + WEBHOOK** — redundant for this problem; webhook adds push-efficiency/recon but is not
required for zero-admin correctness.

**Ranking (least capability first):**
1. **RAZORPAY API** — sufficient by itself.
2. **SIGNED RAZORPAY WEBHOOK** — not sufficient alone; needs API for per-intent links.
3. **API + WEBHOOK** — unnecessary for this goal.

So: **MINIMUM_REQUIRED_EXTERNAL_CAPABILITY = RAZORPAY API** (Key ID + Key Secret), enabling the
already-implemented per-intent payment-link path. No new verification invention required.

---

## 6. Production Safety (unchanged)

- Normal static-link payments remain **PENDING** (and reference-less receipts are dropped) — users
  are **never falsely activated**.
- No code changed this task. No deploy. No payment made.
- Payment architecture freeze intact (Razorpay API/webhook deferred; Gmail = evidence rail).

---

# ZERO-ADMIN NORMAL PAYMENT STATUS

```
CURRENT_ZERO_ADMIN:
  BLOCKED

ADMIN_FREE_NORMAL_PAYMENT:
  BLOCKED

TRUSTED_USER_CORRELATION:
  FAIL

PLAN_VALIDATION:
  PASS

AMOUNT_VALIDATION:
  PASS

IDEMPOTENCY:
  PASS

REPLAY_PROTECTION:
  PASS

CLIENT_BYPASS:
  BLOCKED

STATIC_LINK:
  SAFE

GMAIL:
  BLOCKED

RAZORPAY_API:
  UNAVAILABLE

RAZORPAY_WEBHOOK:
  UNAVAILABLE

MINIMUM_REQUIRED_EXTERNAL_CAPABILITY:
  RAZORPAY_API (RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET) — the only configuration
  that makes the already-implemented per-intent payment-link reference binding
  work, so a normal payment can be trustedly correlated to exactly one user and
  auto-activated with confidence >= 0.8. A signed webhook alone cannot, because
  a shared static link carries no unique reference to resolve.

CODE_CHANGE_REQUIRED:
  NO

DEPLOYMENT:
  NOT_PERFORMED

FINAL_RECOMMENDATION:
  The capability for genuinely automatic, admin-free normal payments is not
  achievable with the current Razorpay capabilities — not because of a missing
  code path, but because the trusted per-user reference can only be bound to a
  real payment when a unique per-intent Razorpay Payment Link is created via the
  Razorpay API. That path is fully implemented (createRazorpayPaymentLinkForIntent,
  evidence.ts, pipeline.ts, activation.ts) and merely needs RAZORPAY_KEY_ID +
  RAZORPAY_KEY_SECRET to enable it. No code change is required. Until then, the
  system correctly keeps normal static-link payments in PENDING / drops
  reference-less receipts — never falsely activating — which is the safe state.
```

No secrets. No deploy. No real payment. STOP.
