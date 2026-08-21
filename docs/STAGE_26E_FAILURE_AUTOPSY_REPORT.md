# STAGE 26E — FAILURE AUTOPSY + CHECKPOINTS + TIME-TRAVEL — IMPLEMENTATION REPORT

Date: 2026-08-19 — Backend slice for Stage 26E (failure autopsy, recovery history, checkpoints, pause/resume, time travel: rewind/branch, irreversible actions, watchdog sweep).

All work extends the existing codebase. No greenfield replacements, no fake functionality, no second task engine. Migration count: **49/49 applied live** (0048, 0049 added). No deployment was performed.

## Implemented (backend)

### Schema (`database/migrations/0049_stage26e_recovery.sql`)
- `tasks` gains `PAUSED` status (check constraint dropped/re-added with the new member) + `paused_at` / `paused_by` / `paused_reason`.
- New tenant tables (all RLS-enabled, owner-scoped, indexed): `task_checkpoints`, `task_branches` (source → branch link with checkpoint), `failure_autopsies` (`UNIQUE (task_id, attempt_id)`, immutable snapshot rows, `status` GENERATED/SUPERSEDED), `recovery_history` (immutable ordered event timeline), `irreversible_actions` (immutable records).

### Failure autopsy (`backend/src/modules/recovery/autopsy.ts`)
- `classifyRootCause` — evidence-backed mapping from the real failure payload (dependency failures, plugin unavailability, blocked permissions, approval rejection, timeout, max-attempts exhaustion, resource exhaustion, auth failure) → shared `RootCauseCode`; unmapped evidence → `CAUSE_UNKNOWN` with confidence 0 (never invented).
- `buildPrevention` — concrete, per-root-cause remediation actions (verify_dependencies, retry_with_backoff, grant_scopes, revise_request, increase_timeout, increase_max_attempts, free_resources, rotate_credentials); null for CAUSE_UNKNOWN.
- `generateAutopsy` — requires a REAL failed task (`autopsy_requires_failure` conflict otherwise); evidence assembled only from persisted state (attempts, errors, dependency statuses via JOIN, recovery attempts, branch statuses); `successful_fix` only when a later SUCCESS attempt or COMPLETED branch exists; memory (`SEMANTIC`/`AI_INFERRED`, provenance `autopsy:<id>`) + DNA `NEXT_ACTIONS` written only when the root cause is confirmed, best-effort; a re-autopsy of the same attempt SUPERSEDES the prior report (never deletes).
- `applyRemediation` — records REMEDIATED recovery event + `task.remediated` audit.
- `sweepAutopsies` — watchdog-driven: every FAILED/TIMED_OUT/DEAD_LETTERED task without a GENERATED autopsy gets one, per-task try/catch, sweep never fatal.

### Checkpoints (`backend/src/modules/recovery/checkpoints.ts`)
- `createCheckpoint` snapshots: task state (full row), plan state (goal/status/entries), execution metadata (attempts, steps, agent run id, `stage_index`, `run_ids_by_order`, checkpointed-at), approval state (only when an approval exists); rows are immutable after creation; history `CHECKPOINTED` + audit `task.checkpointed`. `getCheckpoint` / `listCheckpoints` tenant-scoped (cross-tenant → not_found / empty).

