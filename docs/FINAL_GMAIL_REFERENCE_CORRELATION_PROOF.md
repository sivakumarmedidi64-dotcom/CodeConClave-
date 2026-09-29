# FINAL — Gmail Zero-Admin Reference Correlation Proof

> **Type:** Evidence-based correlation audit (resolves the remaining `UNKNOWN`). **No code changes, no migration, no deployment, no real payment, no env change, no secrets.** Every claim is anchored to the actual source in `backend/src/modules/payments/`.
> Scope: Can the EXISTING no-API Gmail evidence rail securely correlate a real Razorpay payment to the **exact** CodeConClave user using the **current static Payment Links**? Answer must be evidence-based, not assumed.

---

## 1. Reference trace (Objective 1) — every hop, every controller

Traced end-to-end from source (`intents.ts`, `routes.ts`, `SettingsPage.tsx`, `evidence.ts`):

| # | Hop | What happens | Controller | Classification |
|---|---|---|---|---|
| 1 | CodeConClave pending intent | server generates a **unique** reference `CC{PRO|TEAM}-######` for the user's intent (`makeReference`, `intents.ts:79-88`); amount set from server `PLAN_PRICES_INR` | CodeConClave backend | **SERVER_CONTROLLED** |
| 2 | intent stored + returned | DB UNIQUE constraint on `reference`; `GET /intents/:id/instructions` returns `{ reference, accountEmail, amountInr, planId, paymentLink, status, expiresAt }` (`intents.ts:166-185`, `routes.ts:169-174`) | CodeConClave backend | **SERVER_CONTROLLED** |
| 3 | frontend presents payment link + reference | Billing UI shows the plan button; the **static shared link** is used because no API (`paymentLinkForPlan`, `service.ts:57`); the user is shown a unique reference to include | CodeConClave frontend | **SERVER_CONTROLLED (display) / USER must act** |
| 4 | user pays on static Razorpay link | **User manually types/copies the reference somewhere in the Razorpay hosted checkout** (the static link has NO per-customer `reference_id`; Razorpay does NOT auto-populate customer fields on the hosted page) | **USER** | **USER_CONTROLLED** |
| 5 | Razorpay sends receipt email | merchant mail includes payment id, amount, status, and (if echoed) the customer-entered reference remark | **RAZORPAY** | RAZORPAY_CONTROLLED (content) / **UNKNOWN (whether the manual remark is echoed & parseable)** |
| 6 | Gmail watchdog reads inbox | `sweepPendingIntentEvidence` → `refreshIntentEvidence` → `gmailSource.collect(reference)`; origin-gates with `isAuthenticRazorpayMail` then requires **exact** `ref === reference` (`evidence.ts:306-307`) | CodeConclave backend (via Gmail/Apps Script transport) | **SERVER_CONTROLLED (decision)** / transport is RAZORPAY/Gmail |
| 7 | amount / fraud checks | `checkFraud` (`fraud.ts`): amount tolerance, plan match, replay, velocity; matcher scores (`matcher.ts`) | CodeConclave backend | **SERVER_CONTROLLED** |
| 8 | entitlement engine | `applyDecision` (sole ACTIVE gate) activates exactly-once (`activation.ts:37`) | CodeConclave backend | **SERVER_CONTROLLED** |

**The single USER/CUSTOMER-controlled hop is #4** — the customer must place the reference into the Razorpay payment. Everything else is controlled by the backend or Razorpay itself.

---

## 2. Customer input required (Objective 2)

**YES, a customer action is required: the user must copy/paste/type their unique reference into the Razorpay hosted checkout** (a remarks/note/description field). Evidence:
- The static link has no per-customer `reference_id` (`PLAN_PAYMENT_LINK_INR` are fixed constants; `intents.ts:109` falls back to the static link when the API is unavailable).
- Razorpay's hosted Payment Link does not auto-populate customer-entered fields (per provider behavior; the app cannot set one without the API).
- The Gmail parser can only correlate if a `CC(PRO|TEAM)-######` string appears in an authenticated Razorpay receipt (`evidence.ts:304-307`).

**Is the customer's input cryptographically/authentically bound by Razorpay to the actual payment?**
- **No cryptographic/provider binding.** The reference is a **text field** the customer types. Razorpay does not, for a shared static link, cryptographically bind a customer-supplied remark to a CodeConClave session. The provider DOES authenticate the *receipt* (transport), but the *remark reference* is only **text-extracted from the email**, not a provider-issued per-session identifier.
- **Classify: CUSTOMER_SUPPLIED_REFERENCE.**

---

## 3. Static Payment Link — User A vs User B (Objective 3)

- The **same** static PRO link is used by both users (`paymentLinkForPlan` returns the same constant for all users).
- The only per-user discriminator is the **reference string each user manually enters**. Each intent has a **unique server-issued** reference enforced by a DB UNIQUE constraint.
- Because the reference is **CUSTOMER_SUPPLIED** (not provider-bound) and each intent's collector only accepts a **receipt whose reference exactly equals THAT intent's own reference**, the system distinguishes A and B **only if each enters their own correct reference into their own payment**.
- **Strong enough for automatic entitlement?** Only with the caveats in §6/§7. It is the best available no-API signal, but it rests on user compliance + receipt echo, both unverified live.

