# PHASE 4D — Razorpay Payment + Entitlements Hardening (Report)

## Status
COMPLETE. The server-authoritative payment state machine, capability-detected
evidence providers, idempotent exactly-one entitlement activation, revocation,
tenant isolation, approval-gated admin payment actions, honest frontend UX,
and the Phase 4D test suite are implemented and validated. Nothing is claimed
as production-ready; see PostgreSQL runtime + External blockers.

## Files created
- `database/migrations/0026_phase4d_payments_hardening.sql` — static-only hardening migration (see Database migrations).
- `backend/src/modules/payments/evidence.ts` — evidence provider capability detection (`evidenceProviders()`), server-side provider evidence validation (`validateProviderEvidence`).
- `backend/src/foundation/payments-4d.test.ts` — 28 Phase 4D tests.
- `frontend/src/pages/SettingsPage.test.tsx` — 4 honest billing UX tests.
- `docs/PHASE_4D_REPORT.md` — this report.

## Files modified
- `backend/src/modules/payments/service.ts` — payment sessions: tenant_id + client idempotency key dedupe; verifySession walks DETECTED → VERIFYING → VERIFIED with evidence validation and capture-record completion; `revokeEntitlement`; approval-gated `adminPaymentAction` (owner-scoped) and `systemAdminPaymentAction` (tool path); `paymentCapability()` now reports `evidence` + `razorpayConfigured`.
- `backend/src/modules/payments/tools.ts` — registered `payment_admin` tool: requires an APPROVED `payment_op` approval AND re-validates payment verification server-side before any action.
- `backend/src/modules/payments/routes.ts` — POST `/sessions/:id/admin` (approval-gated admin action).
- `backend/src/modules/execution/approvals.ts` — `CANONICAL_TOOL[PAYMENT_OP]` now includes `payment_admin` (plus existing `plugin_action`).
- `frontend/src/pages/SettingsPage.tsx` — billing tab: evidence provider chips (link/api/webhook ON/OFF) and the exact PENDING message "Payment received at the payment provider. CodeConClave is waiting for independent verification."; never claims success.
- `frontend/src/lib/types.ts` — PaymentCapability/EvidenceProviders, PaymentSession.mode, EntitlementState `REVOKED`.

## Payment architecture
- Preserved state machine: CREATED → PENDING → DETECTED → VERIFYING → VERIFIED → ENTITLEMENT_ACTIVE → COMPLETED, with failure states EXPIRED / FAILED / CANCELLED / REJECTED / ACTIVATION_FAILED / REFUNDED. The session INSERT remains PENDING (CREATED is the modeling root); DETECTED/VERIFYING are walked inside `verifySession` and recorded via `payment_events` (event `payment.detected`) before the VERIFIED transition.
- Only independent provider evidence reaches the verification path: `validateProviderEvidence` rejects client-style claims (source LINK), screenshots/OCR payloads, user-entered payment IDs, and malformed raw payloads with `invalid_evidence` before any write.
- Browser return (`handleReturn`) with `paid`/`status` URL parameters records the event and stays PENDING; explicit cancel → CANCELLED. No client signal can transition toward VERIFIED.
- Duplicate provider evidence is idempotent: `ON CONFLICT (provider_ref) DO NOTHING` on the payments capture row, idempotent entitlement upsert, and a VERIFIED early-return.
- `paymentCapability()` is server-derived: `api` = key AND secret present, `webhook` = secret AND webhook mode, `link` = always. Mode A (Payment Link) is the only active mode in the current environment; Mode B (API) and Mode C (webhook) are DISABLED until real credentials exist.

## Evidence providers
- `evidenceProviders()` returns per-provider `{ enabled, reason }`: link ON; api OFF with the reason "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not both configured"; webhook OFF with the reason "RAZORPAY_WEBHOOK_SECRET is not configured (webhook mode off)". Enabled only when genuinely configured.
- No polling, no fake webhooks, no invented credentials. The webhook endpoint stays disabled (404) unless webhook mode + secret are configured.

## Entitlements
- Activation happens ONLY inside `verifySession` (state VERIFIED), upserting exactly one `entitlements` row per (user, plan) — the unique `(user_id, plan_id)` constraint plus idempotent upsert means duplicate verified evidence can never duplicate entitlements.
- The capture record is completed (`payments.status = 'COMPLETED'`) and linked to its entitlement id.
- `revokeEntitlement` sets state REVOKED (only from PRO_VERIFIED; otherwise `entitlement_not_active`), resets the mirrored `users.plan_id` to free, and audits `entitlement.changed`.
- Tenant isolation preserved: every session/entitlement query filters by `user_id`/`tenant_id`; RLS in 0015_rls.sql unchanged.
- Plan authorization: entitlement activation carries the session's plan (`pro`/`team`); prices unchanged (Pro ₹999, Team ₹4999); no recurring billing or auto-renewal claims.

