# FINAL — Zero-Admin Payment: Current Capability Gate

> **Type:** Capability gate (Objective 14). Determines A/B/C/D/E with **no assumption** — every claim below is traced to the repo source (`backend/src/modules/payments/`), the environment defaults, and system facts. **No live money test run** (not permitted), so items that would require one are explicitly marked **UNVERIFIED** rather than guessed.
> `NO_RAZORPAY_API = YES`, `NO_RAZORPAY_WEBHOOK = YES`, `NO_ADMIN = YES` — this gate evaluates what the system can do under all three, and nothing here weakens payment security.

---

## OBJ 1 — Audit the existing Razorpay static links (no assumption)

**Source of truth:** `backend/src/config/env.ts:89-90` (defaults) + `backend/src/modules/payments/service.ts:48-59`.

| Fact | Finding | Basis |
|---|---|---|
| Link identity | Two static links exist, one per plan, created manually | `PLAN_PAYMENT_LINK_INR = { pro: rzp.io/rzp/sAgHIpxS, team: rzp.io/rzp/3ioXlCxd }` |
| Amount | PRO ₹999, TEAM ₹4999 | `PLAN_PRICES_INR = { pro: 999, team: 4999 }` |
| Shared by all customers | **YES** — one link per plan, re-used by every customer of that plan | both plan links are single constants |
| Unique `reference_id` per customer | **NO** on the link itself — there is exactly one link; it cannot carry a per-customer reference value | a static link has one fixed identity |
| Callback URL | Not controlled/owned by this app config for static links (see OBJ 2) | static links created out-of-band |
| Notes | None controllable per-static-link; the intent's unique reference is a string the **customer copies into the payment**, not a link note | `intents.ts:80-88` `makeReference` + `intentInstructions` |
| IDs obtainable without API | Provider payment id / order id can appear **only** in (a) a receipt email or (b) the callback/return — not from the link itself | system facts |

**Verdict:** The two links are **shared, fixed-identity** links. They carry **no provider-verified per-customer binding** by themselves. The only per-session key is the app-generated `reference` string, which the customer is asked to include in the payment.

---

## OBJ 2 — Is a callback possible for THESE static links? What arrives?

**Direct answer: NO usable, verifiable callback for the current static links.**

- The latent `callback_url` (`/api/v1/payments/status`) is set only on **API-created** payment links (`service.ts:130-131`, inside `createRazorpayPaymentLinkForIntent`). The two static dashboard links are **not** produced by that path, so they do **not** carry this configured callback.
- A generic Checkout callback (submit/return) is a **client-side redirect**; Razorpay's documentation confirms the hosted Payment Link returns to a callback, but the return delivers **unverified query params** (payment_id, reference_id, signature) that this app has **no credential to verify** (see OBJ 3).
- Therefore the only thing a static-link "return" can produce is exactly what `handleReturn` (`service.ts:292-307`) already and honestly does: record a `return` event and **stay PENDING** because there is no verifiable provider evidence. The code comment is explicit: *"Honest: without provider evidence state stays PENDING."*

**Data that a callback would conceptually deliver (were one usable):** `payment_id`, `order_id`/`reference_id`, `signature`, status, link id. Verified via the return: **none are cryptographically trusted by this app today.**

**Verdict: callback = INSUFFICIENT for the static links.** Say so plainly.

---

## OBJ 3 — Can CodeConclave cryptographically verify the callback?

**No — not without a credential it does not currently hold.**

