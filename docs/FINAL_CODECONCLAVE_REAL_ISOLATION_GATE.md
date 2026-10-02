# FINAL CODECONCLAVE REAL ISOLATION GATE

**Date:** 2026-09-01
**Gate:** CODECONCLAVE PRO — REAL PROCESS/CONTAINER ISOLATION ARCHITECTURE.
**Authority:** Next AI OS security phase directive (Part B / Part E). Fail-closed,
honest reporting — policy sandbox is never presented as container/process isolation.
**Predecessor:** `docs/FINAL_AI_OS_CONTAINER_DISTRIBUTED_ROADMAP.md` (isolation held
as ROADMAP; this gate implements the fail-closed real-isolation layer).

---

## Result (honest)

```
ISOLATION_ARCHITECTURE = IMPLEMENTED (fail-closed, tested)
ISOLATION_MODE        = POLICY_ONLY        (this host: no container runtime installed)
REAL_ISOLATION        = DEFERRED           (implementation ready; runtime absent here)
AVAILABLE_RUNTIMES    = { policy }         (no docker/podman/nerdctl/wsl; no namespaces)
```

The real-isolation **architecture is complete and tested** (32 tests). On hosts
WITH a verified container runtime (`ISOLATION_MODE = CONTAINER`) or Linux
(namespace/PID) facilities (`ISOLATION_MODE = PROCESS`), real runs are permitted
with the hardening documented below. On THIS host — and anywhere a real runtime
is missing or below the required minimum mode — real runs are **refused**
(`aios_isolation_unavailable` / `aios_isolation_min_mode_unmet`). This is by
design: **never upgrade a policy sandbox to container/process in the report.**

---

## Security chain (unchanged, real-isolation inserted)

```
AUTH → CAPABILITY → STOP RULES → RESOURCE GOVERNOR → REAL ISOLATION → AUDIT
```

All previous rails (P0.4 capability, P2.6 stop rules, P0.5 resource governor,
P0.6 policy sandbox) remain authoritative and are never bypassed by a real-mode
run. `REAL ISOLATION` is an additional enforcement layer **below** the governor
and **above** the legacy policy sandbox; the policy sandbox stays the default
path when `AIOS_ISOLATION_ENABLED=false`.

---

## What was built (additive, flag-gated, `backend/src/os/isolation/`)

| Module | Role |
|---|---|
| `modes.ts` | `IsolationMode = none / policy_only / process / container / microvm`; rank + `satisfies(minMode)` + `isRealIsolation()` |
| `detect.ts` | injectable capabilities probe (docker CLI + socket, podman, nerdctl, `unshare` namespaces, microvm); returns an honest snapshot |
| `process-controls.ts` | shared spawn primitive: `execFile` allow-lists, cwd scoping, env sanitization (host secrets never forwarded), timeout→SIGTERM→SIGKILL+group-kill, output cap (512 KB default), metacharacter/theoretical-option escaping rejected |
| `container-executor.ts` | `docker run` argv builder: `--rm --init --cap-drop=ALL --security-opt no-new-privileges --user 65534:65534 --network none\|bridge --read-only --workdir /workspace --volume <ws>:/workspace[:ro] --cpus/--memory/--pids-limit`; refuses to run unless the runtime is positively verified |
| `process-executor.ts` | Linux-only `unshare --user --map-root-user --pid --fork --net --mount --` wrapper; refuse on non-Linux / absent namespaces |
| `real-executor.ts` | fail-closed facade: `minMode` enforcement, refuse-with-reason when runtime missing, audit (logger + `EventBus` topic `aios.isolation`), `report()` = ISOLATION_MODE |
| `flags.ts` | `AIOS_ISOLATION_ENABLED` (default false), `AIOS_ISOLATION_MIN_MODE` (default `policy_only`), `AIOS_CONTAINER_*` (image/network/memory/cpus/pids — defaults safe) |
| `index.ts` | barrel; re-exported through `backend/src/os/index.ts` |

Environment flags added in `backend/src/config/env.ts` (additive, all default
OFF, live system unchanged): `AIOS_ISOLATION_ENABLED=false`,
`AIOS_ISOLATION_MIN_MODE=policy_only`, `AIOS_CONTAINER_IMAGE=busybox`,
`AIOS_CONTAINER_NETWORK=none`, `AIOS_CONTAINER_MEMORY_BYTES=0`,
`AIOS_CONTAINER_CPUS=0`, `AIOS_CONTAINER_PIDS_LIMIT=0`.

Two gates must be true before a real run is attempted: OS on
(`AIOS_ENABLED=true`) **and** `AIOS_ISOLATION_ENABLED=true`. Real-mode runs
additionally require the detected runtime to satisfy `AIOS_ISOLATION_MIN_MODE`.
Container argv is built with `buildContainerArgs` (pure, unit-tested); execution
only occurs through `detect()`-verified runtimes.

---

## Verification (executed this gate)

| Check | Result |
|---|---|
| `isolation.test.ts` (backend) | **32 passed** |
| Host capability audit (this machine) | Windows 10.0.26200, Node v26.5.0; **no docker/podman/nerdctl/wsl** → `POLICY_ONLY` |
| Backend full regression (111 files) | **2039 passed / 3 skipped** |
| Backend typecheck / build | PASS |
| Root typecheck (all 5 workspaces) | PASS |
| Root build (shared → backend → local-agent → desktop) | PASS |
| Frontend build (vite) | PASS |

Fail-closed behavior asserted in tests: missing runtime → `aios_isolation_unavailable`;
below-min-mode → `aios_isolation_min_mode_unmet`; container args include
`--cap-drop=ALL --no-new-privileges --user 65534:65534 --read-only` and default
`--network none`; process mode refuses on non-Linux hosts; secrets/`||`/`>`/`&&`
style injection vectors rejected; output caps enforced.

---

## What was NOT done (honest, by design)

- **REAL_ISOLATION = DEFERRED on this host** — no container/namespace runtime is
  installed here and the directive forbids installing/infra/deploy changes, so no
  real container or namespace process run was performed. The executor is
  implemented and unit-tested; the first real run happens on a host with Docker
  or Linux namespaces when the operator enables the flags. Nothing in this
  repository claims otherwise.
- **`PRODUCTION_DEPLOYMENT = NOT_EXECUTED`** — nothing deployed; no Railway/Neon
  change; no DIND provisioning.
- **`REAL_PAYMENT = NOT_PERFORMED`** — unchanged.
- No production executor swap: production still uses the existing policy sandbox
  path (flags default OFF). Existing modules untouched; only `os/` (new) and
  `config/env.ts` (additive flags) were edited.
- `FEATURES_REMOVED = 0` (see preservation matrix, new section).

---

STOP