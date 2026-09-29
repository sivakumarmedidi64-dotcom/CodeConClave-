# CODECONCLAVE AI OS — P3 DEPENDENCY MAP

**Date:** 2026-09-01 | **Type:** ROADMAP / PLANNING ONLY — no implementation | **Status:** P3 NOT IMPLEMENTED

This map lists every planned P3 item, its dependency on the implemented P0/P1/P2
foundation, the existing capability it builds on, the missing capability that
P3 must add, and its security / database / service / local-cloud / production
impact. It is **planning only** — nothing here is implemented and nothing here
deploys.

P0/P1/P2 are **implemented and gated** (all flags default OFF). See
`FINAL_CODECONCLAVE_AI_OS_P0_GATE.md`, `FINAL_CODECONCLAVE_AI_OS_P1_GATE.md`,
`FINAL_CODECONCLAVE_AI_OS_P2_GATE.md`, and
`FINAL_CODECONCLAVE_P2_STOP_RULES_GATE.md`.

---

## 1. Principle

P3 continues the standing rule: **additive, feature-flag-gated, reversible,
CONSOLIDATE NOT DELETE**. Every P3 feature builds on the canonical OS
primitives already present under `backend/src/os/` (Process Manager /
Supervisor, Scheduler/DAG, IPC/Event Bus, Memory/State, Filesystem, Capability/
Policy, Stop Rules, Resource Governor, Sandbox, Git, Observability) and the P2
cowork experience. No P3 item introduces a second execution engine, a second
event bus, or a second scheduler.

---

## 2. P3 Feature Dependency Matrix

Legend per feature columns:
- **Dep P0/P1/P2**: the specific OS primitive it reuses (must be reused, not re-implemented).
- **Existing capability**: what already exists to build on.
- **Missing capability**: what P3 must add (the "why" of the roadmap).
- **Security**: impact / enforcement requirement.
- **DB**: P3 database impact (all gated, in-memory by default).
- **Service / Local-Cloud**: deployment-surface impact.
- **Production risk**: what must stay true before a deploy (deferred by default).

### 3.1 IDE Integrations
- **Dep P0/P1/P2:** P1 IPC/Event Bus + Observability tracing; P2 Command Palette + Context Sidebar + Notifications; P0 Filesystem diff + Capability/Stop Rules.
- **Existing capability:** IPC topic fan-out, event redaction, workspace-scoped events, read-only context model, command registry.
- **Missing capability:** an in-process bridge to an IDE extension runtime (LSP-style) that maps editor events onto OS topics and OS commands back onto editor actions. Stable IPC contract needed first.
- **Security:** the IDE bridge runs as an authenticated, capability-scoped consumer; it can never publish authoritative actions without the same command/stop-rule gate. Harden the bridge surface (no code execution from arbitrary editor payloads).
- **DB:** none (in-memory, event-store only).
- **Service / Local-Cloud:** local editor host ↔ cloud OS events; must be scoped per-workspace and per-user.
- **Production risk:** medium — needs sandbox + IPC stable (both present); defer live rollout.

### 3.2 Advanced Docker / Container Workload Isolation
- **Dep P0/P1/P2:** P0.6 Sandbox executor (security keystone), P0 Supervisor + Resource Governor; P2 Stop Rules.
- **Existing capability:** policy sandbox (deny-by-default, capability-gated, allow-listed, forbidden-token, time-boxed), supervisor lifecycle, resource governor concurrency/runtime/cost/egress.
- **Missing capability:** real process/container isolation (cgroups/namespaces on a host) for untrusted cloud code — currently Node userspace cannot provide OS-level CPU/memory cgroups, so this is the genuine gap the P0 sandbox explicitly does NOT fake.
- **Security:** THE highest-risk P3 item. Must keep the canonical chain (AUTH → CAP → STOP RULES → RESOURCE GOV → SANDBOX). Container escape, image supply-chain, and egress control are all in scope.
- **DB:** none.
- **Service / Local-Cloud:** host daemon/hypervisor layer; local first, cloud only behind a hard gate.
- **Production risk:** HIGH — explicitly deferred; requires a hardened host boundary before any production claim.

