# FINAL AI OS — CONTAINER + DISTRIBUTED EXECUTION ROADMAP

**Date:** 2026-09-01 | **Author:** opencode (roadmap/feasibility) | **Secret-free**
**Phase:** TRACK C — Deferred AI OS capabilities. **Investigation only; NOT implemented.**

---

## 1. Intent (from the master directive)

These two capabilities were deliberately deferred from P3. They are **NOT
removed**; they remain strategic roadmap items:
1. **C.1 — Real container / process isolation** (actual OS-level isolation, not
   policy-only).
2. **C.2 — Distributed execution** across multiple machines / execution workers /
   GPU workers where justified.

---

## 2. C.1 — Real container / process isolation

### 2.1 What exists today (facts)
- Execution isolation today = **`PolicySandboxExecutor`** (`backend/src/os/sandbox.ts`),
  explicitly a **policy** sandbox, NOT container/VM.
- It enforces: command allow-list (deny-by-default), no shell, forbidden-token
  filter, wall-clock timeout (SIGTERM→SIGKILL), output caps (512 KB), capability
  gate, and best-effort process-tree kill.
- It does **NOT** enforce: CPU, memory, disk/IO quotas, egress/network
  namespaces, ports, file/chroot/mount boundaries, seccomp, privilege drop, PID
  limits. `resource-governor.ts` explicitly does not fake CPU/mem cgroups.
- There is an additional **unsandboxed arbitrary-exec path** in
  `modules/preview/service.ts` (raw `spawn`, `PREVIEW_BUILD_COMMAND`,
  `PREVIEW_BUILD_ENABLED=false` default) — flagged as a P0 gap in existing audits.

### 2.2 The binding constraint (why it is deferred)
The live host is **Railway managed-PaaS** (Docker images, Postgres on Neon).
From a Railway container the app process **cannot** create nested containers,
cgroups, namespaces, gVisor, firecracker, or a kernel sandbox, **nor** drop
privileges/seccomp at the kernel level, and there is **no GPU**. The codebase's
own audits already state real container/VM isolation is impossible from
userspace on this host.

### 2.3 Options (for the roadmap decision, not implemented)
| Option | Isolation level | Host requirement | Notes |
|--------|-----------------|------------------|-------|
| Stay `policy` subprocess | Software-only | Current (Railway) | Today's default; NOT a real sandbox |
| OS-user + ulimit hardening | Weak OS boundary | Current-ish | Best-effort, not true isolation |
| **Dedicated execution service / microVM (e.g. Fly Machines, Cloudflare Workers, gVisor/firecracker-backed provider)** | Strong VM/kernel | Move the EXECUTION tier off the Railway app container | **Recommended direction** — isolates "arbitrary code" from the API/tenant data |
| Self-hosted VMs/bare metal + container runtime | Full | You control the host | Strongest, highest ops cost |

**Recommended roadmap:** introduce a **separate execution service as the FIRST
justified new isolated production component** (the existing architecture audit
already calls the sandbox executor exactly that) — deployed on infrastructure
you control or a microVM/sandboxing provider, with real per-run filesystem/
network namespaces, resource quotas, process limits, breakout protection
(seccomp/gVisor-style), cleanup, and SIGTERM→SIGKILL escalation. Policy-only
isolation is **never** claimed equivalent to this.

Safety rules for C.1 implementation (future): chaos/breakout testing never
targets production; new executor routes through the SAME
`AUTH → CAPABILITY → STOP RULES → RESOURCE GOVERNOR → SANDBOX → AUDIT` chain;
the preview/refactor unsandboxed paths are not extended and are audited/closed
before any new arbitrary-exec surface ships.

---

## 3. C.2 — Distributed execution

### 3.1 Goal
Distribute work across multiple machines / execution workers / GPU workers where
justified, reusing the **AI OS Scheduler + Process Manager + IPC/Event Bus +
Resource Governor + Supervisor** — explicitly **NO second scheduler and NO second
event bus.**

### 3.2 Current topology (facts)
- Task "queue" = the **Postgres `tasks` table** polled with `SKIP LOCKED`
  (`queue.ts`); a worker polls every 2s, concurrency 2.
- By default the worker + watchdog run **in the same process** as the API
  (`server.ts`); `npm run worker` runs them in a **separate standalone process**.
- Multiple workers could in principle scale against the same Postgres queue, but
  there is **no leader/lease/fan-out layer**, and **multi-host correctness is not
  designed**: IPC ordering, cross-agent accounting, per-workspace isolation, and
  exactly-once semantics across hosts are open problems.

### 3.3 What distribution requires (roadmap)
1. **Shared leader/lease + fan-out** over the existing scheduler → worker pool
   (a coordination primitive, still ON the canonical scheduler — not a second
   one).
2. Keep **IPC ordering and workspace isolation** correct across hosts
   (workspace-affinity so a workspace runs on one worker; event bus remains the
   single canonical bus).
3. **Correct accounting + budgets** under the Resource Governor across hosts
   (aggregate, not per-process).
4. **Exactly-once task effects** across hosts (claim + dedup at the DB/outbox
   level; idempotency already exists per intent/event).
5. **GPU workers** only where justified (e.g. heavy inference); none exist today,
   and GPUs are unavailable on the current host.

### 3.4 Deferral
Distributed execution and GPU are **deferred, dependency-documentation only**, in
line with the P3 gate. They will be enabled only when (a) the isolation/C.1 host
decision is made and (b) the coordination design above lands on the existing
primitives. No production distributed execution now.

---

## 4. Roadmap gate values

```
CONTAINER_ISOLATION  = ROADMAP (NOT_IMPLEMENTED; NEW_ISOLATED_EVENTUAL_COMPONENT)
DISTRIBUTED_EXECUTION= ROADMAP (NOT_IMPLEMENTED)
GPU_WORKERS          = ROADMAP (NOT_IMPLEMENTED; none available on current host)
POLICY_SANDBOX       = NOT_CLAIMED_AS_REAL_ISOLATION (current production)
PRODUCTION           = NO CHANGE
```
