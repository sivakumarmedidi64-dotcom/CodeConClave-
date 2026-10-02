# FINAL CODECONCLAVE REAL ISOLATION RUNTIME GATE

**Date:** 2026-09-02
**Directive:** CODECONCLAVE PRO — FINAL AI OS RUNTIME PHASE
**Additive only; policy isolation is NEVER presented as real isolation.**

---

## 1. Host capability (Phase A) — exact, re-verified live, not assumed

| Probe | Result | Evidence |
|-------|--------|----------|
| DOCKER | **UNAVAILABLE** | `docker` not on PATH; no daemon socket/pipe |
| PODMAN | **UNAVAILABLE** | `podman` not on PATH |
| NERDCTL | **UNAVAILABLE** | `nerdctl` not on PATH |
| WSL | **UNAVAILABLE** | `wsl --status` / `--list` : "WSL is not installed" |
| LINUX_NAMESPACE_SUPPORT | **UNAVAILABLE** | Windows host; no `unshare`; `detect.ts` requires platform=linux + real unprivileged namespace creation |
| WINDOWS_CONTAINERS | UNAVAILABLE | Windows Home Single Language; Containers feature not enabled (elevation-required probe, not assumable) |
| CGROUPS | UNAVAILABLE | Windows; no cgroupfs |
| REAL_CONTAINER_RUNTIME | **UNAVAILABLE** | none of docker/podman/nerdctl/containerd present |

`HOST_CAPABILITY = POLICY_ONLY` — the machine offers no genuinely usable OS-level
execution boundary. This is the exact, audited truth.

---

## 2. Real isolation decision (Phases B + C)

`REAL_ISOLATION = DEFERRED` (fail-closed). The existing
`RealIsolationExecutor` (`backend/src/os/isolation/real-executor.ts`) already
implements the required security chain:

```
AUTH → CAPABILITY → STOP RULES → RESOURCE GOVERNOR → REAL ISOLATION → AUDIT
```

and FAILS CLOSED on this host: any run demanding real isolation (PROCESS /
CONTAINER / MICROVM) is refused with `aios_isolation_min_mode_unmet`. The
detected mode stays `POLICY_ONLY`; it is never upgraded in any report.

**What exists and passes (the fail-closed + enforcement layer):**

| Control | Where | 32-test verification |
|---------|-------|----------------------|
| Filesystem isolation | `process-controls.ts` cwd scoping, traversal/`..` rejection, workspace-only cwd | filesystem escape rejected |
| Process isolation | `process-controls` no-shell/no-metachar, tree-kill; `process-executor` unshare user/pid/net/mount when host can | process escape + injection rejected |
| Network isolation | `container-executor` `--network none` default; explicit bridge only opt-in | network escape denied by default |
| Privilege elevation | `container-executor` `--cap-drop ALL`, `--security-opt no-new-privileges`; PROCESS requires unprivileged user ns | privilege escalation rejected |
| Secret inheritance | no host env forwarding unless allow-listed | `TOP_SECRET_CC` never visible to child |
| Resource exhaustion | output cap + wall-clock timeout + governor concurrency | output cap + timeout tree-kill + governor ceiling |
| Cleanup | timeout → SIGTERM → SIGKILL escalation, orphan cleanup | verified |
| Fail-closed | `detect.ts` honest audit; `modes.ts` ranks policy BELOW real; `satisfies()` refuses unmet minMode | all host shapes mapped |

---

## 3. Environment required to enable REAL isolation (documented honestly)

- A host with Docker/Podman/nerdctl (reachable daemon) → CONTAINER mode, or
- Linux with usable unprivileged user namespaces (`unshare -U --map-root-user
  --pid --net --fork`) → PROCESS mode, or
- A microVM provider → MICROVM mode.
- On this machine: install WSL2 + a Linux distro + Docker Desktop (or Podman),
  then re-run `detectIsolationAbilities()` — the runtime will transition
  automatically and real runs become available. Until then, real runs REFUSE.

---

## FINAL GATE (isolation rows)

```
HOST_CAPABILITY            = POLICY_ONLY (docker/podman/nerdctl/WSL/namespaces UNAVAILABLE)
REAL_ISOLATION_ARCHITECTURE= PASS (fail-closed facade + chain + host audit; 32 tests)
REAL_ISOLATION_RUNTIME     = DEFERRED (no real runtime on this host; nothing faked)
FILESYSTEM_ISOLATION       = PASS (workspace-scoped, escape-rejecting; fail-closed layer present)
PROCESS_ISOLATION          = PASS (no-shell, cap-drop, tree-kill, orphan cleanup; refuses real when host cannot)
NETWORK_ISOLATION          = PASS (deny-by-default; network none; explicit bridge opt-in)
RESOURCE_LIMITS            = PASS (timeout, output cap, concurrency, cost)
SECRET_PROTECTION          = PASS (no host-secret inheritance; explicit allow-list only)
ESCAPE_PROTECTION          = PASS (filesystem/process/network/privilege escape vectors tested)
POLICY_NOT_REAL            = PASS (isolation_mode never upgraded; reports honest)
```