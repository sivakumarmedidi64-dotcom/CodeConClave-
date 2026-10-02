# TRINITY ARCHITECTURE AUDIT — §1 + §80

**Date:** 2026-09-15
**Spec:** lavada.txt (TRINITY — One Mind, Three Bodies)
**Status:** §1 audit complete — ready for phased implementation

---

## §1 AUDIT — EXISTING SYSTEMS (Five Categories)

### 1. Task System
**EXISTS** — `backend/src/modules/execution/tasks.ts`
- 14 statuses: CREATED / PLANNED / CHANGED / WAITING_APPROVAL / RUNNING / TESTING / VERIFIED / COMPLETED / FAILED / TIMED_OUT / CANCELLED / BLOCKED / WAITING_FOR_LOCAL_AGENT / REQUIRES_REVIEW
- Guard: `guardTransition()` exists in `autonomy/state-machine.ts` — **BUT** only enforced inside `autonomy/harness.ts` (test layer). Runtime writesites **BYPASS** guardTransition: `tasks.ts:265` (scheduleRetry raw UPDATE), `tasks.ts:310` (deadLetterTask), `tasks.ts:463` (requestApproval), `tasks.ts:484` (approveTask), `approvals.ts:184` (rejectApproval). 5+ writesites in `orchestrator.ts`, `agents/service.ts`, `copilot/` call `setTaskStatus()` **without** guard.
- `execution_mode`: CLOUD / LOCAL / HYBRID (migration 0111). No runtime routing enforcement. No `task_location` column.
- Dependencies, DAG orchestrator, checkpoint resume, time-travel, autopsy: **EXISTS**
- DLQ, retry, dead letter: **EXISTS** (multi-layer: attempt checkpoint + user snapshots + irreversible guard + recovery history)
- **MISSING states for Trinity:** READY, EXECUTING, WAITING_FOR_DEVICE, RECOVERABLE

### 2. Task Workers / Queues
**EXISTS** — `backend/src/shared/queue.ts` (PostgreSQL-backed job queue with lease, backoff, DLQ), `backend/src/shared/workers/` (registry with claim+execute+heartbeat). `MAX_CONCURRENT_WORKERS` env var. `enqueueTask` is a no-op — watchdog polls directly. 24/7 lifecycle (real backend worker + watchdog sweep every 15s).

### 3. Watchdog
**EXISTS** — 15s sweep, stale task detection, auto-pause/resume on heartbeat loss.

### 4. Orchestrator / DAG
**EXISTS** — Persisted plan, dependency-safe task groups, checkpoint resume. Full DAG executor with sequence/parallel execution.

### 5. Agents (Multi-agent + Limit Enforcement)
**EXISTS** — `agents/service.ts` + `agents/debates.ts`. Plan-based limits: 2 free / 10 pro / 20 team. Trust L0–L4, clamped by plan. Multi-agent debate (max 5 debate agents). Agent limit enforcement in `assertWithinPlanLimits()`.

### 6. Memory
**EXISTS** — `memory/` module (conversations, superpowers, skill_signals, workspace memory). Memory signals, TTL, cron-sweep. Memory injection into chat prompts.
**MISSING for Trinity:** Cross-device memory synchronization — memory is not replicated to desktop.

### 7. Project DNA
**EXISTS** — Stage 47 (`project-dna.ts`): auto-extract from commits, task history, code analysis. 8 extraction kinds. Versioning, conflict detection. Consumed by agent prompts. Bound to workspace. No cross-device sync.

### 8. Notifications — DUPLICATE (Three Systems)
- `notifications/service.ts` — user notifications (DB-backed, SSE push via chat pipe)
- `team-notifications/service.ts` — team-level notifications (separate system)
- Activity path — writes directly into notification-adjacent audit fields

**DUPLICATE** — three notification paths not unified. No general push sender (chat SSE only).

### 9. Approvals — DISCONNECTED from Desktop
**EXISTS** — `execution/approvals.ts` (risk-based, L3/L4 approval required), `ApprovalCenter.tsx` frontend. Device-aware pending: `/agent` WS + `/agent-browser` push relay for desktop device status.
**DISCONNECTED:** No approval sync across surfaces. Desktop cannot receive or act on approval requests via Trinity sync. No `agent_id` foreign key in approval binding.

### 10. Evidence / Proof Reports — PARTIAL
**EXISTS** — `evidence/` dir, `proof-reports/` (Stage 31), causal chain tracking.
**PARTIAL:** `PaymentConfidence` exists (`active`/`grace`) but no `VERIFIED | SUPPORTED | INFERRED | UNVERIFIED` taxonomy. Proof routes disconnected from approval decision flow in UI. Confidence levels are two-state, not four-state.

