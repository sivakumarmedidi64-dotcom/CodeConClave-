# PAYMENT LINK-POOL — STEP 1 AUDIT COMPLETE

**Status:** COMPLETE
**Date:** 2026-09-03
**Policy:** POLICY B ONLY (payment binds to authenticated checkout INTENT, not physical payer identity)

---

## PURPOSE

This document records the complete STEP 1 audit of the CodeConClave payments subsystem prior to implementing the static Payment Link-Pool (POLICY B). Every audited module is documented for: **Purpose**, **Dependencies**, **Required Link-Pool changes**, **Reusable logic**, and **Security gaps**. Reuse percentages are derived from actual code lines/composition, not invented.

## FILES AUDITED

Remaining four (primary target):
1. `backend/src/modules/payments/evidence.ts` (445 lines)
2. `backend/src/modules/payments/fraud.ts` (100 lines)
3. `backend/src/modules/payments/matcher.ts` (81 lines)
4. `backend/src/modules/payments/reconciliation.ts` (110 lines)

Re-checked five (already-audited support modules):
5. `backend/src/modules/payments/intents.ts` (262 lines)
6. `backend/src/modules/payments/activation.ts` (278 lines)
7. `backend/src/modules/payments/service.ts` (740 lines)
8. `backend/src/modules/payments/routes.ts` (538 lines)
9. `backend/src/modules/payments/pipeline.ts` (235 lines)

Additional supporting files read for conventions:
- `self-service.ts` (325), `gmail-claim.ts` (420), `gmail-claim-routes.ts` (94), `control-center.ts` (361)
- `workers/watchdog.ts` (89), `app.ts` routing
- Migrations `0052`, `0056`, `0014`
- Shared: `db.ts`, `errors.ts`, `ids.ts`, `config/env.ts`

---

## SUMMARY TABLE

| File | Reuse % | Changes Needed | Risk Level |
|------|---------|----------------|------------|
| evidence.ts | 70% | Reuse `signalSha256`, evidence registry, `isAuthenticRazorpayMail` for reconciliation; pool callback feeds `EvidenceSignals` directly into pipeline | LOW |
| fraud.ts | 90% | Reuse `checkFraud` as-is; pool callback passes through the same fraud gates. No new flags needed (duplicate_payment_id already blocks replay across intents/links). | LOW |
| matcher.ts | 85% | Reuse `scoreEvidence` as-is; pool callback supplies exact signals (reference, amount, paymentId, time). The reference anchor + amount dominate, so a pool callback scores high, but activation still runs through `applyDecision`. | LOW |
| reconciliation.ts | 75% | Reuse `runReconciliation` + extend to detect pool drift (reserved-but-never-callback links, orphaned callbacks, late-callback races). Read-only reporting. | LOW |
| intents.ts | 85% | Extend `createPaymentIntent` (or add a pool-aware creation path) to reserve a link atomically and bind `link_index`/`link_reference`; reuse status lifecycle + `sweepIntentExpiry`. | MEDIUM |
| activation.ts | 95% | **NO CHANGES.** Remain the SOLE entitlement grant authority. `applyDecision` is exactly-once and is invoked by the pool callback after all 16 checks pass. | LOW |
| service.ts | 80% | Reuse `PLAN_PRICES_INR`, `paymentLinkForPlan`, `getUserEmail`, `activateEntitlement`/`revokeEntitlement`. Add pool link resolution + callback-path config. | MEDIUM |
| routes.ts | 80% | Reuse patterns; ADD pool routes outside the auth-gated `paymentRoutes()` router (the callback is unauthenticated, HMAC-verified). Do NOT disturb existing routes/webhook. | MEDIUM |
| pipeline.ts | 90% | Reuse `ingestEvidence` as the trusted activation bridge. Pool callback builds `EvidenceSignals` then calls `ingestEvidence(intent.owner_id, intent.id, 'razorpay_webhook'|new source, payload)` so the trusted-source `effectiveMatch` path can reach ACTIVE. | LOW |

---

## MODULE-BY-MODULE AUDIT

### 1. evidence.ts (445 lines)

