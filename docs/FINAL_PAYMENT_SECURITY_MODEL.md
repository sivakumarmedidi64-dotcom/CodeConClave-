# FINAL — Payment Security Model

> **Type:** Security model + Objective 12 attack-verification. **No code changed, no deployment, no real payment.** Every attack below is evaluated against the actual running logic in `backend/src/modules/payments/`. Conclusion: the non-negotiable security rule is **implemented, double-enforced, and not weakened** by this design or by the no-API path.

---

## 1. Enforced non-negotiable rule (source-anchored)

The Payment Orchestrator **never treats customer-controlled input as payment proof.** Enforcement is layered:

1. **Trusted-source gate** — only `gmail`, `razorpay_api`, `razorpay_webhook` may drive ACTIVE; `ocr`/`manual` are forced REVIEW (`pipeline.ts:55-78`). This is the primary defense: no screenshot/typed/claim can ever be proof.
2. **Single ACTIVE gate** — `applyDecision` (`activation.ts:37`) is the only path to ACTIVE and to entitlement activation; it refuses non-PENDING/REVIEW intents and uses an exactly-once conditional UPDATE.
3. **Client surface neutralized** — `handleReturn` stays PENDING without provider evidence (`service.ts:292`); browser redirect / `?paid=true` / client-supplied payloads never reach authority.
4. **Amount / plan authority** — server-side known amounts (`PLAN_PRICES_INR`); provider/evidence amount must equal the intent amount or it's rejected (`service.ts:322-335`; `fraud.ts:55-61`).

---

## 2. What is and is not trusted (explicit)

| Input | Status |
|---|---|
| localStorage / sessionStorage | never read for authority |
| client-selected email / plan / amount / reference | **signals only** (matcher scores them; never facts) |
| `?paid=true` / browser redirect | ignored (`handleReturn` stays PENDING) |
| arbitrary `paymentId` / `orderId` submitted by browser | not a trusted source; source id must be `gmail/api/webhook` |
| UTR entered by user | `ocr`/claim rail only → REVIEW, never ACTIVE |
| screenshot / forwarded receipt / forwarded email | `ocr`/`manual` → REVIEW; replay-guarded |
| activation code | NOT a proof (see §6) |
| customer claim ("I paid") | never proof |

**Email ownership ≠ payment proof.** The payer-email signal is only **+0.10** confidence and is a fraud input (`sender_anomaly`), never the anchor. **An activation code is NOT payment proof** — it is a post-trust delivery token only.

---

## 3. Objective 12 — attack-by-attack verification (all must fail; traced to code)

| # | Attack | Defeated by (source) | Result |
|---|---|---|---|
| 1 | Unpaid return (`?paid=true`) | `handleReturn` stays PENDING; no evidence rail fires | **FAILS** |
| 2 | Fake payment ID (browser) | not a trusted source; `effectiveMatch` → REVIEW for manual; no source accepts arbitrary id | **FAILS** |
| 3 | Fake order ID | same as #2; not a trusted source | **FAILS** |
| 4 | Fake signature | `CALLBACK_SIGNATURE` NOT available; no signature verification path without secret; signature never used for authority | **FAILS** |
| 5 | Modified amount | `amount_mismatch` blocking flag; server-authoritative amount enforced (`fraud.ts:55-61`, `service.ts:322-335`) | **FAILS** |
| 6 | Modified plan | `plan_mismatch` blocking flag (reference plan vs intent plan, `fraud.ts:65-70`); plan is server-set at intent | **FAILS** |
| 7 | Another user's payment | owner-scoped queries (`owner_id`), exact-reference binding to owner's intent; `duplicate_payment_id` blocks reuse | **FAILS** |
| 8 | Payment replay | `screenshot_replay` via sha256 (`fraud.ts:79-85`); replay guard in pipeline (`pipeline.ts:114-131`) | **FAILS** |
| 9 | Duplicate callback | exactly-once conditional UPDATE race guard; idempotent evidence dedupe | **FAILS (no double activation)** |
| 10 | Duplicate Gmail receipt | sha256 + `duplicate_payment_id` dedupe; no double activation | **FAILS** |
| 11 | Cross-user activation | intent+evidence scoped by owner; exact reference to owner's intent; trusted-source gate; fraud checks | **FAILS** |
| 12 | Expired checkout | status=EXPIRED via watchdog (`sweepIntentExpiry`); non-PENDING/REVIEW intents refuse evidence (`activation.ts:46-48`) | **FAILS** |
| 13 | Refunded payment still active | under NO-API/NO-WEBHOOK not auto-detectable (honest); with webhook rail `payment.refunded` → REFUNDED + entitlement revoked (`activation.ts:refundIntent`) | no-API: **NOT_DETECTABLE (honest)**; webhook: **REVOKES** |
| 14 | Activation-token replay | one-time token, hash-stored, consumed once (`activation.ts` / `demo.ts:285` `consume`); single-use | **FAILS (replay blocked)** |

