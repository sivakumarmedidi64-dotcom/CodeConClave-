# CodeConClave — PKG-25 — 24/7 Autonomous Cowork + Durable Background Execution + Failure Recovery + Continuity + Proof — Scope & Audit

**Package:** PKG-25 (CodeConClave PRO)
**Theme:** 24/7 AUTONOMOUS COWORK + DURABLE BACKGROUND EXECUTION + FAILURE RECOVERY + CONTINUITY + PROOF
**Status:** Active (set by this document)

PKG-25's mission is to make CodeConClave's **existing** autonomous/background cowork
capability **durable** and then **PROVE** it with real, honest evidence. It is NOT primarily
about adding new AI features — it is about demonstrating that the existing scheduler +
queue + worker + watchdog + task engine behaves reliably like an always-available cowork:
USER CREATES TASK → PERSISTS → SCHEDULER/WORKER PICKS UP → AGENT EXECUTES → USER CAN
LEAVE → WORK CONTINUES → PROGRESS PERSISTS → FAILURE RECOVERS → RESTART LOSES NOTHING →
RESULT PERSISTS → USER RETURNS → CONTINUITY RESUMES.

It is an **additive hardening + proof layer** over the existing task engine
(`modules/execution/tasks.ts`), queue (`shared/queue.ts`), worker (`workers/task-worker.ts`),
watchdog (`workers/watchdog.ts`), scheduler (`modules/scheduling/*`), automations, recovery/
autopsy, outbox, idempotency, notifications, and PKG-23 memory.

**Hard constraints honored throughout:**
- NO second scheduler, NO second queue, NO second worker model, NO second execution engine,
  NO second memory system — every path REUSES the existing engine.
- NO feature deletion, NO test weakening, NO fake 24/7 claims, NO stale 256-basis.
- NO payment rework. NO secrets exposed in proofs/notifications/harness.
- Simulated/LOGIC proof is reported separately from REAL_INFRASTRUCTURE proof; never pretend
  a short-lived/mocked proof equals a continuously-running deployed worker.
- Does NOT start PKG-26.

---

## Canonical registry scope

Read: `CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md`, `FINAL_FEATURE_MATRIX.md`,
`docs/CODECONCLAVE_PKG24_GATE.md`, `CODECONCLAVE_PKG23_GATE.md`,
`CODECONCLAVE_PKG20_SCOPE_AND_AUDIT.md`, and the actual scheduling/execution/worker code.

The canonical registry's autonomy-theme IDs for **24/7 autonomous cowork, durable background
execution, task continuity, failure recovery, persistent autonomy** already map to the
**existing** `F22/F24` (task engine / task persistence / background tasks), the execution
task tables (Stage-7 task engine), the Stage-26C scheduling subsystem, and the automation
subsystem. These are **already implemented and PASS**. PKG-25 anchors to these **existing
IDs and foundations** (no invented IDs) and adds the durable-proof + hardening layer.

**Registry IDs claimed by PKG-25 (anchors reused, no fabricated IDs):**
- `F22/F24` — task engine / task persistence / background task execution (REUSED; `tasks`,
  `task_attempts`, `task_steps`, `task_checkpoints`, `task_dlq`, `task_dependencies`)
- Stage-7 task engine (fine-grained tasks + approvals + tool calls) (REUSED)
- Stage-26C scheduling (recurring schedules, missed-run handling, goals) (REUSED)
- Stage-26D automations (event-driven runs with dedupe) (REUSED)
- Worker + watchdog (task-worker.ts, watchdog.ts, queue.ts) (REUSED)
- Stage-26E/26G recovery + autopsies + outbox + kill switch + control (REUSED)
- PKG-23 memory / continuity (`memorycoding`) (REUSED for MEMORY_CONTINUITY)
- Notification service (REUSED for task lifecycle notifications)
- Idempotency module (REUSED for exactly-once side-effect guards)
- Runtime execution (REUSED for execution)

**IDs NOT implemented / honestly reported:** a durable "always-running daemon that survives
reboots and runs for days independent of any client" is `REAL_24_7_INFRASTRUCTURE` — reported
honestly per the environment this gate runs in (see truth model), never assumed VERIFIED.

---

## Scope & audit table

