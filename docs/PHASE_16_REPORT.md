# PHASE 16 — Performance, Reliability & Offline Sync (Report)

## Status
COMPLETE. Performance, reliability, and offline-sync hardening across backend
and frontend. Backend 882/882 (58 files, +34 new), frontend 217/217 (37 files,
+22 new), all typechecks and both production builds green. No existing tests
were weakened.

High-impact items closed in this phase: (a) a real long-running-task bug — the
worker sweep `failTimedOutTasks` is gated on `started_at IS NOT NULL`, but
`started_at` was never set anywhere, so timed-out tasks could run forever;
`beginAttempt` now sets `started_at = COALESCE(started_at, now())`. (b) no
idempotency existed on the approval-decide and notifications-read writes, so a
retried request (or an offline-sync replay) could double-execute; both routes
now run through a server-side `Idempotency-Key` service backed by the
`idempotency_keys` table. (c) the agent WebSocket hub and browser relay had no
keepalive — a half-open connection could be mistaken for a live agent forever;
both now run a 25 s ping/pong sweep, terminate dead sockets, and a reconnect
actively replaces the live socket (close 4002, metric `agent.reconnect`).
(d) interrupted task attempts had no durable progress — the orchestrator now
persists a checkpoint after every pipeline group and resumes a failed attempt
from the last checkpoint, reusing completed `coworker_runs` instead of
re-running them. (e) the task worker could be hard-stopped mid-flight on
shutdown — it now drains gracefully (10 s bounded) and `run.ts` shutdown is
async and awaits the stop. (f) queue wait time, memory retrieval, and per-route
API latency were not measured — `queue_wait_ms`, `memory_retrieve_ms`, and a
route-patterned `apiLatency()` middleware now record them into the metrics
snapshot. (g) the frontend had no offline story — user actions (approval
decisions, mark-notifications-read) taken while offline are now queued in
localStorage with per-op idempotency keys, flushed on reconnect, surfaced in a
ConnectivityIndicator + OfflineBanner, and server conflicts are shown with the
server's message for the user to resolve. Success is never reported for a
failed sync; a transient failure stays PENDING with exponential backoff and
only reaches FAILED after 3 exhausted retries.

## WebSocket (agent hub + browser relay)
- `backend/src/modules/agent/ws.ts`: AgentHub keeps a per-connection `alive`
  map. A 25 s `keepaliveSweep()` sends `heartbeat` and, when no
  `heartbeat_ack` (echoing `seq`) arrives, closes the dead socket and
  increments `agent.heartbeat_timeout`. A reconnect for an existing
  connectionKey **replaces** the live socket: the old socket is closed with
  code 4002 and `agent.reconnect` is incremented — no duplicate agent identity
  on the hub. Revoked/invalid credentials close with 4003. `close` cleanup
  removes the `alive` entry so a dead socket can never be counted as a live
  agent.
- `backend/src/modules/agent/browser.ts`: BrowserRelay sockets are kept alive
  by the same sweep pattern (25 s, ping/pong) with
  `relay.heartbeat_timeout`; dead relays are removed from the registry.
- Tested in `ws-16.test.ts` (9 tests) with fake sockets that emit the
  `register` hello buffer — heartbeat timeout, reconnect replacement,
  close-code 4002/4003, `alive` cleanup.

## Offline sync
- `frontend/src/lib/offline.ts`: a localStorage-backed queue
  (`codeconclave_offline_queue`). `enqueueOfflineOp(op, payload)` dedupes an
  identical PENDING twin and attaches a fresh `Idempotency-Key` per op.
  `flushOfflineQueue()` syncs due ops through the real idempotent routes,
  drops synced ops, keeps transient failures PENDING with backoff
  (`2s * 2^min(retryCount,4)`), and marks an op FAILED only after 3 exhausted
  retries. `initOfflineSync()` measures the offline period
  (`lastReconnectMs()`) and flushes on the browser `online` event.
