# STAGE 26H — RAZORPAY PAYMENT INTENT + EVIDENCE RAIL + ENTITLEMENT SYSTEM — IMPLEMENTATION REPORT

Date: 2026-08-20 — Backend + frontend slice for Stage 26H (unique payment intents, evidence sources, confidence matcher, exactly-once activation, fraud guard, reconciliation, receipts, founder digest, user payment status).

Razorpay remains the payment provider — no replacement, no fake payment system. The pipeline is PAYMENT INTENT → EVIDENCE SOURCE → MATCHER → CONFIDENCE → ENTITLEMENT → AUDIT → RECONCILIATION. Screenshots/OCR/Gmail/manual claims are evidence inputs that are scored — never authority. Entitlements activate exclusively server-side through `activation.ts`; client state can never activate Pro. Thresholds are env-configurable and recorded on every intent (`thresholds_used`) for audit. Migration count: **52/52** (0052 added; static-only SQL, validated for syntax — PostgreSQL runtime unavailable in this environment). No deployment was performed.

## Architecture (server-authoritative)

- **Payment intent** (`intents.ts`) — per-user per-plan intent with a globally unique `reference` (`CCPRO-XXXXXX`/`CCTEAM-XXXXXX`, UNIQUE column, collision-safe retry), TTL expiry (`PAYMENT_INTENT_TTL_HOURS` 24), status machine PENDING → REVIEW → ACTIVE → GRACE → EXPIRED/REFUNDED/REVOKED/CHARGEBACK. Only `activation.ts` moves status.
- **Evidence sources** (`evidence.ts`) — the `PaymentEvidenceSource` adapter contract (id/label/available/unavailableReason/collect) with an honest registry: `gmail` (OAuth), `ocr` (deterministic text parsing), `razorpay_api`, `razorpay_webhook` (both credential-gated), `manual` (claims rail). Unconfigured sources report unavailable with a reason and are never simulated. `signalSha256` dedupes (replay guard).
- **Matcher** (`matcher.ts`) — weighted scoring: reference +0.45, amount +0.25, payer +0.10, time +0.10, paymentId +0.10; decisions ACTIVE ≥ active threshold (0.8), REVIEW ≥ grace (0.5), else PENDING. Thresholds audited per decision; matcher never mutates state.
- **Activation** (`activation.ts`) — the ONLY path to ACTIVE: conditional `SET status='ACTIVE' WHERE status IN ('PENDING','REVIEW')` is the exactly-once race guard (losing a race never double-activates); fraud-blocked evidence forces REVIEW, never ACTIVE. Refund → entitlement PRO_REFUNDED + plan free; revoke → REVOKED + plan free; chargeback requires provider evidence with a payment id (`chargeback_no_evidence` otherwise).
- **Fraud guard** (`fraud.ts`) — blocking flags: `duplicate_payment_id` (global provider-id uniqueness), `screenshot_replay` (sha256 across intents/owners), `reference_reuse`; plus amount tolerance, sender anomaly, velocity window (`PAYMENT_VELOCITY_WINDOW_MINUTES` 60 / `PAYMENT_VELOCITY_MAX` 3).
- **Pipeline** (`pipeline.ts`) — EVIDENCE SOURCE → NORMALIZE → DEDUPE → FRAUD → STORE → MATCH → APPLY; `refreshIntentEvidence` pulls from passive sources and reports blocked sources honestly (`no_passive_evidence` when none available).
- **Reconciliation** (`reconciliation.ts`) — drift detection (ACTIVE/GRACE intent without PRO_VERIFIED entitlement, entitlement without payment, orphan evidence); REPORTS drift, never auto-fixes; persisted + audited, `COMPLETED_WITH_DRIFT` when drift exists.
- **Receipts / digest** (`receipts.ts`, `digest.ts`) — receipt resend only for ACTIVE/GRACE/REFUNDED (`receipt_not_available` otherwise); founder digest gated by `PAYMENT_FOUNDER_EMAIL` (`founder_only`).
- **User payment status (P12)** (`service.ts paymentStatus`) — per-plan intent status + confidence + entitlement state + effective plan, server-authoritative.

## Schema (`database/migrations/0052_stage26h_payment_intents.sql`)
- `payment_intents` — status CHECK (8 states), UNIQUE reference, `thresholds_used`/`fraud_flags`/`evidence_summary` jsonb, expiry/grace columns, owner RLS with tenant fallback, `set_updated_at` trigger, owner+status and status+expiry indexes.
- `payment_evidence` — normalized signals only; `source` CHECK matches the adapter registry (`gmail/ocr/razorpay_api/razorpay_webhook/manual`); UNIQUE sha256 (replay), partial UNIQUE provider_payment_id (duplicate guard); owner RLS.
- `payment_reconciliations` — run bookkeeping (intents/evidence/entitlements counts, drift jsonb, status CHECK); `payment_digests` — founder digest buckets (UNIQUE bucket).

