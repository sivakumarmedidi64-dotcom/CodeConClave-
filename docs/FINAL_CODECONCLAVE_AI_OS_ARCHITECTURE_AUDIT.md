# FINAL CODECONCLAVE AI OS ARCHITECTURE AUDIT

**Date:** 2026-09-01 | **Type:** AUDIT ONLY — no implementation | **Auditor:** opencode (read-only)

**LIVE SYSTEM STATUS (verified via source):**
- Backend: LIVE | Frontend: LIVE | Neon (Postgres): LIVE | Auth: LIVE | Security: LIVE
- Cowork / product systems: LIVE | Payments: LIVE (frozen, pending-only)
- **SOURCE_CHANGES: NONE | DATABASE_CHANGES: NONE | DEPLOYMENT: NONE**

This audit answers one question: **what already exists in the live codebase that
maps to an "AI Operating System for Cowork", and what foundational primitives
are missing before we add that layer?** Nothing is rebuilt, deleted, or redeployed.

---

## 1. INVENTORY — EXISTING CAPABILITY MATRIX

Legend: **EXISTS** / **PARTIAL** / **ABSENT** / **UNKNOWN**

| Capability | Status | Actual mechanism (source-verified) |
|---|---|---|
| Agents (multi) | **PARTIAL** | `modules/agents/` run fan-out over the task engine; fragmented lifecycle across `agents/`, `agent/`, `execution/`, `local-agent/` |
| Coworkers (personas) | **EXISTS** | `execution/coworkers.ts` — 9 coworker roles (ARCHITECT, CODER, SECURITY, TESTER, PERFORMANCE, RESEARCH, DOCS, REVIEWER, PLANNER) |
| Task execution | **EXISTS** | `execution/tasks.ts` full state machine + pipeline in `orchestrator.ts` |
| Queues | **EXISTS** | **Postgres `tasks` table IS the queue** (`shared/queue.ts`), atomic `FOR UPDATE SKIP LOCKED` claim |
| Worker processes | **EXISTS** | `workers/task-worker.ts` in-process poller (2s, concurrency 2) + standalone `run.ts` |
| Background jobs | **EXISTS** | task-worker + `workers/watchdog.ts` (15s sweep) |
| Watchdog sweeper | **EXISTS** | heartbeat, timeout fail, retry/DLQ, approval expiry, outbox, schedule, automation, autopsy |
| Memory | **EXISTS** | `modules/memory/` pgvector (HNSW) + BM25 hybrid, provenance, corrections, decisions, continuity |
| Persistence | **EXISTS** | Postgres-centric single `pg.Pool`; Redis as cache only |
| Filesystem access | **EXISTS** | `integrations/storage.ts` (S3/R2/local-memory), whole-file versioning + rollback + trash in `modules/files/` |
| Terminal execution | **PARTIAL** | mirrored from **paired local-agent** over `/agent` WS (cloud never forks a shell) |
| Subprocess management | **ABSENT** | no dedicated subprocess supervision/respawn; server `spawn`/`execSync` in preview build + refactoring wizard only |
| Scheduling | **EXISTS** | `modules/scheduling/` cron/recurrence, DST-safe, atomic due-claim, goals |
| Concurrency | **PARTIAL** | fixed worker concurrency (2); in-flight set; no per-agent runtime budgets |
| WebSocket / SSE | **EXISTS** | `modules/agent/ws.ts` hub + `agent/browser.ts`; SSE in conversations (Last-Event-ID replay) + preview |
| Permissions / RBAC / RLS | **EXISTS** | `auth/rbac.ts` (owner→viewer), withTenant RLS key; policy engines |
| Authentication | **EXISTS** | session cookies + MFA (TOTP) + Google OAuth; device-token WS auth (parallel path) |
| Workspace isolation | **PARTIAL** | project/team scoping + RLS; no process-level isolation |
| Rate limiting | **EXISTS** | Redis-backed, fail-closed (`middleware/rate-limit.ts`) |
| Resource controls | **PARTIAL** | run budgets (`max_tasks`, `max_retries`, `budget_usd`, `deadline`); no CPU/mem limits |
| Retries | **EXISTS** | exponential backoff columns (`retry_count`, `next_attempt_at`) — canonical in `tasks.ts:248-251` |
| Cancellation | **PARTIAL** | sets `CANCELLED` row state; **no cooperative interrupt of an in-flight RUNNING task** |
| Crash recovery | **EXISTS** | stale-run recovery + per-attempt checkpoint resume (`tasks.ts:566-590`) |
| Logging | **EXISTS** | `shared/logger.ts`, sanitized `errInfo` |
| Telemetry | **EXISTS** | audit logging (append-only, 100+ actions) + observability module |
| Package/dependency install | **ABSENT** | none in cloud; not in local-agent |
| Docker / sandboxing | **ABSENT** | only `plugins/sandbox.ts` = **fake-data**; backend `execSync`/`spawn` unsandboxed on host |
| Git operations | **PARTIAL/STUBBED** | `developer-productivity/gitNinja.ts` endpoints return **hardcoded empty** data; no real git dispatch |
| Cloud execution | **PARTIAL** | in-process worker on backend host; no isolation |
| Local execution | **EXISTS** | `local-agent/` (files/diff/terminal/policy/hub) runs on **user machine** (user trust boundary) |