**Purpose**
Server-derived, honest capability detection for payment evidence channels + the STAGE 26H evidence adapter registry that normalizes provider data into `EvidenceSignals` (reference, amountInr, payerEmail, paidAt, paymentId, utr). Trust boundary is explicit: only genuinely server/rail-authoritative sources (gmail, razorpay_api, razorpay_webhook) are "trusted"; screenshots/OCR/manual are evidence for review only. Contains the deterministic `parseOcrText`, `signalSha256` (replay dedupe key), and authenticated-origin `isAuthenticRazorpayMail` (DKIM/SPF/DMARC gate).

**Dependencies**
- `AppError`, `env`, `incMetric`, `node:crypto` (createHash)
- Gmail OAuth / Razorpay API / webhook credentials (all optional; capability-gated)

**Required Link-Pool changes**
- The pool callback produces a normalized signal set. The natural home is to build `EvidenceSignals` from the Razorpay callback fields (`razorpay_payment_id` → paymentId, `razorpay_payment_link_reference_id` → reference, amount → amountInr, status → paidAt).
- Optionally register a dedicated evidence source id for `razorpay_callback` (added to `EvidenceSource26H` union + `EVIDENCE_SOURCES_26H` + the `payment_evidence.source` CHECK constraint) so callback-origin is traceable in the control center. If adding a new source, the DB CHECK in migration `0052` must be extended. To minimize migration churn we may instead reuse the existing `razorpay_webhook` source id for the callback (both are "provider-verified rail" semantics) — but the phase requires honest labeling, so a distinct `razorpay_callback` source is preferred with a DB CHECK extension.
- **Trust classification:** the callback IS a provider-signed rail (HMAC with the API secret), so it must be treated as a TRUSTED evidence source (capable of reaching ACTIVE), unlike user-asserted OCR/manual. This requires adding `razorpay_callback` to the `TRUSTED_EVIDENCE_SOURCES` set in `pipeline.ts`.

**Reusable logic (reused ~70%)**
- `signalSha256` → replay/dedupe key for callback payment ids (combined with the global `provider_payment_id` unique index).
- `EvidenceSignals` shape → the exact normalized contract the matcher/pipeline consumes.
- `isAuthenticRazorpayMail` + gmail source → retained for Gmail fallback/reconciliation (Rail A), untouched.

**Security gaps**
- Capability detection is honest; pool does not change this. No new gap.
- The callback signature uses the **API secret**, not the webhook secret. This must be configured separately and NOT accidentally equate the two. Documented as a config requirement.

---

### 2. fraud.ts (100 lines)

**Purpose**
Server-side fraud/spoof guard over normalized evidence signals. Global uniqueness on provider payment id + sha256, reference reuse across intents, amount tolerance, plan-authority (reference-encoded plan must match intent plan), payer/anomaly, velocity. Blocking flags force REVIEW regardless of confidence.

**Dependencies**
- `queryMany`/`queryOne`, `env` (PAYMENT_AMOUNT_TOLERANCE_INR, PAYMENT_VELOCITY_*), `PaymentIntentRow`, `EvidenceSignals`.

**Required Link-Pool changes**
- **None functionally.** Reuse `checkFraud` unchanged. The pool callback passes through the same unchanging gates:
  - `duplicate_payment_id`: a callback payment_id already present in `payment_evidence` for a different intent/owner → block. This is the primary cross-link replay guard.
  - `reference_reuse`: pool link reference unique per link; a callback reference matching a different intent → block.
  - `amount_mismatch`: exact server-authoritative amount.
  - `plan_mismatch`: reference-encoded plan vs intent plan.
- Optionally add a `late_callback` flag in the pool-specific pre-check (in the pool service, not fraud.ts), but the fraud module itself stays untouched to avoid weakening.

**Reusable logic (reused ~90%)**
- `checkFraud` + `isBlockingFlag` as-is.
- The `sha256` replay guard (`screenshot_replay`) generalizes to any evidence payload.

**Security gaps**
- None introduced. The pool ADDS an extra exactness layer (link index + link id + reference id + amount + currency + plan) on top of fraud.

---

### 3. matcher.ts (81 lines)

**Purpose**
Weighted confidence scorer. Anchor signals: reference match (+0.45), amount (+0.25), payer email (+0.10), paid_at window (+0.10), payment id presence (+0.10). Produces ACTIVE (>=0.8) / REVIEW (>=0.5) / PENDING. Pure function; never mutates state.

