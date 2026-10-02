# FINAL — Payment Orchestrator Architecture (Separate Payment Subsystem)

> **Type / scope:** Architecture + responsibility-mapping + SAFE implementation plan. **No production code written, no deployment, no migration, no env change.** `SOURCE_CHANGES = 0`.
> **Key finding up front:** CodeConClave **already contains a separate, isolated payment subsystem** at `backend/src/modules/payments/`. The "Payment Orchestrator → Evidence Collectors → Verification Engine → Entitlement Engine" stack proposed in the directive is **already implemented** under the existing module boundary. Objective 6 (map before building) therefore resolves to: **do NOT build a second payment subsystem** (that would violate "no duplicate systems" and, per standing rules, no second backend / no redesign). This document maps every proposed component to its existing implementation and documents the one honest gap.

> **Update 2026-09-01 — Private Payment Control Center (read-only control plane):** an observability layer was later added ON TOP of this subsystem as a thin, read-only mirror (see §12). It reuses the exact module above; it does NOT duplicate or mutate anything.

---

## 1. Proposed-vs-existing component map (Objective 6 — avoid duplication)

The directive's `backend/src/modules/payment-gateway/` components are **already served** by `backend/src/modules/payments/`:

| Directive component (proposed) | Existing implementation (already present) | Location |
|---|---|---|
| **PaymentOrchestrator** (never trust client input) | **Evidence ingestion pipeline** — normalize → dedupe → fraud → store → match → apply; server-authoritative; client values are *signals to score*, never facts | `payments/pipeline.ts` `ingestEvidence` |
| **PaymentIntentRegistry** | **Payment intents** — server-issued unique `CC{PLAN}-******` reference, amount, status, expires_at, per-intent link | `payments/intents.ts` |
| **PaymentEvidence** (normalize/dedupe/store) | **Evidence records + sha256 dedupe + replay guard** | `payments/pipeline.ts`, `payments/evidence.ts`, `payments/fraud.ts` |
| **VerificationEngine** | **Confidence matcher** (weighted signals → ACTIVE/REVIEW/PENDING; audited thresholds) | `payments/matcher.ts` `scoreEvidence` |
| **FraudEngine** | **Fraud/spoof guard** (duplicate payment id, reference reuse, amount/plan mismatch, sender anomaly, velocity, replay) | `payments/fraud.ts` |
| **EntitlementEngine** | **Confidence-based activation** — the ONLY path that reaches ACTIVE; exactly-once guard | `payments/activation.ts` `applyDecision`; `service.ts` `activateEntitlement` |
| **IdempotencyStore** | **Exactly-once conditional UPDATE** (PENDING/REVIEW→ACTIVE race guard) + sha256 replay dedupe in pipeline + Postgres unique constraints | `payments/activation.ts:111-123`, `payments/pipeline.ts:114-131`, DB `uq_payment_intents_reference` |
| **PaymentEventLedger** | **Payment audit + events ledger** (`payment_audit`, `payment_events`, `recordAudit`) | `payments/service.ts` `logPaymentAudit`, `routes.ts` |
| **PaymentReconciliation** | **Drift/reconciliation runner** | `payments/reconciliation.ts` |
| **Evidence Collectors** | `gmail` (OAuth watchdog), `ocr` (screenshot, REVIEW-only), `razorpay_api` (dormant), `razorpay_webhook` (dormant) | `payments/evidence.ts` |
| **Gmail/Apps Script watchdog** | Backend-driven Gmail collector + Apps Script claim rail (`gmail-claim`) | `payments/evidence.ts: `gmailSource`, `payments/gmail-claim.ts` |

**Conclusion:** The subsystem already exists and is already **isolated from general application logic** behind the `payments/` module. No new module directory is needed. Any "separate payment service" work must be **expressed as additive enhancements to the existing module**, not a parallel subsystem.

---

## 2. Trust boundary (unchanged, is the guiding rule)

`payments/pipeline.ts:55` — `TRUSTED_EVIDENCE_SOURCES = { gmail, razorpay_api, razorpay_webhook }`.

- Only these three sources can drive an intent to `ACTIVE`.
- `ocr` (screenshot) and `manual` sources are **forced to REVIEW** regardless of confidence (`effectiveMatch`, `payments/pipeline.ts:66-78`) → a fabricated screenshot can never activate.
- `activation.ts` `applyDecision` is the **single code path** to ACTIVE and the **single code path** to entitlement activation (`payments/activation.ts:37`, `service.ts:418`).
- Client/App-Script inputs never become payment authority; they are collected evidence only.
- `service.ts:499-502`: an admin/approval action **can never** verify an unverified payment (approval can only act on already-VERIFIED/ACTIVE payments).
- `service.ts:292` `handleReturn` — "Honest: without provider evidence state stays PENDING"; the browser return is **never** treated as proof.

---

## 3. The subsystem's state machine (Objective 8 — Entitlement Engine)

The directive's proposed `PENDING → PAYMENT_DETECTED → PAYMENT_VERIFIED → ACTIVATING → ACTIVE` is realized as:

- **Intent statuses** (`payments/intents.ts:20-28`): `PENDING → REVIEW → ACTIVE → GRACE → EXPIRED | REFUNDED | REVOKED | CHARGEBACK`.
- **Session statuses** (`service.ts`): `PENDING → DETECTED → VERIFYING → VERIFIED` (and `CANCELLED`/`EXPIRED`).
- **Entitlement states** (`service.ts:420`): `PRO_VERIFIED`, `PRO_REFUNDED`, revoked/expired via `revokeEntitlement`/`revokeExpiredEntitlement`.

Invariant (explicit in code and docs): **No transition to ACTIVE/VERIFIED is legal without a trusted, server-verified payment source.** This is enforced twice: (1) the matcher ACTIVE decision requires a trusted source + threshold, and (2) `applyDecision` refuses non-PENDING/REVIEW intents and uses an exactly-once conditional UPDATE.

---

## 4. Progressive decision ladder (current behavior with only static links + Gmail)

Because only `gmail` is currently available (no API, no webhook), activation for static-link payments is possible **only through the Gmail rail**, and its decision works on a weighted confidence ladder:

`scoreEvidence` weights (`payments/matcher.ts`): reference **+0.45** (anchor), amount **+0.25**, payer-email **+0.10**, paid-at-in-window **+0.10**, provider payment id **+0.10** (max 1.00).

- `confidence ≥ ACTIVE` (env `PAYMENT_CONFIDENCE_ACTIVE`) → ACTIVE (auto).
- `≥ GRACE` threshold but `< ACTIVE` → REVIEW (needs provider/human confirmation).
- `< GRACE` → stays PENDING.

Because the reference anchor is the dominant signal, an **exact server-issued reference present in an authenticated Razorpay receipt** is what makes no-API auto-activation possible. Without a reference-bearing receipt, confidence cannot cross the ACTIVE threshold from a trusted source → the plan does **not** auto-activate (honest default).

---

## 5. Idempotency & race safety (Objective 10 — already implemented)

- **Same payment → one entitlement:** `payments` / `entitlements` / `payment_intents` unique constraints; entitlement `ON CONFLICT (user_id, plan_id) DO UPDATE`; intent `reference` is UNIQUE.
- **Duplicate callback / duplicate Gmail event → no double activation:** pipeline sha256 replay guard (`payments/pipeline.ts:114-131`) flags and drops replayed evidence; `applyDecision` exactly-once conditional UPDATE loses the race instead of double-activating (`activation.ts:111-123`, rowCount===0 → `race_lost_already_active`).
- **Two simultaneous requests → one final state:** the conditional status UPDATE is the DB race guard; Redis is available but the existing design already guarantees exactly-once via the DB constraint, so no new locking is required.
- **Cross-user safety:** every intent/evidence query is scoped by `owner_id` (tenant check); evidence ingestion binds to `intent.owner_id`.

**Idempotency = PASS (already enforced in code).** No new work needed; any added collector must route through the same pipeline to inherit this.

---

## 6. Refunds under NO-API/NO-WEBHOOK (Objective 11)

- Refund **detection** requires a trusted refund-event source. Under no-API/no-webhook:
  - **AUTO_REFUND_REVOCATION = NOT_AVAILABLE** (no independent refund signal; `payment.refunded` webhook is absent; no API query).
  - The infra is ready but dormant: `payment.refunded` is handled only via the signed-webhook rail (`razorpay_webhook` source), and `refundIntent` (`activation.ts:166`) already implements entitlement→PRO_REFUNDED + plan→free when reached.
- **Honest statement:** with the current static-link + no-API + no-webhook setup, the system **cannot auto-detect a refund**. Anyone claiming otherwise would be weakening trust.

---

## 7. UX (Objective 13 — target flow)

Target (already how the intents flow is shaped):

```
1. User signs in (Web / Desktop / Mobile — same session & entitlement server-side)
2. Choose Pro (₹999) or Team (₹4999)  →  server issues a PaymentIntent
   (unique reference + payment link; plan & amount are SERVER-authoritative)
