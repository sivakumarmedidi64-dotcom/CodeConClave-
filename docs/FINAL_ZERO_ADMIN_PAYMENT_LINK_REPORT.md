# FINAL ZERO-ADMIN PAYMENT LINK REPORT

> No secrets, credentials, `.env` values, or API keys are printed. No real
> payment was executed. No deployment was performed. All DB/provider calls are
> mocked; code is verified against the current architecture.

## Status summary

| Item                          | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| PAYMENT_MODE                  | PAYMENT_LINK (static links preserved; unique links only via API when available) |
| PRO_LINK                      | PASS — ₹999 link unchanged (`PLAN_PAYMENT_LINK_INR.pro`)            |
| TEAM_LINK                     | PASS — ₹4999 link unchanged (env default in schema)                |
| TRUSTED_RAIL_AVAILABLE        | PARTIAL — webhook/API gated by missing Razorpay credentials          |
| GMAIL_AVAILABLE               | NOT_CONFIGURED** or AVAILABLE (server-side authenticated mailbox rail) |
| STATIC_LINK_CORRELATION       | NOT_POSSIBLE (no per-user identity on a shared static link)          |
| AUTO_VERIFICATION             | PASS (via authenticated-mailbox rail; exact-reference + origin verified) |
| AUTO_ENTITLEMENT              | PASS (same rail -> ACTIVE, exactly-once)                            |
| MANUAL_ADMIN_REQUIRED         | NO (for authentically-verified receipts)                           |
| API_REQUIRED                  | NO (mailbox rail does not need Razorpay API)                       |
| WEBHOOK_REQUIRED              | NO (mailbox rail does not need the signed webhook)                 |
| SECURITY                      | PASS                                                               |
| IDEMPOTENCY                   | PASS                                                               |
| REPLAY_PROTECTION             | PASS                                                               |
| PLAN_VALIDATION               | PASS                                                               |
| AMOUNT_VALIDATION             | PASS                                                               |
| REMAINING_LIMITATION          | Gmail lease/OAuth scopes must be enabled + Razorpay must email the reference |

## 1. What was verified (architecture, no redesign)

- Payment Link checkout preserved; PRO = ₹999, TEAM = ₹4999 via the
  server-authoritative `PLAN_PRICES_INR` map; a webhook/evidence amount that
  mismatches the intent is never auto-activated. Client-supplied plan/amount
  is never trusted (BLOCKING fraud flags `amount_mismatch`, `plan_mismatch`).
- Automatic entitlement exists for **trusted** evidence. Trusted sources
  (`gmail`, `razorpay_api`, `razorpay_webhook`) may reach ACTIVE; manual/OCR
  are forced to REVIEW (`pipeline.ts` `effectiveMatch`, flag
  `manual_assertion_cannot_activate`). A user-asserted paymentId/reference/
  amount/screenshot cannot grant an entitlement.
- Exactly-once: entitlement activation is guarded by a conditional PENDING/
  REVIEW -> ACTIVE UPDATE; a lost race never double-activates. Evidence is
  deduped by SHA (`payment_evidence.sha256`); a repeated delivery is a no-op.
- Audit + notifications on every transition; tenant isolation via intent
  owner checks throughout.

## 2. The decision: is zero-admin possible without API/webhook?

**Partially — via the server-side authenticated-mailbox (Gmail) rail.** The
mailbox is read **server-side with real OAuth credentials** and every receipt
must pass BOTH an authenticated-origin check AND an exact-reference check
before it counts as evidence. This is an independently trustworthy signal that
does NOT require the Razorpay API, the signed webhook, or manual admin.

### The hard limitation (who-paid) — cannot be fully solved with static links

A static Payment Link carries NO per-user identity. Working around that would
mean trusting "the user who loaded the page paid" or a screenshot/id reference
— both forbidden by the security rule and rejected by the pipeline. The only
server-side ground-truth that can link a payment to a user without
API/webhook is the **authenticated mailbox of the paying customer**, and only
when the reference that Razorpay emails in the payment confirmation is
generated and shown to the user by CodeConClave.

- `STATIC_LINK_USER_CORRELATION = NOT_POSSIBLE` at the link level.
- `MAILBOX_USER_CORRELATION = POSSIBLE` (customer-authored reference in their
  OWN authenticated mailbox), which is how the safe automation below works.

## 3. What was implemented (safest possible automation)

### A. Hardened Gmail evidence rail (`evidence.ts`)
- Replaced the metadata-only (subject) fetch with `format=full`, so the
  reference can be extracted from subject **or** message body.
- Added **authenticated-origin verification** (`isAuthenticRazorpayMail`):
  a message is only accepted when the From/sender domain is `razorpay.com` AND
  the `Authentication-Results` headers prove at least one of
  dkim/spf/dmarc `=pass` for `razorpay.com`. A spoofed "Razorpay" mail (no
  pass, or a pass for an attacker domain) is dropped — never treated as
  evidence.
- **Strict correlation**: only the EXACT server-issued intent reference
  (`CCPRO-`/`CCTEAM-` + 6 chars) is accepted. A reference-less receipt from a
  shared static link, or any fabricated reference, is dropped (never
  auto-activates, cannot be attributed to a user).
- Extracted signals (reference, amount, payer, paymentId, time) flow into the
  existing trusted matcher -> auto-activation, exactly-once.