- Wired into the two user actions that are idempotent server-side:
  `ApprovalsPage.decide` (offline → enqueue + honest toast, no server call)
  and `Topbar.openPanel` mark-all-read (`notifications.markRead`). Both send
  `Idempotency-Key` through `api.ts` (`idempotencyKey` option).
- `frontend/src/components/ConnectivityIndicator.tsx`: Online / Reconnecting
  (browser back, queue still flushing) / Offline — derived from
  `navigator.onLine` + the real queue contents, never guessed. Mounted in the
  Topbar next to the HealthChip.
- `frontend/src/components/OfflineBanner.tsx`: shows queued counts offline,
  failed counts + Retry, and conflict rows; mounted under the shell topbar;
  `initOfflineSync()` is started once in `App.Shell`.
- The vitest/jsdom runtime has no localStorage (Node 22 experimental global
  only), so `src/test/setup.ts` now installs a deterministic in-memory Storage
  — the offline queue persists through it exactly like a browser.
- Tested in `offline-16.test.ts` (13 tests) and the two component suites
  (9 tests).

## Conflict handling
- A server `409` on flush is surfaced as `CONFLICT` with the server's own
  message (never a fabricated one). The user resolves: **Discard** (accept the
  server state, remove the op) or **Try again** (reset backoff, re-sync).
  `resolveOfflineConflict(localId, 'discard' | 'keepLocal')` implements both.
  Work is never silently dropped and success is never reported for a failed
  sync — both properties are regression-tested.

## Task durability
- `backend/src/modules/execution/tasks.ts`: `beginAttempt` sets
  `started_at = COALESCE(started_at, now())` — the timeout sweep
  (`failTimedOutTasks`, gated on `started_at IS NOT NULL`) now actually fires.
  New `saveAttemptCheckpoint(taskId, attemptId, checkpoint)` and
  `latestCheckpoint(taskId, excludeAttemptId)` persist/read the
  `AttemptCheckpoint` (`{ stageIndex, runIdsByOrder }`) on
  `task_attempts.checkpoint`.
- `backend/src/modules/execution/orchestrator.ts`: after each pipeline group
  the checkpoint is saved and the task is `touchTask`-updated (keeps the
  timeout sweep honest mid-run). On resume from a previous attempt, completed
  stages are skipped (`step.resumed` flag) and the task-scoped
  `coworker_runs` (unique `(task_id, coworker_type, order_index)`) are reused
  instead of re-executed. `plan_prepare_ms` and `task_execute_ms` are recorded.

## Worker recovery
- `backend/src/workers/task-worker.ts`: a `draining` flag + `inFlight` Set.
  `stopWorker()` stops claiming, waits up to 10 s for in-flight tasks
  (`inFlightCount()`), then exits; claiming and in-flight processing are
  guarded so nothing is claimed after drain begins. `_resetWorker()` is a test
  hook (the module is a singleton — `draining` persisted across tests).
- `backend/src/workers/run.ts`: shutdown is now async and awaits `stopWorker()`.
- `worker-16.test.ts` (3 tests): drain completes, no claim after drain,
  in-flight tasks finish before exit.

## Long-running tasks
- The timeout sweep fix (above) means a task that outlives its configured
  timeout is honestly failed and re-queued. Checkpoints mean a re-queued long
  task resumes from the last completed stage rather than the beginning.
  Tested in `tasks-16.test.ts` (5 tests: started_at set, checkpoint write,
  latest checkpoint read, resume skips completed stages, coworker_runs reuse).

## Local Agent reconnect
- On hub disconnect the agent is marked offline immediately (`alive` cleanup,
  status sweep) and presence/health rollups reflect it (existing `local-agent`
  health check stays honest). A reconnect replaces the stale socket and
  re-registers the connectionKey. No ghost agent can appear live again.

## Performance
- `backend/src/shared/queue.ts`: `claimNextTask` now RETURNs `created_at`, and
  the worker records `queue_wait_ms` (enqueue→claim latency) via
  `recordLatencyMetric`.
- `backend/src/modules/memory/context.ts`: memory retrieval records
  `memory_retrieve_ms`.