---

## 2. MAP EXISTING ARCHITECTURE → AI OS COMPONENT

Legend: **EXISTS** (real equivalent) · **PARTIAL** (equivalent with gaps) · **ABSENT** (no real equivalent)

### KERNEL / PROCESS SYSTEM
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Process Manager | task engine (create/state machine) | EXISTS |
| Kernel Scheduler | `shared/queue.ts` claim + schedule executor | EXISTS/PARTIAL |
| Process Tree | `task_dependencies` DAG + run→task chain | PARTIAL (task DAG, not general intra-task DAG) |
| Process Supervision | task-worker watchdog + heartbeat | EXISTS |
| Process Monitoring | audit + telemetry + heartbeat | EXISTS |
| Interrupt Handler | approvals / cancel row-state | PARTIAL (no in-flight interrupt) |
| Signal Handling | `run.ts` SIGINT/SIGTERM graceful drain | EXISTS |
| Context Switching | checkpoint resume across attempts | PARTIAL |
| Process Affinity | n/a | ABSENT (overkill at current scale) |
| Load Balancer | fixed concurrency 2; no dynamic balancing | ABSENT |
| Reaper Process | stale `RUNNING` recovery sweeper | EXISTS |
| Process Accounting | task_attempts + run budgets | PARTIAL |
| Deadlock Detector | `blockBlockedDependencies` (dependents of failed) | PARTIAL (no cycle/TTL deadlock detection) |
| Priority Inversion Prevention | `PLAN` priority ordering only | ABSENT |
| Emergency Resource Release | kill switch + run deadline | PARTIAL |
| Suspend/Resume | pending/blocked states; no real pause/resume of in-flight | PARTIAL |

### MEMORY
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Memory Manager | `modules/memory/service.ts` | EXISTS |
| Memory limits | scope = project/team; no quota/enforcement | PARTIAL |
| Garbage collection | trash retention/cleanup sweeps | PARTIAL |
| Cache optimization | `shared/cache.ts` (Redis-or-memory) | EXISTS |
| Swap memory | n/a | ABSENT (unnecessary) |
| Kernel memory pool | n/a | ABSENT (unnecessary) |
| State persistence | Postgres is the durable OS state store | EXISTS |

### FILESYSTEM
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Filesystem layer | `integrations/storage.ts` + `modules/files/` | EXISTS |
| Read/write abstraction | provider-agnostic (S3/R2/local) | EXISTS |
| Watch mode | **ABSENT** (no fs watch) | ABSENT |
| File locking | no advisory locks on concurrent edits | ABSENT |
| Snapshot | preview build snapshots only (not fs) | PARTIAL |
| Rollback | whole-file version rollback | EXISTS |
| Copy-on-write | **ABSENT** (versioning stores full blobs, not diffs) | ABSENT |

### IPC
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Inter-process communication | **no message broker** | ABSENT |
| Event bus | automation event_log + outbox (DB-backed, best-effort) | PARTIAL |
| Message queues | Postgres tables-as-queues (tasks, outbox, event_log) | EXISTS/PARTIAL |
| Serialization | JSON across WS/SSE; token-overlap decision replay | PARTIAL |
| Agent-to-agent communication | debates (via AI gateway + approval judge); no internal bus | PARTIAL |

