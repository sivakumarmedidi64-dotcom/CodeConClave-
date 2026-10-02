# Demo → Production Payment Migration

> **STATUS: PRODUCTION PAYMENT RAILS ARE FROZEN AND UNCHANGED.**
> This document describes how to evolve the non-production demo flow into a
> real, zero-admin, independently-verified payment rail once Razorpay
> capability exists. Nothing here is enabled in production today.

---

## 1. Context

The current stack has **no Razorpay API keys** and **no signed webhook**, so a
real zero-admin payment-verification rail is not possible. The interim
`DEMO_REDIRECT` rail demonstrates the journey but **is not payment proof**.
See `REDIRECT_ONLY_PAYMENT_DEMO_MODE.md`.

## 2. What must change to go production

The demo rail can NEVER become a production payment method. Production requires
either:

1. **Razorpay API mode** — create a real payment link/order with the Razorpay
   API and handle the **signed webhook** (`payment.captured`), OR
2. **Signed webhook on static links** — enable Razorpay webhooks with a shared
   secret and validate the HMAC, OR
3. **A trusted intermediary with cryptographic authenticity** (e.g., the Gmail
   claim rail using an OAuth-authenticated Apps Script + HMAC), which already
   exists in code but is disabled without credentials.

## 3. Migration path (when capability exists)

| Step | Action |
|---|---|
| 1 | Obtain Razorpay key id/secret and configure webhook secret + registered webhook URL. |
| 2 | Leave the demo rail **off** (`DEMO_PAYMENT_MODE=false`) in production — it is not a payment method. |
| 3 | Enable the production rail (Razorpay API/webhook or signed Gmail claim). |
| 4 | Keep `payment_verification_method` honest per rail (`RAZORPAY_API` / `RAZORPAY_WEBHOOK` / `GMAIL`). Remove any `DEMO_REDIRECT` records or mark them non-real (they already are). |
| 5 | Delete the demo endpoints, page, and temp env vars once uninterrupted real verification is proven. |

## 4. Safety invariants you must preserve

- Redirects/query/cookies are **never** payment proof.
- Only server-verified sources (`razorpay_api`, `razorpay_webhook`, `gmail`)
  may reach `ACTIVE`/`PRO_VERIFIED`; manual/OCR stay REVIEW-only.
- Amount/plan are server-authoritative; never accept client-supplied amounts.
- Idempotency, replay protection, and anti-self-activation stay in place.

## 5. Recommendation

Keep `FINAL_DECISION = DEMO_ONLY / BLOCKED` until Razorpay capability exists,
then follow this migration path to a real zero-admin payment rail. This matches
the standing `WAIT_FOR_RAZORPAY_CAPABILITY` recommendation.
