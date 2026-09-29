# FINAL PAYMENT SECURITY REMEDIATION

## Scope
Final remediation of the payment defects found in the pre-deploy audit for CodeConClave V4. Changes are confined to the **backend payments module** and its regression tests. No deployment, no real payment, no secret exposure (all secret values referenced as placeholders only).

## 1. Server-Authoritative Payment Links (Pro / Team)

### Changed files
- `backend/src/config/env.ts` — added `RAZORPAY_TEAM_PAYMENT_LINK` (default `https://rzp.io/rzp/3ioXlCxd`). `RAZORPAY_PRO_PAYMENT_LINK` (default `https://rzp.io/rzp/sAgHIpxS`) preserved.
- `backend/src/modules/payments/service.ts` —
  - `PLAN_PRICES_INR = { pro: 999, team: 4999 }` (already present).
  - New `PLAN_PAYMENT_LINK_INR` = `{ pro: <PRO link>, team: <TEAM link> }`.
  - New `paymentLinkForPlan(planId)` — resolves the authoritative link per plan; throws `AppError.badRequest('invalid_plan')` for any unknown plan.
- `backend/src/modules/payments/intents.ts` — `createPaymentIntent` now stores `paymentLinkForPlan(planId)` instead of the hard-coded Pro link.

### Rules
- Pro intent/session → Pro ₹999 link.
- Team intent/session → Team ₹4999 link.
- **No cross-plan fallback**: a session/intent for one plan never receives the other plan's link.
- Unknown plan → rejected (`invalid_plan`), safe-fails.

### Payment links (public, unchanged)
- PRO = `https://rzp.io/rzp/sAgHIpxS` (₹999 / 99900 paise)
- TEAM = `https://rzp.io/rzp/3ioXlCxd` (₹4999 / 499900 paise)

## 2. Amount / Plan Authority (verifySession)

`backend/src/modules/payments/service.ts`:
- New `evidenceAmountInr(raw)` helper extracts the claimed amount (INR) from Razorpay webhook/API evidence shapes (amount in paise). Returns `null` when absent so a plain "payment link paid" event without an amount is not falsely rejected.
- New **amount-mismatch rejection** in `verifySession`, placed before any `VERIFIED` transition: if the provider evidence carries an amount that does not equal the server-authoritative amount for the session's plan, it:
  - records a `payment_events` row (`payment.rejected`, reason `amount_mismatch`),
  - writes a `payment.amount_mismatch` audit entry,
  - throws `AppError.conflict('amount_mismatch', ...)`.
  - The session is **never** set to VERIFIED and no entitlement is granted.
- `verifyWithProvider` retains `if (env.RAZORPAY_MODE !== 'api') return false;` — API-mode verification only with credentials; otherwise returns false (client can never call `verifySession` directly; see §6).

## 3. Manual Evidence Security (26H intent pipeline)

`backend/src/modules/payments/pipeline.ts`:
- New trust boundary `TRUSTED_EVIDENCE_SOURCES = { 'gmail', 'razorpay_api', 'razorpay_webhook' }`.
- New `isTrustedEvidenceSource(sourceId)`.
- New `effectiveMatch(match, sourceId, fraud)` forces **untrusted user-asserted** sources (`manual`, `ocr`) to decision `REVIEW` and adds the flag `manual_assertion_cannot_activate`, regardless of confidence score. Applied in `ingestEvidence` before `applyDecision`, so a fabricated manual assertion can **never** reach `ACTIVE`/entitlement.
- `backend/src/modules/payments/fraud.ts`:
  - `BLOCKING_FLAGS` now includes `amount_mismatch` and `plan_mismatch`.
  - New `plan_mismatch` detection: a referenced plan encoded in evidence (reference prefix `CCPRO-`/`CCTEAM-`) must match the intent's `plan_id`; a mismatch is flagged.

## 4. Regression Tests