### SCHEDULING
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Priority queues | `PLAN` order; no multi-level priority | PARTIAL |
| Preemption | **ABSENT** (running task not preemptible) | ABSENT |
| Fairness | no per-tenant fairness/quotas | ABSENT |
| Resource allocation | run budgets only | PARTIAL |
| CPU/memory/time budgets | time = `timeout_ms`/`deadline_at`; CPU/mem none | PARTIAL |
| Timer system | watchdog 15s + scheduler | EXISTS |
| Timer wheel | n/a | ABSENT (overkill) |

### EXECUTION / SANDBOX
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Virtual machine layer | **no VM/container isolation** | ABSENT |
| Workload isolation | RLS/tenant scoping (data-level, not process) | PARTIAL |
| Sandboxing | `plugins/sandbox.ts` = **fake-data only** | ABSENT |
| Breakout protection | **absent** | ABSENT |
| Port/network isolation | policy blocks trusted host patterns; no egress isolation | PARTIAL |
| System calls API | tool registry (`execution/tools.ts`) as a syscall analogue | PARTIAL |
| Device manager | device pairing + remote sessions | EXISTS |

### SECURITY
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| System permissions | RBAC roles + RLS | EXISTS |
| Capability-based security | policy engine (deny-by-default, baseline deny first) | EXISTS |
| Secret management | AES-256-GCM at rest (plugins creds, OAuth refresh); SecretGuard scan | EXISTS |
| Firewall rules | policy network host blocklist | PARTIAL |
| Network restrictions | blocklisted hosts only; no egress allow-list | PARTIAL |

### OPERATIONS
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Package manager | **ABSENT** | ABSENT |
| Version control integration | Git Ninja **stubbed** (empty data) | PARTIAL/STUBBED |
| Telemetry backend | audit + observability + usage | EXISTS |
| Kernel logging | shared logger + audit | EXISTS |
| System-call tracing | tool-call registry/policy trace | PARTIAL |
| Process tracing | task attempt history | PARTIAL |

### RELIABILITY
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Boot sequence | server boot + worker startup | EXISTS |
| Crash recovery | stale recovery + checkpoint resume | EXISTS |
| Kernel panic handler | process-level? none; app-level error handling | PARTIAL |
| Process respawn | re-claim to CREATED, not respawn | PARTIAL |
| Exponential backoff | `tasks.ts:248-251` + outbox + agents | EXISTS |
| Failure alerts | notifications + digests + autopsy | EXISTS |

### HOST / RESOURCE MANAGEMENT
| AI OS concept | Existing equivalent | Status |
|---|---|---|
| Thermal management | n/a | ABSENT (unnecessary) |
| Core isolation | n/a | ABSENT (unnecessary) |
| NUMA awareness | n/a | ABSENT (unnecessary) |
| DMA/memory mapping | n/a | ABSENT (unnecessary) |
| Disk I/O scheduling | none | ABSENT |
| File descriptor management | none | ABSENT |

---

## 3. DUPLICATION DETECTION

For each concern: **DUPLICATE** / **CONSOLIDATE** / **KEEP** / **NOT_DUPLICATE**.

- **Queue/claim logic**: `shared/queue.ts` is the single canonical claim (`KEEP`). Scheduling uses its own unique-constraint claim (`NOT_DUPLICATE`, different technique, `CONSOLIDATE` onto shared primitives for consistency).
- **Retry/backoff state machines**: tasks, **outbox**, **agents(runs)**, **scheduling**, **approvals** EACH re-implement attempts/backoff/state. Same **pattern**, 5 separate instances → **DUPLICATE pattern** — the AI OS should expose ONE shared retry primitive and migrate consumers (CONSOLIDATE).
- **Cancellation**: row-state cancel in tasks + scheduling + approvals; no shared interrupt primitive → **DUPLICATE pattern** (CONSOLIDATE into supervisor).
- **State machines**: tasks, agents/runs, scheduling, outbox, approvals each define their own status sets → **DUPLICATE pattern** (OS should own process lifecycle; CONSOLIDATE).
- **Memory stores**: Postgres memories table + embedding-status queue; cache Redis-or-memory; outbox + event_log append-only → multiple stores, distinct concerns → **NOT_DUPLICATE** (keep separate; do not force-merge).
- **Agent lifecycle**: `agents/` + `agent/` + `execution/` + `local-agent/` manage overlapping lifecycle concepts → **DUPLICATE** — the single biggest consolidation target (CONSOLIDATE under one Supervisor/PID model).
- **Filesystem abstraction**: `integrations/storage.ts` is single provider layer; `files/service.ts` consumes it → `KEEP` (already centralized).
- **Permission/policy engines**: `control/policies.ts` + `execution/policy.ts` + `local-agent/policy.ts` = three overlapping policy decision engines → **DUPLICATE** (CONSOLIDATE into one capability/`Policy` primitive — but note local/cloud have different threat models; at minimum share risk-classification vocabulary).
- **Worker supervisors**: task-worker + watchdog + schedule executor are related but distinct sweeps; not duplicated → `KEEP` (consolidate supervision semantics under the OS Supervisor later).

