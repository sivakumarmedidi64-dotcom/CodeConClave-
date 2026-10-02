# FINAL ZERO-ADMIN PAYMENT ARCHITECTURE AUDIT

**Date:** 2026-09-01 | **Author:** opencode (feasibility audit) | **Secret-free**
**Phase:** TRACK B — Zero-admin payment engine. **Feasibility/architecture only; no code, no payment, no deployment.**

---

## 1. Requirement (restated)

CUSTOMER PAYS → PAYMENT VERIFIED → CORRECT USER IDENTIFIED → ENTITLEMENT ACTIVE →
ZERO ADMIN → 24/7, **WITHOUT** Razorpay API keys, **WITHOUT** a Razorpay webhook,
**WITHOUT** admin activation — using static Razorpay links + Gmail/Apps Script.

Security rule: NEVER trust localStorage, sessionStorage, browser redirect,
`paid=true`, user-entered payment ID/UTR/screenshot/reference, or activation
email alone. **EMAIL OWNERSHIP IS NOT PAYMENT PROOF.**

---

## 2. EXACT current flow (source-verified)

1. Authenticated user creates a **server-side pending intent**
   (`POST /api/v1/payments/intents` → row in `payment_intents`, `status='PENDING'`,
   unique server reference `CCPRO-XXXXXX`, server-authoritative `plan_id`,
   `amount_inr`, `expires_at`).
2. If `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are absent (current production),
   the backend uses the **shared static per-plan link**
   (`https://rzp.io/rzp/sAgHIpxS` PRO ₹999 / `https://rzp.io/rzp/3ioXlCxd` TEAM ₹4999).
3. The customer pays the static link. **The static link carries NO per-user or
   per-intent reference** on its receipt.
4. With no API/webhook, the only evidence rails are:
   - **Gmail evidence rail** (`evidence.ts:gmailSource`): searches the mailbox for
     a receipt matching the exact intent reference — but static-link receipts carry
     **no per-intent reference**, so nothing matches.
   - **Gmail claim rail** (`gmail-claim.ts`, Apps Script → HMAC → `/gmail-claim/request`
     → hashed one-time claim token → email → `/gmail-claim/activate`): also requires
     a per-intent reference in the receipt; **blocked for static links**.
5. Result (current, intended-safe): the intent stays PENDING until its 24h TTL;
   **no automatic activation is possible**.

Note: an existing Razorpay **API rail** (`createRazorpayPaymentLinkForIntent`),
a **signed webhook rail**, and the **confidence matcher** are already **fully
implemented and latent** — they just require real Razorpay credentials (an
external account limitation, not a software gap).

---

## 3. Trust analysis — can static + Gmail PROVE the 4 facts?

The four required facts and the only evidence static links + a readable mailbox
can supply:

| Required fact | Static-link evidence available | Verdict |
|---|---|---|
| **REAL PAYMENT occurred** | An email from Razorpay ($pay_... id, amount) that passes DKIM/SPF/DMARC origin check | Only if the mailbox is a trusted inbox AND you can prove the email is about THIS user |
| **EXACT CodeConClave user** | Payer's self-typed email in the receipt | **Providers generally include the payer email; but an attacker can type any email.** Correlation to the logged-in user is NOT cryptographically provable from a static link |
| **CORRECT PLAN** | The static link is per-plan (PRO vs TEAM) | Static links ARE per-plan → plan is inferable |
| **CORRECT AMOUNT** | ₹999 / ₹4999 on the receipt | Matches per-plan price → amount is inferable |

**The binding failure is USER CORRELATION + a mailbox-origin trust gap:**

- A static Payment Link is **shared** across all customers; its receipt carries
  **no per-intent reference**, so the backend cannot bind a given payment to a
  given pending intent (`CCPRO-XXXXXX`).
- Email ownership is not payment proof: proving "this email received a Razorpay
  receipt" does not prove "the person who paid is the owner of that email", and
  the payer email is **self-entered at the Razorpay checkout**, not verified by
  the backend.
- Even the Gmail evidence rail is **strict**: it only accepts evidence that
  matches the exact server-issued reference — precisely because anything looser
  would be spoofable. With static links there is no such reference to match.

**Verdict (proven or rejected):**

```
NO_API_NO_WEBHOOK_NO_ADMIN =
    NOT_POSSIBLE_WITH_CURRENT_PAYMENT_PROVIDER_CAPABILITIES

REAL_PAYMENT          = not provable per-user from a shared static link
EXACT_USER_CORRELATION= IMPOSSIBLE (no per-intent reference; email ≠ payment proof)
CORRECT_PLAN          = inferable (per-plan static link)
CORRECT_AMOUNT        = inferable (per-plan price)
SECURE_ZERO_ADMIN     = IMPOSSIBLE with only static links + Gmail
```

This matches the repo's own prior audited conclusion
(`docs/FINAL_24_7_ZERO_ADMIN_PAYMENT_FEASIBILITY.md: NO_API_NO_WEBHOOK_NO_ADMIN =
NOT_POSSIBLE_WITH_CURRENT_RAZORPAY_SETUP`; `STATIC_MULTIUSER_CORRELATION =
IMPOSSIBLE`). No workaround is invented: the correlation gap is inherent to a
shared static Payment Link, not a missing code path.