- `backend/src/middleware/perf.ts` (new) + `backend/src/app.ts`: `apiLatency()`
  records per-route latency on the metrics snapshot using route patterns
  (`method path:status`), with an `unknown` fallback; no request payloads or
  headers are touched, only timing.
- `perf-16.test.ts` (5 tests): middleware records latency and increments
  counts; queue claim timing captured; memory timing captured; latency
  aggregates exposed in the metric snapshot.
- All values are synthetic/test-instrumented — no real-world throughput
  claims (see Blockers).

## Caching
- No new caching layer is claimed. The queue is the existing durable
  PostgreSQL-backed task queue; the memory retrieval timing is measured, not
  cached. (Caching remains a deployment/infra concern.)

## Frontend resilience
- sse: `frontend/src/lib/sse.ts` now parses optional `id:` lines into
  `SseFrame.id` and `streamChat` returns the last event id
  (`Promise<string | null>`) for future missed-event replay — the parser is
  unit-tested (`sse.test.ts`, 5 tests; `id: \n` stays null).
- `api.ts` gained the `idempotencyKey` request option (→ `Idempotency-Key`
  header) with no behavior change for existing callers.
- Offline components never crash the shell: storage failures are caught
  (queue is best-effort, never fatal), banner/indicator failures render
  nothing, and connectivity state is always derived from real signals.

## Idempotency
- `backend/src/modules/idempotency/service.ts`: `beginIdempotent` /
  `completeIdempotent` / `failIdempotent` / `expireIdempotencyKeys` /
  `hashPayload(op, payload)`. Keys are scoped `UNIQUE(user_id, key)`, 1-128
  chars, TTL 24 h (`IDEMPOTENCY_TTL_MS`). Replay of a completed key returns
  the stored response (nothing runs twice); a key reused with a different
  payload is rejected (`idempotency_key_reused`); a FAILED key is
  `idempotency_key_failed`; payload hashes are stored for comparison.
- `backend/src/modules/idempotency/route.ts`: `withIdempotency` wraps the
  decide/read handlers — a request without a key behaves exactly as before
  (idempotency is additive, never breaking).
- Wired: `POST /api/v1/execution/approvals/:id/decide` and
  `POST /api/v1/notifications/read` (server-side: `routes.ts`); the watchdog
  sweep `idempotencyExpired` purges stale keys (metric `watchdog.*`). Prefix
  `PREFIX.IDEMPOTENCY` added to `shared/ids.ts`.
- `idempotency-16.test.ts` (12 tests): begin/complete/fail, hash mismatch →
  reused, failed-key reject, replay returns stored response, TTL expiry,
  watchdog sweep, route helper without key passes through.

## Files created
- `backend/src/modules/idempotency/service.ts` + `route.ts` — idempotency
  service + route helper.
- `backend/src/middleware/perf.ts` — per-route latency middleware.
- `database/migrations/0038_phase16_reliability.sql` — `idempotency_keys`
  (UNIQUE(user_id,key), status, response jsonb, created_at idx) +
  `task_attempts.checkpoint`/`checkpointed_at` (static-only).
- `backend/src/foundation/ws-16.test.ts` (9), `idempotency-16.test.ts` (12),
  `tasks-16.test.ts` (5), `worker-16.test.ts` (3), `perf-16.test.ts` (5).
- `frontend/src/lib/offline.ts` + `offline-16.test.ts` (13 tests).
- `frontend/src/components/ConnectivityIndicator.tsx` (+3 tests),
  `OfflineBanner.tsx` (+6 tests).
- `frontend/src/test/setup.ts` — in-memory Storage for the jsdom runtime.

## Files modified
- `backend/src/modules/agent/ws.ts` — keepalive sweep, alive map, reconnect
  replace (4002) + `agent.reconnect`, heartbeat seq ack, close cleanup.
- `backend/src/modules/agent/browser.ts` — relay keepalive + timeout metric.
- `backend/src/modules/execution/tasks.ts` — `started_at` COALESCE fix,
  `saveAttemptCheckpoint` / `latestCheckpoint`, `AttemptCheckpoint`.