---

## 4. COWORK FEATURE MAPPING

Legend: EXISTS · PARTIAL · ABSENT · DependsOn=AI OS primitive needed · DB=new schema? · Risk

| Feature | Now | Depends on AI OS | Needs new DB? | Needs new service/worker? | Production risk |
|---|---|---|---|---|---|
| Breakpoint System | ABSENT | Process Manager (pause/suspend/resume) | Yes (checkpoint/pause state) | No (extend task engine) | Medium |
| Real-time Diff View | PARTIAL | Filesystem (diff/COW/watch) | Maybe | No | Low |
| Session Replay | ABSENT | State persistence + IPC (event log replay) | Yes | No | Low |
| Smart File Picker | ABSENT | Filesystem + Workspace Context | No | No | Low |
| AI Personality Modes | ABSENT | (model gateway only) + memory style prefs | Maybe | No | Low |
| Undo Last N | PARTIAL | State persistence (undo journal) | Yes | No | Low-Med |
| Cowork Templates | ABSENT | IPC/recipes (reuse automation recipes) | Yes | No | Low |
| Custom Stop Rules | ABSENT | Scheduler + Supervisor (preempt/stop) | Yes | No | Med |
| Command Palette | **EXISTS** (Ctrl+K, not "F82") | — | No | No | Low |
| Team Cowork | ABSENT | IPC (agent-to-agent) + scheduler | Yes | No | Med |
| Handoff Cards | PARTIAL | State persistence (continuity) | No | No | Low |
| Team Invites | **EXISTS** | — | No | No | Low |
| Live Presence | **EXISTS** (device WS online) | — | No | No | Low |
| 24/7 Background Work | **EXISTS** | — (worker already server-side) | No | No | Low |
| Notifications | **EXISTS** | — | No | No | Low |
| Session Summary | PARTIAL | Memory + return-to-work | No | No | Low |
| Terminal Export | **EXISTS** | — | No | No | Low |
| Error Quick-Fix | ABSENT | Supervisor + tool calls + review gate | Yes | No | **High** (auto-fix risk) |
| Keyboard Shortcuts | PARTIAL | — | No | No | Low |
| Workspace Context Sidebar | PARTIAL | Filesystem/Memory context | No | No | Low |
| Mobile UI | **EXISTS** | — | No | No | Low |
| Git Integration | PARTIAL/STUBBED | Filesystem/execution + git engine | No | Maybe (local-agent) | Med |
| IDE Extensions | ABSENT | WS hub + IPC | No | Yes (new surface) | **High** |
| Jira/Slack/GitHub | PARTIAL | Webhook ingestion + plugins | Maybe | No | Med |
| Usage Dashboard | **EXISTS** | — | No | No | Low |
| Pricing | PARTIAL | — | — | — | Low |

---

## 5. AI OS DEPENDENCY GRAPH (from actual repo modules)

```
IPC / Event Bus (ABSENT → build)
    ↓ (state changes published)
Process Manager / Supervisor  (execution/tasks.ts + workers) 
    ├── Scheduler (shared/queue.ts + scheduling/executor.ts)
    │        ↓ multi-agent orchestration (agents/service.ts) + coworker fan-out (execution/coworkers.ts)
    │        ↓ Background Cowork (workers/task-worker.ts, watchdog.ts)
    ├── State Persistence (Postgres)
    │        ↓ Checkpoint/resume (tasks.ts) → Breakpoint → Session Replay → Handoff (continuity.ts)
    ├── Filesystem Layer (integrations/storage.ts + modules/files)
    │        ↓ Workspace Context (memory/context.ts) → sidebar → Smart File Picker
    │        ↓ Diff/COW (ABSENT → build) → Real-time Diff
    ├── Memory (modules/memory) → Slide context, summaries, personality
    ├── Permissions / Policy (execution/policy + control/policies + local-agent/policy) 
    │        ↓ capability-gated Tool Calls (execution/tools.ts) 
    │        ↓ Sandboxed Execution (ABSENT → build) → Security Agent
    └── Terminal/Remote (modules/terminal + agent/ws) → IDE Extensions, Live Presence, Keyboard Shortcuts
```

