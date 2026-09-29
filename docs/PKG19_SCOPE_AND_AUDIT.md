# CodeConClave — PKG-19 — BROWSER + RUNTIME DEVELOPMENT — Scope & Audit

**Package:** PKG-19 (CodeConClave PRO, Group C / core runtime expansion)
**Theme:** BROWSER + RUNTIME DEVELOPMENT — the developer runtime loop RUN → OBSERVE → PREVIEW → DEBUG → VERIFY
**Auditor:** opencode
**Date:** 2026-09-04
**Anchored to:** existing canonical registry runtime foundation, extended (never rebuilt).

---

## 1. Anchoring decision (derived from canonical registry + repo audit)

The BROWSER + RUNTIME DEVELOPMENT theme does **not** map to a distinct numbered
Group-C intelligence cluster. The canonical registry already represents the live
runtime foundation under explicit IDs. PKG-19 is an **expansion/completion layer**
anchored to those parents — it does **not** invent new registry IDs and does **not**
rebuild the parents.

**REGISTRY_ANCHORS (primary):**

| Anchor | Capability | Existing source (reused, NOT rebuilt) |
|---|---|---|
| F34 | Terminal | `backend/src/modules/terminal/{routes,service,store}.ts` — agent-relay sessions, policy-gated |
| F90 | Local Terminal Execution | `backend/src/os/sandbox.ts` `PolicySandboxExecutor` + `modules/execution/policy.ts` + `os/{lifecycle,git}.ts` |
| F38 | Preview System (SSE) | `backend/src/modules/preview/{service,routes}.ts` + `frontend/src/components/PreviewPanel.tsx` |
| F49 | WebSocket Hub | `backend/src/modules/agent/ws.ts` / `agent/browser.ts` + SSE precedents (`preview/service.ts` `subscribePreview`) |

