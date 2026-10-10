# PHASE 29 — MASTER EVIDENCE REPORT: P0 LOCAL EXECUTION FABRIC

Status: **COMPLETE** (phase stopped after finish, per command: implement current phase → STOP → report).
Locality: source-only. **Nothing deployed, nothing committed, nothing pushed.**

---

## A. Phase scope (P0, items 1–6)

1. Local task dispatch (parked task → assigned device → delivery).
2. Claim / attempt ownership (lease + fencing on the assignment ledger).
3. Result + artifact reporting (honest, real, never fabricated).
4. Reconnect / recovery (redeliver on agent reconnect; sweep expired leases).
5. Scoped permissions (capability grants, deny-by-default policy, workspace path resolution, audit trail).
6. Feature-gating (all new capabilities off by default).

## B. What was built (backend)

- `backend/src/modules/agent/dispatch.ts` (new) — dispatcher/fabric service:
  `localExecutionEnabled()`, `localLeaseMs()`, `resolveEligibleDevices()`, `dispatchLocalTask()` (idempotent on assignmentId), `deliverAssignment()`, `onAgentReady()` (re-deliver + flush parked), `dispatchParkedTasks()`, `claimAssignment()` (ownership + lease + parked checks → `beginAttempt` → `EXECUTING`), `heartbeatAssignment()`, `recordAssignmentProgress()`, `reportAssignmentArtifact()`, `completeAssignment()` (`finishAttempt` SUCCESS → `COMPLETED`), `failAssignment()` (re-park with budget bump keeping `WAITING_FOR_LOCAL_AGENT`, else `deadLetterTask`), `cancelAssignment()`, `recoverExpiredAssignments()`, `startLocalRecoverySweep()` (idempotent, unref'd).
- `backend/src/modules/agent/hub.ts` (new) — `setHub`/`wsHub` singleton (avoids runtime import cycle ws.ts→dispatch.ts).
- `backend/src/modules/agent/ws.ts` — registers hub; on agent `ready` → `onAgentReady` flush (flag-gated); inbound `task_claim|task_heartbeat|task_progress|task_artifact|task_complete|task_fail` → `handleTaskMessage()` with `task_ack` replies; disabled flag replies `task_ack {ok:false, error:'local_execution_disabled'}`.
- `backend/src/modules/execution/orchestrator.ts` — `dispatchLocalIfEnabled()`; LOCAL branch in `executeTask` + `createTaskFromChat` parks (`WAITING_FOR_LOCAL_AGENT`) then dispatches (flag-gated, `.catch(()=>undefined)`).
- `backend/src/app.ts` — calls `startLocalRecoverySweep()` in `attachAgentHub` (watchdog.ts untouched — it is frozen).
- `backend/src/config/env.ts` — flags `LOCAL_EXECUTION_ENABLED`, `BROWSER_CONTROL_ENABLED`, `DESKTOP_CONTROL_ENABLED`, `LIVE_PREVIEW_ENABLED`, `UNIFIED_ACTION_RUNTIME_ENABLED` (default `'false'`), plus `LOCAL_TASK_LEASE_MS` (default `120000`).
- `backend/src/shared/ids.ts` — `LOCAL_ASSIGNMENT: 'lta'`.
- `shared/src/constants.ts` — 10 `LOCAL_TASK_*` AuditAction members (`local.task_assigned/.claimed/.heartbeat/.progress/.artifact/.completed/.failed/.cancelled/.expired/.recovered`); shared rebuilt to `shared/dist`.
- `database/migrations/0143_local_task_dispatch.sql` (new) — `tasks.assigned_device_id`, `tasks.local_assignment_at`, `local_task_assignments` ledger (statuses ASSIGNED/CLAIMED/RUNNING/REPORTED/COMPLETED/FAILED/CANCELLED/EXPIRED), 3 indexes, RLS `owner_id = app.uid()`.

## C. What was built (local agent)

- `local-agent/src/tasks.ts` (new) — `createLocalTaskExecutor(send)`: claim → heartbeat (30 s) → progress → command execution IF `instruction.command` present and allowed by `gateTerminalInput`/`classifyCommand`/`resolveWorkspacePath`; reports REAL output + REAL artifact refs (sha256/bytes via node crypto+fs) for `instruction.outputs`; honest fails: `capability_not_granted` (pre-claim), `no_local_instruction`, `policy_denied`, `path_outside_grant`, `local_timeout`, `local_command_failed`. Ack correlation map; `ok:false` stops a running local task.
- `local-agent/src/hub.ts` — routes inbound `task_assign` → `handleTask`, `task_ack` → `handleTaskAck`.
- `local-agent/src/index.ts` — `cmdServe` wires `createLocalTaskExecutor((m)=>hub.send(m))` + `handleTask`/`handleTaskAck`.

## D. Capability / permission model (P0.5)

- Every local task requires an explicit `requiredCapabilities` grant present in a paired workspace.
- Deny-by-default: dangerous commands (immutable policy), protected paths (`.env`, `.ssh`, `.aws`, key material, `.codeconclave`, …), traversal + symlink escapes (`resolveWorkspacePath`) are blocked deterministically — never an LLM decision.
- No instruction ⇒ honest `no_local_instruction` failure (never fabricated PASS). No autonomous goal execution yet (later phase); the agent runs only explicit granted commands.

## E. Fencing / ownership (P0.2)

- Claim grants ownership via `beginAttempt` (func attempt id) and flips task to `EXECUTING`/`RUNNING` only while parked (`WAITING_FOR_LOCAL_AGENT`).
- Cross-device claim, expired lease, and not-parked claims are rejected (16 dispatch tests cover these).
- Heartbeat/complete/fail fenced via `assertAttemptOwns` + lease window.

## F. Recovery (P0.4)

- `onAgentReady` on reconnect re-delivers the device's active assignment and flushes parked dispatches.
- `startLocalRecoverySweep()` (every 60 s) re-lands expired in-flight work: `EXECUTING`→re-park (keep budget) or `COMPLETED`/`FAILED`; heartbeat required to keep a claim.

## G. WS protocol

`task_assign` (server→agent) · `task_claim|task_heartbeat|task_progress|task_artifact|task_complete|task_fail` (agent→server) · `task_ack` (server→agent control). Feature-flag enforced at WS boundary.

## H. Honesty (P0.3)

- Backend persists only what the agent reported (real result, real artifact refs).
- Agent-side executor reports real exit codes, real stdout/stderr, real sha256/bytes; failure paths are explicit error codes, never fabricated success.
- Disabled capability ⇒ NOT ENABLED error frame, never pretended.

## I. Evidence — backend typecheck

`tsc -p tsconfig.json --noEmit` in `backend/` → **exit 0**.

## J. Evidence — backend tests

`vitest run dispatch + local-execution-17 + orchestration-7 + scheduling-26 + autonomy state-machine + autonomy` → **123/123 PASS** (16 new dispatch + 107 existing LOCAL/autonomy).

## K. Evidence — local-agent typecheck

`tsc -p tsconfig.json --noEmit` in `local-agent/` → **exit 0**.

## L. Evidence — local-agent tests (new P0 executor)

`local-agent/src/foundation/local-tasks.test.ts` (new, 5 tests) → **5/5 PASS**: honest `no_local_instruction` refuse; policy-denied refused pre-exec; real success + real artifact refs; honest `local_command_failed`; capability-not-granted refuse pre-claim with nothing executed.

## M. Local-agent full suite

**58/60 pass; 1 pre-existing, environment-only flake**: `terminal.test.ts` "transitions to TIMED_OUT" spawns an argless `node` REPL expecting a 300 ms hang; on this non-TTY Windows host `node` exits immediately ⇒ FAILED, not TIMED_OUT. `terminal.ts`/`terminal.test.ts` were NOT touched by this phase (verified `git status`). Not a P0 regression.

## N. Environmental / build notes

- Backend consumes `@codeconclave/shared` from `shared/dist`; shared was rebuilt after adding `LOCAL_TASK_*` audit actions (tsc exit 0). Generated `dist` changes are build artifacts — not committed.
- Node runtime used at `...\noderestore2\node-v24.19.0-win-x64\node.exe` (AV quarantine risk; restore via Expand-Archive).
- Tool output may display `WAITING_FOR_LOCAL_AGENT` mangled to `ln` — a display artifact only; file content is correct.

## O. Constraints honored

No deploy · no commit · no push · CLOUD path untouched · demo path intact · `watchdog.ts`/`0142`/durable-*/nodejs/desktop-shim frozen/untouched · RLS/auth not weakened · no fabricated verification · capabilities feature-gated default OFF · no LLM on local agent.

## P. Known pre-existing defects (carried, NOT in P0 scope)

- Artifact `/download` + `/references` 500 from `assertArtifactAccess()` param binding (`backend/src/modules/artifacts/service.ts:227-241`; fix = reorder params — NOT applied).
- `SATURDAY_DEMO_GATE_REPORT.md` needs 109→117 correction (true tally 119 PASS/7 FAIL; outside step 6 = 117/117).
- Stale live claims (`Available now` ×15, `24/7 task`); live still on pre-heartbeat-fix build `96b4241`.

## Q. Gating matrix

| Capability | Flag | Default |
|---|---|---|
| Local execution | `LOCAL_EXECUTION_ENABLED` | false |
| Browser control | `BROWSER_CONTROL_ENABLED` | false |
| Desktop control | `DESKTOP_CONTROL_ENABLED` | false |
| Live preview | `LIVE_PREVIEW_ENABLED` | false |
| Unified action runtime | `UNIFIED_ACTION_RUNTIME_ENABLED` | false |
| Lease | `LOCAL_TASK_LEASE_MS` | 120000 |

## R. Files changed/added (this phase)

New: `backend/src/modules/agent/dispatch.ts`, `dispatch.test.ts`, `hub.ts`; `database/migrations/0143_local_task_dispatch.sql`; `local-agent/src/tasks.ts`, `local-agent/src/foundation/local-tasks.test.ts`.
Modified: `shared/src/constants.ts` (+shared/dist rebuild), `backend/src/shared/ids.ts`, `backend/src/config/env.ts`, `backend/src/modules/agent/ws.ts`, `backend/src/modules/execution/orchestrator.ts`, `backend/src/app.ts`, `local-agent/src/hub.ts`, `local-agent/src/index.ts`.

## S. What was deliberately NOT done (scope honesty)

- P1–P3 phases not started. No browser/desktop/preview/unified-runtime code beyond flags.
- No autonomous goal execution (LLM-driven) on the local agent.
- No live deployment or restart of any service. No DB migration applied (must be applied by ops when the phase is released).
- Artifact-download defect intentionally left unfixed (not in P0; needs its own ticket).

## T. Final status

Phase P0 (items 1–6 of the 29-phase command) is **complete and verified locally**: typechecks green, 123 backend + 5 new agent tests green. Work **stopped** per the command. Awaiting instructions for P1 (paired-device browser automation).

## U. Stop signal

STOP — implementation phase complete; master evidence report returned.

## V. Next phase (not started)

P1: paired-device browser automation (real, flag-gated) — requires explicit go-ahead.