Key real-world derivations:
- **Filesystem Layer → Workspace Context → Smart File Picker** — files + memory context already present; picker is a UI on top.
- **Process Manager → Scheduler → Multi-Agent → Background Cowork** — already real (task engine + worker).
- **State Persistence → Breakpoint → Session Replay → Handoff** — persistence + handoff real; **breakpoint & replay are the missing pieces**.
- **Permissions → Syscall API → Sandbox → Security Agent** — permissions/tool-call registry real; **sandbox ABSENT** (the critical gap).
- **IPC → Live Presence / Team Cowork / IDE Extensions** — WS hub real; **a message bus is missing** for cross-agent team cowork.

---

## 6. TRUE KILLER COMPONENTS — RANKED

Scored on foundational value, features unlocked, reuse, security, reliability, differentiation, complexity, production risk.

### P0 — FOUNDATIONAL (build first; almost everything depends on them)
1. **State Persistence as an OS primitive** — Postgres already IS this; formalize process/attempt/checkpoint/event serialization. Unlocks breakpoint, replay, handoff, undo, resume.
2. **Process / Supervisor lifecycle** — unify the fragmented agent lifecycle + add suspend/resume + in-flight cooperative cancellation into ONE supervisor. Kills the biggest duplication (`agents/`+`agent/`+`execution/`). Enables pause/resume, stop rules, error quick-fix.
3. **Filesystem diff/COW/watch layer** — extend existing `files/service.ts` from whole-blob versioning to **Myers diff + copy-on-write + watch**. Unlocks Real-time Diff, Smart File Picker, undo, IDE-ish workflows. High reuse; low risk.
4. **Permissions / Capability layer consolidation** — one capability-based policy primitive shared by control, execution, local-agent. Security-critical; reduces three divergent engines. Enables controlled execution.
5. **Resource governance (budgets + time + rate)** — extend run budgets to a general Resource Governor (CPU/mem/token/rate). Prevents runaway; foundation for safe background work.

### P1 — IMPORTANT
6. **Scheduler** — formalize the existing `scheduling/` + `shared/queue.ts` into execution policy (priority, budgets); add general intra-task DAG.
7. **IPC / Event Bus** — a real durable event bus (Postgres outbox-backed) so agents/processes/WS broadcast state; unlocks Team Cowork, Live Presence extensions, IDE Extensions, cross-agent coordination.
8. **Supervisor (watchdog, respawn, panic)** — consolidate the watchdog sweeps into an OS supervisor with respawn semantics.
9. **Sandbox / execution isolation** — the single most security-important new primitive; gates Error Quick-Fix, cloud execution, package installs, IDE execution.
10. **Observability / telemetry consolidation** — unify audit + metrics + tracing for OS-wide process tracing.
11. **Git / VCS engine** — implement the stubbed Git Ninja against real git (via local-agent + cloud broker) — foundational for real diff/handoff/PR flows.

### P2 — ADVANCED
12. **Breakpoint System** (on the P0 process/state primitives)
13. **Session Replay** (on P0 state + event log)
14. **Undo Last N** (on P0 state + event log)
15. **Team Cowork** (on IPC + scheduler)
16. **AI Personality Modes** (model gateway + memory)
17. **Custom Stop Rules** (on supervisor/scheduler)

### P3 — FUTURE / EXPERIMENTAL
18. **IDE Extensions** (external surface; high risk, needs stable IPC + sandbox first)
19. **Package/dependency manager (sandboxed)** 
20. **Docker/container workload isolation** for cloud code execution
21. **Jira/Slack/GitHub first-class connectors** (beyond stub/plugin-action status)

---

## 7. REDUNDANT / LOW-VALUE OS COMPONENTS (do NOT build literally)