### 3.3 Sandboxed Package Management
- **Dep P0/P1/P2:** Sandbox executor + Resource Governor (egress allow-list) + Capability (`package.install`) + Stop Rules (`package.install` operation).
- **Existing capability:** `package.install` capability + stop-rule operation; network host allow-list; `ErrorQuickFix` `install` op kind; deterministic `Scheduler`.
- **Missing capability:** supply-chain scanning/allow-list of package registries, version pins, SBOM, and deterministic install into an isolated store.
- **Security:** installs execute only through the sandbox + stop-rule gate; egress allow-listed; never auto-run arbitrary post-install scripts without approval.
- **DB:** gated package ledger (default in-memory).
- **Service / Local-Cloud:** local registry proxy + scan service.
- **Production risk:** medium — depends on 3.2 container isolation for full safety.

### 3.4 Jira Integration
- **Dep P0/P1/P2:** P0 Capability/Policy + P1 IPC + P2 Notifications + Command Palette + Templates/Skills.
- **Existing capability:** capability-gated connectors pattern, event-async notifications, command registry, replay timeline.
- **Missing capability:** an authenticated Jira client behind a `jira` capability with OAuth token handling (never stored/unlogged) and two-way issue↔cowork mapping.
- **Security:** credential handling = fetch from secrets store only; tokens redacted by `sanitizeFields` on any event; capability-gated read/write; no cross-workspace data bleed.
- **DB:** gated issue-mapping cache (default in-memory).
- **Service / Local-Cloud:** cloud OAuth exchange; local client token.
- **Production risk:** low-medium — additive connector; defer any production creds.

### 3.5 Slack Integration
- **Dep P0/P1/P2:** P1 IPC + P2 Notifications + Command Palette (commands-as-facades) + Team Cowork.
- **Existing capability:** notification sink (redacted, durable, Last-Event-ID replay), command dispatch through the same gate, session-scoped cowork.
- **Missing capability:** Slack app gateway mapping Slack commands to palette commands and Slack events to notification redaction — all through the same authenticated model (no bypass, mirroring Voice P2.19–21).
- **Security:** Slack slash-commands route through the identical capability + stop-rule gate; no payload can escalate; all outgoing text redacted.
- **DB:** none.
- **Service / Local-Cloud:** cloud Slack app; local dev webhook.
- **Production risk:** low — but must never bypass the panel; reuse the Voice no-bypass pattern.

### 3.6 GitHub Integration
- **Dep P0/P1/P2:** P0 Git engine (`git.ts` — capability-gated, sandboxed, no push/auto-merge) + P1 IPC + Observability.
- **Existing capability:** real Git engine gated by `git.read`/`git.write`, `git.push` explicitly not present by design; Git capabilities in `CapabilityKind`.
- **Missing capability:** a `github` capability + OAuth-gated remote push/pr management — must be additive ON TOP of the existing local git engine and must still respect the shared Stop-Rule-derived policy (e.g. `git.merge`) and approvals.
- **Security:** remote push is a new high-sensitivity op; requires bound approval; no auto-merge; tokens stored server-side only, redacted in every event.
- **DB:** gated remote-link store (default in-memory).
- **Service / Local-Cloud:** cloud OAuth + webhook; local repo remains source of truth.
- **Production risk:** medium — remote push adds blast radius; gate behind approval + capability.

### 3.7 Advanced External Connectors (generic)
- **Dep P0/P1/P2:** Capability/Policy + IPC + Notification sink + Command Palette + Templates.
- **Existing capability:** the connector pattern established by Jira/Slack/GitHub entries; capability-gated adapter with redacted events.
- **Missing capability:** a generic, validated connector SDK with a shared secrets-store and a per-connector capability registry.
- **Security:** every connector declares its required capability + stop-rule operation; tokens never logged; no arbitrary webhook code execution.
- **DB:** gated per-connector state (default in-memory).
- **Service / Local-Cloud:** cloud webhook ingestion; local test harness.
- **Production risk:** low-medium; each connector independently gated.

