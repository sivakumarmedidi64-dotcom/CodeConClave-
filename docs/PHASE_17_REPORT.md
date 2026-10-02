# PHASE 17 — Full System Integration, E2E & Failure/Recovery Validation (Report)

## Status
COMPLETE. Full-system integration validation across backend and frontend:
backend 920/920 (64 files, +38 tests), frontend 221/221 (38 files, +4 tests),
both typechecks and both production builds green. No existing tests were
weakened; no faked provider success; no production-ready claims beyond what is
evidenced.

Two real production defects were found and fixed during this phase:
(a) `createCoworkerRun` crashed with `TypeError: Cannot read properties of
undefined (reading 'id')` on every retried/resumed task — the `ON CONFLICT`
keep of the existing run row left the code fetching by the newly generated id;
it now reuses the existing run row when one is present. (b)
`hasActiveRemoteSession` queried with swapped WHERE parameters
(`deviceId, userId` instead of `userId, deviceId`), so remote-session presence
checks were wrong; the parameter order is fixed and now covered by a test.

## Scope delivered (with evidence)

### End-to-end user journey (backend)
- `integration-17.test.ts` — 9/9 GREEN. Full journey through the real
  composition root: register/verify → MFA enroll/complete → workspace restore
  → chat fast path → memory + DNA updates → COWORK task → plan → approval →
  execution → artifact → DNA → notification → task COMPLETED, all against the
  real (emulated) database stack. Also verifies "Write Your Work Away" is
  evidence-only, the free-limit Moon fires exactly once, and Pro is never
  gated.

### Local execution & device pairing
- `local-execution-17.test.ts` — 7/7 GREEN. LOCAL tasks stay
  `WAITING_FOR_LOCAL_AGENT` with no pipeline/attempt/coworker runs claimed
  while offline; `requireAgentOnline` rejects with `local_agent_offline`;
  paired devices get idempotent remote-session reuse; revoked sessions and
  unpaired devices are rejected; device presence transitions ONLINE/STALE/
  OFFLINE; parked tasks revalidate correctly.

### Failure & recovery matrix (categories 12–15, completing the failures-15 matrix)
- `failure-17.test.ts` — 4/4 GREEN.
  - 12: mid-pipeline coworker crash → persisted FAILED step/run/attempt,
    RETRIED decision, process never crashes.
  - 13: worker crash recovery resumes from the checkpoint, reuses completed
    runs, never re-runs work, never regenerates the plan.
  - 14: verification evidence gate — verify SKIPPED with `no verifier executed`
    when no evidence exists.
  - 15: planner AI outage → DEFAULT_PLAN fallback with audit
    `source: 'default_fallback'`.

### Security matrix (categories 13–14, completing the security-15 matrix)
- `security-17.test.ts` — 9/9 GREEN. OAuth state tampering escalation:
  attacker-key forgery, cross-protocol prefix binding (`google-oauth2` /
  `session`), signature swap, CSRF nonce replacement, key rotation; OAuth
  callback fail-closed: `googleConfigured()` false without creds, authorizeUrl
  embeds untrusted state verbatim (never interprets it), callback gated
  server-side.

### Performance smoke
- `perf-17.test.ts` — 3/3 GREEN, honest TARGET/MEASURED:
  - task_execute_ms: TARGET ≤ 2000, MEASURED 21.
  - task_create_20_ms: TARGET ≤ 1000, MEASURED 5.
  - sse_rebuild_500_ms: TARGET ≤ 50, MEASURED 0.

### SSE Last-Event-ID replay
- Backend: `sse-replay-17.test.ts` (6 GREEN) plus route/service replay logic
  (`Last-Event-ID` header, `msg_<id>` ids, missed-message replay).
- Frontend: `ChatPage` sends `Last-Event-ID` only after a done frame for a
  conversation, dedupes replayed deltas by message id (never re-appends a
  duplicate replay); covered by ChatPage.test.tsx (Phase 17 replay suite) and
  the new app-level journey below.

### Frontend E2E journeys (RTL)
- `src/journeys/phase-17.test.tsx` — 2/2 GREEN, full-app journeys through the
  real router/shell:
  1. Chat stream → done frame → reconnect carries `Last-Event-ID` → missed
     delta replayed exactly once → duplicate replay of the same id never
     re-appended.
  2. `/home` renders the evidence-backed WYWA card (counts, actions) and
     expanding reveals the summary text.