### 11. Desktop App — DISCONNECTED (IPC Bridge Broken)
**EXISTS** — Electron 44.2.0: hardened preload, IPC channels (capabilit grants, drag-drop, clipboard, screenshots, URL launcher, terminal xterm.js).
**DISCONNECTED:** Zero `window.api.*` imports in frontend web code. Capability advertisement non-functional: desktop never sends capabilities to backend; backend hardcodes defaults. Two **separate** device registries: DB `devices` table (`modules/agent/service.ts`) vs in-memory `DeviceRegistry` (`os/devices/registry.ts`). Capability grant module exists but is gated by DEV-only preprocessor.

### 12. Local Agent — DISCONNECTED from Main Orchestration
**EXISTS** — `local-agent/` (companion runner, daemon.ts, WS + REST), file I/O + git + execution + terminal.
**DISCONNECTED:** Different registration flow than DB device registry. `hub.isOnline()` check not wired into task routing engine. Local agent cannot receive orchestration instructions through task state machine.

### 13. Web App
**EXISTS** — 30+ pages, routing, sidebar, command palette, presence indicators. Presence is polling-based (no realtime push).

### 14. Realtime — PARTIAL (No General Push Bus)
- Chat SSE: EXISTS (`lib/sse.ts`)
- Preview SSE: EXISTS
- WS for Local Agent: EXISTS (desktop WS bridge)
- General task/approval/presence/device event push: **ABSENT** — no broadcast bus.

### 15. Mobile — BROKEN from Trinity View
Responsive web (ChatPage.tsx 640px threshold). No PWA. No service worker. No push transport. No offline intent queue. Mobile is "absent" for Trinity.

### 16. Offline — PARTIAL
`lib/offline.ts`: tiny 2-op browser queue (approval.decide + notifications.markRead). Idempotency keys, conflict resolution, auto-flush on reconnect. Desktop offline: no architecture. Offline intent queue: not built.

### 17. Kill Switch / Global Stop
**EXISTS** — `control/killSwitch.ts` (force-kill, per-user granularity, task-state gate). Also: `control/policies.ts` (user-defined control policies with action-type: BLOCK / REQUIRE_APPROVAL / ALLOW). Policy tests exist. Integration wired into task creation + execution.
**MISSING:** Cross-device propagation (desktop not notified). Integration with local-agent.

### 18. Policy Engine
**EXISTS** — `execution/policy.ts`: typed actions (ALLOW / DENY / REQUIRE_APPROVAL / WAIT_FOR_DEVICE / WAIT_FOR_AUTH). Deny-by-default. L0–L4 trust model. RBAC. RLS. Capability grants. Secret path guard. Dangerous command blocklist. Network blocked hosts.
**MISSING:** User-defined trusted-values rules (e.g. "never deploy on Friday"). `control/policies.ts` exists but is a separate simpler system from `execution/policy.ts` — two policy engines not unified.

### 19. Connectors
**EXISTS** — OAuth connector system (11+ types), workspace-bound, RLS-scoped. Plugin adapters (GitHub, Jira, Slack, Linear etc.). Connector card UI. Health checks.

### 20. Auth / Sessions
**EXISTS** — Most complete subsystem. MFA (TOTP), device pairing, refresh rotation, workspace sessions. Device-pair approval flow with IP + user-agent fingerprinting. RLS policy.

### 21. Audit Logs
**EXISTS** — `audit/service.ts` + `activity/service.ts` (two tracks). Canonical audit events (80+ types). Activity aggregation from persisted tables. History service unified chronological view.

### 22. Scheduled Jobs
**EXISTS** — `cron-sweep.ts` (memory TTL), watchdog (task sweep), `reactive-rules.ts` (realtime reactions).

---

## §80 FINAL REPORT — TRINITY STATUS

### A. Existing systems reused
**IMPLEMENTED**
Massive reuse of existing subsystems: task state machine, watchdog, orchestrator, policy engine, approvals, memory, project DNA, audit, auth, MFA, kill switch, control policies, desktop Electron shell, local-agent CLI, web frontend routing and sidebar. No unnecessary duplicates created.

### B. Existing systems integrated
**PARTIAL**
- Two device registries (DB `devices` table vs `os/devices/registry.ts` in-memory) not unified
- Three notification engines (user/team/activity) not unified into one
- Command palette exists twice (frontend nav + backend OS registry) and is not connected
- Desktop IPC bridge exists but is DISCONNECTED from web frontend (zero `window.api.*` usage)
- `execution/policy.ts` + `control/policies.ts` are separate policy systems not unified