| Registry ID | Capability | Current Status | Existing Foundation | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|---|
| F22/F24 | Durable task model + persistence | PASS (VERIFIED) | `modules/execution/tasks.ts` + `tasks`/`task_attempts`/`task_steps`/`task_dlq`/`task_checkpoints` | Full durable field set exists (status, heartbeat, attempts, timeout, error, retry, DLQ, checkpoint) | Reused as-is in the proof harness | VERIFIED (reuse) |
| — | Explicit task state machine guard | PARTIAL | `setTaskStatus` + direct SQL transitions (implicit) | No explicit validator rejects illegal transitions (e.g. COMPLETED→RUNNING) | Add `autonomy/state-machine.ts` valid-transition graph + `assertValidTransition` | VERIFIED (additive guard) |
| F22/F24 | Heartbeat + stuck-task detection | PASS | `heartbeatRunningTasks`, `recoverStaleTasks`, `touchTask`, `watchdog.ts` | Exists (30s TTL, heartbeat recovery) | Proven in harness; report honestly (stalled RUNNING is recovered, never claimed as progress) | VERIFIED (reuse) |
| F22/F24 | Timeout + retry + dead-letter | PASS | `failTimedOutTasks`, `recoverTimedOutTasks`, `scheduleRetry`, `deadLetterTask`, `retryOrDeadLetter`, DLQ | Exists with exponential backoff + DLQ | Proven in harness | VERIFIED (reuse) |
| — | Idempotent side effects after retry | PARTIAL | `modules/idempotency` (`beginIdempotent`/`completeIdempotent`/`failIdempotent`) | No autonomy-facing exactly-once guard for retried side effects | Add `autonomy/idempotency.ts` guard reusing the idempotency module | VERIFIED (additive) |
| — | User-disconnect continuity proof | PARTIAL | execution is backend-driven; UI is not the source of truth | No deterministic disconnect proof | Harness "disconnect → progress → reconnect" phase driving the real engine | VERIFIED (additive proof) |
| — | Restart recovery proof | PARTIAL | checkpoints (`saveAttemptCheckpoint`/`latestCheckpoint`) + graceful drain | No deterministic restart proof | Harness "re-init → recover durable state → resume" phase, incl. REAL DB where available | VERIFIED (additive proof) |
| Stage-26C | Recurring autonomy / schedules | PASS | `modules/scheduling/*` (HOURLY/DAILY/WEEKLY/CRON; missed-run policies; unique occurrence claim) | Exists + idempotent duplicate-run prevention | Proven in harness | VERIFIED (reuse) |
| — | Notification of lifecycle events | PASS | `notifications/service.ts` + `modules/execution/tasks.ts` (started/completed/failed/approval) | Exists; notification failure never destroys task state | Proven in harness (fail-safe notification) | VERIFIED (reuse) |
| — | Resource/concurrency control | PASS | worker CONCURRENCY=2, `max_attempts`, `timeout_ms`, queue limit, kill switch, control policies | Exists (metadata-backed, not raw CPU enforcement) | Reported honestly (metadata controls only) | VERIFIED (reuse, honest) |
| F05/F14.. | Memory / continuity | PASS | PKG-23 `memorycoding` (coding context, continuity) | Exists | Connect task completion/pause to memory continuity, proven | VERIFIED (reuse) |
| — | 24/7 proof harness | MISSING | real engine functions + real DB (+ fake-DB for determinism) | No deterministic end-to-end proof | Add `autonomy/harness.ts` (12-phase lifecycle, failure injection, distinguish LOGIC vs REAL_INFRASTRUCTURE) | VERIFIED (new) |
| — | 24/7 truth report | MISSING | runtime probes (env gates, DB reachability, worker/watchdog mode) | No honest truth model | Add `autonomy/truth.ts` + `/api/v1/autonomy/status` | VERIFIED (new) |
| — | Frontend autonomy dashboard | PARTIAL | existing panels + task APIs | No autonomy dashboard | Add `AutonomousTasksPanel.tsx` (task/state/progress/attempts/recovery/result + truth readout) | VERIFIED (new) |

**Scope guardrails honored:**
- NO second scheduler/queue/worker/engine/memory — harness DRIVES the existing engine.
- NO payment architecture change; NO test weakening; NO feature deletion.
- NO fabricated 24/7 operation; truth model reports REAL_24_7 and REAL_LONG_RUNNING honestly.
- Feature-gated report/paths (`AIOS_P2_AUTONOMY`, default OFF, reversible); status remains
  available (read-only) so truth is visible regardless.
- Does NOT start PKG-26.
