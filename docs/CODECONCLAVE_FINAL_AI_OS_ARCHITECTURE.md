# CODECONCLAVE — FINAL AI OS ARCHITECTURE

**Date:** 2026-09-01 | **Type:** ARCHITECTURE (unified) | **Status:** P0 + P1 + P2 implemented & gated; real-isolation + distributed-exec prep implemented (latent); P3 planned

This document unifies the AI OS + Cowork runtime into ONE architecture, showing
how the OS kernel is the shared foundation that every cowork feature runs on.
It is a consolidation view of the existing implementation under `backend/src/os/`
(P0/P1), `backend/src/os/p2/` (P2), plus `backend/src/os/isolation/`
(fail-closed real-isolation), `backend/src/os/dist-exec/` (latent distributed
coordination), `backend/src/os/devices/` (capability-gated device model), and
the planned P3 surface. No deployment in this pass.

---

## 1. The architectural story

CodeConclave is **not** "100 unrelated features."

CodeConclave =
**AI Operating System**
\+ **Cowork Runtime**
\+ **Agents**
\+ **Persistent Memory**
\+ **Controlled Execution**
\+ **Team Collaboration**
\+ **Developer Intelligence**

The large feature count demonstrates the breadth of the platform built on a
single kernel — it is not the platform itself. Every feature that looks
"separate" is an adapter or user surface on one shared OS foundation.

---

## 2. One unified view

```
                        USER
                          │
                     CODECONCLAVE
                          │
                   COWORK RUNTIME   (breaks, diff, replay, undo, team, summary,
                          │         personality, smart-files, templates,
                          │         command palette, error quick-fix, sidebars)
                          │
                    AI OS KERNEL  (authoritative foundation)
     ┌───────────┬────────────┬────────────┬────────────┬───────────────┐
     │ Process   │ Scheduler  │ Supervisor │ IPC /      │ Memory /      │
     │ Manager   │ / DAG      │ (P0.1,P1.B)│ Event Bus  │ State /       │
     │ (P0.1)    │ (P1.C)     │            │ (P1.A)     │ Checkpoint    │
     ├───────────┼────────────┼────────────┼────────────┼───────────────┤
     │ Filesystem│ Capability │ Stop Rules │ Resource   │ Sandbox       │
     │ diff/COW  │ / Policy   │ (P2.6)     │ Governor   │ (P0.6)        │
     │ (P0.3)    │ (P0.4)     │ SECURITY    │ (P0.5)     │ POLICY        │
     ├───────────┼────────────┼────────────┼────────────┼───────────────┤
     │ Git       │ Observability / Tracing (P1.E)          │
     └───────────┴────────────────────────────────────────┘
                          │
                        AGENTS
                          │
              SKILLS / TASKS / SCHEDULES
                          │
                     USER FEATURES
                          │
          TEAM / IDE / MOBILE / INTEGRATIONS   (P3 surface)
```

---

## 3. The canonical security chain (invariant)

Every action — from any surface (UI, API, WebSocket, scheduled/background task,
skill, voice, replay, IDE, Slack/Jira/GitHub, mobile/device) — must transit the
same chain. It is enforced **below the prompt layer**; no prompt, sub-agent,
tool argument, or imported state can bypass it.

```
REQUEST
   │
   ▼
AUTHENTICATION
   │
   ▼
CAPABILITY            (P0.4 capabilities, git.read/git.write/terminal.exec/...)
   │
   ▼
STOP-RULE POLICY      (P2.6 — protected files/dirs, no-delete, max-files,
   │                   max-runtime, approvals, precedence; child history)
   │
   ▼
RESOURCE GOVERNOR     (P0.5 — concurrency, runtime, cost, egress allow-list,
   │                   priority; fail-closed)
   │
   ▼
REAL ISOLATION        (isolation/ — fail-closed real runtime, minMode gate,
   │                   void when ISOLATION_MODE = POLICY_ONLY; refuses real
   │                   runs without a verified runtime)
   │
   ▼
SANDBOX               (P0.6 — deny-by-default, allow-listed commands,
   |                   forbidden tokens, time-boxed)
   ▼
ACTION
```

Precedence (deterministic, never overridden by a lower rule or any personality):
`HARD DENY → PROTECTED RESOURCE → CAPABILITY DENY → APPROVAL REQUIRED → RESOURCE LIMIT → ALLOW`.
Real-isolation refusal (`aios_isolation_unavailable` / `aios_isolation_min_mode_unmet`)
is above ALLOW; a policy sandbox is never reported as container/process isolation.

---

## 4. Kernel primitives (P0/P1) — the shared foundation

