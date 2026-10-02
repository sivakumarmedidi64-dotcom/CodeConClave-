# FINAL — Gmail Zero-Admin Activation Engine Audit
## Static Razorpay Links · NO Razorpay API · NO Razorpay Webhook · NO Admin Normal Path · Apps Script Watchdog

**Scope:** Determine whether the *existing* Google Apps Script Gmail watchdog can
power a safe **zero-admin automatic** payment-activation engine using **static
shared payment links** (PRO ₹999 / TEAM ₹4999), by adding a **server-side
pending checkout** correlated against the **payer email** extracted from the
merchant notification — with **no Razorpay API, no webhook, no admin**.

**Audit only. No deploy. No real payment. No secrets. No source change.**

---

## 1. Verdict Summary

| Item | Result |
|---|---|
| `WATCHDOG` | **READY** (as trusted HMAC transport) |
| `HMAC` | **PASS** (`HMAC-SHA256`, `timingSafeEqual`, timestamp window, `paymentId` dedup) |
| `MERCHANT_EMAIL_PAYER_IDENTITY` | **UNKNOWN (cannot be verified) → NOT SAFE as identity key** |
| `PENDING_CHECKOUT` | **MISSING** (no existing table stores a payer-email-correlated checkout; would need a migration) |
| `USER_CORRELATION` | **FAIL** (no trusted signal binds a static-link payment to a user) |
| `PLAN_VALIDATION` | **PASS** (`PLAN_PRICES_INR`, server-authoritative) |
| `AMOUNT_VALIDATION` | **PASS** (exact ₹999 / ₹4999, no tolerance) |
| `IDEMPOTENCY` | **PASS** (unique `provider_payment_id`/`paymentId`, dedup) |
| `REPLAY_PROTECTION` | **PASS** (timestamp window + dedup) |
| `CLIENT_BYPASS` | **BLOCKED** (client/redirect/localStorage never reaches verification) |
| `EMAIL_MISMATCH` | **UNSAFE as the correlation key** (payer checkout email ≠ account email) |
| `REFUND_AUTO_DETECTION` | **NOT_AVAILABLE** (no API/webhook ⇒ no auto-refund signal) |
| `ZERO_ADMIN_NORMAL_PATH` | **IMPOSSIBLE** |
| `24X7` | **BLOCKED** (for auto-activation) |

**`ZERO_ADMIN_GMAIL_WITH_STATIC_LINK = BLOCKED`**
**`IMPLEMENTATION = BLOCKED`**

---

## 2. What actually exists (source-verified)

- **Users:** `users.email` is **UNIQUE** (`uq_users_email_lower`). No same-email
  duplicate accounts are possible. (proposal §11 ⇒ **PASS / not a concern**)
- **Pending-checkout candidates:**
  - `payment_sessions` (0011): bound to `user_id`, `plan_id`, `amount_inr`,
    `mode IN ('PAYMENT_LINK','API','WEBHOOK')`, state. It is a per-user pending
    session, but it has **no `payer_email`** column and no independent payer
    identity field. It is keyed to the authenticated user, not a payer email.
  - `payment_intents` (0052): has a `payer_email` column, but it is populated
    **only** for reference-bound intents; static-link emails carry no reference,
    so this path is unreachable for static links.
  - `payment_claims` (0057): has `payer_email`, but is bound to an `intent_id`
    and is only reached via a reference.
  - ⇒ **No existing table stores a pending checkout keyed by user + a distinct
    payer email.** Implementing the proposal's §8 correlation would **require a
    schema change** (new column/table), which the constraints forbid without
    approval and is NOT justified because the correlation key is unsafe anyway.
- **Gmail watchdog receiver:** `POST /api/v1/payments/gmail-claim/request`
  (`gmail-claim-routes.ts`), body
  `{ payload: {paymentId, amount, plan, payerEmail, paidAt, reference}, timestamp, signature }`.
  - HMAC verified with `GMAIL_CLAIM_HMAC_SECRET` (the backend's actual secret
    env; the proposal names `GMAIL_APPS_SCRIPT_SHARED_SECRET`, a naming
    mismatch), `timingSafeEqual`, 300s timestamp window, `paymentId` dedup.