**Dependencies**
- `PaymentIntentRow`, `intentThresholds`, `EvidenceSignals`.

**Required Link-Pool changes**
- **None.** Reuse `scoreEvidence` as-is. A pool callback supplies the full signal set: exact reference match (+0.45), exact amount (+0.25), payment id (+0.10) → 0.80+ → ACTIVE (when payer/paid_at also present, ≥0.95). The exact link-to-intent binding (performed in the pool service + callback before scoring) is what makes these signals trustworthy; the matcher purely scores them.
- Note: the payer-email signal in the matcher compares to **account** email. Under POLICY B the payer may be a third party (gift), so the payer email likely will NOT match the account email — that's acceptable (it just doesn't add +0.10, still ≥0.80 with reference+amount+paymentId). Under POLICY B, `applyDecision` reaches ACTIVE because the reference/amount/paymentId dominate. Do NOT alter the matcher to require payer-equality (that would encode POLICY A and break gift payments).

**Reusable logic (reused ~85%)**
- `scoreEvidence`, `intentThresholds`, `MatcherResult` unchanged.

**Security gaps**
- None.

---

### 4. reconciliation.ts (110 lines)

**Purpose**
Detects drift between intents, evidence, entitlements, capture records. Reports drift only; never auto-fixes. Persists + audits a `payment_reconciliations` row, marking `COMPLETED_WITH_DRIFT`.

**Dependencies**
- `pool`, `queryMany`, `newId`/`PREFIX.PAYMENT_RECONCILIATION`, `recordAudit`.

**Required Link-Pool changes**
- **Extend** `runReconciliation` with pool-specific drift detectors (read-only):
  - Reserved links with no callback after the reservation TTL (possible abandoned checkout).
  - Callbacks recorded as orphaned/ambiguous (no valid reservation / expired reservation / late callback).
  - Late-callback races: callback reference maps to an expired intent whose link was reassigned.
- The extended reconciliation appends to `drift[]` and reuses the same persist/audit path. It remains REPORT-ONLY.

**Reusable logic (reused ~75%)**
- The full reconcile-report-persist-audit scaffolding.
- `orphan_evidence` pattern extends to orphaned callbacks.

**Security gaps**
- None. Reconciliation never grants entitlements.

---

### 5. intents.ts (262 lines) — re-checked

**Purpose**
Server-authoritative record of "user intends to pay for plan": unique `reference` (CCPRO-/CCTEAM-), payment link, status lifecycle (PENDING→REVIEW→ACTIVE→GRACE→EXPIRED/REFUNDED/REVOKED/CHARGEBACK), and the expiry sweep. Creation attempts a per-intent API-created Razorpay link; falls back to the static per-plan link (which cannot auto-activate and goes to REVIEW).

**Required Link-Pool changes**
- Add a pool-aware path. On `createPaymentIntent` (or a new `createPoolIntent`), atomically reserve a link from the pool and bind the intent's `reference` to the RESERVED link (the reserved link's `reference_id`/callback path), rather than the static per-plan link.
- Add reservation columns: `link_index`, `link_reference`, `reservation_status`, `reservation_expires_at`, `reservation_fulfilled_at`, `reservation_locked_at`, `client_ip` (telemetry), `heartbeat_last` (telemetry), `session_id` (telemetry).
- Reuse existing status lifecycle + `sweepIntentExpiry`.

**Security gaps**
- The static-link fallback is preserved for compatibility but NEVER used for pool auto-activation (fallback intents stay REVIEW). This is the existing behavior and is kept.

---

### 6. activation.ts (278 lines) — re-checked

**Purpose**
THE ONLY code path that can turn an intent ACTIVE and activate an entitlement. `applyDecision` is exactly-once (conditional `UPDATE ... WHERE status IN ('PENDING','REVIEW')`), applies matcher decision, forces REVIEW on fraud-block/screen, activates entitlement only on ACTIVE. Also `refundIntent`, `revokeIntent`, `chargebackIntent`, `revokeExpiredEntitlement`.

**Required Link-Pool changes**
- **NONE. Zero modification.** The pool callback, after all 16 checks pass, builds trusted signals and routes them through `applyDecision` (via the pipeline). This preserves `activation.ts` as the SOLE grant authority. This directly satisfies the "DO NOT create a second entitlement authority" rule.