Each primitive is a dedicated module under `backend/src/os/`. Cowork features
reuse these; they are never re-implemented.

| Kernel component | Module | What it provides |
|---|---|---|
| Process Manager / Supervisor | `types.ts`, `supervisor.ts` | canonical 9-state lifecycle, restart policy, cooperative cancel/pause, crash detection, checkpoint resume |
| Scheduler / DAG | `dag.ts` + existing `modules/scheduling/recurrence` | general DAG (serial/fan-in/parallel/conditional), reuse of the existing recurrence engine |
| IPC / Event Bus | `ipc.ts`, `event-bus.ts` | workspace-scoped events, monotonic seq, durable store, consumer offsets, idempotency, retry, DLQ |
| Memory / State / Checkpoint | `state.ts` | versioned, checksummed serializable state blocks |
| Filesystem | `fs-layer.ts`, `diff.ts` | Myers diff / COW / watch |
| Capability / Policy | `capabilities.ts`, `types.ts` | risk vocabulary + capability grants |
| **Stop Rules** | `p2/stop-rules.ts` | policy/capability enforcement below prompt (P2.6) |
| Resource Governor | `resource-governor.ts` | real enforceable budgets, fail-closed concurrency |
| Sandbox | `sandbox.ts` | policy sandbox executor (deny-by-default, capability-gated) |
| **Real Isolation** | `isolation/{modes,detect,process-controls,container-executor,process-executor,real-executor,flags}.ts` | fail-closed real runtime facade; `docker run` hardening (`--cap-drop=ALL --no-new-privileges --user 65534:65534 --network none --read-only`) and Linux `unshare`; refuses without verified runtime (`ISOLATION_MODE = POLICY_ONLY` here) |
| **Distributed Prep** | `dist-exec/coordinator.ts` | latent worker leases/heartbeats/dedupe on the existing IPC bus; no second queue/scheduler; hand-off targets the Supervisor |
| **Device Model** | `devices/registry.ts` | capability-gated `DeviceKind` registry, deny-by-default |
| Git | `git.ts` | real, sandbox-gated git engine (no push/auto-merge) |
| Observability | `observability.ts` | tracing, `sanitizeFields` redaction, never logs secrets |
| Lifecycle | `lifecycle.ts` | child-process tree tracking + cleanup (zombie prevention) |

---

## 5. Cowork Runtime — P2 features on the kernel

Every P2 feature is a thin, flag-gated surface **on** the kernel primitives
(all 17 `AIOS_P2_*` flags default OFF):

| P2 feature | Reuses kernel |
|---|---|
| Breakpoint | State/checkpoint + Supervisor + Scheduler |
| Real-Time Diff | Filesystem diff (`diffLines`) |
| Session Replay | IPC events + Observability redaction |
| Undo Last N | snapshot/diff (`diffLines`) |
| Team Cowork | IPC (session-scoped) + Capability |
| Custom Stop Rules | Capability/Policy (enforced below prompt) |
| AI Personality | behavior-only; never overrides rules |
| Session Summary | Replay timeline |
| Smart Files | Filesystem/context awareness |
| Error Quick-Fix | execution + Observability |
| Context Sidebar | read-model of Filesystem/Stop-Rules |
| Cowork Templates | versioned steps, secret-stripped |
| Command Palette | capability + stop-rule dispatch (canonical command model) |
| Skills | process/state/DAG; replay under current policy |
| Scheduling | **reuses** existing recurrence engine + DAG + Supervisor |
| Voice | same command model — no bypass |
| Notifications | IPC event bus, redacted, durable |

---

## 6. Agents → Skills/Tasks/Schedules → User Features → Ecosystem

