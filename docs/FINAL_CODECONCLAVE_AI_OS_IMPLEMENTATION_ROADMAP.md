# FINAL CODECONCLAVE AI OS IMPLEMENTATION ROADMAP

**Date:** 2026-09-01 | **Type:** ROADMAP ONLY — sequenced plan, no implementation | **Auditor:** opencode (read-only)

This roadmap is derived from `FINAL_CODECONCLAVE_AI_OS_ARCHITECTURE_AUDIT.md`.
It sequences how to add an **AI Operating System for Cowork** to the existing
LIVE product **additively, behind feature flags, without breaking production**.

**SOURCE_CHANGES (original): NONE | DATABASE_CHANGES: NONE | DEPLOYMENT: NONE**

> **Status update (2026-09-01):** Phase 1 (P0), the P1 first-half of Phase 2, and the **P2 second-half
> of Phase 3** are now **implemented and gated** behind additive, default-OFF `AIOS_*` flags in
> `backend/src/os/` (+ `backend/src/os/p2/`). No DB migration and no deployment were performed. See:
> `FINAL_CODECONCLAVE_AI_OS_P0_GATE.md` (P0, PASS), `FINAL_CODECONCLAVE_AI_OS_P1_GATE.md` (P1, PASS),
> `FINAL_CODECONCLAVE_P2_STOP_RULES_GATE.md` (P2.6, PASS), and
> `FINAL_CODECONCLAVE_AI_OS_P2_GATE.md` (P2, PASS).

---

## Guiding Principles

1. **Additive & reversible** — every phase is flag-gated; existing task/worker/memory path stays the fallback until the OS layer is proven.
2. **Reuse, don't rebuild** — the Postgres-backed task/process/scheduler/state/memory substrate is already an embryonic kernel. The AI OS is a **consolidation + 3 missing primitives** (Supervisor semantics, IPC/event bus, Sandbox).
3. **Fix duplication via one authority** — consolidate fragmented agent lifecycle and policy engines rather than adding a 5th.
4. **Security first** — the sandbox/process-isolation gap gates all autonomous-execution claims.

---

## Phase 0 — Audit (DONE)

- Current state documented in `FINAL_CODECONCLAVE_AI_OS_ARCHITECTURE_AUDIT.md`.
- No source/DB/deploy change. `CURRENT LIVE SYSTEM: SAFE`.

---

## Phase 1 — OS Core behind feature flags (P0) — ✅ DONE (GATE PASS)

All new primitives are **new modules invoked only when an OS feature flag is on**; the legacy path is untouched.

Handled in `FINAL_CODECONCLAVE_AI_OS_P0_GATE.md` (33/33 tests, no regression, `FEATURES_REMOVED = 0`).

| # | Primitive | Provenance | Legacy path untouched? | New DB? |
|---|---|---|---|---|
| P0-1 | **Process lifecycle consolidation (Supervisor)** | unify `agents/` + `agent/` + `execution/` lifecycle into one supervisor; add cooperative in-flight cancellation + suspend/resume | yes (old handlers retained) | gated (pause state) |
| P0-2 | **State persistence as OS primitive** | formalize attempt/checkpoint/event serialization on Postgres | yes | gated (checkpoint events) |
| P0-3 | **Filesystem diff/COW/watch layer** | extend `files/service.ts` whole-blob versioning → Myers diff + COW + watch | yes (versioning path kept) | gated |
| P0-4 | **Capability/policy consolidation** | one shared risk vocabulary + capability primitive for `control` + `execution` + `local-agent` | yes | no |
| P0-5 | **Resource Governor** | extend run budgets (time/token/rate) → general quotas | yes | gated (quota ledger) |
| P0-6 | **Sandbox executor** | NEW isolated process/container that runs cloud code currently unsandboxed (`preview` spawn, `refactoringWizard` execSync) | yes (old exec retained until proven) | no |

**Entry criteria:** all P0 behind flag; `npm run typecheck` + full regression green; existing 122-feature suite unaffected.

---

## Phase 2 — Internal / Test Users (P1, first half) — ✅ P1 DONE (GATE PASS)

- **P1-A: Durable IPC / Event Bus** — outbox-backed publish/subscribe so processes/agents/WS broadcast state.
- **P1-B: Supervisor respawn/panic/resume** — OS-level watchdog consolidation; process respawn semantics.
- **P1-C: General intra-task DAG** — scheduler executes a general DAG (currently linear/parallel-group only).
- **P1-D: Real Git/VCS engine** — un-stub `gitNinja.ts`; drive real git via local-agent + cloud broker.
- **P1-E: Observability/tracing** — unify audit + metrics + tracing for process-level traces.

P1-A → P1-E implemented additively in `backend/src/os/` (`ipc.ts`, `supervisor.ts`+`lifecycle.ts`,
`dag.ts`, `git.ts`, `observability.ts`) and **gated PASS** — see `FINAL_CODECONCLAVE_AI_OS_P1_GATE.md`
(24/24 P1 tests; OS suite 57/57; no regression; `FEATURES_REMOVED = 0`). No deployment.

**Remaining entry criteria:** OS path live only for **staging/internal accounts**; production data
read-only or shadow-mode; parity vs legacy — all **deferred to an explicit deployment request**.

---

## Phase 3 — Production Beta (P1 second half + P2) — ✅ P2 DONE (GATE PASS)