---

## 4. THE TRUST CHAIN THAT WOULD make zero-admin secure

The only secure path is to mint **per-intent dynamic Payment Links via the
Razorpay API**, which the backend already implements and which requires
`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`:

```
Login (proves exact user, bound to server-side pending intent CCPRO-XXXXXX)
→ Razorpay API creates a per-intent Payment Link with:
     - unique reference_id = the intent reference
     - notes { intent_id, plan }
     - customer.email = the logged-in user's verified email
→ customer pays THAT link (₹999/₹4999 per plan)
→ EVIDENCE (either):
     (a) signed webhook    — HMAC-SHA256 verified, intent resolved by reference
     (b) API status poll   — server-side, notes.reference matched (~15s)
     (c) Gmail claim rail  — Apps Script + HMAC; receipt now carries the
                             per-intent reference_id → exact match possible
→ EXACT-ONCE activation.applyDecision() → entitlement ACTIVE
```

This precisely satisfies: REAL PAYMENT (origin-verified evidence) +
EXACT USER (link minted for the logged-in user + per-intent reference) +
CORRECT PLAN + CORRECT AMOUNT + IDEMPOTENCY (dedup by provider_payment_id/sha256)
+ ZERO ADMIN + 24/7.

**Minimum single enabler = Razorpay API credentials** (per-user correlation).
**Recommended** = API + signed webhook for instant activation. Both rails are
already implemented and latent.

---

## 5. Activation code layer — recommendation

`ACTIVATION_CODE = NOT_RECOMMENDED as a verification mechanism` (recommended only
as an optional recovery/claim UX AFTER a trusted payment).

Correct architecture (already designed in the gmail-claim rail):
`TRUSTED PAYMENT VERIFICATION → ENTITLEMENT CREATED → ONE-TIME ACTIVATION TOKEN → EMAIL → OPTIONAL USER REDEMPTION → ACTIVE`.

Never: `USER CLAIMS PAYMENT → SEND CODE → ACTIVE` (that is spoofable; it has no
trusted payment anchor and would fail the security rule).

Activation codes **cannot** solve the static-link correlation gap — a code is a
UX/recovery layer, not payment proof
(`docs/FINAL_ACTIVATION_CODE_ENGINE_FEASIBILITY.md` agrees). Do not implement the
code system until payment trust is established.

---

## 6. Security properties already in place (preserved)

- Server-authoritative pending intents with `reference`, `plan_id`, `amount_inr`, expiry.
- Exact-once activation (`activation.ts` conditional UPDATE) — only `gmail` /
  `razorpay_api` / `razorpay_webhook` evidence may reach ACTIVE; `manual`/`ocr`
  are forced to REVIEW.
- Replay/dedup via `provider_payment_id` + `sha256`; fraud guard module.
- Claim tokens stored SHA-256-hashed, one-time, expiring; HMAC-authenticated Apps
  Script request with timestamp (5-min) + DKIM/SPF/DMARC origin gate.
- **Anti-self-activation gate** in the pipeline.

---

## 7. Refund / revocation

- With the signed webhook rail: `payment.refunded` / `payment_link.payment_refunded`
  are handled automatically (intent → REFUNDED, entitlement revoked).
- **With NO API/webhook: refund detection is NOT possible automatically.**
  `REFUND_HANDLING = FAIL` under the no-API constraint (no trusted refund event
  source). A human/ops override would violate zero-admin.

---

## 8. Secret exposure note (no values printed)

Threat-relevant finding, no value disclosed: a **plaintext Apps Script shared
secret file exists in the repo root**
(`GMAIL_APPS_SCRIPT_SHARED_SECRET.txt`). Per policy, its contents are not shown.
Remediation (separate from this feasibility gate): move the value to a secret
manager / env var, remove the file from the repo tree and history, and confirm it
is git-ignored. Do not rely on it as the trust anchor while it sits in the
repository. (Related docs already mention the env-name mismatch
`GMAIL_APPS_SCRIPT_SHARED_SECRET` vs backend `GMAIL_CLAIM_HMAC_SECRET`.)

---

## 9. Final gate values

```
STATIC_LINK            = SHARED / NO PER-USER REFERENCE
NO_API                 = YES (current production)
NO_WEBHOOK             = YES (current production)
NO_ADMIN               = YES (current production)
SECURE_ZERO_ADMIN      = IMPOSSIBLE  (with NO API, NO webhook, NO admin and only static links)
                         POSSIBLE    (with Razorpay API for per-intent links; webhook recommended)
ACTIVATION_CODE        = NOT RECOMMENDED as payment proof (optional recovery layer only, post-trust)
PAYMENT_TRUST          = FAIL   (static-link path)  /  PASS (per-intent API/webhook path)
USER_CORRELATION       = FAIL   (static-link path)  /  PASS (per-intent reference)
REFUND_HANDLING        = FAIL   (no API/webhook — no trusted refund event)
```
