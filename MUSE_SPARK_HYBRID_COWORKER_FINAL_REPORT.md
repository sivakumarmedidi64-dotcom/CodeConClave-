# MUSE SPARK + HYBRID AI COWORKER — FINAL EVIDENCE REPORT

Branch: `temporary-demo-mode` @ `9a4b33b`. **No deploy, no commit, no push, no production-config change, no billable API calls.** All pre-existing uncommitted work preserved (working tree intact; only the files listed in §1 added/modified).

Status vocabulary: `WORKING` / `PARTIAL` / `BROKEN` / `CONFIGURATION REQUIRED` / `NOT VERIFIED`.

---

## 1. Codebase baseline and files changed (this pass only)

**Modified (9):**

- `shared/src/constants.ts` — added `MUSE_SPARK: 'muse_spark'` to `ProviderId` (+ rebuilt `shared/dist`, gitignored build artifact).
- `backend/src/config/env.ts` — added `MUSE_SPARK_API_KEY` (optional) + `MUSE_SPARK_ENABLED` (default `'false'`).
- `backend/src/modules/ai/providers.ts` — `MUSE_SPARK_BASE/CHAT_URL/DEFAULT_MODEL`, `museSparkAdapter()`, `museSparkEnabled()`, `getAdapter` case with flag-first gate.
- `backend/src/modules/ai/registry.ts` — key map entry + `configuredProviders()` excludes `muse_spark` while the flag is off.
- `backend/src/modules/ai/providerKeySpec.ts` — `EXISTING_PROVIDER_IDS` + key map (no `NEW_PROVIDER_KEY_SPEC` change: that array pins the historical Prompt-3 seven).
- `backend/src/modules/ai/capabilities.ts` — `muse_spark` in `VERIFIED_PROVIDERS` (endpoint-identity semantics only; see §2).
- `backend/src/modules/operations/service.ts` — operations key map entry.
- `.env.example` — documented `MUSE_SPARK_API_KEY` / `MUSE_SPARK_ENABLED=false`.
- `backend/src/foundation/ai-transparency-26.test.ts` — expected snapshot list + `muse_spark` (new union member flows into the snapshot).

**Added (3):**

- `backend/src/modules/ai/muse-spark.test.ts` — 14 mocked provider tests.
- `database/migrations/0145_muse_spark_provider.sql` — CHECK-constraint extension + `muse-spark-1.3` seed (NOT applied: no DB in this environment).
- `local-agent/src/foundation/local-workspace-e2e.test.ts` — 10 real device-side E2E proofs.

**Test-only content fix (1):** `local-agent/src/foundation/local-workspace-e2e.test.ts` canary reworded after the repo secret-scanner flagged its first draft (`generic_api_key` fixture shape). No source behavior changed.

---

## 2. Muse Spark provider — `PARTIAL` (code `WORKING`, live call `CONFIGURATION REQUIRED`)

- **API/config:** base `https://api.meta.ai/v1`, endpoint `POST /chat/completions`, Bearer auth, default model `muse-spark-1.3` — verified against the official Meta Model API docs (`dev.meta.ai/docs/protocols/chat-completions`: OpenAI-compatible, SSE streaming, tool calling, `response_format` structured output, usage with reasoning tokens, 429-retry guidance, never-retry-400). No undocumented capability used. Computer control is NOT advertised: the adapter is a text/streaming/tool-call provider only; all execution still passes through CodeConClave tools + permission engine.
- **Endpoint identity:** live unauthenticated TLS/HTTP probe → host resolves, `GET /v1` answers HTTP 404 (no credentials sent, nothing billable). Real-call verification pending.
- **Flag discipline:** `MUSE_SPARK_ENABLED=false` default. Flag off → `getAdapter` throws `provider_not_configured` before any network I/O; `configuredProviders()` excludes it so default routing is byte-identical. Key absent → status `NOT_CONFIGURED` / key-state `MISSING_KEY` (never `CONNECTED`/`AVAILABLE`).
- **Gateway reuse (no parallel stack):** timeout/cancellation via `attemptSignal` + chain deadline, 429/`Retry-After` via `httpError`, fallback chain + `provider_not_configured` skip, health via `updateProviderHealth`/`deriveStatusFromFailure`, usage/cost logging, typed tool-call flow (`supportsToolCalls: true` per documented tool support), key never logged (test-asserted).
- **Tests:** `muse-spark.test.ts` **14/14** — flag-off/flag-on-no-key (zero fetch calls), SSE text+usage, 429+hint, 401, HTTP-200-non-SSE-is-failure, abort→timeout, key-state honesty, key non-leakage. All HTTP mocked; **zero billable calls**.
- **Regression:** all provider/affected suites green — §12.
- **Remaining:** authorized live smoke test (needs `MUSE_SPARK_API_KEY` + written spend approval — NOT performed); apply migration 0145 in a DB-backed environment; add `muse_spark` to `AI_PROVIDERS_ENABLED` where desired.

