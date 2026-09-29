# FINAL CODECONCLAVE DISTRIBUTED EXECUTION GATE

**Date:** 2026-09-02
**Directive:** CODECONCLAVE PRO — FINAL AI OS RUNTIME PHASE
**Additive only; reuses the EXISTING Scheduler/Supervisor/EventBus/State;
no second scheduler, queue, state engine, or event bus.**

---

## 1. Chain (Phase E)

```
EXECUTION COORDINATOR → WORKER REGISTRY → LEASE → WORKER → SUPERVISOR → RESULT
```

The coordinator is the EXISTING `ExecutionCoordinator`
(`backend/src/os/dist-exec/coordinator.ts`, unchanged). What was previously a
documented PREP gap — "this file does not implement that binding yet" — is now
closed **additively and opt-in** by the NEW `SupervisedWorkerExecutor`
(`backend/src/os/dist-exec/worker-executor.ts`): a lease is executed through the
EXISTING `Supervisor` (canonical lifecycle, restart policy, resource governor
slot, durable checkpoint) and produces a RESULT.

Nothing is wired to production HTTP or a live worker pool:
`DISTRIBUTED_EXECUTION = PREPARED-NOT-ACTIVE`.

---

## 2. Worker support matrix

| Requirement | Where | Verification |
|-------------|-------|--------------|
| Registration | `coordinator.register` (duplicate ids rejected) | tests |
| Heartbeat | `coordinator.heartbeat` + `tick` stale-watchdog | tests |
| Capability labels | `labels` + `capabilities` (task caps must be a subset) | tests |
| Resource reporting | `resource.cpu/memoryBytes/concurrency` | tests |
| Lease acquisition | `assign` → LEASE_GRANTED, single ownership | tests |
| Lease expiration | `tick` → failSync → requeue | tests |
| Ownership | `renewLease` only for owning worker; hostile complete refused | tests |
| Task reassignment | requeue → next worker, attempt increments | tests + integration |
| Retry | coordinator `maxAttempts`; executor does NOT retry (single responsibility) | tests |
| Idempotency | `enqueue`/`complete` dedupe by taskId + result key | tests |
| Workspace isolation | `workspaceId` binding (strict mode); cross-workspace refusal | tests + integration |
| Graceful shutdown | `deregister` requeues borrowed tasks (nothing lost) | integration |
| Crash recovery | runnable throw → lease failure → requeue; duplicate completion deduped | integration |

---

## 3. Worker capabilities (Phase F)

`WorkerResource` now exposes the Phase F dimensions (additive):

- `os` · `architecture` · `gpu` · `networkPolicy` (none/isolated/allowlist/
  unrestricted) · `localTools[]` · `executionClass`
  (policy/process/container/microvm/remote)

Tasks may constrain them via `requireOs`, `requireArchitecture`, `requireGpu`,
`requireNetworkPolicy`, `requireExecutionClass`. Routing is strictly
capability-based: a worker only ever receives a task whose advertised profile it
holds (a GPU task never lands on a non-GPU worker; `networkPolicy` mismatch
excludes the worker, etc.). Selection stays deterministic (least-loaded +
registration order — no second scheduler).

---

## 4. Worker security (Phase G)

A worker never receives more authority than the task requires:

- **Secret isolation** — executor runnables see no host secrets forwarded.
- **Capability isolation** — task caps must be a strict subset of worker caps.
- **Workspace isolation** — a workspace-bound worker serves only its workspace.
- **Network isolation** — `networkPolicy` matching at scheduling.
- **Hostile completion refusal** — a non-owner worker's `complete()` is
  deduped/rejected; the owning lease is untouched.

---

## 5. Failure recovery (Phase H)

| Scenario | Outcome |
|----------|---------|
| Worker disappears mid-task | `deregister` requeues all borrowed tasks; nothing lost |
| Worker heartbeat stops | `tick` → HEARTBEAT_LOST → requeue → worker removed |
| Lease expires | `tick` → LEASE_EXPIRED/REASSIGNED → requeue (bounded attempts) |
| Task requeued | fresh lease, attempt+1, idempotent enqueue |
| Duplicate completion arrives | deduped by taskId + key; conflicting key refused |
| Worker crashes mid-task | lease failure → no duplicate destructive execution → requeue |
| Parent (supervisor) restart | durable `StateStore` checkpoints keep lifecycle + result |
| Child crashes | supervisor crash detection + bounded restart policy |
| Scheduler/coordinator restarts | coordinator is in-memory today (PREP); state durability lives in existing StateStore — documented, not faked |

---

## 6. Device model (Phase I)

Existing capability-gated kinds cover the required surface (`DeviceRegistry`,
`backend/src/os/devices/`, 7 tests):

- `LOCAL_TERMINAL`, `LOCAL_FILESYSTEM`, `LOCAL_GIT`
- `DOCKER_EXECUTOR` (= ISOLATED_EXECUTOR — real only when a runtime exists)
- `CLOUD_EXECUTOR`
- `FUTURE_REMOTE_WORKER` (= REMOTE_WORKER)

---

## 7. Performance (Phase K) — honest TARGET/MEASURED (in-memory, local)

Enabled with default vitest env; measured on this host:

| Metric | TARGET | MEASURED |
|--------|--------|----------|
| Worker schedule + lease (single assign) | ≤ 5000 µs | < 5000 µs (µs-scale) |
| Lease expiry → requeue → reacquire | ≤ 5000 µs | **451 µs** |
| 1000 × event-bus publishes | ≤ 50 ms | **8.75 ms** |
| 20 × supervised in-memory worker runs | ≤ 2000 ms | **13 ms** |
| 5000 × governor acquire/release | ≤ 50 ms | **3.31 ms** |
| 10 heartbeats (1 s cadence) | ≤ 5000 µs | **624 µs** |

No premature optimization; bounds are generous to avoid flakes; numbers are
reported, never claimed as production performance.

---

## FINAL GATE (distributed rows)

```
DISTRIBUTED_EXECUTION     = PREPARED-NOT-ACTIVE (runtime binding implemented + tested; not wired to production/live pool)
WORKER_REGISTRY           = PASS (register/heartbeat/capabilities/resources/concurrency)
LEASES                    = PASS (grant/renew/expire; single ownership; lease-race safe)
HEARTBEAT                 = PASS (OK tracking + stale watchdog)
REASSIGNMENT              = PASS (expiry/worker-loss requeue → next eligible worker)
FAILURE_RECOVERY          = PASS (crash→requeue; disappear→requeue; duplicate completion deduped; no lost state)
WORKSPACE_ISOLATION       = PASS (workspace-bound workers; cross-workspace refused; strict mode)
WORKER_SECURITY           = PASS (hostile completion refused; capability/profile subset; secret isolation)
DEVICE_MODEL              = PASS (LOCAL_TERMINAL/FS/GIT, ISOLATED_EXECUTOR, CLOUD_EXECUTOR, REMOTE_WORKER — capability-gated)
SUPERVISOR_BINDING        = PASS (lease → EXISTING Supervisor → durable RESULT; new, opt-in)
No second scheduler/queue/state/bus = PASS (reuses canonical Supervisor/Governor/State/EventBus)
```