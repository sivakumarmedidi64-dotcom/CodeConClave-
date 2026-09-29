# CodeConClave – Rail A (Gmail Evidence + Watchdog) NO-MONEY Validation Gate

> Date: 2026-09-03. Type: **test/validation gate** for the automatic zero-admin
> verification pipeline (Rail A). Uses a **deterministic synthetic, test-scoped
> Razorpay receipt** delivered only through a mocked Gmail `fetch`. **No real
> money, no contact with Razorpay, no live customer receipt, no deployment, no
> entitlement granted to any real user.** `SOURCE_CHANGES = 0` (properties) minus
> one **test-only reset seam** (see §6).

---

## 0. What this gate is and is not

This gate **proves implementation correctness** of the entire Rail A automatic
pipeline: correlation, origin gate, watchdog zero-admin behavior, exactly-once,
replay/idempotency, and fail-closed security. It does **NOT** prove that Razorpay
actually echoes the user-typed reference inside real merchant receipts — that is
an **external fact** that only a real (non-synthetic) receipt can confirm. That
distinction is enforced in every field below (`PROVEN_*` vs `UNVERIFIED`).

---

## 1. Architecture under test (unchanged)

| Concern | Where | Behavior (verified by this harness) |
|---|---|---|
| Watchdog sweep | `service.ts` `sweepPendingIntentEvidence` (602) | polls PENDING/REVIEW, bounded 25/cycle, backoff 30 s/intent, contained no-op when unconfigured (`evidence_source_blocked`) |
| Watchdog every 15 s | `watchdog.ts:68` `mailboxReceipts` | idempotent, sanitized error logging |
| Reference generation | `intents.ts` `makeReference` (79-88) | server-issued unique `CC{PLAN}-XXXXXX`; instructions tell customer to type it (166-185) |
| Reference correlation | `evidence.ts:304-307` | **exact** `ref === reference`; static-link reference-less receipts dropped |
| Receipt parser | `evidence.ts` `mailTextOf`/collect (262-328) | extracts ref, amount (₹), paymentId (`pay_…`), payer, date from authenticated email |
| Origin (merchant) gate | `evidence.ts` `isAuthenticRazorpayMail` (247-260) | DMARC/SPF/DKIM pass **bound to razorpay.com** + `From` domain razorpay.com |
| Amount validation | `matcher.ts` `scoreEvidence` + `fraud.ts:55-60` | amount mismatch → `amount_mismatch`, REVIEW, never ACTIVE |
| Plan validation | `fraud.ts:65-70` | plan encoded in reference must equal intent plan; strictly the exact-binding in `evidence.ts` rejects cross-plan refs first |
| Fraud gating | `fraud.ts:20-26,95` | blocking flags force REVIEW |
| Decision + entitlement | `activation.ts` `applyDecision` (37) + `service.ts` `activateEntitlement` (418) | **sole** ACTIVE/entitlement path; exactly-once conditional UPDATE |
| Sources | `pipeline.ts:55` `TRUSTED_EVIDENCE_SOURCES` | `gmail` may reach ACTIVE; `ocr`/`manual` forced REVIEW |

---

## 2. Synthetic receipt fixture (test-scoped, never production)

The harness (`backend/src/foundation/payments-rail-a-nomoney.test.ts`) defines a
deterministic `syntheticReceipt(...)` (subject, body, From, Date,
Authentication-Results) and injects it **only** through a stubbed `fetch` that
stands in for the Gmail `users/me/messages` API. The SQL DB is mocked exactly like
the existing payment suites.

**Why it can never be production evidence:** there is no code path that imports the
test file or injects synthetic payloads at runtime. In production the identical
pipeline is driven by a real origin-authenticated Razorpay email from a real
OAuth-authenticated mailbox. The synthetic message is a caricature whose sole job is
to exercise the logic.

---

## 3. What the 35-case harness proves (all passed)

### Correlation (valid → ACTIVE, zero admin)
- valid synthetic Pro receipt (origin pass, exact ref, ₹999) → **ACTIVE + entitlement** (via `ingestEvidence` → `applyDecision`), no admin anywhere.
- valid Team receipt (₹4999, `CCTEAM-…`) → ACTIVE, correct `team` entitlement.
- `scoreEvidence` anchor: reference = +0.45; full valid signals → confidence 1.0 / ACTIVE.

