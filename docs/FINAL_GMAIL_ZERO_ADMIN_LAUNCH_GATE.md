# CodeConClave — FINAL GMAIL ZERO-ADMIN LAUNCH GATE

> Date: 2026-08-31
> Decision under review: use the **existing Gmail payment-evidence rail** as the
> zero-admin activation path for the initial 1–2 controlled customers.
> Razorpay API/webhook are NOT required for this initial bridge (deferred).
>
> This is a **verification gate** — no code changed, nothing deployed, no payment
> made, no secrets exposed.

---

## 1. Gmail Rail — READY

- Source: `backend/src/modules/payments/evidence.ts` (`gmailSource`, lines 262-328).
- Server-side OAuth read of the controlled mailbox via the Gmail API
  (`messages?q=...`, `format=full`). Only normalized signals are extracted; message
  contents are never stored.
- Availability gate `gmailDetectorAvailable()` (evidence.ts:196-201): active when
  `GMAIL_OAUTH_ACCESS_TOKEN` is set, OR (`GMAIL_OAUTH_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID` +
  `GOOGLE_CLIENT_SECRET`) are set.
- Watchdog `verifyPendingPayments` (service.ts:589-621) polls PENDING/REVIEW intents and
  activates them via the Gmail rail — this is the zero-admin "founder asleep" path.
- gmail is a member of `TRUSTED_EVIDENCE_SOURCES` (pipeline.ts:55) so trusted evidence may
  reach ACTIVE.

## 2. Mailbox — READY

- The same Gmail account authorized by the configured OAuth tokens is the mailbox the
  reader queries (`users/me/messages`). It is the controlled mailbox that should receive
  Razorpay payment confirmations.
- Configured in the live backend: `GMAIL_OAUTH_ACCESS_TOKEN`, `GMAIL_OAUTH_REFRESH_TOKEN`
  (names confirmed present in Railway environment; values never printed).

## 3. OAuth — READY

Required vars, presence in live backend environment (names only; values never printed):

| Variable | Status |
|----------|--------|
| GMAIL_OAUTH_ACCESS_TOKEN | PRESENT |
| GMAIL_OAUTH_REFRESH_TOKEN | PRESENT |
| GOOGLE_CLIENT_ID | PRESENT |
| GOOGLE_CLIENT_SECRET | PRESENT |
| GOOGLE_REDIRECT_URI | CONFIGURED (non-default, live callback) |
| GOOGLE_SCOPES | DEFAULT (code default includes gmail.readonly) |

- `GOOGLE_SCOPES` is not overridden, so the default applies (env.ts:47-49) and includes
  `.../auth/gmail.readonly`. Google OAuth is live in production (prior smoke tests).

## 4. Payment Email Matching — PASS

- Origin gate `isAuthenticRazorpayMail` (evidence.ts:247-260): a candidate message is
  evidence only if delivery-authentication headers prove `razorpay.com` sent it
  (`dkim=pass`/`spf=pass`/`dmarc=pass` bound to `razorpay.com` AND the `From` domain is
  `razorpay.com`). Spoofed "Razorpay" mail is never evidence.
- Strict reference binding (evidence.ts:304-307): only the EXACT server-issued intent
  reference (`CCPRO-…`/`CCTEAM-…`) is released. A reference-less static-link receipt is
  dropped (never auto-activates).
- Extracts normalized signals: reference, amount (₹/INR), provider `pay_…` id, payer
  email, paid-at timestamp. Matcher requires reference as the anchor (+0.45 of 1.0).

## 5. Plan Validation — PASS (PRO ≠ TEAM, no fallback)

- `PLAN_PRICES_INR = { pro: 999, team: 4999 }` (service.ts:41) — matches the decision.
- `paymentLinkForPlan` (service.ts:57-60): unknown/invalid plan **throws**; never falls
  back to another plan's link.
- Payment links:
  - PRO ₹999 → `https://rzp.io/rzp/sAgHIpxS` (`RAZORPAY_PRO_PAYMENT_LINK`)
  - TEAM ₹4999 → `https://rzp.io/rzp/3ioXlCxd` (`RAZORPAY_TEAM_PAYMENT_LINK`)
  - Distinct URLs; TEAM never falls back to PRO.

