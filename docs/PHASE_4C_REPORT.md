# PHASE 4C REPORT — Approval Center + Human-Gate Execution

## Status
COMPLETE. The server-authoritative Approval Center is fully implemented and tested: proposals are classified server-side by risk tier, duplicate PENDING proposals are idempotent, decisions revalidate the approval record, and human-gate execution re-runs the entire security stack (status, expiry, action coverage, resource coverage, policy engine, capability grants, device pairing/online/remote-session) before any tool runs — an approved flag alone never executes anything. The frontend Approval Center renders honest states (pending/approved/rejected/expired/executed/execution failed) and waits for the server execution result. PostgreSQL runtime is NOT available in this environment — migration 0025 is written and statically validated only, never executed (see PostgreSQL runtime).

## Files created
- `shared/src/contracts-phase4c.test.ts` — Phase 4C contract tests (12): proposal/execution schemas, frozen action types, expiry/resource caps, new status/audit/timeout constants.
- `database/migrations/0025_phase4c_approvals.sql` — approvals extension (action_type, coworker, model, justification, affected_resources, proposed_action, execution record, audit_reference, batch_group; status CHECK extended with EXECUTED/CANCELLED) + `approval_resources` table (FK, RLS, indexes).
- `backend/src/foundation/approval-center.test.ts` — 29 backend tests covering all 16 required scenarios (risk tiers, expiry, reapproval, duplicate, already-approved, already-rejected, batch, wrong user/tenant, action mismatch, resource mismatch, expired capability, revoked device, offline agent, no-bypass-policy, execution success/failure, audit records).
- `frontend/src/pages/ApprovalsPage.test.tsx` — 10 frontend tests (honest states, approve/reject, server-result execution, malformed-input refusal, no fake completion from a button click).

## Files modified
- `shared/src/constants.ts` — ApprovalStatus + EXECUTED/CANCELLED, new `ApprovalActionType` (15 frozen action types), `ApprovalExecutionState`, 5 new AuditActions (`approval.created`, `approval.execution_started`, `approval.execution_succeeded`, `approval.execution_failed`, `approval.expired`), Timeouts `APPROVAL_DEFAULT_EXPIRY_MS` (30 min) + `APPROVAL_MAX_RESOURCES` (50).
- `shared/src/contracts.ts` — `approvalResourceSchema`, `approvalProposeSchema` (actionType enum, justification 1–2000, resources 1–50, proposedAction, expiry 1–30 min), `approvalExecuteSchema` (tool + input + optional deviceId) + input types.
- `backend/src/modules/execution/policy-shared.ts` — ApprovalStatus/ApprovalExecutionState additions, 5 new AuditAction keys, Timeouts `APPROVAL_DEFAULT_EXPIRY_MS`/`APPROVAL_MAX_RESOURCES`.
- `backend/src/modules/execution/approvals.ts` — ApprovalRow extended with the full 4C record; `proposeApproval` (server risk classification per action type, 30-min default window capped at 30 min, idempotent duplicate-PENDING return, approval_resources insert, audit `approval.created`); `executeApprovedAction` (full revalidation gate + execution record + audits); `expireStaleApprovals` now audits each expiry (`approval.expired`). Existing `createApproval`/`decideApproval` behavior and TTLs are untouched (all prior tests green).
- `backend/src/modules/execution/routes.ts` — POST `/approvals` (proposal, zod-validated, server risk re-typed) and POST `/approvals/:id/execute` (human-gate execution).
- `frontend/src/lib/types.ts` — Approval extended (actionType/coworker/model/justification/affectedResources/proposedAction/execution fields) + `mapApproval` snake→camel mapper (fixes the latent Phase 3 bug where the page read camelCase fields that never existed in the snake_case rows).
- `frontend/src/pages/ApprovalsPage.tsx` — rewritten as the full Approval Center: risk/action/status pills, justification, proposed command, affected resources, coworker/model, timestamp, live 1-second expiry countdown, Approve/Reject with reason, Review Details (proposed action JSON), Execute form for APPROVED approvals, honest execution-result banner (executed / execution failed with server error + audit reference), status filter incl. Executed.

## Database migrations
`0025_phase4c_approvals.sql` (new) — static validation only, never executed (no PostgreSQL runtime). ALTERs approvals with the full persisted record + status CHECK extended to include EXECUTED and CANCELLED (lifecycle PENDING→APPROVED→EXECUTED / PENDING→REJECTED→CANCELLED / PENDING→EXPIRED); new `approval_resources` (one approval, many resources, FK ON DELETE CASCADE, owner-scoped RLS); indexes (approval_resources.approval_id, approvals.batch_group, approvals.action_type+status). Migrations 0021–0025 remain unapplied.

