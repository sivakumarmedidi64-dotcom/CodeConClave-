# FINAL RAZORPAY PRODUCTION CONFIGURATION GATE

> Status report. **No** credentials, `.env` values, or API keys are printed here.
> **No** payment was run against a live account and **no** deployment was performed.

## Gate status: BLOCKED

The auto-activation rail is implemented, wired, and green in tests, but
`RAZORPAY_WEBHOOK_SECRET` is not configured in the runtime environment, so a
signed webhook cannot exist yet. The gate cannot open until the Razorpay
Dashboard credentials below are provided and `RAZORPAY_WEBHOOK_ENABLED=true`.

## Required statuses

| Item                    | Status    | Default when absent                |
| ----------------------- | --------- | ---------------------------------- |
| RAZORPAY_KEY_ID         | MISSING   | optional (env.ts:81) — empty in .env |
| RAZORPAY_KEY_SECRET     | MISSING   | optional (env.ts:82) — empty in .env |
| RAZORPAY_WEBHOOK_SECRET | MISSING   | optional (env.ts:83) — empty in .env |
| RAZORPAY_WEBHOOK_ENABLED| FALSE     | default 'false' (env.ts:88), absent in .env |
| WEBHOOK_ENDPOINT        | PRESENT   | POST /api/v1/payments/webhook/razorpay (app.ts:212; raw body mounted before JSON at app.ts:78) |
| WEBHOOK_SIGNATURE       | PASS      | HMAC-SHA256 over raw body Buffer + timingSafeEqual; invalid -> 401 (routes.ts:305-309) |
| AUTO_ACTIVATION         | PASS      | trusted signed webhook -> ingestEvidence -> AVT-F + spring free + SENT; rail tests 64/64, 28/28 |
| MANUAL_ADMIN_NORMAL_PATH| NOT_REQUIRED | bound+trusted webhook auto-activates; manual/OCR still forced REVIEW |
| PRO_₹999                | PASS      | PLAN_PRICES_INR.pro = 999 (service.ts:40); amount+plan enforced by trusted matcher |
| TEAM_₹4999              | PASS      | PLAN_PRICES_INR.team = 4999 (service.ts:40); amount+plan enforced by trusted matcher |

## Where to obtain each MISSING credential (none printed)

- **RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET** — Razorpay Dashboard →
  Account & Settings → API Keys. Store as backend-only secrets, never in
  frontend/shared code. These are the *secondary* (API query / link creation)
  rail; without them checkout falls back to static per-plan links only.
- **RAZORPAY_WEBHOOK_SECRET** — the secret Razorpay shows when you create the
  webhook: Razorpay Dashboard → Settings → Webhooks → Create Webhook.
  Use the same value server-side in `RAZORPAY_WEBHOOK_SECRET`.
- **RAZORPAY_WEBHOOK_ENABLED** — set to `true` in the backend runtime env
  ONLY after the webhook is registered and reachable.

## Webhook registration checklist (operator, after gate items are filled)

1. Register URL `https://<app>/api/v1/payments/webhook/razorpay` in
   Razorpay Dashboard → Settings → Webhooks (webhook secret: the new value).
2. Subscribe events: `payment.captured`, `payment_link.paid`, `payment.refunded`.
3. Set env: `RAZORPAY_WEBHOOK_SECRET=<secret>` and `RAZORPAY_WEBHOOK_ENABLED=true`.
4. Redeploy backend, confirm `providerStatus` reports Razorpay AVAILABLE
   (payment_link + api + webhook all enabled).
5. Run one test payment against the links flow and confirm auto-activation.

## Verification evidence (source-verified, no secrets)

- Schema: `backend/src/config/env.ts` lines 80-91 (`RAZORPAY_WEBHOOK_ENABLED`
  decoupled gate; per-plan link defaults; poll minutes).
- Dual-rail activation path is unchanged architecture: checkout static/unique
  payment links; verification via signed webhook (trusted rail) or API status;
  manual/OCR never auto-activate (`manual_assertion_cannot_activate`).
- Plan/amount mismatches are BLOCKING fraud flags (`amount_mismatch`,
  `plan_mismatch`); never activate.
- Intent binding uses provider `reference_id` / payment-link id / internal
  reference; never email-only.
- Idempotency: `payment_webhook_events` keyed by Razorpay `event.id`
  (`ON CONFLICT (event_id) DO NOTHING`, routes.ts:344-346).
- `.env.example` aligned with schema (added `RAZORPAY_WEBHOOK_ENABLED`,
  `RAZORPAY_TEAM_PAYMENT_LINK`) — config docs, not architecture.
- Reporting-layer fix: ops/evidence availability now honors
  `RAZORPAY_WEBHOOK_ENABLED === 'true'` (was stale `RAZORPAY_MODE === 'webhook'`).
- Test runs: payments-26h 64/64, payments-4d 28/28, and operations-14 /
  billing-14 / failures-15 all green (128/128 of the targeted suites);
  backend `tsc --noEmit` clean.

## Not done (by rule)

- No `railway up` / deploy.
- No live payment executed against Razorpay.
- No new architecture change except the reporting-gate fix above.