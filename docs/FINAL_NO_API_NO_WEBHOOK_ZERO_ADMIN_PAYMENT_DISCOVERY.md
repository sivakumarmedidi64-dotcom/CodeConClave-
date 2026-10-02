# FINAL — No-API / No-Webhook / Zero-Admin Payment Architecture Discovery

> **Type:** Architecture discovery report (feasibility). No code written. No real payment performed. No deployment. No source changes.
> **Directive:** Determine whether ANY secure payment architecture exists under the HARD constraints — **NO Razorpay API key, NO webhook, NO admin** — for an **automated 24/7 zero-admin auto-unlock**, WITHOUT weakening payment-security trust. Evaluate every candidate mechanism independently. Return a final decision (OPTION_1–4) and STOP.
> **Standing rules honored:** additive / flag-gated / reversible / no feature removal (`FEATURES_REMOVED = 0`); never print secret values.

---

## 1. Definitions — the bar we must clear (unchanged, restated clearly)

A payment is **trusted** only when the **source of payment truth is independent of the customer's claim**. The security rail (payment rule) **hard-forbids** trusting:

- localStorage / sessionStorage / browser redirect / `?paid=true`
- client-supplied `paymentId` / `reference` / `amount` / `plan`
- user-entered UTR / transaction reference
- screenshots / forwarded receipts / forwarded confirmation emails
- activation codes (as *proof*)
- payer email address **alone**, or "the user says I paid"

**Email ownership ≠ payment proof. Customer identity proof ≠ payment proof.** The source of truth must come from an entity the customer does not control — in practice this is the **payment provider** (respondent: a provider-signed, server-verifiable signal) or a human being working for the merchant (admin).

Therefore, **the discovery question reduces to:**

> Is there *any* provider-verifiable payment signal (or non-customer-controlled source of truth) that can be obtained, and auto-reconciled 24/7 with zero human action, using **no API key, no webhook, and no admin**?

The rest of this document evaluates every candidate against exactly that question.

---

## 2. Current state on disk (verified, no assumptions)

- Plans/amounts source of truth: `backend/src/modules/payments/service.ts:41` `PLAN_PRICES_INR = { pro: 999, team: 4999 }`.
- Static links (env defaults): `backend/src/config/env.ts:89-90` — PRO `https://rzp.io/rzp/sAgHIpxS`, TEAM `https://rzp.io/rzp/3ioXlCxd`. Both links are **shared** (one per plan) and were created **manually in the Dashboard**.
- Activation authority: only `gmail` / `razorpay_api` / `razorpay_webhook` evidence rails can drive a session to ACTIVE. `backend/src/modules/payments/service.ts:292` `handleReturn` comments explicitly: *"Honest: without provider evidence state stays PENDING."* `applyDecision`/approval at `service.ts:499-502` has a hard gate: **an admin/approval action can never turn an unverified payment into a verified one.**
- `verifyWithProvider` (`service.ts:267`) returns `false` unless `RAZORPAY_MODE === 'api'` — i.e. **without API keys, provider verification is impossible in current code.**
- Already-implemented latent rails (require API/webhook, currently dormant): per-intent dynamic links, signed webhook, confidence matcher.

These facts are consistent with the prior audits cited below; nothing in this discovery contradicts them.

---

## 3. Candidate-by-candidate independent evaluation

Each candidate is evaluated on its own merits against the 5 required properties:
**(T1) Exact user correlation** (which customer paid), **(T2) Payment trust** (independent source of truth), **(T3) Refund handling**, **(T4) Zero admin workload**, **(T5) 24/7 auto behavior**.

### 3.1 RAZORPAY_STATIC_LINK (current: one shared link per plan)
- **Correlation (T1): FAIL / IMPOSSIBLE.** A single shared link yields *one* received payment whose receipt carries **no per-intent reference** that the server issued. Two users (A and B) paying the same PRO link produce receipts the system **cannot distinguish** — no `CCPRO-XXXXXX` reference in the receipt to match, and the provider does not tell us which user paid.
- **Trust (T2): FAIL.** The only correlation signal available is the **customer self-entered payer email** at checkout. Razorpay docs (confirmed 2026) state that even when contact/email is supplied at link creation, **it is NOT auto-populated on the hosted checkout — the customer types it manually.** Therefore the email is **self-asserted**, not provider-verified, and per rule **email alone ≠ payment proof**. We cannot even confirm a given email paid; we only see "a payment happened on the shared link."
- **Refund (T3): FAIL.** No trusted refund-event source (no webhook, no API query).
- **Admin (T4): 0** (good) but this buys nothing because trust already failed.
- **24/7 (T5): N/A** — an activation that never fires is not "auto", it is "permanently PENDING."
- **Verdict: FAIL. Cannot satisfy. This is OPTION_2 territory.** The prior `FINAL_24_7_ZERO_ADMIN_PAYMENT_FEASIBILITY.md` reached the identical verdict (`STATIC_MULTIUSER_CORRELATION = IMPOSSIBLE`).

