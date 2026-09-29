# FINAL ZERO-ADMIN RELEASE GATE

> Status report. No secrets, OAuth tokens, API keys, DB/Redis credentials, or
> `.env` values are printed — only exact **variable names** from the env schema.
> No real payment made. No deployment performed (gate not passed).
>
> Source-verified against live code, not documentation (env schema
> `backend/src/config/env.ts`; callback route `backend/src/modules/auth/
> routes.ts` GET `/api/v1/auth/google/callback`; gmail evidence rail
> `backend/src/modules/payments/evidence.ts`; trusted pipeline
> `backend/src/modules/payments/pipeline.ts`; watchdog sweep
> `backend/src/modules/payments/service.ts` + `backend/src/workers/watchdog.ts`).

## Gate status

| Item                          | Status                                     |
| ----------------------------- | ------------------------------------------ |
| Google/Gmail requirements     | Confirmed (Gmail API + OAuth consent + gmail.readonly) |
| Mailbox configuration         | Controlled Razorpay notification mailbox   |
| Razorpay API requirement      | REQUIRED for unique static->user correlation |
| Per-intent correlation        | PASS (code)                                |
| Trusted verification          | PASS (origin-auth + exact reference)       |
| Automatic activation          | PASS (code) / BLOCKED (operator setup)     |
| Security                      | PASS                                       |
| ZERO_ADMIN_PAYMENT_GATE       | BLOCKED (human setup not completed)        |
| DEPLOYMENT                    | BLOCKED                                    |

## Google / Gmail requirements (human)

1. Google Cloud Console (`https://console.cloud.google.com/`): the project that
   holds the CodeConClave OAuth client. Only ONE OAuth client for
   CodeConClave — do not create a second one if the correct one already exists.
2. Enable **Gmail API** (Console → APIs & Services → Library → Gmail API →
   Enable).
3. **OAuth consent screen** — required scope `gmail.readonly`. In testing mode,
   add the controlled Razorpay notification mailbox as a **test user**. Use the
   appropriate testing/publishing mode for this launch (keep it in Testing for
   personal/verified use; Publishing for public launch).
4. **OAuth client** — Web application; **Authorized redirect URI**
   `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`
   (route verified: `auth/routes.ts:329`).