## Approval APIs
- `POST /api/v1/execution/approvals` — propose an action: server classifies risk when absent (file_read LOW, file_write/create/network/plugin MEDIUM, file_delete/terminal/publish/deploy/payment/remote/batch HIGH, production/secret/policy-override CRITICAL), 30-minute default window, unknown action types refused, duplicate PENDING (same action + same resources) returns the existing approval (idempotent retry).
- `POST /api/v1/execution/approvals/:id/decide` — APPROVE/REJECT, only the owner, only PENDING, never expired (existing route, unchanged).
- `POST /api/v1/execution/approvals/:id/execute` — human-gate execution. Server revalidates: approval exists and belongs to the caller → status APPROVED → not expired → tool covered by the action type → touched resource inside the approved resources → policy engine still allows (approval never bypasses policy) → capability grants still valid (expired grants deny) → terminal/remote actions additionally require a paired device, an online agent, and (remote) an ACTIVE remote session. Result is recorded on the approval: EXECUTED + SUCCEEDED (with output + audit_reference) or EXECUTED + FAILED (with the error).
- Existing GET `/approvals` (list + pendingCount), GET `/approvals/:id` unchanged.

## Policy integration
`executeApprovedAction` re-runs `evaluateToolCall` with the executed tool and input at execution time — a previously approved action is re-checked against the live policy engine, so baseline denials (secrets, OS-sensitive paths, dangerous commands, blocked network hosts) and capability grants (which can expire or be revoked after approval) always win. Tests prove `baseline_commands` (rm -rf) and `capability` (revoked grants) denials on approved approvals.

## Execution integration
The human gate is a separate server-authoritative path: no `tool_calls` row is fabricated, no task status is faked. Approval execution runs registered tools only (`runRegisteredTool`), records RUNNING→SUCCEEDED/FAILED with timestamps and the JSON result on the approval, and emits the audit trail `approval.execution_started` → `approval.execution_succeeded`/`approval.execution_failed`. Terminal/remote execution reuses the Phase 4B device stack (requirePairedDevice/requireAgentOnline/requireRemoteSession).

## Frontend
Full Approval Center at `/approvals`: pending list with risk tier, action type, justification, proposed command preview, affected-resource pills, coworker + model + created/expires timestamps, live countdown, "expires soon" warning; Approve/Reject (with optional reason); Review Details expands the proposed action; APPROVED approvals show an Execute form (tool prefilled from the proposal, JSON input, device id for terminal/remote) and render the server result — "executed" only when the server reports SUCCEEDED, "execution failed" with the server error when FAILED; a mere Approve click never displays completion. States render honestly from server records (pending/approved/rejected/expired/executed/revoked/cancelled).

## Audit
`approval.created` (proposal, with action type, risk, task, resources) · `approval.granted` / `approval.rejected` (decisions, existing) · `approval.expired` (watchdog sweep, per approval) · `approval.execution_started` (tool + device) · `approval.execution_succeeded` (tool + output) · `approval.execution_failed` (tool + error).

## Tests
| Workspace | Total | Passed | Failed |
|---|---|---|---|
| shared | 46 | 46 | 0 |
| local-agent | 49 | 49 | 0 |
| backend | 332 | 332 | 0 |
| frontend | 54 | 54 | 0 |
| **Total** | **481** | **481** | **0** |

(+51 over Phase 4B: 12 shared + 29 backend + 10 frontend. All 430 prior tests remain green.)

## Typecheck
All four workspaces pass (`tsc --noEmit`): shared, local-agent, backend, frontend.

## Build
shared and backend build cleanly. (Frontend has no build script; local-agent none.)

## PostgreSQL runtime
NOT AVAILABLE — no .env, no Docker daemon, no postgres client in this environment. Migration 0025 (and 0021–0024) are written and statically validated but never executed; RLS/CHECK/function behavior at runtime is unverified. This is an infrastructure blocker, reported honestly — no migration success is claimed.

## External blockers
1. PostgreSQL runtime unavailable (above) — migrations cannot be applied or runtime-tested.
2. Real screenshot capture remains an external limitation (honest 501 adapter from 4B).
3. LOCAL/HYBRID task dispatch remains `WAITING_FOR_LOCAL_AGENT` — no dispatcher exists (honest gap from 4B, unchanged).
4. No lint scripts exist in any workspace (root lint is a no-op) — reported, not silently claimed.
5. One latent frontend bug found and fixed this phase: the pre-4C ApprovalsPage read camelCase fields (riskLevel/expiresAt) that the snake_case API rows never contained — the new `mapApproval` mapper fixes it and is now covered by tests.

## Next phase
Phase 4D (per the roadmap) after 4C is validated — likely the LOCAL dispatcher (WAITING_FOR_LOCAL_AGENT → real local-agent handoff), the browser WS push stream on the frontend terminal/approval surfaces, and optionally a real screenshot adapter if a capture platform becomes available.