### C. New tables (Trinity-specific)
**NOT IMPLEMENTED**
Trinity spec requires new tables for: offline intent queue, memory sync log, approval sync, device capability advertisement, presence routing log. No Trinity-specific migrations created.

### D. New services (Trinity-specific)
**NOT IMPLEMENTED**
Trinity requires: Presence Engine, Sync Cortex, Local Twin, Reflex Registry. None built.

### E. New task states
**NOT IMPLEMENTED**
Trinity requires: `READY`, `EXECUTING`, `WAITING_FOR_DEVICE`, `RECOVERABLE`. Current 14 states do not include these.

Additionally: `guardTransition()` is not enforced at runtime writesites — any status can be written directly via SQL UPDATE.

### F. Presence routing
**NOT IMPLEMENTED**
`hub.isOnline(userId, deviceId)` provides device online/offline status for execution checks. Team presence (`teamcollab/presence`) exists. Device status (`listDeviceStatus`) derives presence from WS + last_seen_at.
MISSING: Presence routing across three surfaces. Presence-based task routing. Presence-based notification routing. Capability advertisement from desktop.

### G. Desktop capabilities
**PARTIAL**
Capability grant system exists (`execution/policy.ts:178–196`, `CapabilityGrant`), gated by DEV preprocessor. Terminal, clipboard, screenshot, drag-drop, URL launcher all functional in Electron IPC.
MISSING: Capability advertisement from desktop to backend (agent never sends; backend hardcodes defaults). Capability-based task routing.

### H. Mobile capabilities
**NOT IMPLEMENTED**
No PWA. No service worker. No push transport. No offline intent queue. No mobile-specific capability surface. ChatPage.tsx has responsive layout only.

### I. Sync architecture
**NOT IMPLEMENTED**
No memory sync. No approval sync. No task state sync across surfaces. No offline queue on desktop. No "Sync Cortex."

### J. Offline behavior
**PARTIAL**
Browser: tiny 2-op queue (approval.decide, notifications.markRead) with idempotency + conflict resolution + auto-flush. Desktop: offline handling exists in Electron but disconnected from backend. No offline intent queue for general user actions. No offline checkpoint sync.

### K. Resume behavior
**IMPLEMENTED**
Multi-layer: task attempt checkpoint (orchestrator), user snapshots (UI), time-travel playbacks, irreversible actions guard, dead letter, autopsy, recovery history. Checkpoint resume works end-to-end for running tasks.

### L. Approval synchronization
**NOT IMPLEMENTED**
Desktop cannot receive approval requests. Approval state not synced across surfaces. No server→desktop push for new approval requests. ApprovalAgent cannot be reached through task state machine.

### M. Local privacy boundaries
**IMPLEMENTED**
Strong layered privacy: deny-by-default policy engine (`execution/policy.ts`), secret path guard (blocks .env, .ssh, .pem, etc.), OS-sensitive path blocklist, dangerous command blocklist, network blocked hosts, RLS policy everywhere, capability grants system, session isolation. Privacy walls between users, workspaces, and teams.

### N. Memory synchronization
**NOT IMPLEMENTED**
Memory exists in backend. Not replicated to desktop. No cross-device memory flow. Memory is workspace-bound but not user-bound across devices.

### O. Policy system
**PARTIAL**
Two policy engines exist and are not unified: `execution/policy.ts` (deterministic typed actions: ALLOW/DENY/REQUIRE_APPROVAL/WAIT_FOR_DEVICE/WAIT_FOR_AUTH) and `control/policies.ts` (user control policies: BLOCK/REQUIRE_APPROVAL/ALLOW). Missing: user-defined trusted-value rules (e.g. "never deploy on Friday"). Policy engine does not route WAIT_FOR_DEVICE into actual device dispatch.

### P. Local Twin
**NOT IMPLEMENTED**
No local agent twin concept. Desktop runs standalone. No capability advertisement, no background heartbeat, no state mirror between backend and desktop.

### Q. Reflex architecture
**NOT IMPLEMENTED**
No reflex concept in codebase. Nearest: `skill_signals` (taxonomy) and `echo_lessons` (pattern extraction). No reflex registry, no offline inference, no on-device model routing.

### R. Agent continuity
**PARTIAL**
Server→web: working (SSE chat, device presence). Desktop: IPC exists but DISCONNECTED from frontend. Local agent: registration exists but disconnected from main orchestration. No agent continuity across surface switches (e.g. starting task on web, continuing on desktop).

### S. 24/7 behavior
**IMPLEMENTED**
Real backend worker + 15s watchdog sweep. DLQ. Retry with exponential backoff. Auto-pause on heartbeat loss. Budget governors. Watchdog auto-resume. Dead letter queue.