### Time travel (`backend/src/modules/recovery/timeTravel.ts`)
- `pauseTask` — cancels the running agent run through the existing `cancelRun` + `agentTaskChanged` (best-effort), marks PAUSED with pause metadata, excluded from the queue; `task_not_pausable` / `task_already_paused` conflicts; history `PAUSED` + audit `task.paused`.
- `resumeTask` — clears the pause, status back to CREATED, `recovery_status = RECOVERED`, re-claimable by the existing queue (`claimNextTask`/`pendingTaskCount` gate on `paused_at IS NULL`); `task_not_resumable` conflict.
- `modifyFutureSteps` — re-persists the plan through the existing `persistPlan`; history `MODIFIED` + audit `task.plan_modified`; `task_not_modifiable` for terminal tasks.
- `branchTask` — forks a NEW task (immutable original): plan copied from the checkpoint, attempt checkpoint carried over (`stage_index > 0` only — the orchestrator's Phase-16 machinery resumes from it), `task_branches` link row, history `BRANCHED` + audit `task.branched`.
- `rewindTask` — **never claims undo that does not exist**: blocked (`irreversible_action_blocks_rewind`) when irreversible actions exist after the checkpoint's `created_at`; otherwise branches from the checkpoint; original task + history stay immutable; history `REWOUND` + audit `task.rewound`.
- `forkFromCheckpoint` — shared fork machinery (new task via existing `createTask`, `persistPlan` copy, attempt checkpoint carry, branch link).

### Recovery-aware history + irreversible actions
- `history.ts` — `recordRecoveryHistory` / `listRecoveryHistory` (tenant-scoped, ordered, immutable timeline of PAUSED/RESUMED/CHECKPOINTED/MODIFIED/REWOUND/BRANCHED/AUTOPSIED/REMEDIATED/IRREVERSIBLE_ACTION events).
- `irreversible.ts` — `recordIrreversibleAction` (immutable), `listIrreversibleActions`, `irreversibleAfter` (the rewind guard); `task.irreversible_action` audit.
- `routes.ts` — `/api/v1/recovery`: `GET|POST /tasks/:id/checkpoints`, `POST /tasks/:id/pause|resume|modify-steps|branch|rewind`, `GET|POST /tasks/:id/autopsy`, `GET /tasks/:id/autopsies`, `POST /tasks/:id/remediate`, `GET|POST /tasks/:id/irreversible`, `GET /tasks/:id/history`.

## Wired in
- `backend/src/app.ts`: `app.use('/api/v1/recovery', recoveryRoutes())`.
- `backend/src/workers/watchdog.ts`: autopsy sweep phase (`sweep('autopsies', out, () => sweepAutopsies())`).
- `backend/src/shared/queue.ts`: `claimNextTask` + `pendingTaskCount` exclude paused tasks (`paused_at IS NULL`).
- `backend/src/shared/ids.ts`: PREFIX `tcp` / `tbr` / `aps` / `rch` / `irr`.
- `shared/src/constants.ts`: 9 new AuditAction values (`task.paused`, `task.resumed`, `task.checkpointed`, `task.rewound`, `task.branched`, `task.autopsied`, `task.remediated`, `task.irreversible_action`, `task.plan_modified`) + `RecoveryEventType` and `RootCauseCode` consts; shared rebuilt (dist).

## Tests
- New suite `recovery-26e.test.ts` — **28/28 green**: checkpoints (state capture incl. approval, secret-free, newest-first ordering, tenant negatives), pause/resume (agent-run cancellation, queue exclusion + re-enqueue via the real `claimNextTask`/`pendingTaskCount`, terminal/pause-twice/resume-non-paused conflicts), modify future steps, branch (current state + specific checkpoint), rewind (immutable history, irreversible-action guard, foreign checkpoint), irreversible actions, autopsies (classification incl. CAUSE_UNKNOWN, evidence-backed generation, successful-fix detection, non-failed refusal, tenant scope, watchdog sweep, remediation), recovery-aware history, plus both E2E flows: checkpoint → pause → modify/branch → resume → completion, and failure → autopsy → remediation → retry → success.
- Full backend regression: **85 files, 1324 tests, 1320 passed / 3 skipped / 0 failed** (the one timing perf smoke passed on isolated re-run — suite-load flakiness, target 2000ms, measured ~1.4s alone).
- Frontend: 40 files / 236 passed; local-agent: 5 files / 49 passed.
- Typecheck: shared + backend + frontend + local-agent EXIT 0; builds: shared + backend + frontend EXIT 0.

## Failures found & fixed during the slice
- **Production bug**: `forkFromCheckpoint` returned `getTask(...)` without `await` — `branchTask`/`rewindTask` returned a Promise instead of the task row (all fork-path tests failed; caught by the suite).
- Test harness: claim-gate condition missed the collapsed `IN ( SELECT` (space after paren) so claims fell through to the generic UPDATE path; INSERT `VALUES` regex stopped at the first `)` — which is inside `now()` — silently truncating trailing values (forked attempt's `checkpoint` JSON landed empty); `nowIso()` monotonic clock added for deterministic ORDER BY DESC ordering; `withSystem`/`withTenant` exports required on the db mock; MAX-aggregate regex spacing; AppError assertions use `errorCode` (not `code`).
- Typecheck fixes: `fix` possibly-undefined narrowing; `PersistedPlan` has no `risk_level`; `IrreversibleActionRow` uses `action_type` (snake_case) on the written row.

## Limitations / deferred
- Live E2E recovery flows cannot be observed (all AI providers DOWN in this environment — code fails honestly at runtime; provider-dependent scenarios remain blocked, never fabricated).
- Frontend surfaces for pause/resume/branch/autopsy UI (API contracts final; existing pages untouched).
- `successful_fix` detection covers same-task later attempts and completed branches; cross-task "same bug" inference stays out of scope (evidence only).

## Next steps (per continuation prompt)
26F engineering agents (PR Review Swarm, Dependency Upgrade Agent, Flaky Test Hunter, Self-Healing CI) → preview/plugin/control-plane/secret-leak/usage/payment completion → frontend surfaces → full regression → update this report → **STOP (no deployment)**.

---

## STOP — NO DEPLOYMENT PERFORMED