- Razorpay's callback `razorpay_signature` is verified by HMAC-SHA256 using the **API key/secret-derived secret** (`razorpay_secret_key` needed to compute `order_id|payment_id` signature) or the **webhook secret** for webhook payloads. Both are exactly the **API / webhook credentials** that are excluded.
- The directive is correct: **we must not relabel a required Razorpay secret as "no API".** There is **no credential present** (`RAZORPAY_KEY_ID`/`SECRET`/`WEBHOOK_SECRET` are not configured) to verify any signature. `evidence.ts: `razorpayApiSource`/`razorpayWebhookSource` availability returns false without them; `verifyWithProvider` (`service.ts:267`) requires `RAZORPAY_MODE === 'api'`.
- Without verification, callback params are **client-forgeable** (`?paid=true` style), and forgeable payment authority is explicitly forbidden.

**CALLBACK_SIGNATURE = NOT_AVAILABLE (no credential). CALLBACK_PAYMENT_AUTHORITY = FAIL.**

---

## OBJ 4 — User correlation: User A vs User B on the same static Pro link

Critical test (two users, same static link), answered from the running trust design:

- The system does **not** rely on "the browser returned to the same user" (`handleReturn` stays PENDING; browser transport carries no authority).
- **Correlation binding available without API/webhook:** the app-issued unique `reference` (`CCPRO-XXXXXX`), combined with an **origin-authenticated Razorpay receipt email** that contains that exact reference (`gmailSource.collect` requires `ref === reference`, `evidence.ts:306-307`), bound to a **server-side pending intent** keyed by `user_id`.

So with the Gmail rail:

- **If each user copies their own unique reference into their own payment**, each real Razorpay receipt (authenticated: DKIM/SPF/DMARC pass for `razorpay.com` via `isAuthenticRazorpayMail`) carries a distinct reference → the pipeline binds **payment → exact pending intent → exact user**. Correlation works.
- **If a user (or a colluding pair) uses the wrong/no reference**, the receipt either fails the strict `ref === reference` match (no evidence → stays PENDING, no activation) or triggers fraud flags (`reference_reuse`, `duplicate_payment_id`, `amount_mismatch`, `sender_anomaly`) → forced REVIEW, never ACTIVE (`fraud.ts`, `activation.ts`).
- The reference is **server-issued and UNIQUE** (DB unique constraint) per intent; it cannot be reused to activate a different intent, and it is not a value the user invented.

**Strength compared to API:** this is **not cryptographically/provider-bound** the way a per-intent API link's `reference_id`/`notes.intent_id` is (`service.ts:110-148`). It depends on the user **correctly copying** the reference and the receipt **including** it. That is the honest caveat.

**Attack surface (replay/forwarding/cross-user):**
- Forwarding a paid **link** does nothing (a link has no authority; only an authenticated receipt referenced to a specific intent suggests anything).
- Forwarding a **receipt** as OCR/manual evidence is forced REVIEW by the trusted-source gate (`effectiveMatch`, `pipeline.ts:66-78`) — cannot activate.
- Cross-user activation requires an authenticated Razorpay receipt bearing the victim's exact reference — the attacker cannot make Razorpay emit a receipt with a reference that isn't tied to their own payment amount/window, and `payer`/`reference`/`duplicate_payment_id` fraud checks block it.
- **Replay/forwarding of the same receipt** → blocked by sha256 replay guard and `duplicate_payment_id`.

**USER_CORRELATION = PASS (no-API, Gmail rail, reference-bearing authenticated receipts) — conditional on the customer using their unique reference. UNVERIFIED against real receipts (no live test).**

---

## OBJ 5 — Gmail / Apps Script: transport vs authority vs correlation

Separate the three concepts clearly:

| Concept | Status | Why |
|---|---|---|
| **GMAIL TRANSPORT** | AVAILABLE & working | OAuth Gmail collector + Apps Script claim rail already built; watchdog `sweepPendingIntentEvidence` runs it 24/7, bounded + rate-limited + idempotent |
| **PAYMENT AUTHORITY** | **Backend only — never the script** | Apps Script = watchdog/collector only (Objective 7); backend `applyDecision` is the sole ACTIVE gate; client/script inputs are evidence to score, never authority |
| **USER CORRELATION** | Reference-bearing authenticated receipt only | `isAuthenticRazorpayMail` (origin-authenticated) + exact `ref === reference` + amount + payer + fraud checks |

**Can merchant-side Razorpay emails securely establish REAL_PAYMENT + EXACT_USER for shared static links?**

- **REAL_PAYMENT:** partially yes — an origin-authenticated Razorpay receipt is independent evidence that a **real payment landed in the merchant's Razorpay account**. This is genuinely independent of the customer.
- **EXACT_USER:** yes **only** if the receipt carries the exact server-issued reference (i.e., the customer typed it at checkout). Gmail alone provides *transport + origin authentication* of evidence; it does **not** provide *independent per-session verification* when the reference is user-typed (vs provider-echoed).

**Honest statement (as the directive requests):** Gmail provides **evidence and transport**, and origin-authentication, but the **exact-user binding depends on a user-typed reference inside a provider receipt** — it is not the independent, provider-issued correlation the API path gives. So: **Gmail = PASS for PAYMENT_TRUST-building evidence; correlation is conditional and weaker than API**, and the reliability of reference-bearing real static-link receipts is **UNVERIFIED** (no live test).

---

## OBJ 11 — Refunds under current model

- **AUTO_REFUND_REVOCATION = NOT_AVAILABLE** under `NO_API + NO_WEBHOOK` — there is no trusted refund-event source.
- Refund infrastructure exists but is dormant and tied to the webhook rail (`payment.refunded`) / `refundIntent`.
- Stated honestly, not papered over.

---

## OBJ 14 — Final capability classification (A–E)

With every mechanism independently evaluated:

- **A (TRUE ZERO-ADMIN POSSIBLE NOW):** **NOT CLEANLY** — the strict Gmail evidence rail IS live-capable and requires zero admin, but its reliability rests on reference-bearing receipts, which is **UNVERIFIED** (no live no-money test permitted) and depends on a customer copy action. Fails "guaranteed-now" bar.
- **B (ZERO-ADMIN WITH SMALL PROVIDER-SUPPORTED CONFIG):** the closest true fit today (the Gmail watchdog requires only configuration already present), **but the exact-user correlation is not provider-guaranteed** — it needs user-typed references in receipts. B order of magnitude, but with the OBJ-4 caveat.
- **C (IMPOSSIBLE WITH CURRENT RAZORPAY CAPABILITIES) / D (REQUIRES API/WEBHOOK):** these are the correct outcome **for guaranteed, provider-bound exact correlation** — only the API path (per-intent links + reference_id + signed webhook) yields cryptographically/provider-bound correlation + automatic refund detection.
- **E (ANOTHER PROVIDER MEETS REQUIREMENTS):** **NO** — every viable provider still needs API and/or webhook to emit a verifiable signal (already established in `FINAL_NO_API_NO_WEBHOOK_ZERO_ADMIN_PAYMENT_DISCOVERY.md`).

**Primary objective-14 result:**
- If the bar is **"guaranteed, provider-bound exact-user correlation + automatic refund revocation, no admin, 24/7"** → **D (API/WEBHOOK required)**.
- If the bar is **"best-effort zero-admin that can work today via the authenticated-reference Gmail rail, accepting user-typed-reference correlation (unverified live) and no auto-refund"** → **B-with-caveats / C-for-guarantee**.

I will **not force A or B**. The honest primary answer is **C/D for guaranteed trust**; the already-built Gmail rail is the only no-API fallback and is **UNKNOWN-reliability** (not certified) until a live no-money read-only test is permitted.

---

## Gate summary

```
STATIC_LINKS               = SHARED, fixed identity, no provider per-customer binding
CALLBACK                   = INSUFFICIENT for static links (not API-created; return is client redirect)
CALLBACK_SIGNATURE         = NOT_AVAILABLE (no credential; HMAC requires API/webhook secret)
CALLBACK_PAYMENT_AUTHORITY = FAIL
GMAIL_WATCHDOG             = AVAILABLE (backend-authoritative; collector/watchdog only)
USER_CORRELATION           = PASS (no-API via authenticated reference-bearing receipt) — conditional; UNVERIFIED live
PAYMENT_TRUST              = PASS (no-API via origin-authenticated Razorpay receipt) — conditional; UNVERIFIED live
REFUND_HANDLING            = NOT_AVAILABLE (no-API/no-webhook)
ACTIVATION_CODE            = OPTIONAL (post-trust recovery only; NOT a proof mechanism)
IDEMPOTENCY                = PASS (exactly-once + replay dedupe already enforced)

NO_RAZORPAY_API     = YES
NO_RAZORPAY_WEBHOOK = YES
NO_ADMIN            = YES

TRUE_ZERO_ADMIN_NOW = UNKNOWN
   (a secure no-API engine exists and is live-capable via the Gmail evidence rail,
    but its exact-user correlation depends on user-typed references inside
    authenticated receipts, which is unverified without a live no-money read-only test;
    guaranteed provider-bound correlation + auto-refund require the API/webhook)
```

`SOURCE_CHANGES = 0` · `DATABASE_CHANGES = 0` · `DEPLOYMENT = NOT_EXECUTED` · `REAL_PAYMENT = NOT_PERFORMED` · `FEATURES_REMOVED = 0`

*Cross-refs: `FINAL_PAYMENT_ORCHESTRATOR_ARCHITECTURE.md`, `FINAL_PAYMENT_SECURITY_MODEL.md`, `FINAL_NO_API_NO_WEBHOOK_ZERO_ADMIN_PAYMENT_DISCOVERY.md`.*
