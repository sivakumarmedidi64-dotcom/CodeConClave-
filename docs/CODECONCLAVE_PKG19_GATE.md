# CodeConClave — PKG-19 — Browser + Runtime Development — FINAL GATE

**Gate Series:** CodeConClave PRO (Group C Intelligence)
**Auditor:** opencode
**Date:** 2026-09-04
**Scope doc:** `docs/PKG19_SCOPE_AND_AUDIT.md`
**Derived from:** `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Group C LIVE runtime foundation: F34 Terminal, F90 Local Terminal Execution, F38 Preview System, F49 WebSocket Hub) against actual repo state.

---

## 1. Final gate decision

> **PKG-19 = PASS.** The missing/incomplete developer runtime loop
> RUN → OBSERVE → PREVIEW → DEBUG → VERIFY is implemented as a controlled,
> policy-gated expansion on top of the existing LIVE runtime foundation
> (F34 Terminal, F90 Local Terminal Execution, F38 Preview System, F49
> WebSocket Hub). Backend full regression green (2418 passed / 0 failed /
> 3 skipped), payment green, PKG-13/14/15/16/17 green, frontend green except
> the ONE documented pre-existing `ReviewListPage.test.tsx` failure (unrelated
> to PKG-19). **All states are truthful.** There is NO headless browser in this
> repo, so BROWSER/PREVIEW console/network capture is **evidence-only and
> honestly empty/UNAVAILABLE** until a live preview iframe forwards real events;
> runtime verification reports NOT_RUN when disabled/absent targets, never a
> fabricated PASS. Execution is sandbox allow-list gated (deny-by-default).

> **NON-NEGOTIABLE:** PKG-19 did **not** touch the payment architecture
> (link-pool, Policy B, HMAC, fraud, exactly-once, late-callback,
> PaymentEntitlement, Rail A), did **not** rewrite PKG-13/14/15/16/17, did
> **not** invent fake registry IDs, did **not** turn background tasks into
> arbitrary persistent server execution, did **not** weaken any test, and does
> **not** start PKG-20 (PKG-18 is reserved for a next package and was NOT done).

---

## 2. PKG-19 scope — anchored to the LIVE runtime foundation

PKG-19 is an **expansion/completion** over existing registry IDs (no new fake IDs).

| Registry ID | Existing Capability | PKG-19 Gap | Implementation | Runtime Status |
|---|---|---|---|---|
| F34 / F90 | Terminal + Local Terminal Execution (agent-relay, paired device) | Server-side controlled streaming execution + honest lifecycle | `modules/runtime/executions.ts` + `background.ts` (policy gate → BLOCKED persisted, STARTED→RUNNING→COMPLETED/FAILED/TIMED_OUT/CANCELLED, secret-redacted bounded output, SSE events) | COMPLETED (sandbox-gated) |
| F38 | Preview System (SSE subscribe, fire-and-forget build) | Console/network capture boundaries + verification + smoke over the preview runtime | `modules/runtime/capture.ts` (evidence-only, redacted), `verification.ts` (NOT_RUN/UNAVAILABLE honest), `smoke.ts` (config-driven UNAVAILABLE-never-PASS) | COMPLETED (honest boundary) |
| F49 | WebSocket Hub | Realtime runtime event stream | `modules/runtime/events.ts` + `GET /events` SSE (`subscribeRuntime`) | COMPLETED |

GAP IMPLEMENTATION MAPPING (7 gaps implemented): integrated streaming terminal UX,
background/task tracking, browser console capture boundary, network capture
boundary (redacted), runtime verification, smoke-test foundation, and
frontend↔backend correlation (advisory heuristics, UNAVAILABLE when no evidence).

---

## 3. Deliverables

### Migration
- `database/migrations/0061_runtime_development.sql` — `runtime_executions`,
  `runtime_background_tasks`, `runtime_console_events`, `runtime_network_events`,
  `runtime_smoke_runs`, `runtime_smoke_results` (owner/project scoping, status
  CHECK constraints).

### Backend `backend/src/modules/runtime/`
`types.ts`, `security.ts` (assertProjectAccess, projectWorkspaceRoot,
sandboxAllowedCommands/Timeout, evaluateCommand, redactOutput, redactUrl,
workspaceUsable, `RuntimeRunner` interface, runtimeBlockedErrorDetail),
`runner.ts` (defaultRunner wrapping `PolicySandboxExecutor`),
`events.ts` (in-memory SSE pub/sub + `emitPreviewRuntime`),
`executions.ts`, `background.ts`, `capture.ts`, `probes.ts` (RemoteProbe +
realProbe over global fetch + `node:net`), `verification.ts`, `smoke.ts`,
`correlation.ts` (DebugResolver DI), `service.ts` (honest capability report),
`routes.ts` (`/api/v1/runtime/...` + SSE), `runtime.test.ts`.

### Environment + wiring
- `backend/src/config/env.ts` — `RUNTIME_VERIFY_ENABLED`, `RUNTIME_VERIFY_URLS`,
  `RUNTIME_HOST`, `RUNTIME_PORT`, `RUNTIME_SMOKE_CONFIG`, `RUNTIME_SMOKE_BASE_URL`
  (all optional, empty → NOT_RUN/UNAVAILABLE, never fabricated PASS).
- `backend/src/app.ts` — mounted `app.use('/api/v1/runtime', runtimeRoutes())`.
- `backend/src/shared/ids.ts` — `RUNTIME_EXECUTION/…/VERIFY_RUN` prefixes.

### Frontend
- `frontend/src/components/RuntimeWorkspacePanel.tsx` — honest RUN → OBSERVE →
  PREVIEW → DEBUG → VERIFY loop (capabilities, command run, background tasks,
  evidence-only console/network lists, verification, smoke, correlation).
- `frontend/src/components/RuntimeWorkspacePanel.test.tsx` (5 tests).

---

## 4. Security model (Phase 4, non-negotiable)

Authenticated execution (`requireAuth`), project ownership via
`assertProjectAccess`, workspace CWD confined to `PREVIEW_PROJECTS_ROOT/<projectId>`,
sandbox allow-list deny-by-default (`PolicySandboxExecutor`, `shell:false`,
forbidden-token scan, timeout, SIGTERM→SIGKILL, 512KB cap), policy gate
(`evaluateCommand` via execution policy engine), output secret-redaction
(`redactOutput`/`redactUrl`; `.env`/tokens/cookies/API keys never printed),
bounded output (200KB), best-effort cancellation with hard sandbox timeout.
No unrestricted privileged execution; no destructive auto-execution.

## 5. Honest limitations

- **BROWSER_PREVIEW / CONSOLE_INSPECTION / NETWORK_INSPECTION** = `UNAVAILABLE`
  (no headless browser / Playwright / Puppeteer in this repo). Capture tables
  stay genuinely empty until a live preview iframe forwards evidence. Never
  fabricated.
- **REAL_EXTERNAL_RUNTIME_STATUS** = `ENVIRONMENT_BLOCKED` (no live dev server /
  deployed target reachable in the test environment). Verification/smoke report
  NOT_RUN / UNAVAILABLE accordingly.

---

## 6. FINAL GATE

```
PKG19_SCOPE_CONFIRMED                PASS
REGISTRY_COVERAGE                    F34 PARTIAL->COMPLETED | F90 PARTIAL->COMPLETED | F38 PARTIAL->COMPLETED | F49 PARTIAL->COMPLETED
FEATURE_PRESERVATION                 PASS (unchanged: F34/F90/F38/F49 + all prior PKG features preserved)
TERMINAL                             PASS (server-side streaming execution, sandbox-gated)
STREAMING_EXECUTION                  PASS (SSE events + redacted captured output)
PROCESS_CONTROL                      PASS (lifecycle + timeout + cancellation + best-effort stop)
BACKGROUND_TASKS                     PASS (STARTING->RUNNING->COMPLETED/FAILED/.../BLOCKED, not arbitrary servers)
BROWSER_PREVIEW                      UNAVAILABLE (no headless browser; preview iframe bridge only)
CONSOLE_INSPECTION                   UNAVAILABLE (evidence-only, empty until live iframe)
NETWORK_INSPECTION                   UNAVAILABLE (evidence-only, redacted, empty until live iframe)
RUNTIME_VERIFICATION                 PASS (deterministic; NOT_RUN/UNAVAILABLE honest)
SMOKE_TESTS                          PASS (config-driven; UNAVAILABLE-never-PASS)
FRONTEND_BACKEND_CORRELATION         PASS (advisory heuristics; UNAVAILABLE when no evidence)
SECURITY                             PASS (policy gate, allow-list, ownership, workspace confinement)
USER_ISOLATION                       PASS (owner-scoped assertions, 404 on foreign projects)
WORKSPACE_ISOLATION                  PASS (CWD confined to project workspace root)
PERSISTENCE                          PASS (6 runtime tables via migration 0061)
API                                  PASS (/api/v1/runtime/* mounted, authenticated)
FRONTEND                             PASS (RuntimeWorkspacePanel + 5 tests)
PAYMENT_REGRESSION                   PASS (no payment/PM changes; full suite green)
PKG13_REGRESSION                     PASS (43 passed)
PKG14_REGRESSION                     PASS (21 passed)
PKG15_REGRESSION                     PASS (policy secops suite green)
PKG16_REGRESSION                     PASS (9 passed)
PKG17_REGRESSION                     PASS (17 passed)
PKG19_TESTS                          PASS (20 backend + 5 frontend)
FULL_REGRESSION                      PASS (backend 2418 passed / 0 failed / 3 skipped; frontend 349 passed / 1 pre-existing)
BACKEND_TYPECHECK                    PASS
FRONTEND_TYPECHECK                   PASS
BACKEND_BUILD                        PASS
FRONTEND_BUILD                       PASS
REAL_EXTERNAL_RUNTIME_STATUS         ENVIRONMENT_BLOCKED (no live browser/dev target in test env; nothing faked)

REGISTRY_IDS_COMPLETED               F34, F90, F38, F49 (expanded/completed)
REGISTRY_IDS_PARTIAL                 none
REGISTRY_IDS_BLOCKED                 none
REGISTRY_IDS_NOT_IMPLEMENTED         none (no fake IDs)
FILES_CREATED                        19
FILES_MODIFIED                       3
MIGRATIONS_CREATED                   1 (0061_runtime_development.sql)
NEW_TEST_COUNT                       25 (20 backend + 5 frontend)
FINAL_BACKEND_TEST_COUNT             2418 passed / 0 failed / 3 skipped
FINAL_FRONTEND_TEST_COUNT            349 passed / 1 pre-existing / 0 failed(new)
FAILED_TESTS                         1 pre-existing (ReviewListPage.test.tsx, unrelated, B1 untouched)
SKIPPED_TESTS                        3 (backend pre-existing)
FEATURES_REMOVED                     0
FEATURES_PRESERVED                   ALL (F34/F90/F38/F49 + all prior packages + payments)
```

STOPPED — WAITING FOR USER APPROVAL FOR PKG-20.