These are real OS terms that are **NOT appropriate to implement literally** at CodeConclave's current scale. If retained as abstractions, map as follows:

| Term | Verdict | If retained, map as… |
|---|---|---|
| NUMA awareness | unnecessary | n/a (single-host Node) |
| DMA / memory mapping | unnecessary | n/a |
| Thermal management | unnecessary | n/a (cloud provider handles) |
| CPU core pinning | unnecessary | future: affinity hint to scheduler |
| Swap memory | unnecessary | future: memory spill to cache |
| File descriptor emulation | unnecessary | n/a |
| Timer wheel | unnecessary | keep watchdog+schedule (no need for a wheel) |
| Process affinity | future | scheduler priority hint |
| Priority inversion prevention | future | task-priority-aware claim when multi-priority added |
| Deadlock detector | **worthwhile now (PARTIAL)** | extend `blockBlockedDependencies` with cycle/TTL detection |

---

## 8. SECURITY AUDIT (AI OS introduces new risk — mapped against existing controls)

| Threat | Existing protection | Gap (for AI OS) |
|---|---|---|
| Arbitrary code execution | preview/refactor `spawn`/`execSync` **unsandboxed on host**; local-agent on user machine | **No sandbox/container/privilege drop** → P0 gap |
| Prompt injection | policy deny-by-default on tools; plan parsed+validated (free-form never executed) | model output → tool-call chain needs capability scoping per agent |
| Agent privilege escalation | agent roles/trust; run budgets | fragmented lifecycle = no single authority to enforce escalation bounds |
| Workspace traversal | storage path-traversal guards; RLS tenant scoping | no process-level chroot/namespace for cloud execution |
| Secret exfiltration | policy blocks secret patterns; SecretGuard scan; AES-256-GCM at rest | sandbox + egress allow-list needed |
| Cross-workspace access | RLS + project/team context | no per-process isolation |
| Agent-to-agent privilege escalation | debates via approval/judge | no graded trust propagation across agents |
| Runaway processes | run deadline + kill switch + timeouts | no CPU/mem/egress quotas at process level |
| Resource exhaustion | rate limiting (Redis) + run budgets | no general Resource Governor |
| Package supply-chain | — | **no package manager at all** (must be sandboxed + scanned) |
| Malicious dependencies | — | absent (would be new) |
| Sandbox escape | — | **no sandbox exists** to escape — build first |
| Network abuse | blocklisted hosts in policy | no egress allow-list / per-sandbox networking |
| Unauthorized file modification | policy + approvals + RLS | sandbox + capability-scoped writes |

**Protections that are genuinely strong (not the problem):** authn/authz, RBAC+RLS, secret-at-rest encryption, approval gating, kill switch, deny-by-default policy engine, rate limiting, audit trail.
**The decisive gap:** there is **no runtime process-isolation layer**. The approval/control gates currently guard an **unsandboxed** execution surface. Any credible "AI OS" execution claim must start with a sandbox.

---

## 9. DATABASE IMPACT (no migrations — assessment only)

**Existing tables reused (no change):**
- `tasks`, `task_attempts`, `task_dependencies`, `task_dlq` → process manager + scheduler + DLQ
- `memories` (+ pgvector) → memory
- `files` / `file_versions` (+ trash) → filesystem
- `schedule_runs`, `schedules`, `goals` → scheduler
- `ai_agent_runs` (+ tasks) → agent runs
- `outbox_events`, `audit_logs`, `event_log`, `notifications` → IPC/telemetry/notify
- `payment_intents`, `payment_sessions`, `payment_claims`, `entitlements` → (unchanged)

**Redis (existing):** cache + rate limiter. **Does not hold OS queue state** (queue = Postgres).

**Would need NEW tables / migrations (NOT created — future phases, gated):**
- OS process/supervisor events, checkpoint/pause state (Breakpoint/Suspend-Resume)
- Event-bus subscription/offset table (Team Cowork, Session Replay)
- Undo journal (Undo Last N)
- Workspace/run resource-quota ledger (Resource Governor)
- Personality/style preferences (AI Personality)
- Git workspace metadata (Git integration)
- Cowork templates / stop-rules

**Classification per capability:** OS core primitives (process, state, memory, fs, scheduler) largely **reuse existing tables**; the new durability needed is narrow and can be introduced behind feature flags in later phases.

---

