# FINAL RAZORPAY ZERO-ADMIN READINESS

> No secrets, `.env` values, or API keys are printed. No real payment was run.
> No deployment was performed.

## Status

| Item                    | Status                                     |
| ----------------------- | ------------------------------------------ |
| CODE_SUPPORT            | PASS                                       |
| CREDENTIALS             | MISSING                                    |
| WEBHOOK_ENDPOINT        | PASS                                       |
| SIGNATURE_VERIFICATION  | PASS                                       |
| AUTO_ACTIVATION         | READY_WHEN_TRUSTED_RAIL_ENABLED            |
| MANUAL_ADMIN_NORMAL_PATH| NOT_REQUIRED                               |

## Verification (source-confirmed, no code changed)

- Payment Link checkout preserved. Per-intent unique links are created via the
  Razorpay API only when it is available; otherwise the app falls back to the
  SAME static per-plan links. PRO link and TEAM link values unchanged.
- Pro = ₹999 / Team = ₹4999 (`PLAN_PRICES_INR` in `service.ts`); server map is
  the sole price authority; webhook amount is validated against the intent and
  a mismatch is never auto-activated.
- Trusted automatic entitlement: the signed webhook is ingested through the
  trusted 26H pipeline (`razorpay_webhook` source) and can reach ACTIVE.
  Manual/OCR evidence is forced to REVIEW and can never self-activate.
- Webhook endpoint: `POST /api/v1/payments/webhook/razorpay` (raw body mounted
  before the JSON parser).
- Signature: HMAC-SHA256 over the raw body bytes; timing-safe compare; invalid
  signature -> 401 + audit event.
- Idempotency: event-level dedupe via `payment_webhook_events`
  (`ON CONFLICT (event_id) DO NOTHING`); a duplicate delivery is a no-op.
- Replay protection: duplicate event.id is ignored and non-PENDING/REVIEW
  intents are a no-op.
- User/payment association: server-authoritative identifiers only
  (`provider_reference_id` / `provider_payment_link_id` / internal reference).
  Never email-only. An unresolvable webhook is recorded and rejected.
- Admin is not required on the trusted rail: bound, signed, amount-matched
  webhooks auto-activate.

## Blocker

- RAZORPAY_ACCOUNT_BLOCKER = YES
- CREDENTIALS = MISSING (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET, and RAZORPAY_WEBHOOK_ENABLED=false).
- This is an **external account limitation**, not a software failure.
  Razorpay Dashboard requires onboarding (live reviewed website + the first
  paying customers) before API keys and webhooks are enabled.

## Why static links alone cannot auto-activate

A static link carries NO per-user identity. When a customer pays it, the
webhook (once enabled) would still refer to one shared link id — the server
cannot tell WHICH user paid, so it cannot safely grant the right account.
Therefore the zero-admin path needs BOTH:

1. the signed webhook (the trusted confirmation), and
2. a unique per-intent payment link created via the Razorpay API (the trusted
   binding that says "this payment belongs to this user").

Both rails are already implemented in code; they activate automatically the
moment the account enables them.

## Interim (before the account enables webhooks/API)

Static-link payments stay PENDING -> REVIEW. A human must approve them once.
This is unavoidable while Razorpay gates the trusted rails, and it is exactly
the secure behaviour required. First 2–3 customers => REVIEW approvals =>
Razorpay enables webhooks/API => zero-admin switches on with NO code change.

## What must happen in Razorpay Dashboard (the founder)

1. Complete merchant KYC and upload the live website for review.
2. Take the first 2–3 real payments (approved manually in the app).
3. Once enabled, Razorpay Dashboard -> Settings -> Webhooks -> Create Webhook:
   - URL: `https://<app>/api/v1/payments/webhook/razorpay`
   - Events subscribed: `payment.captured`, `payment_link.paid`,
     `payment.refunded`.
   - Copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.
4. Razorpay Dashboard -> Account & Settings -> API Keys: copy
   `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (needed to mint unique
   per-intent links). Set them in the backend runtime env.
5. Set `RAZORPAY_WEBHOOK_ENABLED=true`, redeploy. Verified with one test path.

Credentials are entered directly into Railway/the local environment by the
founder; they must never be pasted into chat.