# FINAL — PRIVATE PAYMENT CONTROL CENTER AUDIT

**Audit + design first. Read-only.** CodeConClave is live. No build, no
deployment, no real payment, no production/schema change in this turn. This
report determines whether the existing payment subsystem already provides the
private control center, what evidence the current static-link + Gmail path can
actually produce (and how trustworthy it is), and what (if anything) is
genuinely new to build.

---

## 1. Headline conclusion

**The required control center already exists** as the isolated `payments/`
subsystem (`backend/src/modules/payments/`). Every component named in the
directive maps to an existing module **except** three genuinely additive,
non-security surfaces: a **private Founder Dashboard** (read-only), an optional
**Google Sheet audit mirror**, and an optional **`country` customer metadata**
field. A separate/duplicate control-center subsystem is **NOT recommended**.

`PRIVATE_PAYMENT_CONTROL_CENTER = RECOMMENDED`
(implement as a thin **consolidation/read layer** reusing the existing module —
do NOT build a parallel payment system).

---

## 2. Directive component → existing module map (reuse, not duplicate)

| Control-center component | Existing implementation |
|---|---|
| Customer Registry | `users` (identity) + temp payment identity (`payment_sessions`) |
| Payment Intent Registry | `modules/payments/intents.ts` (`payment_intents`) |
| Evidence Collector | `modules/payments/evidence.ts` (sources: gmail / ocr / api / webhook) |
| Correlation Engine | `modules/payments/matcher.ts` (exact-reference matching) |
| Verification Engine | `modules/payments/pipeline.ts` + `evidence.ts` (origin/authenticity gate) |
| Risk/Fraud Engine | `modules/payments/fraud.ts` (7 blocking flags + velocity) |
| Idempotency Ledger | DB unique constraints + `fraud.ts` dedupe + `signalSha256()` + outbox/idempotency |
| Entitlement Engine | `modules/payments/activation.ts` (`applyDecision` — the SOLE activator) |
| Refund Monitor | **NOT_AVAILABLE** (no API/webhook; dormant webhook rail only) |
| Google Sheet Mirror | **NOT built** — optional additive, AUDIT ONLY |
| Founder Dashboard | **NOT built** — optional additive private read-only page (data source: `reconciliation.ts`) |

---

## 3. What trusted evidence the current path can actually produce

**Evidence signals captured** (`EvidenceSignals`, `evidence.ts`):
`reference`, `amountInr`, `payerEmail`, `paidAt`, `paymentId`, `utr`.

**Source availability (server-derived, honest):**

| Source | Available? | Fields it contributes | Trust boundary |
|---|---|---|---|
| Hosted Payment Link (static) | YES | payment link URL / pool | shared; NO per-user `reference_id` |
| Razorpay API | NO (no keys) | — | — |
| Razorpay webhook | NO (no secret enabled) | — | — |
| Gmail receipt (origin-authenticated) | YES (when OAuth configured) | reference, amount, payerEmail, paidAt, paymentId | DKIM+SPF+DMARC pass AND fromDomain=razorpay.com |
| OCR (screenshot text) | BLOCKED (no OCR engine); parser exists | amount, paymentId, utr, reference, paidAt | never authority; matcher input only |

**Key finding — correlation boundary (evidence.ts:191-194):**
> "Only messages that carry the EXACT server-issued intent reference are released
> as signals. A reference-less receipt (e.g. from a shared static Payment Link)
> cannot be attributed to a user ... so it is dropped (never auto-activates)."

The current **static links are SHARED** — they carry **no per-customer
`reference_id`**. Therefore the ONLY per-user discriminator that can reach the
verification path is the **customer-typed unique reference** (`CCPRO-XXXXXX` /
`CCTEAM-XXXXXX`) appearing in a real, origin-authenticated Razorpay receipt.

- `payment ID`: extracted from receipt text (e.g. `pay_…`) — tied to the payment,
  not provider-bound to the intent.
- `payment link ID` / `provider reference_id`: **NOT reliably present** on shared
  static links in the no-API path (the 0056 binding columns exist but are only
  populated when a per-customer link/reference is actually bound).
- `payerEmail`: text-extracted from the receipt; in a single-mailbox integration
  the sender is Razorpay's merchant mail, so it is **not** by itself proof of the
  paying customer (consistent with "email ownership ≠ payment proof").

---

## 4. Trusted-evidence sufficiency (do NOT assume — verdict)