**Secondary anchors (read-only intelligence reuse):**
- `modules/developer-workflow/contextualDebug.ts` (PKG-17, #41) — runtime-debug correlation evidence
- `health/health.ts` `computeHealth()` + `/health`,`/healthz`,`/ready` — runtime verification inputs
- `quality-intelligence/security.ts` source-intake containment — reuse patterns for redaction

---

## 2. Audit summary (Phase 2 — what EXISTS vs what is MISSING)

| Area | Exists (reuse) | Missing (PKG-19 gap) |
|---|---|---|
| Terminal | F34 agent-relay sessions, policy engine, history store, logs | Integrated **server-side streaming** UX with lifecycle states, background/task tracking, secret redaction on capture |
| Command execution | F90 `PolicySandboxExecutor` (deny-by-default, timeout, SIGTERM→SIGKILL, output cap) | Execution **records**, streaming, cancellation by the browser, background dev-task lifecycle |
| Browser/Preview | F38 preview sessions + SSE + sandboxed `/content` (CSP) + `PreviewPanel` iframe | **Console capture** and **network/runtime capture** from the running preview |
| Runtime observation | `/health`,`/healthz`,`/ready`, `computeHealth()`, watchdog, frontend E2E smokes | Runtime **verification**, **smoke-test foundation**, **frontend/backend correlation** |
| Realtime | F49 `/agent`,`/agent-browser` WS + preview SSE | Runtime event SSE hub (execution/task/preview/verification) |

**Honest runtime limitation:** there is **no headless browser / Playwright / Puppeteer**
in the repo. PKG-19 therefore implements console & network capture as **honest capture
boundaries** — evidence is only ever what a live preview iframe forwards; nothing is
fabricated, and these surfaces are `UNAVAILABLE`/empty until real evidence arrives.

---

## 3. PKG-19 scope table

| Registry ID | Capability | Current Status | Existing Code | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|---|
| F34 | Terminal | PARTIAL (agent-relay) | `modules/terminal/*` | server-side streaming UX + lifecycle + redaction | Runtime execution endpoints + SSE stream + redaction | ENABLED (sandbox allow-list gated) / BLOCKED when unconfigured |
| F90 | Local Terminal Execution | PARTIAL (sandbox exists) | `os/sandbox.ts`, `os/lifecycle.ts` | execution records, background tasks, cancellation, timeout | `runtime_executions` + `runtime_background` tables + engine | ENABLED / BLOCKED when unconfigured |
| F38 | Preview System (SSE) | LIVE (build/SSE/content) | `modules/preview/*` | console + network capture | capture boundary endpoints + persistence | VERIFIED (capture) / UNAVAILABLE until evidence |
| F49 | WebSocket Hub | LIVE (`/agent`) | `modules/agent/*` | runtime event SSE hub | runtime event bus + SSE | ENABLED |
| (additive) | Runtime Verification | MISSING | `health/health.ts` | deterministic runtime checks | verification endpoints (PASS/FAIL/BLOCKED/NOT_RUN/UNAVAILABLE) | ENABLED |
| (additive) | Smoke-Test Foundation | MISSING | `frontend/e2e/*` | config-driven smoke suite | smoke runner + persisted results | ENABLED / UNAVAILABLE when no target |
| (additive) | Frontend↔Backend Correlation | MISSING | `developer-workflow/contextualDebug.ts` | correlate capture+logs | correlation endpoint (advisory) | HEURISTIC / PARTIAL |

---

## 4. PKG-19 GAP IMPLEMENTATION MAPPING

| Parent Registry ID | Existing Capability | PKG-19 Gap | Implementation | Runtime Status |
|---|---|---|---|---|
| F34 | Terminal | Integrated streaming terminal UX | `runtime` POST /executions (SSE streamed), GET /executions, cancel | ENABLED / BLOCKED when unconfigured |
| F90 | Local Terminal Execution | Background/task execution tracking | `runtime_background` lifecycle (start/status/stop/cancel) | ENABLED / BLOCKED when unconfigured |
| F38 | Preview System | Browser console capture | `runtime` console capture boundary + persistence | VERIFIED(capture)/UNAVAILABLE until evidence |
| F38 | Preview System | Network/runtime capture | `runtime` network capture boundary + redaction + persistence | VERIFIED(capture)/UNAVAILABLE until evidence |
| F38 | Preview System | Runtime verification | `runtime` verification checks (PASS/FAIL/BLOCKED/NOT_RUN/UNAVAILABLE) | ENABLED |
| F49 | WebSocket Hub | Runtime event stream | `runtime` SSE event hub (execution/task/preview/verification) | ENABLED |
| F49 | WebSocket Hub | Frontend↔backend correlation | `runtime` correlation endpoint (advisory, evidence-gated) | HEURISTIC / PARTIAL |

---

## 5. Out of scope (preserved, NOT touched / NOT rebuilt)

- **Payment architecture** (link-pool, Policy B, HMAC, fraud, exactly-once, `PaymentEntitlement`, Rail A) — untouched.
- **PKG-13/14/15/16/17** modules committed by prior gates — untouched except read-only reuse.
- **Existing `modules/terminal`, `modules/preview`, `os/sandbox`, `modules/agent`** — reused as-is; PKG-19 adds a new sibling `runtime` module rather than editing parents (except additive mount in `app.ts` + new id prefixes).
- No **privacy/secret** value is ever returned (redaction + never log bodies by default).
- No **unrestricted/privileged execution**; every command goes through `PolicySandboxExecutor` deny-by-default + policy engine.
- PKG-19 does **not** start PKG-20.

---

## 6. Security model (Phase 4/5)

- **Authenticated + project-owned:** every `runtime` route `requireAuth` + `assertProjectAccess(userId, projectId)` (project.owner_id), mirroring the established app-level isolation.
- **Deny-by-default execution:** commands execute only via `PolicySandboxExecutor` under `AIOS_SANDBOX_ALLOWED_COMMANDS`; unauthorized/forbidden → `BLOCKED` (never silently run, never faked PASS).
- **Forbidden/dangerous commands** (`dangerousCommand`, secret-path patterns) rejected before execution.
- **Secret redaction:** captured output runs through a redactor that masks `.env`/token/api-key/password/secret patterns and payment identifiers; sensitive request bodies are **not** logged by default.
- **CWD restriction:** execution `cwd` is confined to the project workspace path; path traversal rejected.
- **Timeout + resource:** `AIOS_SANDBOX_TIMEOUT_MS` + sandbox output cap; long-running tasks are tracked not unbounded.
- **Idempotent, honest:** statuses PASS/FAIL/BLOCKED/NOT_RUN/UNAVAILABLE are exact; an unavailable check is never converted to PASS.

---

## 7. Deliverables

- `docs/PKG19_SCOPE_AND_AUDIT.md` (this file)
- `database/migrations/0061_runtime_development.sql` (+ optionally `0062`) — persisted executions/tasks/console/network/smoke; idempotent, RLS stayed app-level (mirror secops/scoping)
- `backend/src/modules/runtime/` — `types.ts`, `security.ts` (redaction + project access + policy helpers), `executions.ts`, `background.ts`, `capture.ts` (console+network), `verification.ts`, `smoke.ts`, `correlation.ts`, `service.ts`, `events.ts` (SSE hub), `routes.ts`, `runtime.test.ts`
- `backend/src/app.ts` — additive mount `/api/v1/runtime`
- `backend/src/shared/ids.ts` — new `RUNTIME_*` prefixes
- `frontend/src/components/RuntimeWorkspacePanel.tsx` + `.test.tsx`
- `docs/CODECONCLAVE_PKG19_GATE.md`

---

## 8. Testing plan

Vitest (`--maxWorkers 2`): execution allowed/denied/blocked, streaming, lifecycle states,
timeout, cancellation, secret redaction, workspace isolation, background task lifecycle,
console/network capture (evidence-only, honest empty), verification statuses, smoke
execution + unavailable, correlation advisory, authorization, malformed requests,
idempotency, resource limits. `NO_TESTS_WEAKENED = TRUE`.

## 9. Known limitations (honest)

- No headless browser → console/network are **capture boundaries**, real only when a live preview iframe forwards evidence.
- Server-side execution only runs commands under the configured sandbox allow-list; otherwise reports `BLOCKED` (no fake success).
- Runtime verification/smoke targets depend on configured URLs/ports; absent → `UNAVAILABLE`, never PASS.
