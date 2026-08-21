# PHASE 7 — Task Engine + 9 Coworkers + Orchestration + 24/7 Work (Report)

## Status
COMPLETE. The real persistent task engine now covers the full lifecycle
(CREATED → PLANNED → WAITING_APPROVAL → RUNNING → TOOLS_USED → ARTIFACTS_CREATED
→ TESTING → VERIFIED → COMPLETED; failures FAILED/TIMED_OUT/CANCELLED/BLOCKED/
WAITING_FOR_LOCAL_AGENT/REQUIRES_REVIEW), with attempts, steps, heartbeats,
watchdog, timeout, cancellation, retries with exponential backoff, a
dead-letter queue, priority, task dependencies, failure reasons + recovery
status, structured persisted Planner plans (never free-form text), all nine
coworkers with full role metadata, sequential + dependency-safe parallel
orchestration with complete handoffs, artifact-center references
(task/attempt/coworker/timestamp/verification), and an exposed task timeline
(plan, dependencies, failure info, DLQ). Cloud work continues offline; LOCAL
tasks wait for the Local Agent and are never faked. Migration 0029 and the
Phase 7 test suite are implemented and validated. All 597 pre-existing tests
still pass; 38 new Phase 7 tests were added (635 total). Nothing is claimed as
production-ready; see PostgreSQL runtime + External blockers.

## Files created
- `database/migrations/0029_phase7_task_engine.sql` — static-only migration (see Database migrations).
- `backend/src/modules/execution/planner.ts` — Planner module: `DEFAULT_PLAN` (deterministic fallback), `parsePlannerResponse` (strict JSON parse, markdown fences tolerated), `validatePlannerEntries` (nine coworker types only), `persistPlan` (idempotent, replaces entries), `getPlan`, `generatePlan` (PLANNER via the AI gateway; ANY failure or invalid output → default plan, never free-form), `planToPipeline`, `groupPipeline` (dependency-safe parallel buckets).
- `backend/src/foundation/task-engine-7.test.ts` — 17 tests (priority/dependencies, claim gating, backoff, retry/DLQ, manual recovery, watchdog sweeps).
- `backend/src/foundation/planner-7.test.ts` — 16 tests (strict parsing/validation, fallback, idempotent persistence, parallel grouping).
- `backend/src/foundation/orchestration-7.test.ts` — 5 tests (LOCAL never faked, persisted plan + parallel execution with real concurrency, retry on failure, DLQ on exhaustion).
- `docs/PHASE_7_REPORT.md` — this report.

## Files modified
- `shared/src/constants.ts` — `TaskRecoveryStatus` (NONE/RETRYING/DEAD_LETTERED/RECOVERED), `PlanStatus` (ACTIVE/COMPLETED/ABANDONED), `TaskDependencyKind` (finish), `RetryPolicy` (BASE_BACKOFF_MS 60s, MAX_BACKOFF_MS 15m, DEFAULT_MAX_ATTEMPTS 3), `TaskPriorityLevel` (NORMAL 0 / URGENT 5 / CRITICAL 10).
- `backend/src/shared/ids.ts` — prefixes `TASK_DLQ`, `TASK_DEPENDENCY`, `PLAN`, `PLAN_ENTRY`.
- `backend/src/modules/execution/policy-shared.ts` — new audit codes `task.retried`, `task.recovered`, `task.dead_lettered`, `task.dependency_added`, `task.plan_created`.
- `backend/src/modules/execution/tasks.ts` — `TaskRow` += `priority`, `failure_reason`, `recovery_status`, `retry_count`, `next_attempt_at`, `dead_letter_at`, `requires_review_reason`; `createTask` accepts `priority` (appended as the final INSERT param so existing param-index assertions hold) and `dependsOn` (registers finish dependencies); new `scheduleRetry` (status CREATED + exponential backoff + RETRYING recovery + audit), `deadLetterTask` (terminal FAILED + `task_dlq` row + audit), `retryOrDeadLetter` (budget check `max_attempts - 1 - retry_count`), `retryTask` (manual recovery, RECOVERED, removes the DLQ row), `listDeadLettered`, `getTaskFailureInfo`, `addTaskDependency`/`listTaskDependencies`, watchdog `recoverTimedOutTasks` (TIMED_OUT → retry or DLQ per budget) and `blockBlockedDependencies` (dependent → BLOCKED when a dependency fails).
- `backend/src/shared/queue.ts` — claim gate now orders by `priority DESC, created_at`, skips tasks until `next_attempt_at`, and refuses to claim while a dependency is not COMPLETED (all pre-existing SQL fragments preserved — task-engine.test.ts unchanged and green).
- `backend/src/modules/execution/coworkers.ts` — `CoworkerDef` gains full metadata for all nine coworkers (capabilities, constraints, model policy, permission scope, task lifecycle, artifact schema, failure behavior, memory access, audit behavior); `createCoworkerRun` persists `parallel_group`; `saveCoworkerArtifact` accepts `attemptId` + `verification` (Artifact Center references).
- `backend/src/modules/execution/orchestrator.ts` — `executeTask` runs from a persisted plan (existing plan → validated explicit pipeline → PLANNER with deterministic fallback), executes groups sequentially with runs in a `parallelGroup` running concurrently (order preserved; handoffs between groups only), verification before artifacts, artifacts with attempt + verification refs, and failures go through `retryOrDeadLetter` (never silently terminal). `getTaskTimeline` now returns `plan`, `dependencies`, `failureInfo`, `dlq`.
- `backend/src/modules/execution/routes.ts` — `POST /tasks` accepts `priority` (0..10) + `dependsOn`; new `GET /tasks/dlq`, `GET /tasks/:id/plan`, `GET /tasks/:id/dependencies`, `GET /tasks/:id/artifacts`, `POST /tasks/:id/retry`.
- `backend/src/workers/watchdog.ts` — added `recoverTimedOutTasks` (retry/DLQ sweep) and `blockBlockedDependencies` sweeps alongside the existing timeout/recovery sweeps.