**STATIC_LINK_CORRELATION = CONDITIONAL** (not cryptographically guaranteed; user-typed dependent).

---

## 4. Gmail authenticity (Objective 4)

What is **provider-authenticated** vs **merely text-extracted**:

| Element | Authenticity | Basis |
|---|---|---|
| Message arrives in direct merchant mailbox | Transport (real) | merchant Razorpay inbox |
| Sender/domain = razorpay.com | Authenticated | `isAuthenticRazorpayMail` requires `fromDomain === razorpay.com` AND DKIM/SPF/DMARC **pass** for that domain (`evidence.ts:247-272`). Spoofed messages rejected. |
| Reference present in receipt | **text-extracted, NOT provider-bound** | parsed from email body via regex `\bCC(PRO|TEAM)-[A-Z0-9]{6}\b` |
| Amount | **text-extracted** | parsed from email text (₹/INR) |
| Payment status (success) | **text-derived / receipt presence** | inferred from receipt; not independently verified without API |
| Payment ID (`pay_...`) | **text-extracted** | regex; presence used as a +0.10 signal |
| Payer identifier | **Razorpay sender** (`headers.from` = `fromDomain razorpay.com`), NOT the customer's payer email | `evidence.ts:314` reads the RFC5322 From header, which origin-gating requires to be a razorpay.com address |

**Key honest point:** the Gmail rail's *transport* is authenticated (origin gating is strong), but **the correlation-bearing fields (reference, amount, status, payment id) are all extracted as text from the email and are NOT cryptographically/provided-bound to a CodeConClave session.** The customer-entered reference is not echoed under any provider guarantee for a static shared link (UNVERIFIED).

---

## 5. Attack tests (Objective 5) — cross-user activation

**Threat model (A = victim, B = attacker):**