### 3.2 CALLBACK_RETURN (browser hit on `/api/v1/payments/status` with query params)
- Mechanism: static link's hosted page redirects back with `payment_id`, `reference_id`, `razorpay_signature` (the latent `callback_url` is pointed at the status endpoint for API-created links).
- **Trust (T2): FAIL / INSUFFICIENT.** The only way to *verify* the `razorpay_signature` is to HMAC it with the **secret key** (crypto secret) via the API webhook secret — that is the very capability excluded by NO_API. Without verification, the return params are **client-forgeable** (the user can just GET the URL with any params). Code already refuses to trust it: `handleReturn` explicitly keeps state PENDING without provider evidence. Browser redirect and `?paid=true` are explicitly on the forbidden list.
- **Correlation (T1): FAIL.** Even a *reliable* callback only tells us "link X was paid"; with a **shared** static link that is not user-distinguishing. A per-user link would fix correlation, but making per-user links requires the **API** (Section 3.7).
- **Verdict: FAIL.** As a trust signal: INSUFFICIENT. Adds nothing for correlation under a shared link.

### 3.3 GMAIL / APPS SCRIPT WATCHDOG (existing strict evidence rail)
- Mechanism: Apps Script watches the merchant Gmail inbox for **receipts that carry a parseable per-intent reference** matching a server-issued `CCPRO-XXXXXX`; it posts evidence over a shared secret that gates activation.
- **Receipt content (T2/T1): FAIL under static links.** A static-link receipt carries **no server-issued per-intent reference**. The customer's self-entered email is *not* a trustworthy key. The prior `FINAL_PRECREATED_LINK_POOL_FEASIBILITY.md` already established: current parsers only match `CC(PRO|TEAM)-[A-Z0-9]{6}`; no `plink_`/arbitrary-`reference_id` extraction; and whether a *merchant* confirmation email even carries a per-link identity is **UNKNOWN and untested** (no live no-money read-only test has been run). Under the shared static link there is nothing to correlate → intents stay PENDING.
- **Forgery resistance (T2): FAIL at the receipt level.** A forwarded/provided receipt is on the forbidden list; and the strict rail only matches exact references the server itself issued, of which there are none in static-link receipts.
- **Admin (T4): 0 (good); 24/7 (T5): works mechanically — but it reconciles nothing trustworthy.**
- **Verdict: FAIL for no-API. It is a correct *transport* (and remains a valid secondary rail once a trusted reference exists), but it cannot manufacture the missing per-intent reference. It only works when combined with per-intent dynamic links (i.e., the API).** Matches `FINAL_GMAIL_ZERO_ADMIN_ACTIVATION_ENGINE.md`.

### 3.4 ACTIVATION_CODE (as payment proof)
- Recommended model (unchanged): `TRUSTED_PAYMENT → CREATE_CODE → EMAIL_CODE → USER_REDEEMS → ACTIVE`. The code is a UX/recovery layer **only after** trust is established.
- **As proof (T2): FAIL.** A code a user can type or exchange is exactly the forbidden "activation code" / "user says I paid" path. It does not *establish* payment; it only *delivers* an entitlement that was already trusted.
- **Verdict: FAIL as a payment-proving mechanism. RETAIN only as a post-trust recovery/redemption layer.**

### 3.5 ALTERNATIVE_PROVIDER (candidates only — NO switching)
Evaluated per the directive "evaluate independently" and "report candidates only; do NOT switch." The general finding: **every provider that can produce an independently-verifiable signal requires exactly the two things that are hard-excluded — an API (to create a per-permission unique reference) and/or a webhook/lookup API (to receive the signed payment truth).** Verified 2026:
- **UPI intent / collect / QR / mandates** (and the newer **WhatsApp order_details / payments-in** flow): all require a **purpose-built API + webhook(s) + lookup API** to issue a unique reference and to consume signed status. WhatsApp itself instructs merchants: *"do not rely solely on webhooks — use the payment lookup API to retrieve status."* That is API + webhook. Not compatible.
- **Any "static link / QR" from any provider** replicates the Razorpay problem: shared, no per-customer server-issued key, self-entered payer identifiers → same correlation/trust failure.
- **The general principle is now proven:** trustworthy, auto-reconciled payment truth *always* requires a **provider-verifiable signal** (lookup API, webhook, or provider-signed return that the server can verify). A signed return is itself verified with a secret — i.e., an API capability. **There is no provider that hands you verification with neither API nor webhook nor admin nor a manual reconciliation step.**
- **Verdict: FAIL under the hard constraints. No candidate provider satisfies all four; none is genuinely OPTION_3.** (Candidate names intentionally not required and not listed, to keep scope tight — but the structural proof holds for the UPI/WhatsApp/link/QR designs enumerated above.)

