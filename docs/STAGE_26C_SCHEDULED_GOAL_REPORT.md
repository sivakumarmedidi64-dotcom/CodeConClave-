# STAGE 26C — SCHEDULED AUTONOMOUS TASKS + GOAL MODE — IMPLEMENTATION REPORT

Date: 2026-08-19 — Backend slice for Stage 26C (scheduled tasks + Goal Mode).

All work extends the existing codebase. No greenfield replacements, no fake functionality, no second scheduler or task engine. Migration count: **47/47 applied live** (0046, 0047 added). No deployment was performed.

## Implemented (backend)

### Scheduled tasks (`backend/src/modules/scheduling/`)
- `service.ts` — CRUD over `scheduled_tasks` (`createSchedule`, `updateSchedule`, `listSchedules`, `getSchedule`, `setScheduleEnabled`, `deleteSchedule`, `runNow`, `listScheduleRuns`, `previewNextRuns`, `describeSchedule`). Server-side validation: unknown IANA timezone / bad cron / past ONCE runs rejected; recurrence kinds ONCE / HOURLY / DAILY / WEEKLY / MONTHLY / CRON; `next_run_at` always computed by the server, never client-supplied. Every mutation audited (SCHEDULE_CREATED/UPDATED/PAUSED/RESUMED/DELETED/RUN_NOW).
- `executor.ts` — the scheduler driver **reuses the existing worker/watchdog/queue/task/agent pipeline**:
  - `schedulerTick` scans due enabled schedules and calls `claimOccurrence`.
  - `claimOccurrence` — atomic execution identity via `INSERT ... ON CONFLICT (schedule_id, scheduled_for) DO NOTHING RETURNING *`: a duplicate tick or a second run-now is a no-op; a schedule can never execute the same instant twice.
  - `executeClaimedRun` — starts execution **through the existing `startRun`** with the existing task engine (task execution mode `CLOUD/LOCAL_ONLY/HYBRID`, timeout, max attempts applied to the created task), marks the run DUE→RUNNING/WAITING_FOR_LOCAL_AGENT/FAILED.
  - Missed-run policies (server-authoritative, computed on tick): `RUN_ON_RECOVERY` (older missed occurrences recorded MISSED `missed_window`, latest recovered EXECUTED `recovered_missed`), `RUN_ONCE` (latest executes `covered_by_single_run`, older recorded SKIPPED), `SKIP_STALE` (all SKIPPED `stale_missed`, nothing executes). Stale threshold = max(15 min, period); ONCE never stale.
  - `reconcileDueSchedules` — folds REAL terminal agent-run states onto schedule runs (COMPLETED → notification `schedule.run_completed` when notify_on_completion; FAILED/BLOCKED → FAILED with the real error, `schedule.run_failed`), advances the schedule (`advanceSchedule` sets next_run_at, last_run_status, run_count, error).
  - `sweepScheduledRuns` — watchdog-swept (wired in `backend/src/workers/watchdog.ts`).
- `routes.ts` — `/api/v1/scheduling`: `GET/POST /schedules`, `GET/PATCH/DELETE /schedules/:id`, `POST /schedules/:id/pause|resume|run-now`, `GET /schedules/:id/preview`, `GET /schedules/:id/runs`, plus goal routes below.

### Recurrence engine (`backend/src/modules/scheduling/recurrence.ts`)
- Timezone-correct, DST-safe: `tzOffsetMs` from Intl API, two-pass `zonedToUtc` (guess from UTC wall clock, re-check offset, re-derive) — nonexistent spring-forward wall times resolve to a valid instant, ambiguous fall-back times resolve deterministically; wall-clock recurrence (09:00 daily) stays 09:00 across DST.
- ONCE `YYYY-MM-DDTHH:MM`; HOURLY at fixed minutes past the hour; DAILY/WEEKLY (named weekdays) /MONTHLY (day-of-month) at `HH:MM`; CRON 5 fields with `*`, numbers, ranges `a-b`, lists `a,b,c` — steps are honestly unsupported (null result, never a silent wrong next-run); `occurrencesBetween` bounded preview with cap.