### 3.8 Distributed Execution (where justified)
- **Dep P0/P1/P2:** P1 DAG + Supervisor + IPC (durable/workspace-scoped) + State/Checkpoint + Scheduler.
- **Existing capability:** DAG orchestration with checkpoint resume, supervisor restart, durable IPC ordering, cross-agent resource accounting (Stop Rules), workspace-scoped events.
- **Missing capability:** multi-host coordination: a shared leader/lease + fan-out that keeps IPC ordering and cross-agent accounting correct across hosts. Only justified where single-host concurrency is genuinely saturated.
- **Security:** cross-host accounting must remain atomic; workspace isolation must hold across hosts; every remote node inherits the same capability/stop rules (no broader privileges).
- **DB:** distributed lease/queue (gated; default in-memory single-host).
- **Service / Local-Cloud:** multi-instance; local single-host fallback preserved.
- **Production risk:** HIGH blast radius — deferred; single-host correctness first.

### 3.9 Advanced Ecosystem Capabilities
- **Dep P0/P1/P2:** full OS kernel surface; P2 Skills + Templates + Voice + Notifications.
- **Existing capability:** versioned skills/templates with secret stripping and current-policy replay; command palette facades.
- **Missing capability:** ecosystem marketplace/signing/verification for skills+templates so imported recipes are auditable and cannot smuggle privileges.
- **Security:** imported recipes replay under current stop rules only; signatures verified; no capability escalation.
- **DB:** gated catalog (default in-memory).
- **Service / Local-Cloud:** registry service (read-only mirror); local first.
- **Production risk:** low — additive.

### 3.10 Remaining Intelligence Features (the approved 50)
- **Dep P0/P1/P2:** Observability tracing + Replay timeline + Session Summary + Error Quick-Fix + Smart Files.
- **Existing capability:** redacted event pipeline, deterministic replay, session summarization, quick-fix with approval, workspace-aware file ranking.
- **Missing capability:** the specific intelligence features already mapped in the approved 50-intelligence list (V4 series) — implemented one-by-one, each additive and flag-gated.
- **Security:** mirrors observability redaction; no intelligence feature expands authority, only surfaces insight.
- **DB:** gated derived-index stores (default in-memory).
- **Service / Local-Cloud:** local compute; cloud optional.
- **Production risk:** low — each item independently gated.

### 3.11 Advanced Mobile / Device Capabilities
- **Dep P0/P1/P2:** P1 IPC + P2 Notifications (SSE/WebSocket sink, Last-Event-ID re-sync) + Voice (same command model) + Team Cowork.
- **Existing capability:** durable redacted notification sink, voice intent through the same gate, workspace-scoped events.
- **Missing capability:** device push transport and per-device auth that still routes all commands through the canonical command model (no bypass, mirroring Voice).
- **Security:** device-originated commands are authenticated facades; notifications redacted on every device sink.
- **DB:** gated device-token store (default in-memory).
- **Service / Local-Cloud:** push gateway; local dev.
- **Production risk:** low — additive.

### 3.12 Skill System, Scheduling, Voice, Small UX, Team, Documentation, Security/Performance/Architecture/Testing Intelligence
These map onto already-implemented P2 foundations and the intelligence catalog:

- **Skill System** — depends on P2 Skills; P3 adds versioned skill registry + signing (3.9).
- **Scheduling** — depends on P2 Scheduler which **reuses** the existing recurrence engine; P3 adds calendar/trigger integrations.
- **Voice** — depends on P2 Voice (same command model, no bypass); P3 adds more NLU intent coverage through the same palette gate.
- **Small UX features** — depend on P2 Command Palette + Context Sidebar; P3 extends the read-side only.
- **Team features** — depend on P2 Team Cowork (owner authoritative, session-scoped IPC, capabilities); P3 adds presence/roles.
- **Documentation** — depends on OS Observability + Replay; P3 auto-generates docs from redacted timelines.
- **Security intelligence** — depends on Stop Rules audit + Observability; P3 surfaces anomaly detection from audit events (read-only).
- **Performance intelligence** — depends on DAG + Supervisor timings; P3 adds profiling from the resource governor + trace spans.
- **Architecture intelligence** — depends on DAG + Filesystem; P3 adds dependency mapping (additive insight only).
- **Testing intelligence** — depends on DAG + Error Quick-Fix; P3 adds test generation/verification behind the same approval gate.

---

## 4. Cross-cutting P3 rules

1. **Consolidate, don't duplicate.** Every P3 feature reuses the canonical P0/P1/P2 primitive listed in its row — no second bus/scheduler/diff/state/policy.
2. **No feature is enabled by default.** Each gets its own `AIOS_P3_*` flag, OFF by default (mirrors the 17 `AIOS_P2_*` flags).
3. **Security chain is invariant.** ALL P3 paths (IDE, Git remote push, Slack/Jira/GitHub, package install, distributed nodes, device/mobile, voice) must transit AUTH → CAPABILITY → STOP RULES → RESOURCE GOVERNOR → SANDBOX. Voice/Skills/Scheduler/Replay/Notifications cannot bypass — same proof already gated for P2.
4. **No production** deploy/migrate/var change at this stage. `PRODUCTION_DEPLOYMENT = NOT_EXECUTED`.
5. **Deferred live-risk items** (container isolation, distributed execution, Git remote push) are explicitly gated behind hardened host/sandbox + approval before any roll-out.

---

**P3 = READY (planned). NOT implemented. No deployment.**

---

## 5. Addendum — Final AI OS Runtime Phase (2026-09-02)

The runtime phase re-verified the host and added the one remaining PREP link
without creating a second scheduler/queue/state/bus and without changing P3
planning semantics.

| Component | Depends on | State |
|-----------|-----------|-------|
| Real-isolation runtime | P0-6 sandbox + `isolation/{detect,modes,real-executor,container-executor,process-*}`, host capability audit | **DEFERRED on this host** (no docker/podman/nerdctl/WSL/namespaces; fail-closed `POLICY_ONLY`; 32 isolation tests PASS) |
| Distributed execution runtime | P0-1 Supervisor, P0-2 State, P0-5 Resource Governor, P0-6 Sandbox, P1 IPC/EventBus, P2 Scheduler | **PREPARED-NOT-ACTIVE**; runtime binding `SupervisedWorkerExecutor` (lease→Supervisor→RESULT) added + tested (42 dist-exec tests PASS); workers hold only required capabilities |
| Worker registration | ExecutionCoordinator + EventBus | coordinator PREP (registry, heartbeat, leases, reassignment) — PASS |
| Worker capability routing (Phase F) | `WorkerResource` profile (os/arch/gpu/net-policy/local-tools/exec-class) | added; tasks constrain by profile; capability-gated |
| Phase K performance | Coordinator + Supervisor + ResourceGovernor | measured in-memory (µs scheduling/lease, ms supervised/IPC); generous TARGET/MEASURED |

Constraints preserved:
1. **No second** scheduler / queue / state engine / event bus / memory system.
2. Distributed work reuses the EXISTING `Supervisor`, `ResourceGovernor`,
   `StateStore`, `EventBus`.
3. Production execution is NOT wired; the coordinator owns retry policy and
   worker execution happens only when a worker holds the advertised capability.
4. `REAL_ISOLATION` is NEVER presented as real when the host is POLICY_ONLY.
5. No deployment. `PRODUCTION_DEPLOYMENT = NOT_EXECUTED`.