| Question | Verdict |
|---|---|
| Can static links + Gmail produce payment ID? | PASS (origin-authenticated receipt yields `pay_…`) |
| Can they produce Payment Link ID / provider reference_id? | FAIL/UNKNOWN (shared links have no per-customer reference_id in the no-API path) |
| Can they produce an exact CodeConClave USER? | CONDITIONAL — only via customer-typed + echoed exact reference + amount + time + payment ID |
| Are those fields trustworthy? | PASS for origin authenticity; correlation is CONDITIONAL (not provider-bound) |
| Reference echo in a real receipt proven? | UNKNOWN — UNVERIFIED until a real controlled payment is observed |

**Bottom line:** the mechanisms are safe and enforced (reference-less receipts are
dropped; only exact-reference authenticated receipts can reach the single ACTIVE
gate; cross-user and replay are prevented). But `EXACT_USER_CORRELATION` and
`STATIC_LINK_CORRELATION` cannot be upgraded from CONDITIONAL/UNKNOWN to PASS
without either (a) observing a real receipt that proves the reference echo, or
(b) enabling the API/webhook to make correlation provider-bound.

---

## 5. AUTO-UNLOCK rule (existing `applyDecision` — unchanged)

ACTIVE requires ALL of:
```
TRUSTED_PAYMENT_EVIDENCE (origin-authenticated, exact reference)
+ EXACT_USER_CORRELATION
+ CORRECT_PLAN  (PRO ₹999 / TEAM ₹4999; no cross-plan fallback)
+ CORRECT_AMOUNT
+ IDEMPOTENCY_PASS
+ FRAUD/REPLAY_PASS
= ACTIVE
```
Anything short → PENDING / REVIEW / UNKNOWN. Never auto-activate uncertain
payments. Client claims (redirect, localStorage, sessionStorage, user-typed
paymentId/UTR, screenshot, forwarded receipt, Sheet row, "I paid") are never
authority.

---

## 6. Country

- **No `country` field exists** in `payments`/`entitlements` today (verified by
  search). Adding it is genuinely additive and optional: a **metadata column on
  the customer/intent record only** — never used as payment proof, never used to
  infer citizenship.

---

## 7. Idempotency / replay (verified present)

- DB constraint on provider payment id (unique-where-not-null) prevents one
  payment activating two accounts.
- `signalSha256` gives a deterministic evidence dedupe key; `fraud.ts` blocks
  `duplicate_payment_id` / `screenshot_replay` / `reference_reuse`.
- `applyDecision` is exactly-once via a conditional UPDATE.
- Apps Script must dedupe + retry safely on the transport; the backend owns
  authority.

---

## 8. Refund

With no API/webhook there is no trusted refund-event source, so the existing
dormant `payment.refunded` webhook rail cannot be exercised. Honest verdict:

`AUTO_REFUND_REVOCATION = NOT_AVAILABLE` (do not claim 24/7 refund enforcement).

---

## 9. Roles (bounded)

- **Google Apps Script = COLLECTOR / WATCHDOG / TRANSPORT only.** May scan,
  parse candidate evidence, sign payloads, dedupe, retry, send to backend. It
  must **never** independently activate an account.
- **Google Sheet = AUDIT / REPORTING / HUMAN-READABLE LEDGER only.** Never the
  authorization source. Columns (suggested): timestamp, user_email, country,
  plan, expected_amount, payment_id, payment_method, payment_time,
  evidence_source, correlation_status, verification_status, entitlement_status,
  reason. **No secrets.**
- **Founder Dashboard = private, read-only.** Aggregate TODAY (customers, PRO,
  TEAM, revenue, pending/verified/rejected/unknown) + payments table (email,
  country, plan, amount, payment ID, method, time, status, correlation,
  entitlement). Read from `reconciliation.ts` + `payment_intents`; no write path,
  no secrets. Founder-only auth.

---

## 10. Production safety

No deployment, no real payment, no Railway/Neon change, no production payment
config change, no production migration, no new activation path.

---

## 11. Decision

```
PRIVATE_PAYMENT_CONTROL_CENTER = RECOMMENDED  (as a thin READ/MIRROR layer on the existing subsystem — NOT a duplicate)
CURRENT_AUTO_UNLOCK          = CONDITIONAL
STATIC_LINK_CORRELATION      = UNKNOWN   (enforced, but echo unverified w/o a real payment)
GMAIL_EVIDENCE               = PASS      (origin-authenticated)
PAYMENT_TRUST                = CONDITIONAL
EXACT_USER_CORRELATION       = CONDITIONAL
GOOGLE_SHEET                 = AUDIT_ONLY
APP_SCRIPT                   = COLLECTOR_ONLY
ADMIN                        = ZERO
```

New, additive work (only if/when approved, and flag-gated): Founder Dashboard
(read-only), optional Sheet mirror (audit only), optional `country` metadata.
This is **not** built in this audit turn.
