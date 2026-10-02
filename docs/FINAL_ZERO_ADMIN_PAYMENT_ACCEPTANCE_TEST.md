# CodeConClave — FINAL ZERO-ADMIN PAYMENT ACCEPTANCE TEST

> Date: 2026-08-31
> Requested: one controlled real PRO ₹999 zero-admin Gmail-rail payment test.
>
> **Status: NOT PERFORMED — BLOCKED (do-not-pay).** The acceptance test as scoped
> (pay via the static Pro link `https://rzp.io/rzp/sAgHIpxS`) **cannot auto-activate**
> an entitlement, because auto-activation requires a unique server-generated intent
> reference bound to the payment, which the static payment link does not carry.
>
> No payment was made, nothing was fabricated, nothing was activated.

---

## 1. The blocker (verified from source + live config)

The current production backend has **no Razorpay API/webhook configured** (this is the
intended "Gmail-only launch bridge" / deferred Razorpay state). Env confirms
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` /
`RAZORPAY_WEBHOOK_ENABLED` are NOT set.

Consequence for intent/link generation:

- `createRazorpayPaymentLinkForIntent` (`service.ts:110-153`) returns **null** whenever
  `razorpayAuth()` is null, i.e. when no Razorpay key/secret exist (line 115-116). A
  per-intent Razorpay Payment Link carrying the unique reference is therefore **not
  created**.
- `createPaymentIntent` (`intents.ts:90-147`) then falls back to the **static per-plan
  link** `https://rzp.io/rzp/sAgHIpxS` (line 109). That static public link has **no
  unique server reference** bound to it (no `reference_id`, no per-intent notes).
- The Gmail evidence matcher uses **strict reference binding**: only a message carrying
  the exact server-issued reference `CCPRO-XXXXXX` / `CCTEAM-XXXXXX` is released as
  evidence; a reference-less receipt is **dropped** (`evidence.ts:304-307`).
- Therefore paying via the static Pro link produces a Razorpay confirmation email with
  **no matching reference** → the Gmail rail drops it → the intent stays **REVIEW**,
  **never auto-ACTIVE**.

This is the exact documented limitation: *"static per-plan link … cannot auto-activate …
and go to REVIEW instead"* (`intents.ts:107-108`, `service.ts:107-109`).

The source comment "user must copy their unique reference into their Razorpay payment"
(`intents.ts:80`) applies to flows where the reference can be captured into the payment;
a hosted static public link does not expose a field to enter that reference, so the
end-to-end Gmail auto-activation cannot bind it.

## 2. Additional constraint for setup

Intent/session creation is **auth-gated** (`paymentRoutes` → `router.use(requireAuth)`,
`routes.ts:46`). Preparing the server-generated intent/reference/checkout URL requires a
real authenticated user session. A per-intent reference can only be produced and acted
upon with that user's own account, and even then the generated `payment_link` is the
static link while the API is deferred.

## 3. Required to un-block a REAL zero-admin acceptance test

To make `ZERO_ADMIN_TEST = PASS` genuinely possible, one of the following must hold
(not in scope of this task, per the "no architecture change / no feature add / Razorpay
deferred" constraints):

1. **Enable the Razorpay API** (`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`) so the server
   can mint a **per-intent payment link** bound to the unique `CCPRO-XXXXXX` reference
   (backend env change + redeploy). Then the reference reaches Razorpay and the Gmail
   matcher can bind it → auto-ACTIVE. — This is the intended design and the only path
   that satisfies auto-activation with the static/public checkout flow.
2. **A reference-capturing checkout flow** where the customer enters the server-issued
   reference inside the Razorpay payment (UPI / description) so the confirmation email
   carries it — requires product/UI support, not present now.
   - Note the current default razorpay mode is `payment_link` with static links, which
     cannot capture the reference.

Without one of these, the controlled payment would be a **negative test**: payment would
succeed, Gmail evidence would not match (or the email wouldn't carry the reference),
entitlement would land in **REVIEW** requiring a human — which is exactly the 
`ADMIN_ACTION = NONE` / `ZERO_ADMIN_TEST = PASS` condition the test demands.
Per the request's own failure conditions ("do not grant entitlement manually",
"If any unexpected state occurs: STOP and report it"), proceeding with real money is
not appropriate.

## 4. Sanitized record (no secrets)

```
Customer test:       CONTROLLED
Plan:                PRO
Expected amount:     ₹999
Payment:             NOT PERFORMED
Razorpay confirmation: N/A
Gmail evidence:      N/A
Authenticity:        N/A
Reference match:     NOT_POSSIBLE (static link carries no server reference)
Plan validation:     PASS (server-authoritative; PRO 999)
Amount validation:   PASS (server-authoritative; tolerance 0)
Idempotency:         PASS
Verification:        N/A
Entitlement:         NOT_ACTIVE
Admin action:        NONE
ZERO_ADMIN_TEST:     BLOCKED (do-not-pay; static link cannot auto-activate)
```

## 5. Recommended next step (needs decision)

To run a real PASSING zero-admin acceptance test, authorize enabling the **Razorpay API**
(backend env `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` + redeploy of the existing backend
service) so the server can mint per-intent references/links — the trusted
`createRazorpayPaymentLinkForIntent` + Gmail-reference-binding path is already implemented
and handler-level tested. That is a small, contained env+deploy change, separate from
this gate. Alternative: proceed with the static-link payment only as a **negative/
diagnostic** test and accept a REVIEW outcome (not zero-admin).

- Gmail rail, OAuth, mailbox, matcher, and security gates are otherwise **READY/VERIFIED**
  as recorded in `docs/FINAL_GMAIL_ZERO_ADMIN_LAUNCH_GATE.md`.

No secrets were exposed. No payment was made. No entitlement was activated.