### Goal Mode (`backend/src/modules/scheduling/goals.ts`)
- Flow: DRAFT → PLANNING → PLAN_READY → WAITING_FOR_APPROVAL → RUNNING → COMPLETED / BLOCKED → WAITING_FOR_HUMAN_DECISION / FAILED / CANCELLED / PAUSED.
- `createGoal` (validated, project ownership check, budget clamp, audit `goal.created`), `generateGoalPlan` (DNA context via `retrieveDnaForPrompt`, Decision Conflict Detector surfaced as goal blockers — never silently ignored), AI planner via `completeWithFallback` with a **deterministic fallback plan** when the planner is down or unparseable (`planning_fallback` activity); agents assigned by role from idle pools; cost estimate honestly null when providers are down.
- `updateGoalPlan` (user edits revalidated server-side: 1–20 entries, dependency existence, risk allowlist, agent reassignment), `startGoal` → approval gate via the **existing `createApproval`** (`agent.approval_required` notification, `approval_id` persisted) or direct execution when approvals not required, `decideGoalApproval` APPROVE→execute / REJECT→PLAN_READY.
- `executeGoal` runs entries through the **existing `startRun`** (existing task engine, subtasks, `tasks.goal_id` back-link), one runnable entry at a time honoring dependencies; `refreshGoal` computes progress **from real task-graph state** (per-entry agent-run status folded onto the persisted plan; per-entry evidence only when a run actually completed; spent budget from `SUM(spent_usd)` of real runs; task totals from real task rows). `COMPLETED` is only reachable with evidence — all-complete-without-evidence stays BLOCKED `no_evidence` and auto-escalates. Budget-exceeded → BLOCKED `budget_exceeded`; deadline exceeded → FAILED `deadline_exceeded`; unsatisfiable dependencies → BLOCKED `dependency_blocked`.
- `pauseGoal` / `resumeGoal` / `cancelGoal` (cancels running agent runs through existing `cancelRun`, best-effort).
- Memory feed on completion: one `SEMANTIC`/`AI_INFERRED` memory with `provenance goal:<id>` via existing `createMemory`, idempotent (`memory_fed` activity guard), best-effort (never fails the goal).

### Escalations (`backend/src/modules/scheduling/goals.ts`)
- `createEscalation` / `getEscalation` / `listEscalations` (owner-scoped, OPEN-first ordering) / `decideEscalation` (APPROVE / REJECT / EDIT_PLAN / RETRY / PAUSE / CANCEL with notes; only OPEN escalations decidable).
- Auto-escalation: any BLOCKED goal with no open escalation escalates once (evidence + attempted actions + options + recommendation RETRY when retry headroom remains, else EDIT_PLAN) → WAITING_FOR_HUMAN_DECISION + `goal.escalation_needs_decision` notification + `goal.escalated` audit.
- RETRY resets failed entries (attempts < 3, attempt counter incremented) and resumes; REJECT → BLOCKED `recommendation_rejected`; EDIT_PLAN → PLAN_READY; PAUSE/CANCEL as expected.

## Wired in
- `backend/src/app.ts`: `app.use('/api/v1/scheduling', schedulingRoutes())` (after `/api/v1/agents`).
- `backend/src/workers/watchdog.ts`: scheduled-runs sweep phase via `sweepScheduledRuns()`.
- `backend/src/shared/ids.ts`: PREFIX.SCHEDULE `sch`, PREFIX.SCHEDULE_RUN `scr`, PREFIX.GOAL `gol`, PREFIX.GOAL_ACTIVITY `glac`, PREFIX.ESCALATION `esc`.
- `shared/src/constants.ts`: 23 new AuditAction values (schedule.*, goal.*, goal.escalation_decided) + 4 NotificationType values (`schedule.run_completed`, `schedule.run_failed`, `goal.completed`, `goal.blocked`, `goal.escalation_needs_decision`); shared rebuilt.

## Notifications
- `schedule.run_completed` (when notify_on_completion), `schedule.run_failed`, `agent.approval_required` (goal gate), `goal.completed` (with evidence), `goal.escalation_needs_decision` — all via the existing `notify`.

