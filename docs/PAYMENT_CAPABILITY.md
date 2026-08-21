# CodeConClave Pro — Payment Capability Guide (Phase 18)

## Current capability — Payment Link only

| Mode | Status | Notes |
| --- | --- | --- |
| Payment Link | **ON** | `RAZORPAY_PRO_PAYMENT_LINK` configured. |
| API (`RAZORPAY_MODE=api`) | **OFF** unless real `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are configured. |
| Webhook (`RAZORPAY_MODE=webhook`) | **OFF** unless real `RAZORPAY_WEBHOOK_SECRET` is configured. |

No verified transaction is ever fabricated. The provider integration is
honest by construction.

## Flow

1. User requests Pro → the server creates a `payment_sessions` record with a
   checkout `reference` (the configured Payment Link when no API credentials
   exist) and state **`PENDING`**, expiring after
   `RAZORPAY_PAYMENT_LINK_STATUS_POLL_MINUTES`.
2. The user completes payment at Razorpay; no client-side code claims success.
3. The session becomes **`VERIFIED`** **only** through independent provider
   evidence:
   - webhook event (`payment.captured` / `payment_link.paid`) with signature
     verification, or
   - a server-side API status fetch (`RAZORPAY_MODE=api`).
4. Entitlement activates only on `VERIFIED` (`PRO_VERIFIED`); `PENDING` maps to
   `PRO_PENDING` (no premium benefits).
5. Refunds and cancellations only apply to `VERIFIED`/`PENDING` sessions and
   are admin-gated.

## Verification rules (never faked)

- Screenshots, user-entered payment IDs, localStorage, and polling from the
  client are **never** treated as evidence.
- Without verifiable provider evidence, a session stays `PENDING` forever —
  the UI shows "pending verification", never success
  (`backend/src/modules/payments/evidence.ts`).
- Idempotency: repeated create calls reuse the existing `PENDING` session per
  user/plan; verification is single-shot.
- Entitlement separation: payment state, session state, and entitlement state
  are distinct tables with explicit transitions (`payments.test.ts`,
  `payments-4d.test.ts`, `billing-14.test.ts`).

## Live validation status

**BLOCKED** — no real Razorpay credentials are present in this environment.
Contract-level tests pass; the live checkout → webhook → VERIFIED path must be
exercised after deployment (see runbook). `RAZORPAY_MODE` stays
`payment_link`; do not set `api`/`webhook` until real credentials exist.