### Fail-closed vectors (all no-entitlement)
| Vector | Handling |
|---|---|
| reference missing (static-link receipt) | dropped → `no_evidence`, stays PENDING |
| wrong reference | dropped → `no_evidence` |
| wrong amount | `amount_mismatch` → REVIEW, no entitlement |
| wrong plan (cross-plan ref) | rejected by strict binding → no evidence |
| wrong merchant (codeconclave.dev / spoofed auth) | origin gate false → dropped |
| forged sender (no auth results) | origin gate false → dropped |
| customer-forwarded / non-original | origin gate false → dropped |
| wrong user (caller ≠ owner) | `getIntent` not found → 404, no entitlement |
| wrong workspace / cross-tenant ref reuse | sha256 replay guard → blocked |
| expired intent | `intent_not_matchable` → no entitlement |
| malformed receipt (no signals) | `no_evidence` |
| user-entered payment id / fabricated reference | manual source forced REVIEW, never ACTIVE |

### Watchdog + idempotency
- `sweepPendingIntentEvidence` auto-activates a pending intent from a synthetic receipt (no click).
- contained no-op (`evidence_source_blocked`) when Gmail rail unconfigured.
- exactly-once: 1×/2×/10× same receipt → exactly **one** entitlement.
- restart recovery: `__resetMailboxSweepWatermarkForTest()` models a fresh boot; a fresh sweep verifies exactly once, and an already-ACTIVE intent never double-activates.

---

## 4. Entitlement authority is unchanged

The only path to ACTIVE/entitlement is the **existing** `ingestEvidence` →
`applyDecision` → `activateEntitlement`. The harness adds **no** new activation entry
point, **no** admin/force/approve surface, and exercises only canonical watchdog
entry points. `FEATURES_REMOVED = 0`; no existing test was weakened.

---

## 5. Scope boundary – what the no-money test does NOT prove

The harness proves the **implementation** of the automatic path. It **cannot** prove
that Razorpay, when a real user pays, actually puts the exact typed reference
(`CCPRO-…`) into the receipt that arrives in the mailbox. That requires a legitimate
real merchant receipt (or Razorpay documentation/historical evidence). Until then:

`REAL_RAZORPAY_REFERENCE_BEHAVIOR = UNVERIFIED`

`AUTOMATIC_ZERO_ADMIN_FEASIBILITY = PROVEN_IMPLEMENTATION` (externally UNVERIFIED)

---

## 6. Diff summary (this phase)

| File | Change |
|---|---|
| `backend/src/foundation/payments-rail-a-nomoney.test.ts` | **new** – 35-case no-money synthetic Rail A harness |
| `backend/src/modules/payments/service.ts` | **+1 test-only seam** `__resetMailboxSweepWatermarkForTest()` (models a process restart; never called by app code; no behavior change) |
| `docs/CODECONCLAVE_PAYMENT_RAIL_A_VALIDATION_GATE.md` | **new** – this document |

No other production file, route, migration, entitlement rule, or feature changed.

---

## 7. Test results

- New harness: `payments-rail-a-nomoney.test.ts` — **35/35 pass**.
- Existing payment/security/watchdog suites re-run with the harness (7 files):
  `payments-gmail-gate`, `payments-26h`, `payments-4d`, `payments`, `payments-webhook-route`,
  `gmail-claim`, `payments-rail-a-nomoney` — **173/173 pass**.
- `tsc -p tsconfig.json --noEmit` — clean.

---

## 8. Remaining external verification (blocked on real evidence, by design)

To flip `REAL_RAZORPAY_REFERENCE_BEHAVIOR` to `VERIFIED`, one of:
1. A legitimate merchant Razorpay receipt (or the user's own paid, non-customer-synthetic
   receipt) that is **parsed by this exact code** and shown to carry the exact typed reference; or
2. Official Razorpay documentation / API contract confirming the reference is echoed in
   the receipt subject/body.

This is intentionally out of scope for the no-money harness and is not fabricated here.