## 10. PRODUCTION DEPLOYMENT IMPACT (live system must not break)

| Phase | Scope | Live risk |
|---|---|---|
| **Phase 0** | **THIS AUDIT.** No source/DB/deploy change. | None |
| **Phase 1 — OS core behind feature flags** | Introduce Supervisor/scheduler/state/fs-diff primitives as **new modules invoked only when flag on**; existing task path unchanged. | None if flag-gated & isolated tests |
| **Phase 2 — internal/test users** | Enable OS path for internal/staging accounts only; keep production data read-only or shadow-mode. | Low |
| **Phase 3 — production beta** | Sandbox + resource governor live; OS path for opt-in beta cohort; rollback flag = kill switch fallback. | Medium (isolated) |
| **Phase 4 — general availability** | Full migration of cowork onto OS layer; old independent infra **deprecated not deleted** during transition. | Managed |

Guiding rule: **additive, flag-gated, reversible.** The existing task/worker/memory paths remain the fallback until the OS layer is proven equal-or-better under load.

---

## 11. MONOLITH vs SERVICE BOUNDARY

- **Keep the AI OS core INSIDE the existing Node backend** (monolith) for Phase 1–2. The backend already owns the queue (Postgres), the in-process worker, Redis, and the tool registry. Splitting services now adds latency + ops burden for zero Phase-1 benefit.
- **Minimum boundaries — do NOT over-decompose:**
  1. **Worker** already runs as an optional standalone process (`run.ts`) — keep that split as-is (workload boundary, not OS boundary).
  2. **local-agent** is already a separate process on the user's machine — keep it; it is the LOCAL execution trust boundary.
  3. **Sandbox executor** (P1) is the FIRST justified new isolated component (separate process/container) because it must contain arbitrary code that the backend currently runs unsandboxed.
- **Recommendation:** monolith-first; extract only the **sandbox executor** and later the **event-bus** if cross-process fan-out demands it. Do not create a second app.

---

## 12. LOCAL + CLOUD ARCHITECTURE SPLIT (based on actual implementation)

| Component | Locus | Evidence |
|---|---|---|
| Filesystem (user workspace) | **LOCAL** | `local-agent/files.ts` + `diff.ts` on user machine |
| Terminal/subprocess (interactive) | **LOCAL** | `local-agent/terminal.ts`; cloud mirrors via WS (`terminal/service.ts`) |
| Local-agent policy | **LOCAL** | `local-agent/policy.ts` (deny-default, grants vs protected paths) |
| Scheduler | **CLOUD** | `scheduling/executor.ts` inside backend/watchdog |
| Task/process engine | **CLOUD** | `execution/` + `workers/` in backend |
| Cloud execution (build/test) | **CLOUD** (currently unsandboxed) | `preview/service.ts` spawn, `refactoringWizard.ts` execSync |
| Memory | **SHARED** | Postgres (cloud) but scoped per project/team |
| Workspace permissions | **LOCAL + CLOUD** | local policy + cloud RLS/RBAC |
| Execution sandbox | **LOCAL + CLOUD** | local = user boundary; cloud = build (P1) |
| Git | **LOCAL** (real) / **CLOUD** (broker, stubbed) | local-agent capability; cloud Git Ninja stub |
| Secrets | **CLOUD** (vault) + **LOCAL** (agent policy) | AES at rest; local policy allow-list |

---

## 13. COMPETITIVE DIFFERENTIATION / MOAT

Do **not** market on feature count. The durable architectural moat from THIS codebase is the combination of four already-real primitives that competitors rarely combine on one plane:
1. **Persistent, searchable memory (pgvector + provenance + decisions + continuity)** — not per-chat context, but a durable project memory that survives sessions. → resumability, "while you were away".
2. **A real server-side background execution engine** (worker + watchdog + task DAG + checkpoints) that runs **24/7 without a browser open** → background work is already a platform property, not a UI trick.
3. **Local + cloud split** (local-agent on user machine + cloud scheduler/process) → controlled local workspace access without giving the cloud arbitrary host code.
4. **Defense-in-depth control plane** (deny-by-default policy, risk-based approvals, kill switch, RLS, audit) → `controlled execution`.