- **Trust model in code (decisive):**
  - `matcher.ts:33` comment: *"reference matches the intent's unique reference
    +0.45 (anchor signal)"*; payer email = **+0.10** only.
  - Prior audit (FINAL_GOOGLE_APPS_SCRIPT_ZERO_ADMIN_AUDIT.md): *"payer email =
    NOT trusted for identity, reference = the ONLY user-binding key."*
  - `evidence.ts` Gmail source: releases signals **only** when the exact
    server-issued `CCPRO/CCTEAM-….` reference is in the razorpay-origin email;
    reference-less static-link receipts are **dropped**.
  - `gmail-claim.ts:262`: empty `reference` → `400 reference_required`. The
    claim flow binds entitlement to `intent.owner_id` (reference-resolved), not
    to `payer_email`.

## 3. The decisive blocker (proposal §24)

The proposal's own most-important feasibility test asks:

> **MERCHANT_EMAIL_PAYER_IDENTITY = PRESENT / ABSENT / UNKNOWN**

Determination: **UNKNOWN and — even where present — NOT a safe identity key.**

1. **Cannot be verified.** The `.gs` Apps Script source is not in the repo; the
   merchant notification format is not reproduced anywhere. I will not claim a
   parser/field exists "reliably" without evidence (proposal §16 forbids this).
2. **Even if present, it is not the CodeConClave account email.** With a static
   shared link, the buyer's email captured at Razorpay checkout is the **paying
   party's checkout email** — it can be a different person paying for an
   account, or an email typed differently at checkout than the account email
   (§10 EMAIL MISMATCH). Correlating a payment to a user by that email is
   exactly the **"payer email = identity"** pattern the established, correct
   trust model rejects.
3. **PENDING_CHECKOUT does not rescue it.** A pending checkout created on the
   user's own "I want to pay" claim does not authenticate the *payment*. The
   only signal linking the payment to that checkout would still be **payer
   email** — i.e., the same unsafe key. The checkout would be a real user, but
   the binding from payment→checkout remains forged-or-mismatched-able.

**Net:** Trusted watchdog + ARBITRARY PAYER EMAIL + pending checkout does **not**
produce a trustworthy binding. Only a **cryptographically / server-authoritative
per-user reference** can (which requires per-intent dynamic links via the
Razorpay API — not available).

## 4. Security controls that ARE sound (not the failure point)

`HMAC` ✅ · timestamp ✅ · `paymentId` idempotency ✅ · plan whitelist ✅ ·
exact amount ✅ · client bypass blocked ✅ · exactly-once race guard ✅ ·
`users.email` uniqueness ✅. The failure is **correlation availability**, not
security plumbing.

## 5. Refund limitation

No API/webhook ⇒ a later refund cannot be auto-detected.
**`REFUND_AUTO_DETECTION = NOT_AVAILABLE`** (provider limitation; unchanged).

## 6. Conclusion

The existing watchdog is a **secure transport**, but with static shared links it
cannot deliver zero-admin automatic activation because there is **no trusted
per-user correlation field** in the payment signal, and the proposed
payer-email correlation is unsafe/unverifiable and would require a schema change.

**`ZERO_ADMIN_GMAIL_WITH_STATIC_LINK = BLOCKED`**
**`IMPLEMENTATION = BLOCKED`**

**Recommended secure path (unchanged):** obtain Razorpay **API** (per-intent
dynamic links carrying a unique `reference_id` + `notes`) and/or the **signed
webhook**; both rails are already implemented and only need real credentials.
Do not build the payer-email correlation workaround.

---

*End of audit. No secrets. No deployment. No real payment. Standing
`FINAL_RECOMMENDATION = WAIT_FOR_RAZORPAY_CAPABILITY`.*