5. **Controlled mailbox** — a mailbox owned by the CodeConClave payment owner
   (not a customer's). Configure Razorpay to send payment notifications there.
6. Complete **offline OAuth** (access_type=offline) for that mailbox so a
   refresh token is granted; provision the token via the secure Railway
   mechanism.

## Mailbox configuration

- **MAILBOX_OWNER = the controlled Razorpay notification mailbox (payment owner).**
- **MAILBOX_PURPOSE = receive Razorpay payment-confirmation emails so the
  server auto-verifies and auto-activates with zero admin.**
- The reader calls `users/me/messages` with a server-env token
  (`GMAIL_OAUTH_ACCESS_TOKEN`), reads `format=full`, and only accepts messages
  whose authenticated origin is razorpay.com (dkim/spf/dmarc `=pass` for
  razorpay.com) carrying the EXACT server-issued intent reference.

## Razorpay API requirement

- **RAZORPAY_API = REQUIRED** for the intended static-link → per-user
  correlation, because a static Payment Link carries no CodeConClave user
  identity. The trusted alternative (webhook) is not used by the mailbox rail.
- **REASON (from code, not assumption):** `createRazorpayPaymentLinkForIntent`
  (`service.ts`) creates a UNIQUE per-intent link whose reference is stored on
  the intent and (via the Razorpay API notes/description) appears in the
  confirmation email. Only then can the mailbox rail correlate the email to the
  exact intent/user deterministically. Without the API, static-link receipts
  are ambiguous and correctly stay PENDING/REVIEW.
- Therefore the user must create/refresh fresh **Razorpay API credentials** and
  put `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` into Railway. No real payment
  is made yet.

## Per-intent correlation (client never chooses the reference)

- Server generates a unique reference (`CCPRO-`/`CCTEAM-` + 6 chars) in
  `createPaymentIntent` (`intents.ts`).
- Server creates a unique Razorpay link per intent with that reference
  (`createRazorpayPaymentLinkForIntent`).
- Intent stores `provider_payment_link_id` + `provider_reference_id`.
- The confirmation email (mailbox) is matched to the intent by the EXACT
  reference; the client is never allowed to pick it.

## Trusted verification + automatic activation

- Origin: `isAuthenticRazorpayMail` (From=razorpay.com + dkim/spf/dmarc pass).
- Reference: exact server-issued reference match only.
- Amount: matches intent (`PLAN_PRICES_INR`: pro 999 / team 4999); mismatch is
  a BLOCKING fraud flag -> REVIEW, no entitlement.
- Plan: validated; `plan_mismatch` blocks; no cross-plan fallback.
- Trusted sources (`gmail`, `razorpay_api`, `razorpay_webhook`) may reach
  ACTIVE; manual/OCR forced REVIEW (`manual_assertion_cannot_activate`).
- Watchdog `mailboxReceipts` sweep polls pending/REVIEW intents automatically
  (bounded 25/cycle, per-intent >=30s backoff, idempotent, failures isolated
  and retried) — no admin click, founder may be offline/asleep.

## Security (verified)

Manual evidence cannot activate; OCR cannot directly activate; client cannot
activate (no client-only path); fake paymentId/reference/amount cannot
activate; plan/amount mismatch rejected; duplicate/replay rejected (evidence
sha256 dedupe + exactly-once guarded ACTIVE update); untrusted origin rejected;
wrong/cross-user correlation rejected (exact reference + tenant owner checks);
tenant isolation preserved; audit trail on every transition. If the Gmail
token is absent/expired, the rail fails closed (no activation).

## Railway secure variables (exact names from env schema — values entered by the owner in the Railway console, never in chat)

Backend:
- `DATABASE_URL` (required — no default must remain)
- `DATABASE_SSL=true`
- `SESSION_SECRET` (strong random — prod refuses weak default)
- `JWT_SECRET` (strong random — prod refuses weak default)
- `REDIS_URL` (only if `QUEUE_PROVIDER=redis`)
- `QUEUE_PROVIDER` (`memory` or `redis`)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET` (secret)
- `GOOGLE_REDIRECT_URI` =
  `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`
- `GOOGLE_SCOPES` (must include `https://www.googleapis.com/auth/gmail.readonly`)
- `GMAIL_OAUTH_ACCESS_TOKEN` (secret) and/or `GMAIL_OAUTH_REFRESH_TOKEN`
  (secret) for the controlled mailbox
- `RAZORPAY_KEY_ID` (secret)
- `RAZORPAY_KEY_SECRET` (secret)

Frontend: only browser-safe values (no secrets).

## Human actions remaining

1. Google Cloud: enable Gmail API; OAuth consent screen with `gmail.readonly`,
   add the controlled mailbox as a test user (testing mode).
2. OAuth client (reuse existing if present) with redirect URI
   `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`.
3. Controlled Razorpay notification mailbox; enable Razorpay email
   notifications to it.
4. Razorpay Dashboard: create/refresh **API keys** (`RAZORPAY_KEY_ID`,
   `RAZORPAY_KEY_SECRET`) for unique per-intent links.
5. Run offline OAuth for the mailbox -> obtain the token; enter into Railway.
6. Enter all backend variables into Railway (exact names above); never share
   values.
7. Redeploy, then STOP for explicit human authorization before any real
   payment.
8. With authorization: controlled zero-admin acceptance test (real payment,
   PRO ₹999 and optionally TEAM ₹4999) -> expect automatic activation; then
   the deployment gate can be considered PASS.

## Test results

- Payments + workers + resilience + security (changed/adjacent): 209/209 PASS
- Gate suite (gmail origin/reference/tenant/replay/sweep): 16/16 PASS
- Full backend: 1772 passed / 1 pre-existing non-payment timing flake
  (`security-15` authLimit cache-store outage; passes in isolation) / 3 skipped
- Frontend: 279/279; Shared: 63/63; Local Agent: 49/49
- Typecheck: PASS (backend, frontend, shared, local-agent)
- Build: PASS (backend, frontend)

## Deployment state

**BLOCKED.** `ZERO_ADMIN_PAYMENT_GATE` is not PASS until the Google/Gmail,
mailbox, and Razorpay API human steps above are completed and the controlled
zero-admin payment acceptance test passes. No real payment was made and no
deploy command was run.