- `backend/src/modules/execution/orchestrator.ts` — resume from checkpoint,
  coworker_runs reuse, `touchTask` per group, `plan_prepare_ms` /
  `task_execute_ms`, step `resumed`.
- `backend/src/modules/execution/routes.ts`, `backend/src/modules/notifications/routes.ts`
  — `withIdempotency` on decide/read.
- `backend/src/workers/task-worker.ts` — graceful drain (inFlight, draining,
  10 s bound), `inFlightCount()`/`_resetWorker()`.
- `backend/src/workers/run.ts` — async shutdown awaits `stopWorker()`.
- `backend/src/workers/watchdog.ts` — `idempotencyExpired` sweep.
- `backend/src/shared/queue.ts` — claim RETURNs `created_at` →
  `queue_wait_ms`. `backend/src/modules/memory/context.ts` →
  `memory_retrieve_ms`. `backend/src/app.ts` — mounts `apiLatency()`.
- `backend/src/shared/ids.ts` — `PREFIX.IDEMPOTENCY`.
- `frontend/src/lib/sse.ts` — `id:` parsing, `SseFrame.id`, `streamChat`
  returns last event id. `frontend/src/lib/api.ts` — `idempotencyKey` option.
- `frontend/src/components/Topbar.tsx` — offline markRead + ConnectivityIndicator.
- `frontend/src/pages/ApprovalsPage.tsx` — offline decide + enqueue.
- `frontend/src/App.tsx` — `initOfflineSync()` + `OfflineBanner` mount.
- `frontend/src/styles/global.css` — offline banner styles.
- `frontend/src/lib/sse.test.ts`, `frontend/src/pages/ChatPage.test.tsx` —
  updated for the `streamChat` return-type change (no assertions weakened).

## Database migrations
- `0038_phase16_reliability.sql` only (DDL; no table duplicates, no changes to
  existing policies/tables other than two additive columns on
  `task_attempts`). Static-only — see Blockers.

## Tests
- Backend: `npx vitest run` — 882/882 (58 files; new: ws-16 9,
  idempotency-16 12, tasks-16 5, worker-16 3, perf-16 5). No existing test
  weakened.
- Frontend: `npx vitest run` — 217/217 (37 files; new: offline-16 13,
  ConnectivityIndicator 3, OfflineBanner 6). No existing test weakened.

## Typecheck / Build
- `shared`: built clean.
- `backend`: `npx tsc --noEmit` clean; `npm run build` clean.
- `frontend`: `npx tsc --noEmit` clean; `npm run build` (vite) clean.

## Live infrastructure validation
- None beyond the existing runtime environment: PostgreSQL is not available
  here, so migration 0038 (idempotency_keys + task_attempts checkpoint) is
  unexercised against a live database — the idempotency service and watchdog
  sweep are exercised against the mocked store in tests, and the SQL is
  static-audited. No live AI credentials (perf values are synthetic);
  no browser/network simulation beyond jsdom (`navigator.onLine` events and
  an in-memory Storage).

## Remaining risks
- Migration 0038 runs only when a live Postgres is available; the
  `idempotency_keys` UNIQUE constraint and the `task_attempts` columns are the
  only untested-against-Postgres surface.
- Offline queue storage is localStorage — multi-tab concurrent flushes are
  last-write-wins per tab; the server-side idempotency key keeps the effect
  safe (first execute wins, replays return the stored response), but a tab
  could briefly show a stale queue until the next flush.
- Perf numbers are instrumented, not benchmarked against production load;
  operator alerting on the new latency/counter metrics is not implemented.
- SSE `id:` is parsed and returned, but no consumer requests missed-event
  replay yet (Last-Event-ID is not sent) — the wire contract is ready.

## Next phase
- STOP. No Phase 17 without instruction. When instructed, candidate
  follow-ups: execute migrations 0037 + 0038 against a live Postgres;
  send `Last-Event-ID` from the SSE client on reconnect to replay missed
  events; multi-tab offline-queue coordination; operator alerting on the
  latency/queue/health metrics.