All 17 P2 features implemented additively, flag-gated (default OFF) under
`backend/src/os/p2/`, consolidating onto the P0/P1 primitives (no independent
infrastructure): Breakpoint, Real-Time Diff, Session Replay, Undo Last N, Team
Cowork, **Custom Stop Rules** (policy/capability-enforced, below the prompt
layer), AI Personality, Session Summary, Smart File Picker, Error Quick-Fix,
Workspace Context Sidebar, Cowork Templates, Command Palette, Skills, Scheduling
(reuses the existing recurrence engine), Voice, and Notifications.

**P2 gate PASS** — see `FINAL_CODECONCLAVE_AI_OS_P2_GATE.md` (35/35 P2 tests; OS
suite 92/92; typecheck/build clean; `FEATURES_REMOVED = 0`) and
`FINAL_CODECONCLAVE_P2_STOP_RULES_GATE.md` (P2.6 security gate PASS). No deployment.

- **P2-A: Breakpoint System** (on P0 state) — pause/resume at checkpoints. ✅
- **P2-B: Session Replay** (on P0 state + event log). ✅
- **P2-C: Undo Last N** (on P0 state + event log/undo journal). ✅
- **P2-D: Team Cowork** (on IPC + scheduler) — multi-user, agent-to-agent. ✅
- **P2-E: Custom Stop Rules** (on Supervisor/Scheduler) — enforced below prompt. ✅
- **P2-F: AI Personality Modes** (model gateway + memory style prefs) — behavior-only. ✅
- **P2-G: Session Summary** upgrade (memory + return-to-work). ✅
- **P2-H+: Smart File Picker, Error Quick-Fix, Context Sidebar, Templates,
  Command Palette, Skills, Scheduling, Voice, Notifications.** ✅

**Entry criteria:** sandbox + resource governor confirmed live; opt-in **beta cohort**; rollback flag = kill-switch fallback; no production regression.

---

## Phase 4 — General Availability

- Migrate cowork fully onto the OS layer.
- **Deprecate, don't delete**, the legacy independent infra during transition (kept as documented fallback), then remove after soak.
- Introduce gated **Error Quick-Fix** (needs sandbox + review gate first — high risk).

---

## Future / Experimental (P3) — ✅ P3 DONE (GATE PASS)

P3 (final integration + P3 prep) is implemented additively, feature-flag-gated
(`AIOS_P3_*`, all default OFF), and consolidated onto the canonical P0/P1/P2
primitives. Full gate: `docs/FINAL_CODECONCLAVE_AI_OS_P3_GATE.md`.

Implemented P3 tracks (each behind its own flag, default OFF):
- **P3.1 GitHub** — remote connector (approval-gated writes, workspace-scoped
  credentials, approved egress, no auto-push/auto-merge).
- **P3.2 Jira + Slack** — connectors + slash-command foundation via the same
  authenticated command model / IPC bus.
- **P3.3 Device Notifications** — mobile/device delivery composing the P2
  Notifications module (redacted, workspace-scoped, Last-Event-ID replay).
- **P3.4 Skill Security** — integrity hash, signing, owner/trust state,
  capability allow-list (imported skills never silently gain capabilities).
- **P3.5–3.11 Intelligence tracks** — Context (9), Testing (5), Security (7),
  Performance (7), Architecture (5), Team (5), Documentation (6) agents;
  capability-gated, recommendations-first, production-safe.
- **P3.12 IDE Foundation** — additive editor/IDE bridge (no IDE shipped).

Still on the roadmap (DEFERRED — not implemented, dependency docs only):
- **Docker/container workload isolation** for a production sandbox (package
  manager + Docker workloads depend on P0-6 sandbox; see dependency sketch).
- **Distributed execution** across machines/GPUs.
- Roots: package/dependency manager (sandboxed + supply-chain scanned).
- IDE **extensions at a higher phase** once the foundation is adopted by a
  concrete editor surface.

---

## Consolidated Duplication to resolve (in order)

1. **Agent lifecycle** (`agents/` + `agent/` + `execution/` + `local-agent/`) → one Supervisor (P0-1).
2. **Retry/backoff/state machines** (tasks, outbox, agents, scheduling, approvals) → one shared retry/cancel primitive (P0-1/P0-2).
3. **Policy engines** (control + execution + local-agent) → one capability vocabulary (P0-4).
4. **Claim logic** (tasks `SKIP LOCKED` vs scheduling unique-constraint) → converge on shared primitive (P1-C).

---

## Dependency sketch (sequence not parallel-guaranteed)

```
P0-6 Sandbox  ──security keystone──────────────►  P3 Docker workloads, P3 package manager
P0-1 Supervisor ─► P0-2 State ─► P2-A Breakpoint ─► P2-B Replay → P2-C Undo
P0-3 FS diff/COW ─► P1-D Git ─► QoL diff → P2-G Summary
P0-1/P0-5 → P2-E Stop Rules → Error Quick-Fix (gated)
P0-4 Capability → P2-D Team Cowork (via P1-A IPC)
```

**Result:** a single AI OS layer that cowork features call, built additively on the live system.

---

**ROADMAP ONLY.** Uppercase `SOURCE_CHANGES: NONE | DATABASE_CHANGES: NONE | DEPLOYMENT: NONE`.