## 3. Web → local files — `PARTIAL` (device half `WORKING`, transport leg `NOT VERIFIED`)

- Bridge (`backend/src/modules/local-workspace`: devices/workspaces/tree/file PUT/file/exec) + agent enforcement (`policy.ts`, `files.ts`, `terminal.ts`, `index.ts` handlers) + `LocalWorkspacePanel` wired into `WorkbenchPage` — all present, unchanged, panel tests green (§12).
- **New real proof** (`local-workspace-e2e.test.ts`, **10/10**): real temp project → browse tree → read file (content+sha256) → real unified diff → permitted edit verified byte-for-byte on disk → rollback recovery via backup → allow-listed `echo` through BOTH gates with real PowerShell stdout + exit 0 → failing-command honesty (dual-gate refusal documented) → traversal/`.env`/dangerous/unknown/nested-shell denials, canary non-exposure. Genuine fs/process I/O, nothing mocked.
- **NOT VERIFIED:** the Web→WS→device transport (`pair → task waiting → claim → result` over a live socket) — no Postgres/Redis/running backend/pairing infra exists in this environment (all ports closed, no `.env`). No fake success substituted.

## 4. LOCAL dispatch/recovery — `PARTIAL`

- Dispatcher, idempotent assignment, claim/lease/fencing, heartbeat, progress/artifact/result, cancel, recovery sweep (`dispatch.ts`, `tasks.ts`, `ws.ts`, migration 0143) unchanged from P0; `dispatch.test.ts` **16/16**, `local-tasks.test.ts` included in agent suite, orchestration/state-machine suites green inside the full backend run.
- **NOT VERIFIED live** (same missing-infra reason as §3). LOCAL work is never routed to CLOUD as a workaround — the code paths are separate and the flag-off behavior denies honestly.

## 5. Browser automation — `PARTIAL` (device execution `WORKING`, Web-dispatched run `NOT VERIFIED`)

