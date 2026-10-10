# Phase 31 — P2 Unified Autonomous Coworker: Progress Report

Scope delivered this pass (real implementations, no deploy/commit/push):
1. **Unified action runtime** (control plane) — NEW
2. **Desktop control** (backend policy + local-agent runner) — NEW
3. **Kuberns adapter boundary** (honest integration boundary) — NEW
4. **Artifact tenancy bug fix** + regression test

Status vocabulary: WORKING / PARTIAL / BROKEN / CONFIGURATION_REQUIRED / NOT_IMPLEMENTED / NOT_VERIFIED.

---

## 1. Unified Action Runtime

- **STATUS: WORKING** (feature-gated; default OFF). Frontend surfacing: NOT_IMPLEMENTED.
- **BACKEND:** `backend/src/modules/actions/`
  - `contract.ts` — single catalogue of execution surfaces (`CLOUD`, `LOCAL`, `BROWSER`, `DESKTOP`), each with its **real** env gate and honest availability; `unifiedActionRuntimeEnabled()` (reads `UNIFIED_ACTION_RUNTIME_ENABLED`, default OFF); `inferSurface()` derives the surface from an explicit field or the `localInstruction.type`.
  - `service.ts` — `routeAction()` routes one declarative action to the **same task fabric** used everywhere else (`createTaskFromChat`), never a second engine: CLOUD → coworker pipeline; LOCAL/BROWSER/DESKTOP → a LOCAL task carrying a server-validated instruction on a paired device. Validates surface gate, then delegates instruction validation to the existing `browser-policy` / `desktop-policy` (deny-by-default), enforces device ownership, and records an audit event (`action.routed`). `listActionSurfaces()` returns the honest surface matrix.
  - `routes.ts` — `GET /api/v1/actions/surfaces` (catalogue + `enabled`), `POST /api/v1/actions` (route an action). Mounted in `backend/src/app.ts` under `paid`.
- **DATABASE:** none required — routed actions persist as **tasks** (existing tables); routing decisions persist in the **audit** log. No redundant action table introduced.
- **PERMISSION:** reuses task ownership checks (`getProject`), device ownership check, and the browser/desktop capability policies. Runtime cannot be a bypass: it is gated and routes through the same validated path.
- **TEST EVIDENCE:** `backend/src/modules/actions/service.test.ts` **9/9**. Combined `actions + agent + kuberns + integration-hub + execution` = **108/108**. `tsc --noEmit` (backend) clean.
- **REMAINING GAP:** no frontend surface/cockpit for the surface catalogue yet; persisted per-action log is via audit/tasks (no dedicated `action_records` table by design).

---

## 2. Desktop Control

- **STATUS: WORKING** (feature-gated `DESKTOP_CONTROL_ENABLED`, default OFF; app allowlist from `DESKTOP_ALLOWED_APPS`).
- **SHARED:** `DesktopCapability` (`desktop.inspect` / `desktop.open_app` / `desktop.focus_window`) + `DesktopActionOp` (`list_windows` / `open_app` / `focus_window`) in `shared/src/constants.ts`.
- **BACKEND:** `backend/src/modules/agent/desktop-policy.ts` — deny-by-default parse; op→capability enforcement; server-side app allowlist; anti-loop bound (`DESKTOP_MAX_ACTIONS`); lifetime clamp (`DESKTOP_PERMISSION_MAX_LIFETIME_MS` = 30d); `desktopInstructionRequiredCapabilities()`, `desktopActionRisk()`. Wired into `execution/routes.ts` and `agent/dispatch.ts` (browser branch preserved).
- **LOCAL-AGENT:** `local-agent/src/desktop/runner.ts` + wiring (`config.ts`, `tasks.ts`, `index.ts`) — `desktop enable|revoke|list`; win32 executes via PowerShell/WScript, non-win32 refuses with `desktop_unsupported_platform`; error codes `desktop_not_enabled` / `desktop_capability_not_granted` / `desktop_app_not_allowlisted` / `desktop_action_failed`.
- **TEST EVIDENCE:** `desktop-policy.test.ts` 13, `local-agent/src/desktop/runner.test.ts` 13; backend agent suite 57/57; local-agent full suite 98/99 (only pre-existing terminal flake).
- **REMAINING GAP:** real desktop e2e on Windows host not executed in CI (unit-tested with platform guards).

---

## 3. Kuberns Adapter Boundary