3. Pay on the (static or per-intent) Razorpay link
4. Trusted verification (Gmail evidence rail today; API/webhook when available)
5. ACTIVE entitlement (24/7, no admin)
```

**Customer action that is currently required for the no-API path:** the user must **copy their unique payment reference (`CCPRO-XXXXXX` / `CCTEAM-XXXXXX`) into the Razorpay payment remarks/description** so an authenticated receipt can be bound to the exact session. This is the one, explicitly-identified customer action (Objective 13). It is lightweight (copy-paste), requires no admin/chat/screenshot/spreadsheet/ticket.

No admin chat, screenshot submission, spreadsheet, manual approval, or support ticket is required anywhere in the flow.

---

## 8. Web + Desktop + Mobile consistency (Objective 16)

- The billing/payment/entitlement state is **entirely server-authoritative** (`payment_intents`, `entitlements`, `users.plan_id`).
- Clients (Web SPA, Electron desktop, mobile companion) call the **same** `/payments/*` APIs and read the **same** entitlement/plan state; **no client ever becomes payment authority**.
- Desktop architecture (per `FINAL_CODECONCLAVE_WEB_DESKTOP_ARCHITECTURE.md`) reuses the same backend; the payment subsystem needs no variant — it is client-agnostic by construction.

---

## 9. Future upgrade compatibility (Objective 15 — no dead end)

The subsystem is explicitly designed to accept the future API/webhook rails without redesign (they are already implemented and dormant, selected by `RAZORPAY_MODE` and credential availability):

- `razorpay_api` rail (`evidence.ts: `razorpayApiSource`) — activates when `RAZORPAY_KEY_ID`+`SECRET` present.
- `razorpay_webhook` rail (`evidence.ts: `razorpayWebhookSource`) — activates when `RAZORPAY_WEBHOOK_SECRET` present.
- Per-intent dynamic Payment Links with unique `reference_id` + `notes.intent_id` (`service.ts:110` `createRazorpayPaymentLinkForIntent`) — when API present, correlation becomes **cryptographically/provider-bound** instead of user-typed.
- Gmail remains a **secondary reconciliation rail** in that design.

Upgrade path = flip flags / add credentials; **no architecture change, no dead end.**

---

## 10. Safe implementation plan (what MAY be done later, none today)

Any future additive change (all `SOURCE_CHANGES = 0` for now) would, in order of safety:

1. Keep the existing module as the single subsystem; never create a parallel one.
2. Any new collector must register in `evidenceSources26H()` and honor the trusted-source gate + sha256 replay guard.
3. Any new auto-activation must go through `applyDecision` (the sole ACTIVE gate) — never a new bypass.
4. Gmail/Apps-Script remain **collector/watchdog only**; backend stays authoritative; Sheets stays an audit mirror.
5. Flag-gate + reversible only; no feature removal (`FEATURES_REMOVED = 0`).

---

## 11. Compliance

**SEPARATE_PAYMENT_SERVICE = READY** — the subsystem exists, is isolated, and is the single authority; no new module was created and none should be.
`SOURCE_CHANGES = 0` · `DATABASE_CHANGES = 0` · `DEPLOYMENT = NOT_EXECUTED` · `REAL_PAYMENT = NOT_PERFORMED` · `FEATURES_REMOVED = 0`.

*Cross-refs: `FINAL_ZERO_ADMIN_PAYMENT_CURRENT_CAPABILITY_GATE.md`, `FINAL_PAYMENT_SECURITY_MODEL.md`, `FINAL_ZERO_ADMIN_PAYMENT_ARCHITECTURE_AUDIT.md`, `FINAL_PRECREATED_LINK_POOL_FEASIBILITY.md`.*

---

## 12. Private Payment Control Center (added 2026-09-01, read-only control plane)

Implemented as a **thin observability layer** over the existing module; **no
second payment subsystem** was created (consultation of §1 map confirmed the
module already covers the dashboard's every data need):

- **`payments/control-center.ts`** — read-only service. Reads the existing
  `payment_intents` LATERAL-joined to the latest `payment_evidence` row and the
  latest `entitlements` state, plus `users.email`. Maps each payment to a
  secret-safe row: intent id, owner id, email, plan, expected vs detected
  amount, payment id / payment-link id / reference id, payment method, payment
  timestamp, evidence source, **correlation status**
  (`CORRELATED | PARTIAL | UNKNOWN`), **verification status**
  (`ACTIVE | REVIEW | PENDING | FAILED | EXPIRED`), entitlement status
  (`ACTIVE | PENDING | NONE`), fraud flags, and a derived `reason`. No token /
  credential / raw evidence payload is ever returned.
- **`payments/control-center-routes.ts`** — **GET-only** router mounted at
  `/api/v1/payments/control-center` behind `requireAuth` +
  `assertControlCenterAccess` (founder `PAYMENT_FOUNDER_EMAIL` **or** RBAC
  `owner`/`admin`):
  - `GET /summary` — TODAY aggregates (total/pro/team, detected, verified,
    active entitlements, pending/rejected/unknown, **verified** revenue in ₹ —
    ACTIVE/GRACE only).
  - `GET /payments` (+`/payments/:id`) — read-only filters
    (plan/status/correlation/verification/source/customer/paymentId/date-range)
    and per-payment verification chain (intent → evidence → correlation →
    verification → entitlement).
  - `GET /stats` — aggregate statistics (by status/plan/source/fraud-flag).
- **No state mutation surface:** there is deliberately **no** activate /
  approve / force-active / grant endpoint. `activation.applyDecision` remains
  the ultimate gate (§3, §5); a dashboard user **cannot** verify, activate, or
  grant anything. Cross-tenant membership is impossible by construction (a
  member/viewer never passes the gate; only the founder or owner/admin sees
  other tenants' payment rows).
- **Country metadata: NOT_REQUIRED.** No `country` column exists in
  `payment_intents` / `entitlements` / `users`; per directive, existing fields
  are preferred and **no schema change was applied** (or prepared — none is
  needed for the dashboard contract).
- **Google Sheets / Apps Script remain unchanged:** Sheets = AUDIT_ONLY mirror
  (never authoritative); Apps Script = COLLECTOR / WATCHDOG / TRANSPORT only.
- **Tests:** `payments/control-center.test.ts` (17) — unauthorized access
  rejected (`founder_only`), non-founder member/viewer rejected, owner/admin
  and founder allowed, founder-gate fails closed when `PAYMENT_FOUNDER_EMAIL`
  unset, no secret fields serialized, uncertain correlation stays non-ACTIVE
  (PENDING/UNKNOWN), trusted ACTIVE shows CORRELATED + ACTIVE, amount/plan
  mismatch surfaced and never ACTIVE, duplicate payment id idempotently
  non-ACTIVE, fake evidence stays PENDING, verification-chain detail safe, and
  the router registers **only GET** handlers (no activate/approve/force/grant).
- **Verification:** backend typecheck + build pass; payment suites
  (123 + 46 tests), security/billing suite (188 tests), and the full backend
  regression (108 files / 1987 passed, 3 skipped) all pass with the control
  center in place. `FEATURES_REMOVED = 0`.

Full gate: `docs/FINAL_PRIVATE_PAYMENT_CONTROL_CENTER_IMPLEMENTATION_GATE.md`.
Also cross-ref `docs/FINAL_PRIVATE_PAYMENT_CONTROL_CENTER_ARCHITECTURE.md`
(design) and `docs/FINAL_PRIVATE_PAYMENT_CONTROL_CENTER_AUDIT.md` (audit that
preceded it).