## Task engine (24/7)
- Persistent tasks, attempts (`task_attempts` numbered, capped by `attempt_count < max_attempts`), steps, coworker runs, and handoffs were already present; Phase 7 adds the failure machinery: `scheduleRetry` puts a failed task back at CREATED with `next_attempt_at = now() + backoff` where backoff = min(15m, 60s × 2^retry_count); the claim gate will not pick it up early; after `max_attempts - 1` retries the task is dead-lettered: status FAILED, `recovery_status = 'DEAD_LETTERED'`, `dead_letter_at`, failure reason, and a `task_dlq` row (project/owner/title/reason/error/attempts) for the DLQ listing endpoint. Manual recovery (`retryTask`) re-queues FAILED/TIMED_OUT/BLOCKED or dead-lettered tasks with `RECOVERED` and removes the DLQ row.
- No task can run forever: the existing watchdog heartbeat recovery + `failTimedOutTasks` remain untouched, and the new retry sweep converts every TIMED_OUT task into either a scheduled retry or a DLQ entry — a TIMED_OUT task is never left dangling.
- Dependencies (`kind = 'finish'`): a dependent task claims only when every dependency is COMPLETED; a dependency that fails/times out/cancels blocks the dependent (BLOCKED, `dependency_failed`) via the watchdog sweep.
- Priority: higher values claim sooner (`ORDER BY priority DESC, created_at`), validated 0..10 at the API.

## Cloud vs Local
- CLOUD/HYBRID tasks are claimed and executed by the worker in-process or standalone (`npm run worker`); cloud-side work continues while the user is offline (polling the tasks table is the source of truth).
- LOCAL tasks transition to `WAITING_FOR_LOCAL_AGENT` immediately and are never executed or faked on the cloud side — the orchestration test asserts zero coworker runs for LOCAL tasks.

## Nine coworkers
- All nine types (ARCHITECT, CODER, SECURITY, TESTER, PERFORMANCE, RESEARCH, DOCS, REVIEWER, PLANNER) were already in the registry; Phase 7 enriches every definition with capabilities, constraints, model policy (compute class + token budget), permission scope, task lifecycle placement, artifact schema, failure behavior, memory access, and audit behavior — surfaced through `GET /coworkers`.
- The PLANNER is now actually invoked: when a task has no persisted plan and no explicit validated pipeline, `generatePlan` calls the PLANNER through the AI gateway and persists the structured plan; the orchestrator then executes exactly that persisted plan. Invalid or missing model output falls back to the deterministic DEFAULT_PLAN (ARCHITECT→CODER→SECURITY→TESTER→REVIEWER→DOCS); free-form model text is NEVER executed — `parsePlannerResponse` rejects anything that is not a validated JSON pipeline of the nine types, and the audit records `source: planner | default_fallback`.