- **STATUS: CONFIGURATION_REQUIRED** (honest boundary; never claims live).
- **BACKEND:** `backend/src/modules/kuberns/adapter.ts` — `KubernsState = DISABLED | CONFIGURATION_REQUIRED | CONFIGURED`; declared capabilities `[deploy,status,logs,rollback]`; `kubernsDeploySupported(): false`; `assertKubernsReady()` throws `AppError.unavailable`. `routes.ts` — `GET /status`, `POST /deploy` refuses honestly. Mounted in `app.ts`; added to `deploymentProviderCapabilities()` in `integration-hub/service.ts` (mapped into the hub's fixed provider vocabulary; detailed state stays on `/kuberns/status`).
- **CONFIG:** `KUBERNS_ADAPTER_ENABLED` / `KUBERNS_API_URL` / `KUBERNS_API_TOKEN` (all default OFF/empty). Never returns a credential value; `live:false` always in this phase.
- **TEST EVIDENCE:** `kuberns/adapter.test.ts` **6/6**; `integration-hub.security.test.ts` **23/23** (A10 honesty test reconciled — 29/29 for kuberns + integration-hub).
- **REMAINING GAP:** actual Kuberns deployment API call is intentionally NOT_IMPLEMENTED; boundary refuses honestly.

---

## 3b. Artifact Tenancy Bug Fix

- **STATUS: WORKING.** `artifacts/service.ts` `assertArtifactAccess()` had swapped placeholders (`WHERE a.id = $1` with params `[artifactId, userId]`). Fixed to `WHERE a.id = $2` with params `[userId, artifactId]`. Regression test added in `foundation/artifacts-8.test.ts` (**12/12**).

---

## 5. Local Workspace Bridge (Web → real local files + terminal)

- **STATUS: WORKING (backend/API); frontend cockpit NOT_IMPLEMENTED.**
- **BACKEND:** `backend/src/modules/local-workspace/` — the one server-side path that lets the Web app drive real local files/commands on a paired device. It never touches the filesystem itself: every op is forwarded over the existing command protocol (`agentWs().executeCommandResult`) to the Local Agent, which enforces workspace scope, capability grants (`file_read`/`file_write`/`terminal_exec`), path containment and command policy **on the device**.
  - Routes: `GET /devices`, `GET /workspaces`, `GET /tree`, `GET /file`, `PUT /file` (diff-then-apply), `POST /exec`. Mounted under `paid`.
  - Tenancy is structural (`executeCommandResult` resolves the socket by `userId:deviceId`, so a user can only reach their own device). Write/read/exec are audited (`local.file_written` / `local.file_read` / `local.command_executed`).
  - Error mapping is honest: agent offline → `local_agent_offline`; agent policy denial → `local_action_denied`; out-of-scope → `local_scope_denied`.
- **LOCAL-AGENT:** added `workspaces.list` command (`local-agent/src/index.ts`) so the Web app can discover the device's granted roots (root/name/capabilities). Existing `file.list/metadata/read/diff/write` + `terminal.exec` cases are reused unchanged.
- **DATABASE:** none new — files/commands are real on-device; the cloud stores only audit entries.
- **TEST EVIDENCE:** `backend/src/modules/local-workspace/service.test.ts` **8/8** (offline, policy-denied, out-of-scope, read/metadata, diff+apply write, command output). Combined `local-workspace + actions` = **17/17**. Backend `tsc --noEmit` clean; local-agent `tsc --noEmit` clean; local-agent suite **110/111** (only the known pre-existing `terminal.test.ts` TIMED_OUT host flake).
- **REMAINING GAP:** no Workbench UI wired to these endpoints yet; a full "browse a real paired-device project in the browser" demo step is **PARTIAL** until the frontend consumes this API.

## Not started / gaps carried forward

- **NOT_IMPLEMENTED:** Workbench 2.0, cross-surface verification, continuity, cost/resource guardrails hardening, frontend cockpit for the unified action runtime.
- **PARTIAL:** memory/audit (existing), unified router auto-selection heuristics (surface is currently explicit or instruction-derived).
- **Known defect (pre-existing):** deployment-wizard missing tables.
- **Pre-existing flake (do not fix):** `local-agent/src/foundation/terminal.test.ts` TIMED_OUT on this non-TTY host.

## Working-tree note
No commit/deploy/push performed. `backend/src/workers/watchdog.ts` shows as modified in git status and was **not** touched by this pass (pre-existing uncommitted change; left intact per rules). Shared package `dist` was rebuilt to emit the new audit enum member.

## Run
- `PHASE31_P2_PROGRESS_REPORT.md` written. STOP.