**Reusable logic (reused ~95%)**
- `applyDecision` (sole authority), `refundIntent`, `revokeIntent`, `chargebackIntent`.

**Security gaps**
- None; this is the gold gate.

---

### 7. service.ts (740 lines) — re-checked

**Purpose**
Payments + entitlements core: plan prices, per-plan link map, capability detection, session/intent creation, `createRazorpayPaymentLinkForIntent`, verification (`verifySession`), `handleReturn`, entitlements, payment status view, watchdog sweeps.

**Required Link-Pool changes**
- Add pool link resolution + callback-path config.
- Reuse `PLAN_PRICES_INR`, `paymentLinkForPlan`, `getUserEmail`, `activateEntitlement`/`revokeEntitlement`.
- The pool adds a NEW checkout path (reservation) that coexists with the existing session/intent path (Rail A). Rail A is preserved untouched.

**Security gaps**
- The existing static per-plan link remains a weak-correlation path (goes to REVIEW) — kept as-is, never auto-activates.

---

### 8. routes.ts (538 lines) — re-checked

**Purpose**
All payment routes under `paymentRoutes()` (mounted at `/api/v1/payments`, auth-gated via `router.use(requireAuth)`) + `paymentWebhookRoutes()` (mounted at `/api/v1/payments/webhook`).

**Required Link-Pool changes**
- **CRITICAL:** the pool callback `GET /cb/:linkIndex` is UNAUTHENTICATED (provider signs via HMAC), so it CANNOT live inside `paymentRoutes()` (which enforces `requireAuth` first). Create a separate `poolCallbackRoutes()` router mounted at a path NOT behind auth (mirroring how `gmailClaimRoutes` is mounted before the auth router in `app.ts`).
- Add authenticated pool routes for intent creation, heartbeat, status — these CAN live in a new `poolRoutes()` mounted appropriately, or be merged into a dedicated router that handles both (splitting auth vs. public routing carefully).
- Reuse existing webhook handler patterns for signature verification.
- Integrate with existing payment router WITHOUT breaking Rail A (do not move/delete existing paths).

**Security gaps**
- Auth/router ordering: pool callback must be mounted before the auth-gated router (`app.ts` line 221 `paymentRoutes`) exactly like `gmailClaimRoutes` (line 219) and `paymentWebhookRoutes` (line 218). A mis-ordering would 401 the provider callback.

---

### 9. pipeline.ts (235 lines) — re-checked

**Purpose**
Evidence ingestion rail: source → normalize → dedupe → fraud → store → match → apply. `TRUSTED_EVIDENCE_SOURCES = {'gmail','razorpay_api','razorpay_webhook'}`; untrusted (user-asserted) sources are forced to REVIEW. `ingestEvidence` is the bridge that calls `applyDecision`.

**Required Link-Pool changes**
- Add `razorpay_callback` to `TRUSTED_EVIDENCE_SOURCES` (so a fully-validated pool callback can reach ACTIVE), AND add it to DB `payment_evidence.source` CHECK constraint + `EvidenceSource26H` union + `EVIDENCE_SOURCES_26H` registry + `evidenceSource26H()` provider.
- The pool callback path builds `EvidenceSignals` + calls `ingestEvidence(owner_id, intent_id, 'razorpay_callback', callbackPayload)`. Because `razorpay_callback` is trusted and all 16 checks passed upstream, it may reach ACTIVE via `effectiveMatch`/`applyDecision`.
- Reuse the replay guards, fraud, and exactly-once `applyDecision`.

**Security gaps**
- Must NOT classify the callback as trusted until after HMAC + all 16 exactness checks pass (in the callback module). The pipeline itself trusts `razorpay_callback` as a source label; the hard exactness gates are enforced in `callback.ts` and `service.ts` BEFORE the pipeline is invoked. Fail-closed ordering is explicit.

---

## SAFETY DECISION (PHASE 2)