- **Real proof:** `src/browser/controller.e2e.test.ts` **3/3** against a REAL headless Chrome (found on this host): full happy-path instruction with real artifacts (PNG magic/sha256/bytes) + honest password-field denial + third case. Fixture server is loopback-only; no external egress. Mode 2 (user's own authenticated tabs) remains explicitly unimplemented/denied.
- Backend validation (`browser-policy`), `BrowserTaskPanel` (device picker, authoring, gate-denial surfacing) green (§12). The Web→paired-device dispatched browser run needs live pairing infra → `NOT VERIFIED`; no mock completion exists anywhere in the path.

## 6. Live Preview — `CONFIGURATION REQUIRED` (honesty logic `WORKING`)

- `preview-25.test.ts` **15/15**: `previewConfigured()` false by default, session honestly `NOT_CONFIGURED` without tooling, `BUILDING→READY` with tooling, `ERROR` on build failure, missing-workspace honesty. `PreviewPanel`/`WorkPage` render the `NOT_CONFIGURED` state with setup guidance (no fake render).
- No real application was built/rendered here: `PREVIEW_BUILD_ENABLED=false` default and no preview workspace configured. Local-first implementation path stands; production preview needs `PREVIEW_*` configuration (unchanged, undocumented-values-not-invented).

## 7. Desktop control — `PARTIAL` (policy+runner `WORKING`, real-app E2E `NOT VERIFIED`)

- Backend `desktop-policy.test.ts` **13/13**; agent `desktop/runner.test.ts` **12/12** (allowlist, platform guard, error codes). Narrow contract only (`list_windows`/`open_app`/`focus_window` on allow-listed apps); no global keyboard/mouse endpoint; every action behind auth/device-ownership/permission/audit.
- No real application was launched in this pass (deliberate: unsafe to open apps as a side effect of verification). Real desktop E2E `NOT VERIFIED`.

## 8. Unified action runtime — `WORKING` (gated, UI-wired)

- `actions/service.test.ts` **9/9** (master gate, per-surface gates, same-policy validation, real task-fabric routing, device-ownership check). `ActionRuntimePanel` wired into `WorkbenchPage`; panel tests green. No competing orchestrator: CLOUD→coworker pipeline, LOCAL/BROWSER/DESKTOP→LOCAL task with validated instruction; audit `UNIFIED_ACTION_ROUTED`. PREVIEW is intentionally NOT a runtime surface (preview has its own build service; adding it would invent a routing semantic) — documented gap, not a silent substitution.

## 9. Workbench integration — `WORKING` (as far as infra allows)

- `WorkPage` (BrowserTaskPanel + Live Preview status/refresh/open) and `WorkbenchPage` (Preview + LocalWorkspace + ActionRuntime tabs) consume real APIs; SSE + persisted-state-first recovery; honest empty/denied/unconfigured states. Panel/page tests **33/33**. Reload-persistence against a live backend is `NOT VERIFIED` (no DB here); no fixture rows in production paths.

## 10. Verification, memory, audit — `WORKING` (existing systems, untouched)

- Completion invariant holds (verifier executes + persists real artifact content; `COMPLETED` only on earned verification). Full backend suite covers state-machine, fencing, verification, review, memory/DNA, audit, RLS. This pass added no parallel completion mechanism and stored no memory entries.

## 11. Security / RLS — `WORKING` (plus one found-and-fixed finding)

- `security-15`, pairing/RLS, policy, browser/desktop-policy, attempt-fencing suites all green inside the full runs. Denials proven for real (§3, §5).
- **Found & fixed:** repo-wide `secret:scan` initially flagged the new test's `.env` canary (`generic_api_key` shape). Fixed by rewording the canary (no behavior change); rescan: **files=1271, findings=0, exit 0**; `secret-scan.test.ts` **3/3**.
- Revocation/kill-switch paths are pre-existing and untouched; cross-user device/task and traversal cases covered by existing suites (green).

## 12. Test/typecheck/build evidence

| Suite | Result |
|---|---|
| Backend full (`vitest run`, node on PATH) | **4344 passed, 76 skipped, 1 failed → fixed** (secret-scan fixture; re-verified 3/3 + scan exit 0) |
| Backend `tsc --noEmit` | **exit 0** |
| New `muse-spark.test.ts` | **14/14** (all HTTP mocked) |
| Local-agent full | **120/121** — 1 pre-existing environmental flake (`terminal.test.ts` TIMED_OUT on non-TTY Windows; file untouched, reported in P0–P2) incl. new **10/10** real E2E + **3/3** real-Chrome E2E + **12/12** desktop runner |
| Local-agent `tsc --noEmit` | **exit 0** |
| Frontend panels/pages (5 files) | **33/33** |
| Frontend `tsc --noEmit` | **exit 0** |
| Preview honesty `preview-25` | **15/15** |
| Desktop policy (backend) | **13/13** |
| Actions runtime | **9/9**; dispatch **16/16**; local-workspace svc **8/8** |
| Secret scan (repo-wide) | **0 findings** |

Node runtime used: `codex-primary-runtime node v24.19.0` (no system node on PATH; sandbox-spawning suites run with it prepended to PATH). CLOUD pipeline, heartbeat/fencing, auth/RLS, demo-mode suites all inside the green backend run. Migration 0145 NOT applied (no database); its column list mirrors 0128 exactly.

## 13. Failed / partial / unavailable / untested

- `PARTIAL`: Muse Spark (live call pending), Web→local (transport), LOCAL lifecycle (live), browser (Web-dispatched), desktop (real-app), action-runtime PREVIEW surface (by design — see §8).
- `CONFIGURATION REQUIRED`: Muse Spark credentials+flag, Live Preview tooling (`PREVIEW_*`), Kuberns adapter (honest boundary, unchanged).
- `NOT VERIFIED` (all for missing-infra reasons, none papered over): full Web→device chains, live LOCAL task lifecycle, Web-dispatched browser run, real preview render, real desktop app control, reload-persistence against live backend, billable Muse Spark smoke test.
- `BROKEN`: none found. Pre-existing flakes carried: `terminal.test.ts` TIMED_OUT (environmental), deployment-wizard missing tables (pre-existing, untouched).

## 14. Credentials / infrastructure still required

1. `MUSE_SPARK_API_KEY` + `MUSE_SPARK_ENABLED=true` + `muse_spark` in `AI_PROVIDERS_ENABLED` + apply migration 0145 + authorized spend approval for the smoke test.
2. Postgres + Redis + running backend + paired local-agent + project grants for live LOCAL/Web→file/browser chains.
3. Chrome/Edge on the paired device (present here; needed wherever browser runs execute).
4. `PREVIEW_BUILD_ENABLED=true` + `PREVIEW_BUILD_COMMAND` + `PREVIEW_PROJECTS_ROOT` for Live Preview.
5. Windows GUI session + allow-listed apps (`DESKTOP_ALLOWED_APPS`) for real desktop E2E.

## 15. Exact remaining work

1. Authorized Muse Spark smoke test → flip key-state to VERIFIED on success; record usage/cost sample.
2. Stand up DB-backed staging → run live pairing → Web→file edit+diff+command → LOCAL lifecycle → Web-dispatched browser run → preview build+render → desktop allow-list action → cross-surface objective with verification + artifact + audit → reload-persistence check.
3. Apply 0145 via normal migration tooling (never hand-edited prod DB).
4. Saturday-demo rehearsal from a clean start with the CLOUD fallback armed (untouched).

---

## Definition-of-success verdict

One coworker that plans, picks an authorized surface, uses real tools, recovers, verifies, artifacts, memorizes, and audits: **the control plane, policies, panels, and verification gates are real and tested; the device-side execution halves are proven with genuine I/O; the live connected chains await staging infra and are honestly marked, not claimed.**

STOP — working tree left for review, uncommitted, undeployed.
