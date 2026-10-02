# FINAL ZERO-ADMIN LAUNCH GATE

> Status report. No secrets, credentials, `.env` values, OAuth tokens, or API
> keys are printed. No real payment was executed. No deployment was performed.
>
> Source-verified against the live code (not documentation): the OAuth flow
> (`auth/google.ts`), the callback route (`auth/routes.ts` GET
> `/api/v1/auth/google/callback`), the gmail evidence rail (`evidence.ts`,
> authenticated-origin + exact-reference, `format=full`), the trusted pipeline
> (`pipeline.ts` trusted sources, manual/OCR forced REVIEW), the watchdog
> mailbox sweep (`service.ts` `sweepPendingIntentEvidence` + `watchdog.ts`).

## Gate status

| Item                    | Status                                     |
| ----------------------- | ------------------------------------------ |
| PAYMENT                 | PASS                                       |
| PRO                     | PASS (₹999)                                |
| TEAM                    | PASS (₹4999)                               |
| GMAIL_RAIL              | READY (code) / BLOCKED (operator setup)    |
| STATIC_LINK_CORRELATION | LIMITATION                                 |
| AUTO_ACTIVATION         | PASS (trusted rail)                        |
| MANUAL_ADMIN_NORMAL_PATH| NOT_REQUIRED (for verified receipts)       |
| RAZORPAY_API            | REQUIRED for exact static->user correlation; OPTIONAL for the mailbox rail itself |
| RAZORPAY_WEBHOOK        | NOT_REQUIRED                               |
| MAILBOX                 | HUMAN_ACTION_REQUIRED (controlled mailbox OAuth) |
| GOOGLE_OAUTH            | HUMAN_ACTION_REQUIRED (consent + gmail.readonly) |
| PLAN_VALIDATION         | PASS                                       |
| AMOUNT_VALIDATION       | PASS                                       |
| IDEMPOTENCY             | PASS                                       |
| REPLAY_PROTECTION       | PASS                                       |
| MANUAL_EVIDENCE_BYPASS  | PASS (blocked)                             |
| TYPECHECK               | PASS                                       |
| BUILD                   | PASS                                       |
| OVERALL                 | BLOCKED (operator setup required)          |

## Definitions verified

- **NORMAL_TRUSTED_PAYMENT = AUTO_ACTIVE**: a receipt from an
  authenticated-origin Razorpay email carrying the EXACT server-issued
  reference, with amount/plan matching the intent, is trusted (`gmail` is a
  trusted source) and drives the intent to ACTIVE with an entitlement — no
  admin action.
- **AMBIGUOUS_PAYMENT = REVIEW/PENDING**: a reference-less static-link
  receipt (cannot be attributed), a fabricated reference, an unauthenticated
  (spoofed) email, a wrong amount/plan, or manual/OCR evidence never reaches
  ACTIVE. These stay PENDING/REVIEW and are clearly audited/flagged.

## Key decisions

- **RAZORPAY_API = REQUIRED (for correlation), but NOT for mailbox
  verification.** The Gmail rail reads an authenticated, exact-reference
  receipt; it does not call the Razorpay API. HOWEVER, a static Payment Link
  carries no per-user CodeConClave identity, so the correct user can only be
  associated when the payment is created via the Razorpay API as a **unique
  per-intent link** whose reference appears in the confirmation email. Without
  that, static-link receipts are ambiguous and stay REVIEW. Hence the API is
  needed precisely for **unique user correlation / automatic activation** at
  scale, not for reading mail.
- **RAZORPAY_WEBHOOK = NOT_REQUIRED** for the mailbox rail. It remains an
  alternative trusted rail for later but is not needed here.
- **MAILBOX_OWNER = the Razorpay notification mailbox the operator controls.**
- **MAILBOX_PURPOSE = receive Razorpay payment-confirmation emails so the
  server verifies and auto-activates payments with zero admin.**

## Security controls present (source-verified)

- Server-authoritative entitlement: only `applyDecision`/`activateEntitlement`
  can create ACTIVE; client requests never suffice.
- Trusted evidence isolation: `gmail`/`razorpay_api`/`razorpay_webhook` are
  trusted; `manual`/`ocr` are forced REVIEW with
  `manual_assertion_cannot_activate`.
- Origin authentication: `isAuthenticRazorpayMail` requires From=razorpay.com
  AND dkim/spf/dmarc pass for razorpay.com; spoofed mail dropped.
- Exact correlation: only the unique server-issued reference is accepted; a
  customer/fabricated reference or paymentId/amount alone can never activate.
- Plan/amount: server `PLAN_PRICES_INR` (pro 999 / team 4999); mismatch is a
  BLOCKING flag, no entitlement.
- Idempotency: evidence deduped by `sha256`; activation exactly-once via the
  guarded PENDING/REVIEW->ACTIVE UPDATE.
- Replay: duplicate evidence across intents flagged; duplicates are no-ops.
- Manual-evidence/OCR cannot reach VERIFIED/ACTIVE.
- Audit: `payment.activated`, fraud flags, origin rejections all audited.
- Tenant isolation: intent owner checks throughout; cross-user/non-matching
  reference is dropped.
- Refresh/expiry: env token OAuth; if the Gmail token is absent/expired the
  rail is unavailable (no activation) — it throws `evidence_source_blocked`
  rather than fabricating success.

## Tests

New/updated gate suite `backend/src/foundation/payments-gmail-gate.test.ts`
covers the mandated list: valid receipt -> ACTIVE; Pro ₹999; Team ₹4999;
invalid origin rejected; fake reference rejected; fake amount (TEAM+₹999)
rejected; wrong plan rejected; duplicate -> one entitlement; ambiguous
(reference-less / amount+payer-only) -> PENDING; authentication unavailable
-> blocked/no activation; manual & OCR cannot activate (existing suites);
tenant isolation; audit trail. Replay + watchdog sweep (bounded, backoff)
covered.

- Payments + workers + resilience + security (my + adjacent areas): **209
  passed / 0 failed / 0 skipped**
- New gate suite: **16 passed / 0 failed / 0 skipped**
- Full backend: **1772 passed / 1 pre-existing non-payment timing flake /
  3 skipped** (the flake is `security-15` `authLimit …store down`, untouched by
  these changes; passes deterministically in isolation)
- Backend typecheck: **PASS**; Backend build: **PASS**
- Frontend/shared/local-agent: unchanged by this payment work (see dedicated
  workspace runs; regression documented in the final response).

## The exact external limitation (never a software defect)

`STATIC_LINK_USER_CORRELATION = LIMITATION`. A static Razorpay Payment Link
(`https://rzp.io/rzp/sAgHIpxS`, `https://rzp.io/rzp/3ioXlCxd`) carries no
per-user CodeConClave identity. To auto-verify WHO paid, the server needs an
independently trustworthy signal linking the payment to a user. The mailbox
rail provides that ONLY when the Razorpay payment-confirmation email contains
the unique CodeConClave reference, which requires creating the payment via the
Razorpay API (unique per-intent links). Until then, static-link receipts are
correctly held at REVIEW — the system never guesses or fakes an assignment.

## Not done (by rule)

- No deploy (`railway up`/redeploy/deploy), no push.
- No real payment executed.
- No unrelated features added.
- No secrets/.env/.env.example contents exposed anywhere in these docs or the
  diff.