## Security
- RLS enabled on every new tenant table (`scheduled_tasks`, `schedule_runs`, `goals`, `goal_activities`, `escalations`) + `tasks.goal_id` inherited existing policy; every service entry point owner-scoped; tenant-isolation negatives tested (foreign reads → not_found, cross-tenant lists empty).
- Unique execution identity `(schedule_id, scheduled_for)` prevents double execution; approval gate + audit on every state change; honest failures (agents busy → FAILED with real message, providers down → BLOCKED with real error) — no fabricated progress or winners.

## Tests
- New suites (all green): `scheduling-26.test.ts` **29/29** (recurrence/DST/cron, schedule CRUD + preview, atomic claim idempotency, duplicate tick/run-now, LOCAL_ONLY offline, agent-busy, missed-run policies, reconcile, sweep, notifications, audits, tenant negatives), `goals-26.test.ts` **31/31** (create/plan/fallback/conflict-detector, plan edits, approval gate, decide APPROVE/REJECT, evidence-required completion, no_evidence auto-escalation, budget/deadline/dependency blocks, memory feed once, pause/resume/cancel, escalation lifecycle, tenant negatives).
- Full backend regression: **84 files, 1242 passed / 3 skipped / 0 failed** (baseline 81/1182 + 60 new).
- Frontend: 40 files / 236 passed; local-agent: 5 files / 49 passed.
- Typecheck: shared + backend + frontend EXIT 0; backend `tsc --noEmit` clean; backend + frontend + shared builds EXIT 0.

## Migrations
- `0046_stage26c_scheduled_goals.sql` (applied live at 46/46): `scheduled_tasks` (recurrence check list, `next_run_at` NOT NULL, execution_mode CLOUD/LOCAL_ONLY/HYBRID, missed_run_policy check list, timeout_ms 60000–86400000, max_attempts 1–5, require_approval, notify_on_completion), `schedule_runs` (status check list + `UNIQUE (schedule_id, scheduled_for)`, agent_run_id, reason), `goals` (status check list, plan/progress/evidence/blockers jsonb, budget, deadline, require_approval), `goal_activities`, `escalations` (status/user_decision checks), `ALTER TABLE tasks ADD COLUMN goal_id`; RLS on all tenant tables + indexes.
- `0047_stage26c_goal_approval.sql` (applied live at 47/47): `goals.approval_id`.

## Failures found & fixed during the slice
- Test harness: INSERT regex did not tolerate newline before `VALUES` (claim/INSERT resolver missed); reconcile `UPDATE scheduled_tasks` carries only `WHERE id = $1` (resolver required owner_id) — both fixed in the resolver; DST test expectations corrected to real transition instants (next run after spring-forward is 09:00 EDT, not EST); wall-clock helper sign corrected; goal `SUM(spent_usd)` param is a JS array (not a JSON string); `memory_fed` guard query has no owner_id param.
- Agent-busy runs store the human message (`Agent agt-1 has an active run`), not the code — test assertion aligned to the real contract.

## Limitations / deferred
- Frontend UI for scheduled work + Goal Mode (API contracts final; existing pages untouched).
- Live end-to-end scheduled/goal executions cannot be observed (all AI providers DOWN in this environment — the code fails honestly at runtime; provider-dependent E2E scenarios remain blocked, never fabricated).
- Cron step syntax (`*/5`) intentionally unsupported (honest null, documented in code).
- Cost estimation stays null while providers are down (provider-gated).
- Real credentials (Gmail OAuth, Razorpay, plugin tokens) absent — honest statuses only.
- 26D (event automation, broader escalation), 26E, 26F and remaining payment/plugin/control-plane/UI surfaces — **remaining, not started**.

## Next steps (per continuation prompt)
26D event automation + escalation → 26E failure autopsy + time-travel → 26F engineering agents → preview/plugin/control-plane/secret-leak/usage/payment completion → frontend surfaces for 26A/26B/26C → full regression → update this report → **STOP (no deployment)**.

---

## STOP — NO DEPLOYMENT PERFORMED