### T. Kill switch behavior
**PARTIAL**
Server-side kill switch works: per-user granularity, task-state gate (blocks new work), task creation gated. MISSING: cross-device propagation. Desktop not notified of kill switch activation. Local agent not wired in.

### U. Security test results
**PARTIAL**
Strong security test coverage exists: `policy.test.ts` (11 tests), `approval-security.test.ts`, `integration-hub.security.test.ts`, `local-execution-17.test.ts` (device pairing), MFA TOTP tests. §15 (comprehensive Trinity security tests) not yet run — requires all Trinity surfaces to be built first.

### V. Three-surface acceptance results
**NOT IMPLEMENTED**
§16 acceptance tests not run. Web desktop and mobile are not unified under Trinity. Requires: all three surfaces sharing task state, memory, approval, presence, and policy. Not built.

---

## §78 IMPLEMENTATION PHASES — TRINITY ROADMAP

### Phase 1: Audit current architecture ✅ COMPLETE
This document.

### Phase 2: Unify task identity/state — **HIGHEST PRIORITY**
- Add missing states: `READY`, `EXECUTING`, `WAITING_FOR_DEVICE`, `RECOVERABLE`
- Enforce `guardTransition()` at ALL writesites (tasks.ts, orchestrator.ts, approvals.ts)
- Unify the two device registries (DB + in-memory) into one canonical registry
- Add `agent_id` FK to approval binding

### Phase 3: Unify realtime synchronization
- Build general-purpose event broadcast bus (tasks, approvals, presence, device events)
- Server→browser push for task state changes
- Server→desktop push (extend WS bridge)
- Unify three notification systems into one push service

### Phase 4: Implement Presence Engine
- Device capability advertisement (desktop → backend on connect)
- Presence routing across three surfaces
- Presence-based task routing
- Presence-based notification routing

### Phase 5: Integrate Desktop capability state
- Wire `window.api.*` into web frontend for desktop mode detection
- Fix capability advertisement (agent sends on connect)
- Backend consumes advertised capabilities for task routing

### Phase 6: Fix 24/7 background task state
- Wire `WAITING_FOR_DEVICE` into orchestrator
- Implement background task dispatch to device
- Resume tasks after device reconnects

### Phase 7: Unify Mobile control layer
- PWA manifest + service worker
- Push notification transport (Web Push API)
- Mobile offline intent queue

### Phase 8: Implement approval synchronization
- Server→desktop push for new approval requests
- Approval state synced across all surfaces
- Desktop can act on approvals via WS

### Phase 9: Implement Sync Cortex / memory boundaries
- Memory sync across devices (opt-in)
- Workspace-level memory replication
- Privacy-aware memory access controls

### Phase 10: Implement Local Twin / event heartbeat
- Local agent heartbeat to backend
- Background state mirror
- Capability advertisement on startup

### Phase 11: Implement offline queues / checkpoints
- Offline intent queue (expanded beyond 2 ops)
- Offline checkpoint sync for tasks
- Conflict resolution for concurrent offline actions

### Phase 12: Implement policy / values integration
- Unify `execution/policy.ts` + `control/policies.ts`
- User-defined trusted-value rules
- Policy-based routing decisions

### Phase 13: Implement evidence / confidence states
- Add `VERIFIED | SUPPORTED | INFERRED | UNVERIFIED` taxonomy
- Wire evidence into approval decision flow
- Evidence routing across surfaces

### Phase 14: Add future reflex interfaces
- Reflex registry schema (for future on-device models)
- Placeholder API endpoints
- No live implementation yet

### Phase 15: Security tests (§15)
- Trinity-specific security tests for all new surfaces
- Cross-device authorization tests
- Offline queue integrity tests

### Phase 16: Real three-surface acceptance tests (§16)
- Web + Desktop + Mobile sharing task state
- Task created on web, actioned on desktop, monitored on mobile
- Memory and approval synced across all three

---

## GAPS (Blocking Trinity)

| Gap | Impact | Phase |
|---|---|---|
| guardTransition not enforced at runtime | Any status can be written | 2 |
| Two disconnected device registries | Cannot route tasks to devices | 2 |
| No realtime broadcast bus | Surfaces cannot sync | 3 |
| No device capability advertisement | Desktop invisible to backend | 4/5 |
| No general push transport | No task/approval push | 3 |
| Three notification engines not unified | Duplicated behavior | 3 |
| Mobile has no PWA/push | No mobile surface for Trinity | 7 |
| Two policy engines not unified | Inconsistent decisions | 12 |
| No memory sync | Data loss across devices | 9 |
| No approval sync across surfaces | Desktop cannot act on approvals | 8 |

---

*This audit is read-only. Implementation awaits scope confirmation.*