## Orchestration
- Sequential stages (Architect → Coder → Tester → Security → Reviewer per plan) execute in order with handoffs that preserve the task context; the plan may declare dependency-safe parallel groups (e.g. Architect+Research, Tester+Performance, Security+Reviewer) — consecutive entries sharing a `parallelGroup` run concurrently (verified by a concurrency-max assertion), and the pipeline order is always preserved so state-conflicting operations are never parallelized.
- Handoffs occur between groups only, carrying the prior output summary; every run/step is persisted with its state, error codes, and verification result.
- Execution safety reuses the existing layers untouched: policy engine (`policy.ts`), Approval Center (HIGH/CRITICAL tasks gate before execution), AI gateway with fallback + usage accounting, and Local Agent security for local work. Nothing bypasses those layers.

## Artifact Center
- `saveCoworkerArtifact` now stores `attempt_id` and `verification` next to the existing run reference, SHA-256, kind, and content — every artifact references task (via run) / attempt / coworker / timestamp / verification, and no artifact is claimed unless the pipeline actually created it (the final output artifact is only persisted after a run completed). `GET /tasks/:id/artifacts` exposes the task-level artifact list.

## Task timeline
- `GET /tasks/:id` (getTaskTimeline) now returns: task (incl. priority + recovery fields), attempts, steps, tool calls, coworker runs, artifacts, the persisted plan, dependencies, `failureInfo` (failure_reason, recovery_status, retry_count, max_attempts, next_attempt_at, dead_letter_at, error_code/detail), and the DLQ row — the full Created → Planned → Running → Tools Used → Artifacts Created → Testing → Verified → Completed story, with Failed → Reason → Recovery → Retry for failures.

## Database migrations
- `0029_phase7_task_engine.sql` (static): `tasks` += `priority`, `failure_reason`, `recovery_status` (CHECK NONE/RETRYING/DEAD_LETTERED/RECOVERED), `retry_count`, `next_attempt_at`, `dead_letter_at`, `requires_review_reason` + claim index (status, priority DESC, created_at); `task_dependencies` (finish kind, unique pair); `task_dlq` (unique task_id); `plans` + `plan_entries` (nine-type CHECK, parallel_group, depends_on, required_tools, risk, acceptance criteria, expected artifacts); `coworker_artifacts` += `attempt_id` (FK task_attempts) + `verification` (CHECK PASS/FAIL/SKIPPED); `coworker_runs` += `parallel_group`.
- IMPORTANT: PostgreSQL runtime is NOT available in this environment. The migration is validated for SQL syntax only and was never applied. Do not claim runtime migration success.

## Tests
- `backend/src/foundation/task-engine-7.test.ts` (17): priority param + dependencies at creation, idempotent dependencies, claim-gate additions (next_attempt_at / priority ordering / dependency NOT EXISTS — with the pre-existing gate fragments intact), backoff doubling + cap, scheduleRetry (CREATED + backoff + RETRYING + audit), retry vs DLQ decisions, DLQ row contents + notify, manual recovery (RECOVERED, DLQ row removed, `task_not_retryable` refusal), failure info, TIMED_OUT recovery sweep counts, dependency-blocking sweep.
- `backend/src/foundation/planner-7.test.ts` (16): strict parsing (plain JSON, markdown fenced), full metadata entries, rejection of unknown types / garbage / partial-invalid pipelines, parallel group bucketing, generatePlan success (persisted + `source: planner`), gateway failure → default plan, free-form text → default plan, idempotent re-persist, planToPipeline mapping.
- `backend/src/foundation/orchestration-7.test.ts` (5): LOCAL → WAITING_FOR_LOCAL_AGENT with zero coworker activity, persisted-plan parallel execution (plan INSERT, ordered runs, parallel_group hints, handoffs between groups only, VERIFIED/COMPLETED, artifact with attempt + verification refs, SUCCESS attempt, DNA autosave), real concurrency of same-group runs (maxActive = 2), failure → retry with backoff (never FAILED, never DLQ), exhaustion → DLQ (FAILED + `task_dlq` row + failure notification).

## Validation
- shared: typecheck PASS, build PASS, 46/46 tests.
- local-agent: 49/49 tests.
- backend: typecheck PASS, build PASS, 478/478 tests (440 pre-existing + 38 new).
- frontend: typecheck PASS, build PASS, 62/62 tests.
- Total: 635/635.

## Blockers
- PostgreSQL runtime unavailable — migration 0029 was static-validated only; runtime migration, claim-gate performance, and RLS behavior are unverified.
- No real provider API keys — the PLANNER gateway call is mocked in tests; in production without a key the gateway fails gracefully into the deterministic default plan (still persisted and audited).
- No lint scripts configured in any workspace — typecheck + build are the enforced gates.
- Parallel groups execute via in-process Promise.all; for high concurrency across processes, the single worker concurrency (CONCURRENCY = 2 in task-worker.ts) is the limiter — no cross-process parallel orchestration was implemented or tested.