The **AI OS layer** turns these four scattered strengths into a *platform primitive*: supervisor + resource governor + sandbox + IPC that every cowork feature calls instead of reimplementing. That is the moat — a system that can run, pause, resume, sandbox, and audit autonomous multi-agent work with real memory. The **missing keystone is the sandbox/process-isolation** — without it, the "OS" claim is architecturally hollow.

---

## 14. SINGLE INTEGRATED ARCHITECTURE (one diagram, mapped to real modules)

```
User
 ↓
CodeConclave App (frontend — already live)
 ↓
Cowork Runtime (execution/, agents/, scheduling/, terminal/, memory/, files/, notifications/)
 ↓
AI OS Kernel  (NEW thin layer — consolidates + adds)
 ├── Process Manager          ← execution/tasks.ts state machine (unify agents/)
 ├── Supervisor               ← workers/task-worker.ts + watchdog.ts (add respawn/suspend/resume)
 ├── Scheduler                ← shared/queue.ts + scheduling/executor.ts (add priority/budgets)
 ├── Memory                   ← modules/memory/* (pgvector + provenance + decisions + continuity)
 ├── Filesystem               ← integrations/storage.ts + modules/files/* (ADD diff/COW/watch)
 ├── IPC / Event Bus          ← outbox + event_log + WS/SSE (ADD durable bus)
 ├── Resource Governor        ← run budgets + rate limit (ADD CPU/mem/egress quotas)
 ├── Permissions / Capability ← execution/policy + control/policies + local-agent/policy (CONSOLIDATE)
 ├── Sandbox                  ← (ABSENT — ADD isolated executor)
 ├── State                    ← Postgres (already the OS durable store)
 └── Telemetry                ← audit + observability + usage
 ↓
Agents / Tools / Models (tool registry, AI gateway, 9 providers)
 ↓
Local Workspace (local-agent)  /  Cloud (backend worker)  /  External (webhooks, plugins, git)
```

**What is already the "kernel":** an unusually complete Postgres-backed task/process/scheduler/state/memory substrate with a watchdog. The AI OS is a **consolidation + 3 missing primitives** (Supervisor semantics, real IPC/event bus, and Sandbox), not a greenfield rewrite.

---

## 15. IMPLEMENTATION ORDER (sequence only — no work now)

**P0 (foundation):**
- P0: Consolidate process lifecycle under one Supervisor (unify `agents/`,`agent/`,`execution/`)
- P0: State persistence as a formal OS primitive (event/checkpoint serialization)
- P0: Filesystem diff/COW/watch layer atop `files/service.ts`
- P0: Capability/policy consolidation (one shared risk vocabulary)
- P0: Resource Governor (budgets: time/token/rate → CPU/mem later)
- P0: Sandbox executor (isolated process/container) — **security keystone**

**P1:**
- P1: Durable IPC / Event Bus (outbox-backed)
- P1: Supervisor respawn/panic/resume semantics
- P1: General intra-task DAG in scheduler
- P1: Breakpoint system (on P0 state)
- P1: Real Git/VCS engine (un-stub Git Ninja via local-agent)
- P1: Observability/tracing consolidation

**P2:**
- P2: Session Replay · Undo Last N · Team Cowork · Custom Stop Rules · AI Personality · Session Summary upgrade

**P3 (future/experimental):**
- P3: IDE Extensions · Package manager (sandboxed) · Docker workload isolation · first-class Jira/Slack/GitHub connectors

---

## 16. SUCCESS CRITERIA (eventual, "fix auth while I sleep")

The end state, mapped to what must exist:
- **creates cowork** → already (task engine)
- **creates processes / assigns agents / schedules work** → already (orchestrator + coworker + scheduler)
- **filesystem capabilities** → P0 (diff/COW/watch added)
- **isolates execution** → **P0 sandbox (currently ABSENT)**
- **persists state / pauses/resumes / handles failures / retries** → already (Postgres + checkpoint + watchdog)
- **records audit trail / runs tests** → already (audit + task `TESTING` stage)
- **notifies user / preserves memory** → already (notifications + memory)
- **lets user review changes** → P1 (real diff + review gate)
- **WITHOUT breaking production** → additive, flag-gated, reversible phases (sec. 10)

**CURRENT LIVE SYSTEM: SAFE** (audit-only; nothing changed)
**SOURCE_CHANGES: NONE** · **DATABASE_CHANGES: NONE** · **DEPLOYMENT: NONE**

*End of audit. Secret-free. Read-only.*
