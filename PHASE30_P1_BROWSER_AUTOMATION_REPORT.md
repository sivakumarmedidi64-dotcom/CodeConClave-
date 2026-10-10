# CodeConClave — Phase 30 (P1) Paired-Device Browser Automation Report

Status: **DONE — awaiting P2**. No deploy/commit/push performed (per standing instructions).

## Objective

Give a CodeConClave Web/Desktop user the ability to drive a **real browser on their paired device**, securely, reusing the P0 local-execution fabric (dispatch → assignment → lease → agent WebSocket → audit), with the whole capability **feature-gated off** by default.

## A — Scope delivered

- Backend browser-task dispatch + instruction validation for the existing `LOCAL` execution path.
- A local-agent **CDP (Chrome DevTools Protocol) bridge** that launches a managed headless browser and executes a bounded, validated action list.
- A Web/Desktop UI (`BrowserTaskPanel`) to pick a device, author an instruction, dispatch it, and monitor the assignment live.
- Feature gate `BROWSER_CONTROL_ENABLED` (default `false`) wired end to end; disabled deployments report the denial honestly.

## B — Server / backend

- `backend/src/modules/agent/dispatch.ts`
  - New `POST /api/v1/execution/tasks` accepts `localInstruction` + `deviceId` for `executionMode: LOCAL`.
  - Browser instruction is fully re-validated server-side (ops, per-op field requirements, ≤20 actions, ≤20 origins, selector/url/text length bounds, lifetime clamp ≤30d).
  - Consequential ops (click/type/select/submit/download/upload) force `riskLevel: HIGH` and an approval gate; read-only instructions stay `MEDIUM`.
  - `browser_action_failed` handled per §10 failure rules: non-retryable ops → `DEAD_LETTERED` (even with budget left); retryable ops → re-park while approval budget remains.
  - Lease/fencing reused from P0 so stale devices cannot act on an expired assignment.
  - `browser_control_disabled` (403) surfaced when the gate is off.
- `backend/src/modules/agent/service.ts` — `deviceId` honoured on dispatch; device capability match enforced.
- Shared contract (`shared/src/constants.ts`, rebuilt to `dist`): `BrowserCapability` (9 values: browser.open/navigate/read/inspect/click/type/submit/download/upload) and `BrowserActionOp` (17 ops: open, navigate, back, forward, reload, read, inspect, search, extract, scroll, click, type, select, submit, screenshot, download, upload). Server is the source of truth for validation.

## C — Local agent (CDP bridge)

- `local-agent/src/browser/launch.ts` — resolves a Chrome/Edge binary, launches a managed headless instance with an isolated temp profile and a **loopback-only** debug port.
- `local-agent/src/browser/cdp.ts` — minimal, dependency-free CDP client over the existing `ws@^8.18.0` dependency.
- Action executor covers all 17 ops, including `screenshot` (PNG + sha256), `download` (files captured via CDP), and `search` (on-page text search).
- `local-agent/src/browser/contract.ts` — validates the instruction locally **in addition** to the server (defence in depth) before any network action.
- Browser lifecycle tied to the assignment; the process is torn down on completion/failure. Nothing is launched when the gate is off.

## D — Security model

- **Origin allow-list** — only origins explicitly present in `grants.allowedOrigins` may be navigated to; no implicit access.
- **Consequential-action approval** — destructive/interactive ops are blocked behind the same human approval gate used by P0 high-risk tasks.
- **Length + count bounds** — selector ≤512, url ≤2048, text ≤4096, ≤20 actions, ≤20 origins; lifetime clamped to 30 days.
- **Deny-by-default gate** — `BROWSER_CONTROL_ENABLED=false` yields no browser launch and a clean `browser_control_disabled` response.
- **Audit** — dispatch, approval, and per-action outcomes are recorded through the existing P0 audit trail; no fabricated results.

## E — Frontend / Web + Desktop

- `frontend/src/lib/browserInstruction.ts` — pure builder that mirrors the shared contract (ops, bounds, origin derivation, summarisation) because the frontend does **not** depend on `@codeconclave/shared`; the server re-validates, so drift is rejected rather than trusted.
- `frontend/src/components/BrowserTaskPanel.tsx`
  - Device picker listing only online devices (`GET /api/v1/agent/status`).
  - Action-row editor with per-op dynamic fields, risk derivation, dispatch via `POST /api/v1/execution/tasks`, and honest surfacing of `browser_control_disabled`.
  - Active-task monitor refreshing via `GET /api/v1/execution/tasks/:id/local`, showing assignment/lease/progress/result/error and artifact refs; live updates over SSE (`workbenchStream`).
- `frontend/src/pages/WorkPage.tsx` — panel wired in above the task list.
- Desktop consumes the same Web build; no desktop-only code path added.

## F — Verification

| Suite | Command | Result |
|---|---|---|
| Backend | `vitest run` (backend) | **254/254 files, 4289 passed, 0 failed** (76 skipped) |
| Local agent | `vitest run` (local-agent) | **98/99** — 1 pre-existing flake (below) |
| Frontend | `vitest run` (frontend) | **91/91 files, 613/613** |
| P1 targeted | builder + panel + WorkPage | **25/25** |
| TypeScript | `tsc --noEmit` backend / local-agent / frontend | all clean |
| CI build | `build:ci` | shared + backend + frontend all build |

### Environment note (test host only)
Some backend suites (review sandbox / `review runtime — real sandbox execution`, and the terminal state machine) spawn a real child `node`. On this Windows host `node` must be on `PATH` for those to pass; with that adjustment the full backend suite is green (4289/0). This is a host-environment requirement, not a code defect.

## G — Pre-existing flake (not introduced here)

- `local-agent/src/foundation/terminal.test.ts` → "transitions to TIMED_OUT when timeoutMs elapses on a live process": the test relies on a live process pulling a TTY-less stdin; on this non-TTY Windows host the process exits and the state machine reaches `EXITED` instead of `TIMED_OUT`. Unrelated to browser work; left as-is and reported separately.

## G2 — Contract honesty note (open follow-up)

- `ws.ts mergeAdvertisedCapabilities` unions raw claimed capability strings. A `browser revoke` on the agent stops advertising the capability, but the server may retain the previously recorded capability until reconnect/re-pair. This is a monotonic-claim nuance, not a live privilege escalation (the P0 gate still governs whether a browser launches). Tracked as a follow-up.

## H — Not done / deferred (P2+)

- **Mode 2** (driving the user's existing, already-authenticated browser session) is intentionally **not implemented**; only the managed headless profile (Mode 1) exists.
- No scheduling of recurring browser tasks.
- No download-to-project artifact promotion beyond capture + refs.
- Revoke-capability sync on the server side (see G).

## I — Constraints held

- New capability gated off by default; no change to default behaviour of existing deployments.
- No modifications to frozen areas (P0 fabric contracts, existing auth, unrelated modules).
- No secrets logged; no new network egress except the agent's own CDP loopback traffic.
- No deploy, no commit, no push.

## J — Files touched (high level)

- Backend: `modules/agent/{dispatch,service}.ts`, shared `constants.ts` (rebuilt `dist`).
- Local agent: `src/browser/{launch,cdp,contract}.ts` (+ tests), `src/tasks.ts`.
- Frontend: `lib/browserInstruction.ts` (+ test), `components/BrowserTaskPanel.tsx` (+ test), `pages/WorkPage.tsx` (+ test).

---

**Final status: Phase 30 P1 complete and green. Stopping here — no commit, no deploy. Awaiting P2 go-ahead.**