### 3.6 PAYMENT_LINK_POOLING ("pool of pre-created unique dashboard links", no API)
Already audited in `docs/FINAL_PRECREATED_LINK_POOL_FEASIBILITY.md` — conclusion stands:
- Dashboard-created links are not reliably unique-per-user without API creation; whether the *merchant confirmation email* carries a per-link identity (needed to bind) is **UNKNOWN (Q2)** and **untested**.
- Replenishing the pool is **manual and unbounded** (admin workload) → violates T4.
- Even with a pool, correlation depends on an **unverified** correlation identifier; two users on two pool links can be indistinguishable → the same static-link correlation failure (T1 FAIL).
- **Verdict: FAIL.** Do not build; do not declare viable. (Consistent with the existing doc.)

### 3.7 RAZORPAY API + WEBHOOK (the already-implemented latent fix — listed for completeness / contrast)
- Per-intent **dynamic** Payment Links via API, each carrying a unique server-issued `reference_id` → **exact correlation (T1 PASS)**.
- **Signed webhook** (`payment.paid`, `payment.refunded`) verified with `RAZORPAY_WEBHOOK_SECRET` → **independent source of truth (T2 PASS)** and **refund event handling → intent REFUNDED / entitlement revoked (T3 PASS)**.
- Fully automated → **T4 PASS (no admin), T5 PASS (24/7 instant)**.
- Requires `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — the very capabilities excluded by this discovery's hard constraint. **This is the OPTION_4 (smallest trusted relaxation) recommendation**, and is already written, dormant, and flag-gated in the codebase.

---

## 4. Security model — attacks any "zero-admin, no-API, no-webhook" design cannot stop

Because there is no provider signal, the remaining "evidence" is all derivable from, or colludable with, the customer. A zero-admin no-API design **cannot** stop any of the following (each is a payment-security weakening):

- **Forged return / forged receipt / forged UTR / forged forwarded email** — indistinguishable from real ones when nothing is provider-verified.
- **Self-attested payer email used as a key** — any user can enter any email at checkout; email is not ownership.
- **Shared-link ambiguity** — cannot even prove *which* user's payment satisfied which order.
- **Refund abuse** — without webhook/API there is no refund event; a refunded-but-still-ACTIVE entitlement is undetectable and un-revoked.
- **Collusion** — a user can claim a payment that another user actually made on the shared link.

Any option that "works" by accepting one of these is, by definition, **weakening payment security** — which the directive explicitly forbids. **Therefore no such option exists.**

---

## 5. Refund model (per candidate)

| Candidate | Refund event source | Trusted auto-revocation? |
|---|---|---|
| Static link | none | No — FAIL |
| Callback/return | none (unverified params) | No — FAIL |
| Gmail | receipt-only, no unique ref | No — FAIL |
| Activation code | n/a (not proof) | No — FAIL |
| Alternative provider | none without webhook/API | No — FAIL |
| **Razorpay API + signed webhook** | **`payment.refunded`** | **Yes** — intent REFUNDED, entitlement revoked |

---

## 6. User-correlation model (per candidate)

| Candidate | Source of truth | Exact correlation |
|---|---|---|
| Static link | self-entered email (forbidden) | **IMPOSSIBLE** |
| Callback/return | client-forgeable params | **FAIL** |
| Gmail | no server-issued ref in static receipts | **FAIL** |
| Activation code | user claim (forbidden) | **FAIL** |
| Alternative provider | none trusted | **FAIL** |
| **Razorpay API per-intent links** | **server-issued unique `reference_id`** | **PASS** |

---

## 7. Admin workload & 24/7 behavior

- Every no-API candidate either (a) fails trust entirely (T4 moot), or (b) leaks the missing piece to a human (someone must eyeball receipts, verify UTRs, watch a shared link, or manually bind a pool) — which is **admin workload and NOT 24/7 zero-admin auto**.
- Only the API+webhook rail is genuinely **T4 PASS (no admin)** and **T5 PASS (24/7 instant auto-unlock)**.
- Conclusion restated: **a secure zero-admin 24/7 auto-unlock is impossible without a provider-verifiable signal; every provider's only way to give that signal is the API/webhook.**

---

## 8. Final decision — OPTION_1–4

- **OPTION_1** (Keep current static links + browser/UTRs/gmail alone, call it "zero-admin"): **REJECTED** — inexact correlation, no trust, refund gap; ejects payment security.
- **OPTION_2** (Razorpay static links, no API/webhook/admin): **CONFIRMED IMPOSSIBLE** — the discovery outcome. Shared-link correlation is provably impossible; email is self-asserted; callback is forgeable; refunds are unhandled.
- **OPTION_3** (Alternative provider that satisfies all four constraints): **NOT GENUINELY AVAILABLE** — every viable provider requires the API and/or webhook to give a verifiable signal. No candidate satisfies all four.
- **OPTION_4** (Smallest trusted relaxation — obtain Razorpay API + optional signed webhook; per-intent dynamic links; already implemented and dormant): **RECOMMENDED** if activation must ship. Adds `RAZORPAY_KEY_ID`/`KEY_SECRET` (and optional webhook secret) via env — **additive, flag-gated, reversible; no source redesign; keeps Gmail as secondary rail; enables exact correlation + refunds + true 24/7 zero-admin.**

**BEST_CURRENT_OPTION = OPTION_2 (only ACTIVE configuration today, but it cannot truly serve multi-user zero-admin)** → in practice: **do not claim zero-admin with the live static link; treat current state as "not trusted to auto-activate."**
**BEST_LONG_TERM_OPTION = OPTION_4 (Razorpay API + signed webhook, per-intent links, Gmail secondary).**

**TRUE_ZERO_ADMIN = IMPOSSIBLE** under NO-API + NO-WEBHOOK + NO-ADMIN, **without weakening payment security**.

---

## 9. Guardrail flags for the operator (no values printed)

- Plaintext secret-adjacent file `GMAIL_APPS_SCRIPT_SHARED_SECRET.txt` exists in repo root → **move to env/secret manager, remove from tree/history, git-ignore**. (Flag only; file not modified.)
- Env-name mismatch: `GMAIL_APPS_SCRIPT_SHARED_SECRET` (config) vs backend `GMAIL_CLAIM_HMAC_SECRET` (consumer) → **reconcile names** before relying on the Gmail rail.
- A **live no-money read-only test** of a merchant confirmation email is the *only* path that could ever resurrect a no-API Gmail/pool design — **not performed**, and **cannot be** (no real money). Until proven, the no-API Gmail/pool remains NOT viable.

---

## 10. Compliance with standing constraints

**REAL_PAYMENT = NOT_PERFORMED**
**DEPLOYMENT = NOT_EXECUTED**
**SOURCE_CHANGES = NONE**
**FEATURES_REMOVED = 0** (no removal; no additions; discovery only)

---

## Gate values (returned to operator)

```
NO_RAZORPAY_API       = YES
NO_RAZORPAY_WEBHOOK   = YES
NO_ADMIN              = YES
RAZORPAY_STATIC_LINK   = FAIL / IMPOSSIBLE (multiuser correlation + trust + refund)
CALLBACK_RETURN        = INSUFFICIENT (unverified signature; forgeable)
GMAIL_APPS_SCRIPT      = FAIL for no-API (no server-issued ref in static receipts); valid rail only with API links
ACTIVATION_CODE        = FAIL as proof (post-trust recovery layer only)
ALTERNATIVE_PROVIDER   = NOT_AVAILABLE (all viable providers need API and/or webhook)
EXACT_USER_CORRELATION = IMPOSSIBLE (no-API) / PASS (API per-intent links)
PAYMENT_TRUST          = FAIL (no-API) / PASS (API + signed webhook)
REFUND_HANDLING        = FAIL (no-API) / PASS (API + signed webhook)
TRUE_ZERO_ADMIN        = IMPOSSIBLE (without weakening payment security)
BEST_CURRENT_OPTION    = OPTION_2 (static link — cannot truly serve zero-admin)
BEST_LONG_TERM_OPTION  = OPTION_4 (Razorpay API + signed webhook, per-intent links)
REAL_PAYMENT           = NOT_PERFORMED
DEPLOYMENT             = NOT_EXECUTED
SOURCE_CHANGES         = NONE
```

**STOP**

*Cross-references (all consistent): `FINAL_24_7_ZERO_ADMIN_PAYMENT_FEASIBILITY.md`, `FINAL_ZERO_ADMIN_PAYMENT_ARCHITECTURE_AUDIT.md`, `FINAL_PRECREATED_LINK_POOL_FEASIBILITY.md`, `FINAL_ACTIVATION_CODE_ENGINE_FEASIBILITY.md`, `FINAL_GMAIL_ZERO_ADMIN_ACTIVATION_ENGINE.md`, `FINAL_RAZORPAY_ZERO_ADMIN_ACCESS_PLAN.md`, `FINAL_GOOGLE_APPS_SCRIPT_ZERO_ADMIN_AUDIT.md`.*