- **Agents** execute through the Supervisor, each holding only explicitly granted
  capabilities (child processes inherit — and never exceed — the parent's rights).
- **Skills / Tasks / Schedules** run through the kernel; scheduled/skilled work
  re-applies the **current** stop rules at execution time (no stale broader policy).
- **User Features** (IDE/mobile/integrations, P3) are authenticated surfaces on
  the same chain — never an execution back-door.

---

## 7. Lifecycle states (canonical)

`QUEUED → STARTING → RUNNING → PAUSED/CANCELLING → COMPLETED/FAILED/KILLED → RECOVERING`

Illegal transitions are rejected (e.g. pause from non-running, resume from
non-paused). Robustness: restart policy caps, checkpoint resumption, DLQ,
exponential backoff, child-tree cleanup.

---

## 8. Provenance & consolidation

- **CANONICAL:** the OS kernel modules above (`backend/src/os/*`).
- **ADAPTER:** the P2 cowork surfaces and `adapters/p1.ts` — always flag-gated,
  fall back to existing behavior when off.
- **LEGACY:** the pre-AI-OS production task/agent/scheduler/etc. paths — left
  intact and fully available (no regression; `FEATURES_REMOVED = 0`).
- **DUPLICATE_TO_CONSOLIDATE_LATER:** none introduced by P2/P3 planning; P3
  reuses the existing recurrence engine and no second bus/scheduler/diff.

---

**This is the shared foundation. P0 + P1 + P2 implemented & gated (92/92 OS
tests); real-isolation (32), distributed-exec prep (13) and device-model (7)
tests green; typecheck/build clean, npm audit 0 vulns,
`FEATURES_REMOVED = 0`.**
**Real isolation on this host = POLICY_ONLY (no container runtime); brand
integrated (authoritative assets on disk — PASS); cowork UX polish delivered
(17/18 items, quick-action bar = honest subset); desktop UX polished
(brand-black launch + canonical icon). Frontend 299 tests PASS. No deployment.
`PRODUCTION_DEPLOYMENT = NOT_EXECUTED`.**

---

## 9. Final AI OS Runtime Phase (2026-09-02) — real isolation + distributed execution

The FINAL AI OS RUNTIME directive re-verified the host and closed the one
deliberate PREP gap: the worker→Supervisor binding.

### 9.1 Host capability (re-verified, not assumed)
- `docker`/`podman`/`nerdctl` = **UNAVAILABLE** (not installed; no daemon).
- WSL = **UNAVAILABLE** (`wsl.exe` reports "WSL is not installed"; no distro).
- Linux namespaces = **UNAVAILABLE** (Windows host; no unshare).
- Windows containers / Hyper-V = **UNAVAILABLE** (Home SKU; not enabled).
- cgroups = **UNAVAILABLE** (Windows).
- → `ISOLATION_MODE = POLICY_ONLY`, `REAL_ISOLATION = DEFERRED` on-host,
  fail-closed (`aios_isolation_min_mode_unmet`). Policy is NEVER upgraded.

### 9.2 Distributed execution — runtime binding added (still opt-in, not live)
The coordinator PREP is unchanged (PREPARED-NOT-ACTIVE). Added:

- **`SupervisedWorkerExecutor`** (`backend/src/os/dist-exec/worker-executor.ts`):
  the missing `LEASE → WORKER → SUPERVISOR → RESULT` link. A task assignment
  runs through the **existing** `Supervisor` (queued→starting→running→
  completed/failed/killed), resource governor slots, durable state checkpoints,
  and produces a RESULT. No second scheduler/queue/state/event bus.
- **Phase F worker profile routing**: `WorkerResource` now carries
  `os/architecture/gpu/networkPolicy/localTools/executionClass` and tasks can
  constrain them (`requireOs/requireArchitecture/requireGpu/
  requireNetworkPolicy/requireExecutionClass`) — capability-based, workers only
  receive tasks whose advertised profile they hold.
- **Tests**: dist-exec suites grew from 13 → **42 tests** (worker executor,
  security/hostile-completion, Phase F routing, crash → requeue → reassign,
  worker-disappear requeue, cross-workspace isolation, durable checkpoint).
- **Phase K performance**: measured in-memory coordination (µs scheduling/lease,
  ms supervised runs, ms IPC) — honest TARGET/MEASURED, generous bounds.
- Everything remains architecture/opt-in; production execution is NOT wired,
  and the coordinator still hands work to no live worker pool.

### 9.3 Device model (Phase I)
`LOCAL_TERMINAL`, `LOCAL_FILESYSTEM`, `LOCAL_GIT`, `DOCKER_EXECUTOR`
(= ISOLATED_EXECUTOR), `CLOUD_EXECUTOR`, `FUTURE_REMOTE_WORKER`
(= REMOTE_WORKER) — all capability-gated by `DeviceRegistry` (7 tests green).

### 9.4 Gates
`REAL_ISOLATION_RUNTIME = DEFERRED` (honest), `DISTRIBUTED_EXECUTION =
PREPARED-NOT-ACTIVE` (runtime binding implemented + tested, opt-in), device
model PASS, `FEATURES_REMOVED = 0`, payment untouched (read-only control
center, sole activation authority), `PRODUCTION_DEPLOYMENT = NOT_EXECUTED`,
`REAL_PAYMENT = NOT_PERFORMED`. See
`FINAL_CODECONCLAVE_REAL_ISOLATION_RUNTIME_GATE.md` and
`FINAL_CODECONCLAVE_DISTRIBUTED_EXECUTION_GATE.md`.
