# PHASE32 — HYBRID COWORKER MASTER REPORT (new implementation pass)

**Branch:** `temporary-demo-mode` @ `9a4b33b`. **No deploy, no commit, no push, no production-config change, no billable calls, no new paid dependencies.**
All pre-existing uncommitted work (P0–P2 fabric, cockpits, demo-mode, Muse Spark provider from the prior pass) preserved; this pass only ADDS the items in §2.

> Supersession note: a file of this name from an earlier phase existed and documented the Local-cockpit pass (its verdicts — cockpit WORKING in tree, surfaces gated OFF, preview NOT CONFIGURED — are carried as this pass's baseline in §1). This report replaces it per the master command's deliverable list.
> Status vocabulary: `WORKING | PARTIAL | BROKEN | NOT VERIFIED | NOT IMPLEMENTED | CONFIGURATION REQUIRED`.

---

## 1. Starting repository and working-tree state

- Baseline reports read: `MASTER_PASS_REPORT.md`, `PHASE29_P0`, `PHASE30_P1`, `PHASE31_P2`, `MUSE_SPARK_HYBRID_COWORKER_FINAL_REPORT.md`, `CODECONCLAVE_VERTICAL_SLICE_FINAL_REPORT.md`, prior `PHASE32`/`PHASE33`.
- Starting tree: P0 dispatch/ledger/WS/executor, P1 CDP browser bridge + `BrowserTaskPanel`, P2 action runtime + `ActionRuntimePanel` + `LocalWorkspacePanel` + desktop policy + Kuberns boundary, Muse Spark provider (flag-gated), demo auto-login — all present as uncommitted work, verified by source inspection (not taken on trust).
- Baseline test position (prior pass, re-confirmed before editing): backend 4344 green, local-agent 120/121 (1 known environmental flake), frontend panels green, typechecks clean, secret-scan 0 findings.
- Environment limits (unchanged): no Postgres (5432 closed), no Redis (6379 closed), no running backend (4000 closed), no `.env`; Node only via `codex-primary-runtime v24.19.0`; `cmd.exe` lives in SysWOW64 (ComSpec points at absent System32 copy); Chrome present.

## 2. Files changed and why

| File | Change | Why |
|---|---|---|
| `backend/src/modules/actions/contract.ts` | +`PREVIEW` surface (`LIVE_PREVIEW_ENABLED` gate), `ActionExecutionMode`, `preview` instruction-kind inference; `surfaceExecutionMode` narrowed to task-fabric surfaces | Commanded 5-surface runtime; PREVIEW was the missing one |
| `backend/src/modules/actions/service.ts` | PREVIEW branch (real `requestBuild`, rejects ad-hoc instruction/device), `stopAllWork` (real ledger + task cancels, bounded, audited) | Preview you can actually trigger; a real stop-all control (§13) |
| `backend/src/modules/actions/planner.ts` | NEW deterministic objective→plan grounding (surface resolution, live-gate BLOCKED-vs-re-route, dep validation, risk/permission per step) | §9 planner without inventing NL understanding (gateway owns that) |
| `backend/src/modules/actions/routes.ts` | `POST /plan`, `POST /stop-all`, PREVIEW `session` in route response | Expose planner + stop-all over the existing API |
| `backend/src/modules/actions/service.test.ts` | 5-surface catalogue pin, PREVIEW (3), stop-all (3) | Prove new behavior |
| `backend/src/modules/actions/planner.test.ts` | NEW 8 tests | Prove grounding honesty |
| `backend/src/modules/agent/dispatch.ts` | +`listActiveAssignmentsForUser` (owner-scoped SQL, bounded) | Stop-all needs an honest work inventory |
| `backend/src/modules/preview/service-real-build.test.ts` | NEW 2 tests, REAL child builds | First genuine preview execution proof (§6) |
| `frontend/src/components/ActionRuntimePanel.tsx` | PREVIEW submit (no instruction), session rendering, Stop-all section (server-authoritative) | Cockpit matches the 5-surface runtime |
| `frontend/src/components/ActionRuntimePanel.test.tsx` | +3 tests (PREVIEW post/shape, stop-all counts, stop-all refusal) | Prove panel honesty |
| `shared/src/constants.ts` | +`UNIFIED_ACTION_STOP_ALL: 'action.stop_all'` (+dist rebuild) | Audit the stop-all control |

No payment/entitlement/OAuth/demo logic touched. CLOUD demo path untouched.

## 3. Local-files end-to-end — `PARTIAL`

Cockpit (`LocalWorkspacePanel` in Workbench `Local` tab) + bridge + agent enforcement verified by source + prior 6/6 panel tests. Device-side reality proven last pass (10/10 real fs/process/policy proofs, still green in the agent suite). **NOT VERIFIED:** live Web→WS→device transport (no pairing infra here). Pairing alone is not claimed as proof.

## 4. Local execution results — `PARTIAL`

Dispatcher/ledger/claim/fencing/heartbeat/recovery/cancel paths unchanged and green (`dispatch` 16/16 + `local-execution-17` + orchestration + 156-test P0–P2 gate, §14). New: `listActiveAssignmentsForUser` feeds stop-all. **NOT VERIFIED live** (no DB/WS). Invariants hold by construction + test: absent device → no completion path; failed command → honest failure codes; stale attempts fenced (`assertAttemptOwns`).

## 5. Browser results — `PARTIAL`

Real headless-Chrome E2E still green (prior pass 3/3; code untouched). New integration value: BROWSER is now plannable (`planner.ts` resolves/infers it, warns without device) and routable from the Actions cockpit; consequential ops still force HIGH risk + approval gate server-side. **NOT VERIFIED:** a Web-dispatched run on a live paired device. No passwords/session-stores touched; Mode 2 still explicitly denied.

## 6. Preview results — `PARTIAL` (service pipeline `WORKING`, production `CONFIGURATION REQUIRED`)

**New real proof** (`service-real-build.test.ts` **2/2**, genuine `node` child processes in temp fixture projects):
- `requestBuild` → BUILDING → real build log lines (`> <cmd>`, script stdout) → READY v1 → `previewContent` serves the built marker bytes with the strict CSP (`frame-ancestors 'none'`). Build observably ran (output file did not exist before).
- Failing build (exit 3, stderr `simulated compile error`) → ERROR carrying `exit 3` + log tail; `previewContent` returns null (serves nothing — no fake render).
- Environment note: this sandbox hides `cmd.exe` from ComSpec's System32 path; the test uses the working SysWOW64 copy via process-local `ComSpec` (service code untouched; honest `skipIf` guards remain).
- Mocked layer (stated): Postgres query transport (in-memory rows run the same statements) + audit/notify/snapshots. PG-backed persistence NOT VERIFIED here.
- Production preview still `CONFIGURATION REQUIRED`: `PREVIEW_BUILD_ENABLED`/`PREVIEW_BUILD_COMMAND`/`PREVIEW_PROJECTS_ROOT`/`PREVIEW_OUTPUT_DIR` unset; `LIVE_PREVIEW_ENABLED=false` default. New: PREVIEW is a first-class runtime surface, so the planner/cockpit can request a build the moment tooling is configured.

## 7. Desktop-control results — `PARTIAL`

Policy (13/13) + agent runner (12/12) green, unchanged. Desktop steps are now plannable (permission text cites allow-list + approval) and submittable from the Actions tab; server still enforces `DESKTOP_ALLOWED_APPS` deny-by-default. No real app launched (deliberate). Unsupported apps remain unlabeled as supported.

## 8. Unified action runtime — `WORKING` (gated)

Five surfaces (`CLOUD|LOCAL|BROWSER|DESKTOP|PREVIEW`) with live gates; `POST /` routes (PREVIEW→real build, others→task fabric, 23/23 tests); `POST /plan` grounds objectives (8/8); `POST /stop-all` cancels real work (covered in service tests). Disabled runtime/surface → 503 with exact code, before any work. No second queue, no new task states.

## 9. Workbench connectivity — `WORKING` (as far as infra allows)

Actions tab now drives all five surfaces + stop-all against the real API contract (10/10 tests); Local/Browser/Preview tabs unchanged and green (36/36 across 5 panel/page suites). Disabled/unconfigured states render verbatim. Reload-persistence against a live backend NOT VERIFIED (no DB); no synthetic events.

## 10. Permission/security/RLS results — `WORKING`

Enforcement stays at the boundary (agent policy, instruction re-validation, device/project ownership, attempt fencing, cooperative pipeline cancel). New paths reuse the same gates (PREVIEW: project ownership inside `requestBuild`; stop-all: owner-scoped ledger SQL + per-task cancel). Repo-wide secret scan: **1274 files, 0 findings**. No credentials/stores in logs, artifacts, or audit detail (key names only).

## 11. Verification and artifact evidence — `WORKING`

No parallel completion mechanism added. Planner distinguishes READY/BLOCKED but never completes; router reports routing, not completion; preview reports build state, not app correctness. Real artifact fields (sha256/bytes) flow from the existing executors. Failed builds/commands/denials stay visible as such (proven in §§3/6).

## 12. Memory, audit and persistence — `WORKING` (existing systems)

Return-to-work ("While You Were Away") already exists (`returnToWork/service.ts`, notifications route, home section, `return-to-work-12.test.ts` green in the 156-gate) — no duplicate built. New audit coverage: `action.routed` (PREVIEW branch), `action.stop_all` summary counts. No secrets stored; no fabricated memories.

## 13. Reconnect, cancellation and recovery tests — `PARTIAL`

Proven: recovery sweep + fencing suites green; `cancelAssignment`/`cancelTask` composition via `stopAllWork` unit proofs (success, partial-failure honesty, terminal-skip, disabled-refusal); preview failure/cleanup paths in the real-build test. NOT VERIFIED live: disconnect/reconnect choreography and confirmed process-stop on a live deployment (needs staging).

## 14. Backend/frontend/local-agent/desktop test results

| Suite | Result |
|---|---|
| Backend full | **4360 passed, 76 skipped, 1 failed → FLAKY** (`auth.test.ts` MFA scrypt timeout under load; **46/46 solo**, files untouched by this pass) |
| Backend `tsc --noEmit` | clean |
| New: actions service/planner, preview real-build | **23 + 8 + 2 green** |
| P0–P2 focused gate (12 files) | **156/156** |
| Local-agent full | **120/121** (1 pre-existing non-TTY `terminal.test.ts` flake, untouched) |
| Frontend `tsc --noEmit` | clean |
| Frontend panels/pages (5 files) | **36/36** (incl. 3 new) |
| Secret scan | **0 findings / 1274 files** |
| Desktop | backend policy 13/13 + agent runner 12/12 (in the above) |

## 15. Regression status

P0, P1, P2 suites green (§14). CLOUD pipeline, heartbeat/fencing, auth/RLS, demo-mode, Muse Spark provider suites (prior pass) all inside the green full run. Two failures observed, both classified: MFA timeout = FLAKY/environmental (proven solo-green); terminal TIMED_OUT = PRE-EXISTING/environmental. No real defects, nothing concealed.

## 16. Remaining infrastructure configuration

1. Postgres/Redis + `.env` + migrations (incl. 0143/0144/0145) + running backend/frontend + paired agent + workspace grants → unlocks live LOCAL/Web→file/browser chains.
2. `PREVIEW_BUILD_ENABLED=true` + `PREVIEW_BUILD_COMMAND` + `PREVIEW_PROJECTS_ROOT` + `PREVIEW_OUTPUT_DIR` (+ `LIVE_PREVIEW_ENABLED=true`, `UNIFIED_ACTION_RUNTIME_ENABLED=true` for the cockpit path).
3. Chrome/Edge on the paired device; `DESKTOP_ALLOWED_APPS` + GUI session for desktop E2E.
4. `MUSE_SPARK_API_KEY` + flag + spend approval for the provider smoke test.

## 17. Unsupported capabilities (explicit)

No unrestricted computer control; no arbitrary desktop-app support (3 ops, allow-listed apps only); no Mode-2 user-browser control; no always-on hosting claim (Render Free); no Kuberns execution (honest `CONFIGURATION_REQUIRED` boundary); no NL-to-plan autonomy beyond gateway tool-calls + deterministic grounding (planner validates, never hallucinates executability); Muse Spark never mandatory.

## 18. Exact commands to launch and demonstrate (staging with infra)

```powershell
# 0. Runtime (one process-only PATH prepend; no system change)
$node = 'C:\Users\sride\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
# 1. Env: DATABASE_URL, REDIS_URL, QUEUE_PROVIDER=redis, SESSION/JWT secrets,
#    TEMPORARY_DEMO_MODE=true, VITE_DEMO_BUILD=1, + §16 flags as needed
# 2. Migrate + run:  npm run db:migrate --workspace @codeconclave/backend
#    npm run dev --workspace @codeconclave/backend   # :4000
#    npm run dev --workspace @codeconclave/frontend  # :5173
#    local-agent: init → pair → workspaces add <disposable project>
# 3. Demo journey: login (auto) → Workbench Actions tab → plan (objective +
#    steps) → route LOCAL read/edit/test → diff → PREVIEW build → Preview tab →
#    BROWSER inspect (granted origin) → verification → artifact/audit tabs →
#    reload (persistence) → Stop-all → confirm terminal states.
# Tests: & $node ..\node_modules\vitest\vitest.mjs run <files>  (per package dir)
# Typecheck: & $node ..\node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
```

## 19. Production configuration requirements

Nothing in this pass requires production change. To productize: deploy HEAD + uncommitted release delta (§20); set §16 variables in the hosting environment (never in repo); keep all `*_ENABLED` gates off until each surface's live E2E passes in staging; keep demo-mode/payment/OAuth posture exactly as-is.

## 20. Recommended release delta

1. Prior uncommitted P0–P2 + demo-mode + Muse Spark provider (already reviewed passes).
2. This pass: 5-surface runtime (`contract/service/routes/planner`), `listActiveAssignmentsForUser`, `action.stop_all` audit event, real-build preview proof, cockpit PREVIEW + stop-all.
3. Docs: this report. No migrations beyond 0143–0145 (all standard, non-destructive).

---

## 17-step acceptance journey — exact status

| # | Step | Status | Evidence / blocker |
|---|---|---|---|
| 1 | Open Web app | WORKING | Demo auto-login + CLOUD path (prior passes, suites green) |
| 2 | Select paired device | PARTIAL | Cockpit + device API real; live pairing needs staging (§16.1) |
| 3 | Choose authorized project | PARTIAL | Same blocker |
| 4 | Read permitted file | PARTIAL | Real device-side proof (10/10); live transport NOT VERIFIED |
| 5–6 | Scoped change + permission decision | PARTIAL | Policy/approval gates proven; live decision NOT VERIFIED |
| 7–9 | Execute change, test cmd, diff+output | PARTIAL | Real exec/diff proofs device-side; live NOT VERIFIED |
| 10 | Launch real preview | WORKING (service) | Real-build proof 2/2; needs tooling config in prod |
| 11–12 | Open app via browser bridge, inspect | PARTIAL | Real-Chrome E2E proven; Web-dispatched run needs pairing |
| 13 | Verify behavior | WORKING | Verification contracts enforced + tested |
| 14 | Persist/retrieve artifacts | WORKING | Real hash/size refs + suites green |
| 15 | Audit + memory | WORKING | Real events; return-to-work exists + tested |
| 16 | Reload persistence | NOT VERIFIED | Needs live DB |
| 17 | Cancel + terminal state | WORKING (logic) | stop-all proven vs fakes; live choreography NOT VERIFIED |

Overall journey: **PARTIAL** — every provable half is proven with real execution; the live connected chain awaits staging infra. CLOUD-only fallback remains GO.

STOP — working tree left for review, uncommitted, undeployed.
