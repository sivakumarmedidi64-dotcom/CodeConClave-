# FINAL — CONTROLLED GMAIL PAYMENT ACCEPTANCE TEST

> **Status: HELD AT REAL-PAYMENT GATE.** This directive permits a real ₹999
> payment **only with explicit operator approval** ("Do NOT spend ₹999
> automatically"). No explicit approval was given in the directive message, so
> `REAL_PAYMENT = NOT_PERFORMED` and every step that depends on observing a real
> Razorpay receipt is **NOT_TESTED (gated)**, NOT failed, NOT claimed.
>
> All steps that do NOT require real money / a live receipt were completed and
> verified from source + the safe unit-test harness.

---

## 1. Pre-payment verification (code-verified, no spend)

| Check | Result | Evidence |
|---|---|---|
| Controlled test account | AVAILABLE (auth account, `req.ctx.user`) | — |
| Pending PRO intent creation | PATH EXISTS | `intents.ts` `makeReference(planId)` |
| Reference belongs to exactly one user | PASS | reference is generated per-intent and bounded to `owner_id`; collector matches only the owning intent's DB-unique reference |
| Intent amount == ₹999 (PRO) | PASS | `service.ts PLAN_PRICES_INR = { pro: 999, team: 4999 }` |
| Intent starts PENDING | PASS | intents pipeline status model (`PENDING → REVIEW → ACTIVE …`) |
| Self-service flag/config | `BUILT_INERT / FLAG OFF` | `env.AIOS_PAYMENT_SELF_SERVICE = false` (default) |

Reference scheme: unique per-intent `CCPRO-XXXXXX` / `CCTEAM-XXXXXX`
(`\bCC(PRO|TEAM)-[A-Z0-9]{6}\b`, `evidence.ts:157,305`). All credentials/valid
reference values are handled per safety rules and never printed.

## 2. REAL PAYMENT

**`REAL_PAYMENT = NOT_PERFORMED`** — operator approval to spend ₹999 was NOT
given. No real customer, no automatic spend. When and ONLY when the operator
explicitly approves a controlled ₹999 payment on the designated test
account/email, run: create PENDING PRO intent → operator pays via the static PRO
link with the reference typed into checkout → observe the Gmail watchdog.

## 3. AFTER PAYMENT — receipt observation

**`GMAIL_RECEIPT = NOT_TESTED (gated)`** — requires a live Gmail watchdog `gmail`/
`gmailSource` rail ingesting the real razorpay.com receipt (origin-authenticated,
DKIM/SPF/DMARC) after the approved payment. Receipt metadata (reference, payment
ID, amount, status, date/time) will be inspected **sanitized only**; personal
information and secrets are never printed.

## 4. REFERENCE VALIDATION

**`REFERENCE_ECHO = NOT_TESTED (gated)`** — will compare receipt reference vs the
pending intent reference. If the reference is absent from a real receipt →
`REFERENCE_ECHO = FAIL`, **do not activate**. (Honest limitation: whether a real
static-link Razorpay receipt echoes a customer-typed reference is the one
unverified assumption in this no-API/no-webhook design.)

## 5. PAYMENT VALIDATION

**`PAYMENT_TRUST = CONDITIONAL`** — will verify amount ₹999, status successful,
payment ID present, Razorpay mail path. Never inferred from browser redirect.

## 6. USER CORRELATION

**`USER_CORRELATION = CONDITIONAL`** — will map receipt evidence → exact pending
intent → exact account. **`CROSS_USER_PROTECTION = PASS`** (verified): another
account cannot redeem the same evidence — the collector matches only the owning
intent's DB-unique reference (self-service test: wrong account → `confirmation_user_mismatch`).

## 7. SELF-SERVICE ACTIVATION (verified via safe unit tests — PASS)

| Case | Result |
|---|---|
| correct account + valid token → ACTIVE | PASS |
| wrong account + same token → REJECT | PASS (`confirmation_user_mismatch`) |
| reused token → REJECT | PASS (`confirmation_used`) |
| expired token → REJECT | PASS (`confirmation_expired`/`confirmation_invalid`) |
| weak/fake evidence → no activation | PASS (evidence gate refuses `< ACTIVE`) |

## 8. IDEMPOTENCY (verified — PASS)

Replaying the same event cannot double-activate: authoritative `applyDecision`
is exactly-once via a conditional UPDATE; the self-service test confirms an
already-ACTIVE intent yields **no** duplicate activation/benefit.

## 9. SECURITY — required failures (verified via unit tests — PASS)

| Required failure | Result |
|---|---|
| fake reference | no match → no ACTIVE (PASS) |
| fake amount / fake plan | evidence policy `amount_mismatch`/`plan_mismatch` → not ACTIVE (PASS) |
| fake payment ID | not trusted-source bound → not ACTIVE (PASS) |
| fake status / forged Gmail evidence | only origin-authenticated receipts reach ACTIVE (PASS) |
| wrong account | `confirmation_user_mismatch` (PASS) |
| expired token | `confirmation_expired` (PASS) |
| reused token | `confirmation_used` (PASS) |
| duplicate event / replayed event | intent exactly-once + token one-time (PASS) |

No production attacked; all attack cases exercised through the safe unit harness.

## 10. REFUND

**`REFUND_AUTO_REVOCATION = NOT_AVAILABLE`** — no API/webhook under this config so
no trusted refund-event source. Recorded honestly; no invented refund
verification.

## 11. Customer / Admin actions

- **Customer action:** `COPY_REFERENCE_INTO_CHECKOUT` (type the unique ref into
  Razorpay) — the one extra manual step required; then pay.
- **Admin actions:** `0` (`ADMIN_WORK = NONE`) — no admin activation needed.

---

## Final classification (held at real-payment gate)

- Real receipt present with expected reference + all checks passing →
  `REFERENCE_SOURCE = VERIFIED_RAZORPAY_RECEIPT`, `PAYMENT_TRUST = PASS`,
  `USER_CORRELATION = PASS`, `TRUE_ZERO_ADMIN = CONDITIONAL`.
- Until/unless that is observed → **`PAYMENT_TRUST = CONDITIONAL`,
  `USER_CORRELATION = CONDITIONAL`, `TRUE_ZERO_ADMIN = CONDITIONAL`** (honest
  under NO_API/NO_WEBHOOK).

---

## STOP-CONDITION REVIEW

- No receipt format was observed (no real payment) → no divergence.
- No reference observed (none) → no mismatch to act on.
- No code path activated any entitlement (flag OFF, no server run, no DB write).
- No security boundary failed; no duplicate activation.

## Gates retained

- `RAZORPAY_API = OFF`, `RAZORPAY_WEBHOOK = OFF`, `ADMIN_ACTIVATION = OFF`.
- `NO_API = YES`, `NO_WEBHOOK = YES`, `DEPLOYMENT = NONE`, `SOURCE_CHANGES = NONE`.