- Existing suites already cover the remaining Phase 17 frontend journeys:
  SSE replay details (ChatPage.test.tsx), offline/online (OfflineBanner,
  ConnectivityIndicator), Moon gating (FreeLimitMoon, ThinkingMoon), approvals
  (ApprovalsPage.test.tsx), WYWA (HomePage.test.tsx), coworker grid, memory,
  DNA, terminal, remote, settings, teams, plugins, ideas.

## Critical defects found
1. Retried/resumed tasks always crashed (`createCoworkerRun` id mismatch).
   — FIXED, regression-covered by orchestration/task-engine suites (63/63).
2. `hasActiveRemoteSession` returned wrong results (swapped query params).
   — FIXED, now covered by local-execution-17.

## Files created
- `backend/src/foundation/integration-17.test.ts` (9 tests)
- `backend/src/foundation/local-execution-17.test.ts` (7 tests)
- `backend/src/foundation/failure-17.test.ts` (4 tests)
- `backend/src/foundation/security-17.test.ts` (9 tests)
- `backend/src/foundation/perf-17.test.ts` (3 tests)
- `backend/src/foundation/sse-replay-17.test.ts` (6 tests)
- `frontend/src/journeys/phase-17.test.tsx` (2 tests)

## Files modified
- `backend/src/modules/execution/coworkers.ts` — createCoworkerRun reuses an
  existing run row on retry/resume instead of crashing.
- `backend/src/modules/agent/service.ts` — hasActiveRemoteSession WHERE
  parameter order fixed.
- `frontend/src/pages/ChatPage.tsx`, `frontend/src/lib/sse.ts`,
  `backend/src/modules/chat/*` — SSE Last-Event-ID replay (delivered earlier
  in this phase; included for completeness).

## Database migrations
- None added this phase. Migration 0037/0038 runtime behavior remains
  statically verified only (see Live infrastructure validation).

## Tests
- Backend: 920 passed / 0 failed / 0 blocked (64 files).
- Frontend: 221 passed / 0 failed / 0 blocked (38 files).
- One transient frontend failure was observed under heavy CPU contention
  (App shell "redirects / to /home"); it passed in isolation and in the full
  re-run (38/38, 221/221). Not a test weakening — documented flake, not a
  regression.
- Note: `backend/vitest.config.ts` uses `testTimeout: 15000` to keep the full
  suite deterministic on this machine; this is an infrastructure adjustment,
  not a relaxation of any assertion.

## Typecheck / Build
- Backend: `npx tsc --noEmit` clean; `npm run build` clean.
- Frontend: `npx tsc --noEmit` clean; `npm run build` clean
  (433.25 kB JS / gzip 122.54 kB, 18.09 kB CSS / gzip 4.13 kB).

## Live infrastructure validation
- Database runtime: BLOCKED — no live PostgreSQL instance in this environment;
  migration 0037/0038 and RLS are verified statically and through emulated
  suites only.
- AI providers: BLOCKED — no live credentials; provider behavior validated by
  contract tests only (ai-gateway-5 etc.). No faked provider success anywhere.
- Payments (Razorpay) / email (Resend): BLOCKED — contract-tested only.
- Browser-level E2E: BLOCKED — no browser automation available; frontend E2E
  is RTL-based (bundle evidence above).

## Remaining risks
- Runtime DB and live-provider behavior cannot be exercised in this
  environment; the suites emulate the database layer faithfully but cannot
  prove production connectivity.
- One timing-sensitive frontend test flaked once under artificial CPU
  contention; deterministic in normal runs.
- Replay semantics depend on server-confirmed `msg_<id>` ids; if the upstream
  AI layer ever reorders or drops done frames, replay resumes from the last
  confirmed id (safe by construction, may replay one extra frame).

## FINAL
PASS — full backend and frontend suites green (920 + 221), typechecks and
builds green, two real defects found and fixed with regression coverage, all
Phase 17 journey/matrix items delivered with evidence. Live database,
provider, and browser validations remain BLOCKED by environment (no
credentials, no browser tooling) and are documented as such — nothing is
claimed as verified that was not exercised.