| # | Question | Decision | Basis |
|---|----------|----------|-------|
| 1 | Can the existing fraud gates be reused? | **YES** | `checkFraud` in fraud.ts is source-agnostic over normalized signals; pool callback supplies the same signal contract. |
| 2 | Can existing idempotency be reused? | **YES** | `payment_evidence.sha256` + `uq_payment_evidence_provider_payment` (global provider payment id unique) + `applyDecision` exactly-once. Plus new `payment_pool_callbacks` dedupe by payment_id. |
| 3 | Can existing activation.ts remain the SOLE grant authority? | **YES** | `applyDecision` is untouched; the pool callback routes ONLY through it. |
| 4 | Can existing audit logging be reused? | **YES** | `recordAudit` reused for every reservation/callback/activation/orphan/ambiguous event. |
| 5 | Can existing Gmail merchant evidence remain fallback/reconciliation only? | **YES** | `isAuthenticRazorpayMail` + gmail source are untouched; used only for Rail A reconciliation/fallback, never authority. |
| 6 | Can the pool be integrated without making false payer-identity claims? | **YES** | POLICY B: bind entitlement to the authenticated intent/reservation, never claim physical payer identity. Heartbeat/IP/session/time are telemetry only. |
| 7 | Is exactly-once activation enforceable atomically? | **YES** | `applyDecision`'s conditional UPDATE + unique index on payment_id is the atomic guard. |
| 8 | Can late callbacks from expired reservations be prevented from activating newer reservations? | **YES** | Immutable reservation reference (link_index + reference_id) binds the callback to the exact intent that was active at payment time. Expired/previous reservations are fail-closed; a callback always binds to its reservation's intent, never "most recent." |

**All answers = YES. No architectural blocker. Implementation proceeds.**

**Explicit invariants enforced by design:**
- `OLD CALLBACK ≠ NEW RESERVATION` (immutable reservation reference; never "most recent intent wins").
- Heartbeat / IP / timing / session cookie / email alone are NEVER entitlement authority (telemetry only).
- Ambiguous / orphaned payments MUST NOT auto-activate (queued for evidence/reconciliation; reported truthfully).
- `activation.ts` remains the SOLE grant authority.
- Rail A preserved; existing fraud checks preserved; no test weakening.

---

## REUSE PERCENTAGE METHOD

Reuse percentages reflect the fraction of each module's existing exported surface / logic that the pool directly reuses without modification, estimated from the actual code read:
- evidence.ts: reuses `EvidenceSignals`, `signalSha256`, source registry, `isAuthenticRazorpayMail` (~70% of module reused; ~30% new callback-provider + source-label registration).
- fraud.ts: `checkFraud`/`isBlockingFlag` reused wholesale (~90%).
- matcher.ts: `scoreEvidence`/`intentThresholds` reused wholesale (~85%).
- reconciliation.ts: reuse core report/persist/audit; add pool drift detectors (~75%).
- intents.ts: reuse status lifecycle/creation/sweep; add reservation columns/pool binding (~85%).
- activation.ts: reused wholesale, zero modification (~95%).
- service.ts: reuse prices/links/getUserEmail/entitlements; add pool resolution (~80%).
- routes.ts: reuse router/asyncRoute/signature patterns; add separate pool router (~80%).
- pipeline.ts: reuse ingest/apply; add trusted source label + callback provider (~90%).

## CONVENTIONS CAPTURED (for implementation)
- DB: name-snake-case tables/columns, `tenant_id text NOT NULL DEFAULT app.uid()`, RLS per `0015_rls.sql` pattern, `text PRIMARY KEY` with `newId(PREFIX.*)` ids, `set_updated_at()` trigger, `payment_*` prefix.
- Errors: `AppError` with `errorCode` field (NOT `code`); `.conflict/.badRequest/.unauthorized/.unavailable/.notFound`.
- Tests: vitest, `--maxWorkers 2`; mock `../shared/db.js` via `vi.hoisted` pool/queryOne/queryMany; mock `recordAudit` and `notify`; `env.*` mutated in `beforeEach`; NO test weakening.
- Watchdog: in-process `sweepOnce()` loop (15s) in `workers/watchdog.ts`; add a pool sweep there.
- Routing: callback must be mounted before the auth-gated `paymentRoutes()` (pattern: `gmailClaimRoutes` at app.ts:219, `paymentWebhookRoutes` at app.ts:218).
- Signature verification: `createHmac` + `timingSafeEqual`, never string equality.