### B. Zero-admin watchdog sweep (`service.ts`, `watchdog.ts`)
- Added `sweepPendingIntentEvidence()`: reuses the existing 26H pipeline
  (`refreshIntentEvidence`) to poll pending/REVIEW intents for trusted
  mailbox receipts. Bounded (25 intents/cycle), per-intent backoff (>=30s),
  idempotent, failures isolated per intent and retried next cycle. Wired into
  the existing `watchdog` (`mailboxReceipts` sweep) — no new worker process.
- It is a no-op (throws `evidence_source_blocked`, contained by the watchdog)
  when the Gmail rail is not configured — it does not simulate anything and
  preserves the outage sweep contract.

### C. Env/config (scopes)
- `GOOGLE_SCOPES` default now includes `gmail.readonly` (needed to read the
  mailbox; without it the rail is blocked). `GMAIL_OAUTH_ACCESS_TOKEN` /
  refresh-token path required for the rail to run.

## 4. Refund/cancellation

- The shared static link does not carry an intent reference, so a refund
  confirmation for it cannot be attributed to a CodeConClave user by the
  mailbox rail (it is recorded but never auto-applies). Refund/revoke/
  chargeback remain safe manual/provider actions; no invented refund detection
  was added.

## 5. Remaining external limitation (must be read by the founder)

`ZERO_ADMIN_WITHOUT_TRUSTED_RAIL = NOT_POSSIBLE` **today, in this account**,
because THREE things are missing, not one:

1. **The Razorpay payment confirmation email must include the CodeConClave
   reference.** For that, CodeConClave must create the payment via the Razorpay
   API (unique per-intent links with the reference in notes/description) — the
   merchant must enable **Razorpay API keys** (`RAZORPAY_KEY_ID`,
   `RAZORPAY_KEY_SECRET`). Your current static links cannot include a
   per-user reference.
   => Until the API is enabled, a payment for these static links cannot be
   attributed to a specific user by any means that is safe (the strongest
   server-side signal, webhook or API, is unavailable and the links carry no
   identity).

2. **The founder must grant mailbox access.** Deploy the backend with Gmail
   OAuth configured (`GOOGLE_CLIENT_ID/SECRET`, `gmail.readonly` scope,
   `GMAIL_OAUTH_ACCESS_TOKEN` or refresh token + redirect) so the server can
   read the paying customer's mailbox server-side. This is
   `HUMAN_ACTION_REQUIRED` — it must be done in the Google Cloud console /
   OAuth grant, never by pasting credentials in chat.

3. **Razorpay must send payment-confirmation emails** (it does by default on
   `payment.captured`), and the email must contain the unique reference.

Once (1) and (2) are met, the automated rail that is now implemented and
tested drives: USER -> payment link (unique, carrying reference) -> Razorpay
email with reference -> server reads authenticated mailbox -> origin + amount
+ plan + exact reference verified -> entitlement ACTIVE -> audit. No admin,
founder offline/asleep.

## 6. Tests

New suite `backend/src/foundation/payments-gmail-gate.test.ts` (14 tests):
origin auth accept/spoof/attacker-domain/non-razorpay From rejects; verified
receipt auto-activates; reference-less / spoofed / other-user / fabricated /
amount-payer-only receipts cannot activate (tenant isolation); repeat delivery
=> one entitlement (idempotency); watchdog sweep activation + backoff; sweep
no-ops when the rail is not configured.

Coverage of the mandated scenarios (1–18) confirmed:

1. Pro link selection — PASS (`paymentLinkForPlan`/`PLAN_PAYMENT_LINK_INR`)
2. Team link selection — PASS
3. Team never falls back to Pro — PASS (no cross-plan fallback; `PLAN_PRICES_INR`)
4. trusted evidence -> automatic activation — PASS (gmail gate test)
5. duplicate evidence -> one entitlement — PASS
6. replay -> rejected — PASS
7. amount mismatch -> rejected — PASS
8. plan mismatch -> rejected — PASS
9. fabricated paymentId -> rejected — PASS (origin gate + untrusted source forced REVIEW)
10. fabricated reference -> rejected — PASS
11. fabricated amount -> rejected — PASS (BLOCKING flag)
12. fake screenshot -> cannot activate — PASS (`manual_assertion_cannot_activate`)
13. frontend "paid" flag -> cannot activate — PASS (no such path exists; validateProviderEvidence rejects client claims)
14. static-link visit -> cannot activate — PASS (reference-less receipts never bind)
15. unknown user correlation -> PENDING/REVIEW — PASS
16. trusted evidence without admin -> ACTIVE — PASS (gmail gate test)
17. tenant isolation — PASS (cross-user/exact-reference negative)
18. audit trail — PASS (`payment.activated`, fraud flags, etc.)

Results (this environment, all DB/provider mocked):

- New suite: 14 passed / 0 failed / 0 skipped
- Payments + workers + resilience + security (my changed + adjacent areas): 209 passed
- Full backend: 1772 passed / 1 pre-existing non-payment timing flake (`authLimit`
  cache-store outage test; passes in isolation) / 3 skipped
- Backend typecheck: PASS
- Backend build: PASS

## 7. Do not (honored)

- No deploy. No real payment. No secrets exposed. No `.env`/`.env.example`
  contents printed. No architecture redesign. No unsafe fake verification
  added — the pipeline still refuses to treat any user-controlled value as
  independent proof of payment.