All 14 conclude the system does **not** activate from any unauthorized path.

---

## 4. Trusted source → signal scoring (the honest confidence model)

Because no-API correlation is not cryptographically bound, the model is **confidence-weighted** (`matcher.ts:37-77`): reference **0.45**, amount **0.25**, payer **0.10**, window **0.10**, payment-id **0.10**. An ACTIVE decision requires a **trusted source** (never user-asserted) **and** crossing the ACTIVE threshold; everything is audited (`thresholds_used`, `fraud_flags` on the intent).

This is the security-strength trump card of the no-API path: **even a perfect-looking screenshot/manual claim can never reach ACTIVE** because the trusted-source gate forces REVIEW regardless of confidence. So the no-API Gmail path does **not** weaken the model — it only narrows *which* independent signal can activate.

---

## 5. Apps Script role (Objective 7) — no authority

- Apps Script / Gmail = **WATCHDOG / COLLECTOR**: read mailbox → extract candidate evidence → attach metadata → sign transport payload → POST to orchestrator → safe retry → dedupe.
- The **backend is authoritative** for verification and activation. The script never issues entitlements.
- Google Sheets is only an **audit/ledger mirror**, never an authority.
- The transport payload is HMAC-signed (`gmail-claim.ts` `verifyGmailClaimSignature`) and timestamp-validated; mismatches/timestamps out of window are rejected.

---

## 6. Activation code (Objective 9) — OPTIONAL, never proof

- **SAFE pattern (already correct):** `trusted payment → create one-time token → email customer → customer redeems → activate`.
- **UNSAFE pattern (forbidden):** `customer claims payment → create code → activate`.
- Because the trusted-payment source exists (Gmail rail / API/webhook), an activation code is **OPTIONAL** as a UX/recovery layer — but it is **never** an entitlement mechanism on its own. If no trusted source were present, the code layer must remain **disabled as an entitlement mechanism**. Given a trusted source is present, keeping it **OPTIONAL** is acceptable; treating it as proof is not.

---

## 7. Confidence + fraud independence

- Confidence is **computed server-side** from normalized signals; the thresholds used are stored (`thresholds_used`) and audited per decision.
- Fraud flags are **blocking** where they indicate spoof/reuse/mismatch (`BLOCKING_FLAGS` → forced REVIEW, never ACTIVE). Isolation between users (tenant/owner scoping) prevents cross-account contamination.

---

## 8. Security statement

- The design **does not weaken payment security**; the no-API Gmail path preserves the rule "no trusted source → no ACTIVE."
- The honest limitations are: (a) exact-user correlation is user-typed-reference-dependent (unverified live), and (b) refund revocation is **not auto-detectable** without API/webhook. Neither is a security relaxation — they are honest "not yet automatable" gaps, documented, with the dormant API/webhook rails ready to close them.

---

## 9. Compliance

`SOURCE_CHANGES = 0` · `DATABASE_CHANGES = 0` · `DEPLOYMENT = NOT_EXECUTED` · `REAL_PAYMENT = NOT_PERFORMED` · `FEATURES_REMOVED = 0`. No secrets referenced.

*Cross-refs: `FINAL_PAYMENT_ORCHESTRATOR_ARCHITECTURE.md`, `FINAL_ZERO_ADMIN_PAYMENT_CURRENT_CAPABILITY_GATE.md`.*