## Database migrations
- `0026_phase4d_payments_hardening.sql` (static-only): `payment_sessions.tenant_id` (default `app.uid()`), `payment_sessions.idempotency_key` with a partial unique index, state CHECK extended to the full Phase 4D machine, `payments.idempotency_key` + partial unique index, `payments.entitlement_id` FK to the single activation, payments status CHECK extended (COMPLETED) + provider CHECK (razorpay), entitlements state CHECK extended with REVOKED + plan_id CHECK, `payment_events.payment_id` / `payment_audit.payment_id` FKs with indexes.
- PostgreSQL runtime is NOT available here: the migration is validated for structure only. It was never executed; no runtime migration success is claimed.

## Frontend
- SettingsPage billing shows honest states from the server record: the PENDING message above, evidence provider ON/OFF chips, entitlement states including REVOKED, and the pre-existing "No client-side confirmation is ever trusted" hint. No fabricated success anywhere; `payment_success=true`, redirects, URL params, localStorage/cookies are never treated as verification.

## Approval integration
- Admin payment actions (`revoke`, `mark_refunded`) require an APPROVED, unexpired `payment_op` approval owned by the same user (`approval_required` / `approval_not_approved` / `approval_action_mismatch` / `approval_expired` otherwise).
- The gate is a hard invariant: an approval can NEVER turn an unverified payment into a verified one — `performAdminAction` throws `payment_not_verified` unless the session is already VERIFIED, in both the owner route path and the registered `payment_admin` tool path (defense in depth through the Phase 4C execution engine; `CANONICAL_TOOL[PAYMENT_OP]` includes `payment_admin`).
- All admin actions write `payment_audit` rows (`admin.revoke`, `admin.mark_refunded`) and `payment.admin_action` audit entries.

## Tests
- `backend/src/foundation/payments-4d.test.ts` — 28 tests:
  - Capability/evidence providers (3): link ON; api requires key AND secret; webhook requires secret AND webhook mode.
  - Idempotency + state machine (3): tenant_id + idempotency key on create; same key → same session; URL params never activate.
  - Client claims (4): source LINK claim, screenshot/OCR payload, user-entered id with whitespace, non-object raw — all `invalid_evidence`, never VERIFIED.
  - Verified pipeline (3): DETECTED → VERIFYING → VERIFIED + events + capture COMPLETED + exactly-one entitlement; non-pending states refused; duplicate evidence idempotent.
  - Entitlements (5): unverified → PRO_PENDING, never activates; verified activates exactly one for the session plan; revoke behavior + audit; cannot revoke non-active; tenant isolation.
  - Approval (8): missing/PENDING approval rejected; wrong action type rejected; APPROVED approval + PENDING payment → `payment_not_verified` (owner path); same via `payment_admin` tool; approved revoke succeeds + audited; approved mark_refunded; unknown action rejected; expired approval rejected (system path).
  - Audit linkage (1); getSession isolation (1).
- `frontend/src/pages/SettingsPage.test.tsx` — 4 tests: exact PENDING message; provider chips; no success claim without PENDING; REVOKED rendering.

## Totals
- Total: 513 (shared 46, local-agent 49, backend 360, frontend 58)
- Passed: 513
- Failed: 0
- Typecheck: PASS (all four workspaces)
- Build: PASS (shared, backend; frontend uses tsc typecheck via its pipeline)

## PostgreSQL runtime
UNAVAILABLE in this environment. Migrations 0021–0026 are static-validated only and were never applied to a live database; the service layer is exercised exclusively through the mocked query harness. Do not claim live verification.

## External blockers
- Real Razorpay API credentials / webhook secret absent: API and webhook evidence channels correctly report disabled. Payment Link (Mode A) is the only active channel.
- No lint scripts configured in any workspace (root lint is a no-op) — reported honestly.
- Real screenshot capture remains unavailable (Phase 4B external limitation, honest 501).

## Next phase
- Stand up a real PostgreSQL runtime (local or Docker) and apply migrations 0001–0026, then run the integration suite against a live database.
- When real Razorpay API credentials exist, enable Mode B (API link creation + verification) and re-run capability tests.
- Phase 4E is not started; this phase is complete only for the static/mocked scope described above.