## 6. Amount Validation — PASS

- Matcher requires `signals.amountInr === intent.amount_inr` for the amount signal
  (+0.25); server holds the authoritative amount/plan per intent.
- `PAYMENT_AMOUNT_TOLERANCE_INR` default 0 (env.ts:97) — exact match required.
- Active threshold `PAYMENT_CONFIDENCE_ACTIVE` default 0.8; a correct Gmail receipt scores
  reference(0.45)+amount(0.25)+paymentId(0.1)+time(0.1)+payer(0.1) = 1.0 → ACTIVE.

## 7. Idempotency / Replay — PASS

- Intents: only PENDING/REVIEW → ACTIVE via conditional `UPDATE ... WHERE status IN
  ('PENDING','REVIEW')` (activation.ts:111-115) — exactly-once race guard; already-processed
  intents are no-ops.
- Evidence replay: `signalSha256` canonical-signal key + `payment_webhook_events`
  `event_id` dedupe guard (evidence.ts:129-139) — a replayed receipt cannot double-activate.

## 8. Security — VERIFIED

A Gmail-derived payment becomes ACTIVE only when ALL hold:
1. Origin authenticated (razorpay.com DKIM/SPF/DMARC + From = razorpay.com). ✅
2. Reference matches the server-created intent exactly. ✅
3. Amount matches the server-authoritative plan. ✅
4. Status indicates a successful/paid receipt (successful-payment receipt messages matched). ✅
5. Not already processed (intent state no-op + replay dedupe). ✅

Otherwise → PENDING / REVIEW, **never** ACTIVE.
- `MANUAL_BYPASS = BLOCKED`: user-asserted sources (manual entry, OCR-typed) are forced to
  REVIEW regardless of confidence (pipeline.ts:63-75). Trusted sources (gmail) may ACTIVE.
- Fraud guard forces REVIEW, never ACTIVE (fraud.ts; activation.ts:32).
- Cross-user/tenant isolation and fabricated-evidence tests exist and pass.

## 9. Automatic Activation — READY

Normal path (no admin/review/founder action for a valid trusted payment):
`payment → Razorpay confirmation email in controlled mailbox → Gmail reader authenticates
origin → exact reference match → plan+amount validate → idempotency/state guard → ACTIVE`.

## 10. Testing-Mode Token Limitation

- The Google OAuth app is in **Testing** mode ⇒ `GMAIL_PRODUCTION_PERMANENCE = NO`. Production
  permanence is NOT claimed.
- `INITIAL_CONTROLLED_LAUNCH = ALLOWED`, provided the current token is valid and the
  controlled test succeeds. Token validity is confirmed by a successful live test run
  (not by this static gate alone).

## 11. Razorpay API / Webhook — DEFERRED

- `RAZORPAY_MODE` defaults to `payment_link` (checkout unchanged).
- `RAZORPAY_WEBHOOK_ENABLED`/`RAZORPAY_WEBHOOK_SECRET`/`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`
  are NOT configured → their rails report unavailable. They will be added later when the
  account/business satisfies provider requirements. Not required for this launch.

---

## 12. Runtime Test Preparation (no real payment yet)

```
GMAIL_READER                  = READY
PAYMENT_REFERENCE_MATCH       = READY
PLAN_VALIDATION               = PASS
AMOUNT_VALIDATION             = PASS
IDEMPOTENCY                   = PASS
MANUAL_BYPASS                 = BLOCKED
AUTO_ACTIVATION_PIPELINE      = READY
```

---

## 13. Final Decision

```
GMAIL_ZERO_ADMIN_GATE = READY_FOR_CONTROLLED_PAYMENT
REAL_PAYMENT          = APPROVAL_REQUIRED
```

The Gmail rail is verified ready from source + live configuration check. The final
token-validity + reference-match + auto-activation proof requires the single controlled
PRO ₹999 payment, which will only be performed on explicit human approval. Not performed here.