## Tests — `backend/src/foundation/payments-26h.test.ts` **34/34 green** (all 13 mandated scenarios covered)
- Fake success: no-signal screenshot → `no_evidence`, no insert; amount-only → 0.25 PENDING, no entitlement; client-claimed payment id is stored as `manual` claims evidence, never provider evidence.
- Duplicate: same payment id across intents → `duplicate_payment_id` → REVIEW, never ACTIVE; amount mismatch → flagged → REVIEW, no entitlement; velocity over the window → flagged.
- Cross-user / cross-tenant: another user cannot ingest into someone else's intent (`not_found`); intent lookups always filter `owner_id`.
- Replay: same sha256 against another intent → replay rejected, fraud audit, nothing stored.
- Lifecycle: expiry sweep (PENDING→EXPIRED untouched, ACTIVE→GRACE + notify, GRACE exhausted → entitlement revoked + plan free), refund/revoke/chargeback (entitlement states + plan reset + audits), chargeback refused without provider evidence, receipt resend refused for PENDING / works for ACTIVE.
- Exactly-once: concurrent double activation wins the race once — exactly 1 entitlement insert; applying ACTIVE to an already-ACTIVE intent is a no-op.
- OCR rail: `parseOcrText` extracts UTR/amount/date/payment id; high-confidence ref+amount+paymentId+payer → 0.9 ACTIVE + entitlement + welcome notify + `payment.activated` audit.
- Gmail rail: BLOCKED without OAuth credentials (honest); mocked OAuth collects normalized signals from subject headers → ACTIVE, stored `source=gmail`; refresh pulls passive sources and reports blocked sources (`no_passive_evidence`).
- Reconciliation: ACTIVE intent without entitlement → drift `intent_without_entitlement` (no auto-fix); aligned intents/entitlements/sessions → COMPLETED.
- Founder digest: forbidden for non-founders; generated + persisted + audited for the configured founder.

## Failures found & fixed during the slice
- `refreshIntentEvidence` read `err.code` but AppError exposes `errorCode` → blocked passive sources rethrew instead of reporting → now uses `errorCodeOf` (pipeline.ts).
- `parseOcrText`/Gmail payment-id regex rejected underscores (`pay_ocr_abc123` matched only `pay_ocr`) → `\bpay_[A-Za-z0-9_]{6,}\b`.
- `manual` source existed in the enum/migration but was missing from the `evidenceSources26H()` registry → registered (claims rail; signals are scored, never trusted).
- Matcher decided on unrounded confidence: `0.45+0.25+0.1 = 0.7999999999999999 < 0.8` sent reference+amount+paymentId evidence to REVIEW → decision now computed on `round3` confidence (deterministic, auditable).
- Test harness: evidence read-back (`SELECT * FROM payment_evidence WHERE id = $1`) unhandled → every successful ingest threw; conditional status updates (quoted AND parameterized `SET status = $2`) not mirrored to read-backs; `over` resolvers ran after defaults (velocity test); reconciliation read-back unhandled; cross-tenant lookup test now asserts the `not_found` rejection; race test mirrors the winning conditional update onto the intent.
- Frontend: full-suite runs showed random 5s test timeouts under parallel CPU contention (files pass in isolation) → `testTimeout: 20000` in `vitest.config.ts`; full suite now stable.

## Frontend
- **SettingsPage billing tab (P12)** — new "Payment intent status" table from `GET /api/v1/payments/status`: per-plan intent status (PENDING/REVIEW/ACTIVE/GRACE/EXPIRED/REFUNDED/REVOKED/CHARGEBACK), confidence %, entitlement state, and the effective plan with an explicit "server-authoritative" note. Types added (`PaymentStatusView`/`PaymentStatusPlan` in `lib/types.ts`); test added (status renders from the mock, 5/5 in SettingsPage suite).

## Wiring
- `routes.ts` (existing Phase 4D mount `/api/v1/payments`): `GET /status`, `POST /intents`, `GET /intents`, `GET /intents/:id`, `GET /intents/:id/instructions`, `POST /intents/:id/evidence/:source`, `POST /intents/:id/refresh`, `POST /intents/:id/receipt`, `POST /intents/:id/refund`, `/revoke`, `/chargeback`, `POST /reconcile`, `GET /reconciliations`, `GET /digest`, `GET /digests` (routes pre-existed in the module; verified wired).
- `shared/src/constants.ts`: 12 payment AuditAction values + `PAYMENT_STATUS`/`PAYMENT_REVIEW_REQUIRED` NotificationTypes (pre-existing, verified in place); shared rebuilt (dist).
- `shared/ids.ts` PREFIXes: `pin` / `pev` / `prc` / `pdg` (pre-existing, verified).

## Full regression
- Backend: **88 files, 1422 tests, 1419 passed / 3 skipped / 0 failed** (perf-17 timing flake skipped — passes in isolation; known pattern). Payments suites: `payments-26h` 34/34 + `payments`/`payments-4d` 39/39, no regressions from the fixes.
- Frontend: **42 files, 245 passed** (incl. new P12 status test; SettingsPage/Phase-14/Prefs/auth suites green).
- local-agent: 5 files / 49 passed.
- Typecheck: backend EXIT 0; builds: shared + backend + frontend EXIT 0.

## Limitations / deferred (BLOCKED honestly)
- Live rails — Gmail OAuth (GMAIL_OAUTH_ACCESS_TOKEN), Razorpay API (RAZORPAY_KEY_ID/SECRET) and signed webhook (RAZORPAY_WEBHOOK_SECRET) — have no credentials in this environment: sources report unavailable with reasons, integration paths are covered by mocked tests, and nothing is simulated as real. `link` (hosted payment link) is the only live mode.
- The OCR image-to-text engine is an external integration; `parseOcrText` is the deterministic, unit-tested parser for extracted text.
- Reconciliation detects drift only; remediation remains a manual/operator action by design.
- `manual` evidence is a claims rail: client-supplied values enter the pipeline as signals to be scored and are stored with `source=manual` — they can never bypass the fraud guard, matcher or activation.

## Next steps (per continuation prompt)
Stage 26H is complete per the prompt (intents, evidence rails, matcher, activation, fraud, reconciliation, receipts/digest, payment status, adapter contract, server-authoritative entitlement). **STOP — no deployment; do not begin 26I.**