- **A's reference is UNIQUE to A's intent** (DB UNIQUE, `intents.ts`). B cannot guess it reliably (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, 6 chars = ~33^6 ≈ 1.3B combos; and reuse is rejected by the UNIQUE constraint + `reference_reuse` fraud flag).
- **If B copies A's reference and includes it in a REAL payment:** the resulting receipt carries A's reference (not B's). B's intent collector runs `collect(B's reference)` and requires exact match → **A's-reference receipt fails `ref === reference` for B → B's intent stays PENDING, no activation.** B cannot make B's OWN account ACTIVE this way.

| Attack | Outcome | Guard (source) |
|---|---|---|
| B copies A's reference → B ACTIVE | **FAILS** — receipt ref ≠ B's intent ref | `evidence.ts` exact `ref===reference` |
| Guessed reference | **FAILS** — ~1.3B space + UNIQUE + reuse flag | `intents.ts`, `fraud.ts:47-53` |
| Modified reference | **FAILS** — must equal the server reference exactly | `evidence.ts:307` |
| Reused reference | **FAILS** — UNIQUE constraint; `reference_reuse` flag | `intents.ts`, `fraud.ts:47-53` |
| Wrong plan | **FAILS** — `plan_mismatch` blocking flag | `fraud.ts:65-70` |
| Wrong amount | **FAILS** — `amount_mismatch` blocking flag | `fraud.ts:55-61`; `service.ts:322-335` |
| Duplicate payment | **FAILS** — `duplicate_payment_id` + exactly-once | `fraud.ts:38-46`, `activation.ts` |
| Duplicate email / replayed Gmail event | **FAILS** — sha256 `screenshot_replay` + replay guard | `fraud.ts:79-85`, `pipeline.ts:114-131` |
| Forged email (spoofed "Razorpay") | **FAILS** — DKIM/SPF/DMARC + domain gate rejects | `isAuthenticRazorpayMail` |
| Replayed Gmail event | **FAILS** — sha256 dedupe + exactly-once | `pipeline.ts`, `activation.ts` |
| B pays with A's ref **to activate A** | possible (B spends real money for A); **does not give B free access** | not a free-ride vector |

**Required result — NO CROSS-USER ACTIVATION:** **PASS.** An attacker cannot obtain a free entitlement using someone else's reference; the reference is bound to exactly one intent.

---

## 6. Payment trust (Objective 6)

Under no-API/no-webhook, can the Gmail rail establish:

- **REAL PAYMENT = YES** — an origin-authenticated Razorpay receipt is independent evidence a real payment landed in the merchant account (strong; not customer-controlled).
- **PAYMENT SUCCESS = YES** — inferred from the presence of an authenticated success receipt; **but NOT independently provider-verified** outside email text.
- **CORRECT AMOUNT = YES** — amount parsed from email AND matched to the server amount; a mismatch blocks (`amount_mismatch`). The amount itself is a single static value (₹999 / ₹4999), so amount does **not** discriminate users — it only confirms the plan's amount was paid.

**Honest statement:** payment success for the no-API Gmail rail comes from **email text** of an **authenticated Razorpay message**; it cannot be **independently** verified (no API/webhook). That is a real, documented limitation.

---

## 7. Refunds (Objective 7)

- **A refund cannot be detected automatically by the no-API Gmail system.** A refund would arrive as a different email type, but there is no authenticated, exact-reference refund parser on the Gmail rail, and no webhook/API `payment.refunded` event.
- **REFUND_AUTO_REVOCATION = NOT_AVAILABLE.** Explicit. (The webhook rail, when added, handles `payment.refunded` → REFUNDED + entitlement revoked; dormant today.)

---

## 8. Customer experience (Objective 8)

The flow **cannot** be `SIGN IN → PAY → DONE` (no per-customer provider-bound link without the API). The honest flow is the accepted-fallback:

```
SIGN IN
→ COPY UNIQUE REFERENCE (CCPRO-XXXXXX)
→ PAY on the shared static link (paste reference at Razorpay checkout)
→ DONE (backend auto-verifies via Gmail watchdog)
```

**This is NOT "fully automatic"** — the customer has one extra required step (copy + paste the reference). Do not claim otherwise. Friction is minimal (one copy/paste) but real, and it is a **hard dependency** for the no-API correlation to work at all.

---

## 9. Google Apps Script role (Objective 9)

- **COLLECTOR / TRANSPORT ONLY.** The script reads the mailbox, extracts candidate evidence, attaches message metadata, HMAC-signs the transport payload (`gmail-claim.ts` `verifyGmailClaimSignature`), and POSTs to the orchestrator; it retries safely and dedupes.
- **NEVER PAYMENT AUTHORITY / ENTITLEMENT AUTHORITY.** The backend `applyDecision` is the sole ACTIVE gate.
- **Google Sheet = AUDIT / DEDUPE LEDGER MIRROR ONLY**, never authority.
- Backend remains authoritative.

---

## 10. Final classification (Objective 10)

**B = CUSTOMER-SUPPLIED CORRELATION WITH ACCEPTABLE SECURITY.**

- **Not A** (not provider-bound: the reference is customer-typed text, not a Razorpay-issued per-session id; the payer signal is Razorpay's sender, not the customer).
- **Since the sole user-discriminating signal is the customer-typed reference, correlation is CUSTOMER-SUPPLIED.**
- **Not C/UNSAFE** because **cross-user activation is prevented** (exact-reference-per-intent binding + UNIQUE constraint + fraud/replay guards), activation requires a **real** authenticated Razorpay receipt (real money), and there is **no free access** vector.
- **Not D** (correlation does exist and is enforced).

**Why cross-user activation is prevented (for B):** every intent's Gmail collector only accepts a receipt whose parsed reference **exactly equals that intent's own server-issued reference**. A receipt carrying any other reference (or none) yields no evidence for that intent. Since references are unique-per-intent and reuse/duplication are blocked, an attacker's payment is attributed only to the intent whose reference is literally on the receipt — and the attacker cannot make their own different-reference intent match a receipt bearing a victim's reference.

**Live reliability caveat (drives CONDITIONAL):** the entire path depends on (1) the customer typing the correct reference and (2) the **static-link Razorpay receipt echoing that reference in machine-parseable form inside an authenticated email**. Both are **UNVERIFIED** (no live no-money read-only test permitted). If (2) does not hold, the rail always produces **PENDING (fail-safe)** — it does **not** produce unsafe activation.

---

## 11. Final business decision (Objective 11)

```
TRUE_ZERO_ADMIN = CONDITIONAL       (not ungated YES: depends on a customer copy/paste step +
                                    unverified static-link receipt echo; and NOT NO: the engine
                                    exists, is live-capable, and prevents cross-user activation)
NO_API     = YES
NO_WEBHOOK = YES
NO_ADMIN   = YES
24_7       = YES   (watchdog sweep runs continuously)
STATIC_LINKS        = CONDITIONAL
REFERENCE_SOURCE    = CUSTOMER
USER_CORRELATION    = CONDITIONAL
PAYMENT_TRUST       = CONDITIONAL
REFUND_HANDLING     = NOT_AVAILABLE
CUSTOMER_ACTION     = REQUIRED   (copy/type unique reference at Razorpay checkout)
ADMIN_ACTION        = NONE
```

Do not classify as fully-guaranteed YES. The evidence supports **CONDITIONAL**: secure and automatically enforceable, but requiring one customer step and unverified live receipt-echo behavior.

---

## 12/13. Compliance + Report

**DO NOT IMPLEMENT honored:** `SOURCE_CHANGES = 0` · `DATABASE_CHANGES = 0` · `DEPLOYMENT = NOT_EXECUTED` · `REAL_PAYMENT = NOT_PERFORMED` · `FEATURES_REMOVED = 0`. No secrets referenced.

Report written: **`docs/FINAL_GMAIL_REFERENCE_CORRELATION_PROOF.md`** (this file).