`backend/src/foundation/payments-26h.test.ts` (updated + new; **52 tests PASS**), plus the full payment suite across `payments.test.ts`, `payments-4d.test.ts`, `payments-26h.test.ts` (**91 tests PASS**). New/updated scenarios cover the 19 required security cases:

- Pro ₹999 link, Team ₹4999 link, no Team→Pro fallback, unknown plan rejected.
- Server-authoritative per-plan link/amount in `createPaymentSession` and `createPaymentIntent`; client cannot override amount/plan.
- Fabricated manual paymentId / reference / amount / fully-consistent assertion **cannot** create entitlement (forced REVIEW).
- Manual/OCR evidence alone can **never** become VERIFIED; trusted (gmail/razorpay_api/razorpay_webhook) evidence can.
- Duplicate/replay / entitlement-authority / refund / expiry / audit / tenant-isolation integrity intact.
- `verifySession` rejects amount mismatch (no VERIFIED, no entitlement); matching amount reaches VERIFIED.
- `isTrustedEvidenceSource` table checks.

## 5. Full Regression Results

| Workspace | Result |
|---|---|
| Backend (full `vitest run`, 97 files) | **1745 passed / 3 skipped / 2 failed (timing only)** |
| └ Payment suite (payments/4d/26h) | **91 passed** |
| Shared | 63 passed |
| Local-agent | 49 passed |
| Frontend | 279 passed (rerun 0 errors) |
| Build (shared + backend + local-agent) | PASS |
| typecheck (backend) | PASS |

The 2 backend failures are **pre-existing timing/environment issues, not regressions**:
- `perf-17` — the **documented-flaky** execution-timing test (measured 2838ms > 2000ms target).
- `integration-17` «PHASE 17 integration — memory + DNA» — a long-running memory/DNA test exceeding its 15s timeout (~16.4s) even in isolation; unrelated to payments (file unmodified).
- Frontend first full run reported one unhandled error from a `Toast.tsx` 5s auto-dismiss timer firing after environment teardown (a load-dependent flake); rerun was clean (0 errors). Unrelated to payments (frontend file unmodified).

## 6. Entitlement Authority / Auto-Verification Capability

- Session mode (`verifySession`): entitlement only after `verifyWithProvider` (Razorpay **API mode** with credentials) **or** a signed Razorpay **webhook** — a trusted rail. `verifyWithProvider` returns false unless `RAZORPAY_MODE === 'api'`; a client cannot call `verifySession` directly.
- Intent mode (`ingestEvidence`, Pipeline 26H): ACTIVE/entitlement only from **trusted sources** (`gmail`, `razorpay_api`, `razorpay_webhook`). Untrusted (`manual`/`ocr`) evidence is forced to REVIEW and can never activate.
- **AUTO_ENTITLEMENT: LIMITATION (in current deployment shape).** With `RAZORPAY_MODE` in payment-link/checkout mode and no trusted rail (no Gmail OAuth, no Razorpay API token) configured, no provider rail can independently establish payment. Therefore fully automatic verified entitlement is **not** achievable in pure payment-link mode without enabling a trusted rail (Gmail API, Razorpay API, or the Razorpay webhook signed with `RAZORPAY_WEBHOOK_SECRET`). This is reported honestly rather than overclaiming.

## 7. Remaining Limitations / Notes
- No real Gmail OAuth or Razorpay API credentials available to exercise the trusted-rail happy path end-to-end in this environment; trusted-rail behavior is validated by unit tests with mocked provider fetches.
- Automatic entitlement requires enabling a trusted rail (Razorpay API / webhook / Gmail) — not enabled here; human/admin review remains the safe path for link-mode payments until then.
- `backend/vitest.config.ts` secrets are scrubbed to placeholders (test-only config) — intentional and security-related, not application source.

## 8. Deployment Status
**DEPLOYMENT = BLOCKED.** Deployment remains gated pending explicit user authorization. No deployment was performed; no real payment was made; no secrets were exposed.
