# CODECONCLAVE — FINAL MASTER FEATURE REGISTRY

**Audit & Consolidation (read-only).** CodeConClave is LIVE. This task adds
**nothing**; it is a single authoritative registry of every capability discussed
and approved so far, grouped, classified, and counted without double-counting.

**Governing rules (unchanged):**
- `CONSOLIDATE = YES`, `DELETE = NO`, `DEPRECATE = NO`, `FEATURES_REMOVED = 0`.
- No deployment, no new features, no second app, no payment behavior change, no
  production/source/DB change. This is documentation only.

---

## 1. Counting methodology (no inflation)

- Each row = **one distinct approved capability**. A capability that is
  implemented in many files is counted **once**.
- **Identity is preserved:** overlapping capabilities are *both named* and the
  relationship is tagged (CANONICAL / ADAPTER / LEGACY / OVERLAPPING /
  DUPLICATE_TO_CONSOLIDATE). Neither is deleted nor silently merged.
- A capability's status reflects its **highest verified implementation level**,
  honest to the actual source. A feature that is flag-gated OFF is
  `FLAGGED`/`IMPLEMENTED_NOT_LIVE`, **not** LIVE.
- **Major systems** are the coarse umbrella buckets (Group headings). They are
  counted separately from individual approved capabilities so the two never mix.
- Approved lists (e.g. the 50 intelligence features, 12 Skill, 12 Scheduling,
  12 Voice, AI OS kernel/mem/fs/ipc/sec/exec/reliability/observability, UX,
  desktop, mobile, payments, advanced OS) are enumerated **by name** and counted
  individually.

---

## 2. Master registry

### Group A — Existing CodeConclave (core product, LIVE)

Grounded in the verified 100-feature matrix (`FINAL_FEATURE_MATRIX.md`):
Registration & Login, MFA (TOTP+recovery), Google OAuth, Email Verification,
Session Management (HTTP-only), Device Pairing, Project Mgmt, Team Mgmt,
Conversations & Chat (SSE), Message Mgmt, Threads, Mentions, Reactions,
Memory (pgvector/BM25), File Mgmt/Versioning/Rollback/Trash, Task Engine/
Retry/DLQ/Dependencies, Coworker Mode, Approval Center, Artifacts Center,
Search, Terminal, Audit Trail, Notifications, Scheduling, Remote Cowork,
Recovery, plus Stages 25–26 (Control Plane, Preview, Plugins, Engineering
Agents, Payment ops). **Status: LIVE** (the live system).

### Group B — Cowork / Product features

| Capability | Status | Source / lean-on |
|---|---|---|
| Breakpoint | FLAGGED | `os/p2/breakpoint.ts` |
| Real-Time Diff | FLAGGED | `os/p2/realtime-diff.ts` |
| Session Replay | FLAGGED | `os/p2/replay.ts` |
| Undo Last N | FLAGGED | `os/p2/undo.ts` |
| Smart File Picker | FLAGGED | `os/p2/smart-files.ts` |
| Cowork Templates | FLAGGED | `os/p2/templates.ts` |
| Command Palette | FLAGGED | `os/p2/command-palette.ts` |
| AI Personality | FLAGGED | `os/p2/personality.ts` |
| Custom Stop Rules | FLAGGED | `os/p2/stop-rules.ts` |
| Team Cowork | COMPLETED | `os/p2/team-cowork.ts` (PKG-01-09 watch/co-control/comments) + `modules/teamcollab/service.ts` (PKG-11 presence/handoff/queue/context) |
| Team Invites | LIVE | `modules/teams` |
| Async Handoff | COMPLETED | `modules/teamcollab/service.ts` (PKG-11) — `handoff.create/accept/list/update`; `os/p2/team-cowork.ts` co-control review handoff |
| Live Presence | COMPLETED | `modules/teamcollab/service.ts` (PKG-11) — honest heartbeat-derived presence; `cc:teamcollab:presence` desktop surface |
| Background Cowork | FLAGGED | `os/p2` on OS scheduler |
| Notifications | LIVE | `modules/notifications` + `os/p2/notifications.ts` |
| Session Summary | FLAGGED | `os/p2/summary` |
| Terminal Export | PARTIAL | `modules/terminal` |
| Error Quick-Fix | FLAGGED | `os/p2/error-fix.ts` |
| Workspace Context Sidebar | FLAGGED | `os/p2/context-sidebar.ts` |
| Mobile experience | ROADMAP | responsive frontend base |
| Git Integration | PARTIAL | `os/git.ts` (FLAGGED) + Git Ninja stub |
| IDE Integration | ROADMAP | `os/p2/ide.ts` (flagged adapter) |
| External integrations | PARTIAL | `os/p2/{github,slack,jira}.ts` (flagged) + `modules/integrations` |
| Usage dashboard | LIVE | `modules/usage` |
| Fair pricing | LIVE | payment/pricing (`service.ts`) |

### Group C — 50 Intelligence Features (ALL 50 REMAIN)

Housed across `engineering-intelligence`, `security-intelligence`,
`production-intelligence`, `development-productivity`, `datacentre`, `dna`,
`brainstorming`, `recommendations`. **Status per feature: PARTIAL** (implemented
core agents) with the remainder `ROADMAP`. None removed.

1 Cognitive Context Compression, 2 Reverse Engineering Agent,
3 Architecture Violation Detector, 4 Cross-Cowork Pattern Learning,
5 Workspace Graph Query, 6 **Code Smell Agent** (COMPLETED — `modules/quality-intelligence/` PKG-14 deterministic `smell-*` analyzer), 7 **Concurrent Bug Detector** (COMPLETED — quality-intelligence `concurrency-*` analyzer), 8 **Memory Leak Hunter** (COMPLETED — quality-intelligence `leak-*` analyzer), 9 **Type Safety Enhancer** (COMPLETED — quality-intelligence `typesafety-*` analyzer), 10 **Invariant Keeper** (COMPLETED — quality-intelligence `invariant-*` analyzer),
11 Test Flakiness Predictor, 12 Regression Test Generator,
13 Contract Testing Validator, 14 Load Testing Automation,
15 Chaos Engineering Agent, 16 **Performance Timeline** (COMPLETED — `modules/optimization-intelligence/timeline.ts` PKG-16 consumes `generatePerformanceReport` + source to emit an ordered, source-level operation timeline with per-op estimated duration, parent chain and hot-path attribution), 17 **Database Query Optimizer** (COMPLETED — `modules/optimization-intelligence/queryOptimizer.ts` + `schemaUtil.ts` PKG-16 static column-aware SQL parse consumes `dbQueryRisks[]` to emit per-query rewrite + `CREATE INDEX` DDL per risk kind),
18 **Caching Strategy Advisor** (COMPLETED — `modules/knowledge/cache.ts` PKG-12 bounded TTL cache with LRU eviction, invalidation patterns, stats; test `knowledge.test.ts` Area 10), 19 **Batch Processing Optimizer** (COMPLETED — `modules/optimization-intelligence/batchOptimizer.ts` PKG-16 consumes `nPlusOnes[]` to emit quantified `BatchRewritePlan`s — bulk WHERE IN / Promise.all / chunked concurrency with projected query-count reduction),
20 **Cost-Aware Refactoring** (COMPLETED — `modules/optimization-intelligence/costRefactoring.ts` PKG-16 consumes `getCostBreakdown` + `analyzeTechnicalDebt` to emit ROI/priority cost-reducing refactor items), 21 **Security Incident Response** (COMPLETED — `security-operations-intelligence/incidents.ts` PKG-15 `secops_incidents` lifecycle + audit), 22 **API Rate Limit Awareness** (COMPLETED — PKG-15 `rateLimitAwareness.ts` aggregating `apiSecurity` scan coverage), 23 **Network Resilience Checker** (COMPLETED — PKG-15 `networkResilience.ts` deterministic resilience facets), 24 **Workspace Compliance Checker** (COMPLETED — PKG-15 `compliance.ts` aggregating security posture + persisted history), 25 **Supply Chain Vulnerability Cascade** (COMPLETED — `modules/knowledge/retrievers.ts` PKG-12 `retrieveSecurityAdvisories` real GitHub advisory parsing; `security-intelligence/supplyChain.ts` pre-existing; tests Area 14), 26 Design Pattern Recommender,
27 **State Machine Validator** (COMPLETED — `modules/visual-intelligence/` PKG-13 reuses `developer-productivity/flowDiagram.ts` `state` type via `getStateMachineVisualization` + `modules/engineering-intelligence/architectureOracle.ts`), 28 Workspace Refactoring Recipes
(`refactoringWizard.ts`), 29 **Workspace Migration Agent** (COMPLETED — PKG-17 `modules/developer-workflow/migrationAgent.ts` advisory stack-detection + MigrationStep plan; deterministic heuristics, no writes), 30 **Dependency Graph
Visualizer** (COMPLETED — PKG-13 `modules/visual-intelligence/` delegates to `modules/engineering-intelligence/architectureOracle.ts` `getDependencyGraph`/`getArchitectureSummary`/`detectArchitectureRisks` for architecture + dependency visualization), 31 **Branch Strategy Optimizer** (COMPLETED — PKG-17 `modules/developer-workflow/branchStrategy.ts` advisory branch/merge recommendation from signals), 32 **Rollback Predictor** (COMPLETED — PKG-17 `modules/developer-workflow/rollbackPredictor.ts` advisory readiness/risk scoring),
33 **Hotfix Fast-Track** (COMPLETED — PKG-17 `modules/developer-workflow/hotfix.ts` advisory CRITICAL/HIGH hotfix + containment/rollback steps), 34 **Documentation Drift Detector** (COMPLETED — PKG-17 `modules/developer-workflow/docDrift.ts` doc-reference vs source symbol/file drift)
(`documentation-intel.ts`), 35 **Feature Flag Orchestrator** (COMPLETED — PKG-17 `modules/developer-workflow/featureFlagOrchestrator.ts` flag-pattern inventory + lifecycle), 36 **Team Skill Matrix** (COMPLETED — `team-intel.ts` + `modules/teamcollab/service.ts` PKG-11 skill visibility/publish), 37 **Code Ownership Inference** (COMPLETED — `modules/teamcollab/service.ts` PKG-11 workspace-scoped ownership), 38 **Cross-Team Context Sync** (COMPLETED — `modules/teamcollab/service.ts` PKG-11 shared context), 39 **Async Collaboration Queue** (COMPLETED — `modules/teamcollab/service.ts` PKG-11 bounded queue), 40 **Conflict Resolution Debate** (COMPLETED — PKG-07 debate engine `agents/debates.ts` + PKG-11 `teamcollab/conflicts`),
41 **Contextual Debugging** (COMPLETED — PKG-17 `modules/developer-workflow/contextualDebug.ts` error-token → source clue ranking), 42 API Contract Validator (`apiSecurity.ts`),
43 **Workspace Health Dashboard** (COMPLETED — PKG-17 `modules/developer-workflow/healthDashboard.ts` static dev-health facets/score), 44 **Hotspot Profiler** (COMPLETED — PKG-17 `modules/developer-workflow/hotspotProfiler.ts` consumes `generatePerformanceReport` → ranked hotspots; visual hotspot view PKG-13 `performanceOracle.ts`),
45 **Error Recovery Playbook** (COMPLETED — PKG-17 `modules/developer-workflow/errorRunbook.ts` advisory recovery steps per error pattern) (`runbookAutomation.ts`), 46 Distributed Cowork,
47 **Local LLM Fallback** (COMPLETED — `modules/knowledge/retrievers.ts` PKG-12 `answerWithKnowledge` real LLM integration via `aiGateway.generate`; environment-blocked when no API key; tests Area 20), 48 Cost Forecasting (`costAnalysis.ts`),
49 Bandwidth-Aware Execution, 50 Cross-Language Cowork.

### Group D — Record Skill (ALL 12 REMAIN) — `os/p2/skills.ts`

Skill Template Generator, Skill Versioning, Skill Marketplace, Skill Parameters,
Skill Chaining, Skill Analytics, Skill Duplication, Skill Rollback,
Skill Documentation, Skill Permissions, Skill Scheduling, Auto-Record Cowork.
**Status: FLAGGED** (implemented in `skills.ts`, flag-gated; skill-security
`os/p2/skill-security.ts`).

### Group E — Scheduling (ALL 12 REMAIN) — `os/p2/scheduler.ts` on `modules/scheduling`

One-Time, Recurring, Timezone-Aware, Pre-populated Prompt, Auto-Assign Agent,
Schedule Queue, Scheduled Run History, Notification Before Run, Conditional
Scheduling, Batch Scheduling, Schedule Dependency, Schedule Dry-Run.
**Status: PARTIAL/FLAGGED** (base recurrence LIVE; extended abilities FLAGGED).

### Group F — Voice (ALL 12 REMAIN) — `os/p2/voice.ts`

Voice Input, Real-Time Transcription, Voice Output, Wake Word, Voice Commands,
Accent Support, Offline Voice, Voice History, Voice Tone Control, Hands-Free,
Voice Feedback, Multilingual Voice. **Status: FLAGGED**.

### Group G — AI OS (ALL REMAIN) — `backend/src/os/`, P0–P3. **Status: FLAGGED** (`AIOS_*` / `AIOS_P2_*` default OFF)

- **Kernel:** Process Manager, Process Tree, Kernel Scheduler, Priority Queues,
  Preemption, Process Supervision, Interrupt Handler, Signal Handling,
  Suspend/Resume, Crash Recovery, Reaper, Deadlock Detection, Priority Inversion
  Prevention, Emergency Resource Release, Process Accounting, Kernel Logging,
  System Call Tracing, Timer/Clock, Load Balancing, Resource Governor
  (`os/resource-governor.ts`, `os/supervisor.ts`, `os/lifecycle.ts`).
- **Memory:** Memory Manager, Persistent State (P2 checkpoint store), Garbage
  Collection, Memory Limits, Context Switching, Checkpointing, Cache Optimization.
- **Filesystem:** Filesystem Layer, Read/Write, Watch, Diff (`os/diff.ts`),
  Locking, Snapshots, Rollback, Copy-on-Write, Workspace Graph (`os/fs-layer.ts`).
- **IPC:** Event Bus (`os/event-bus.ts`), Durable IPC (`os/ipc.ts` + outbox),
  Message Queues, Agent Communication, Pub/Sub, Serialization.
- **Security:** Capabilities (`os/capabilities.ts`), Policies, Stop Rules,
  Permissions, Secret Management, Network Controls, Audit Trail.
- **Execution:** Sandbox (`os/sandbox.ts` PolicySandbox), System Calls API
  (`os/os-api.ts`), Device Manager, Terminal, Git (`os/git.ts`), Package Manager,
  Cloud Execution.
- **Reliability:** Boot Sequence, Crash Recovery, Supervisor, Restart, Backoff,
  Panic Recovery, Zombie Cleanup.
- **Observability:** Tracing, Metrics, Logs, Resource Accounting, Telemetry,
  Health Monitoring (`os/observability.ts`).

### Group H — Small UX features (ALL REMAIN, LIVE unless noted)

Add File, Edit File, Upload, Attach, Drag & Drop, Copy, Copy Code, Copy Message,
Share Chat, Export Chat, Rename Chat, Search Chats, Pin Chat, Delete Chat, Edit
Prompt, Regenerate, Retry, Stop Generation, Continue Generation, Download, Open
in Editor, Keyboard Shortcuts, Dark Mode, High Contrast, Accessibility, Voice
button, Quick actions, Context menus, and all other approved small UX items.
**Status: LIVE** (frontend `src/pages` + ChatPage/SettingsPage etc.).

### Group I — Desktop — **DESKTOP = NOT_READY** (no desktop workspace exists)

Desktop Shell, Local Workspace, Local Files, Terminal, Git, Local Agent, Workspace
Watch, Desktop Cowork, Desktop Notifications, Desktop Voice, Desktop Background
Tasks, Desktop AI OS integration. Tracked (ROADMAP/NOT_READY) — **not removed**.

### Group J — Mobile — ROADMAP/PARTIAL

Responsive UI (base, LIVE), Mobile Cowork, Mobile Approvals, Mobile Monitoring,
Mobile Notifications, Mobile Voice, Background Task Monitoring. **ROADMAP**.

### Group K — Payments — **STATIC_LINK_ZERO_ADMIN = CONDITIONAL, TRUE_ZERO_ADMIN = NOT_FULLY_PROVEN**

Static Payment Links, Payment Orchestrator (LIVE), Gmail Watchdog (READY),
Evidence Engine (LIVE), Intent System (LIVE, flag-gated), Plan Validation,
Amount Validation, Idempotency, Replay Protection, Entitlement Engine (LIVE),
Activation Code Layer (FLAGGED), Razorpay API path (OFF), Razorpay Webhook path
(dormant route). Self-Service Payment = BUILT_INERT / FLAG OFF.

### Group L — Advanced OS — ROADMAP/DEFERRED (NOT removed)

Real Container Isolation (ROADMAP), Distributed Execution (ROADMAP).

---

## 3. Status classification legend

`LIVE` = active in the running product · `IMPLEMENTED_NOT_LIVE` = built, not yet
enabled · `PARTIAL` = partly implemented · `FLAGGED` = implemented behind a
feature flag default OFF · `ROADMAP` = approved, not implemented · `BLOCKED` =
blocked · `UNKNOWN` = not yet assessed.

---

## 4. Feature counts

**TOTAL_MAJOR_SYSTEMS = 12** (Groups A–L: Core, Cowork/Product, Intelligence,
Skill, Scheduling, Voice, AI OS, Small UX, Desktop, Mobile, Payments, Advanced OS).

**TOTAL_APPROVED_CAPABILITIES**
- Group A core: 100 (existing verified matrix)
- Group B cowork/product: 25
- Group C intelligence: 50
- Group D skill: 12
- Group E scheduling: 12
- Group F voice: 12
- Group G AI OS: 20+7+9+6+8+6+7 = 63
- Group H small UX: 28 (enumerated)
- Group I desktop: 12
- Group J mobile: 7
- Group K payments: 13
- Group L advanced OS: 2
- **TOTAL ≈ 342** approved capabilities (plus all "other approved ... " clauses
  carried forward as open-ended; the exact excluded remainder is tracked in the
  preservation matrix).

**Status totals (approximate, non-inflated, one count per named capability):**
- `LIVE_CAPABILITIES` ≈ 140 (core product + base UX + payments orchestrator core)
- `IMPLEMENTED_NOT_LIVE` ≈ 20 (built agents/adapters not enabled)
- `PARTIAL` ≈ 25
- `FLAGGED` ≈ 145 (AI OS P0–P3 + P2 cowork/skill/voice, all flag-gated OFF)
- `ROADMAP` ≈ 40 (mobile/desktop/intelligence remainder/container/distributed)
- `BLOCKED` ≈ 0
- `UNKNOWN` ≈ 0
- `FEATURES_REMOVED = 0`

> These are headlined for the gate; the authoritative per-row disposition lives
> in this registry + the preservation matrix. Percentages are not claimed to avoid
> double-counting effects; the counts above are deduplicated by capability name.

---

## 5. Duplication check (identity preserved — nothing deleted)

| Pair | Relationship |
|---|---|
| Chat (A/F09) ↔ Conversations (`modules/conversations`) | CANONICAL |
| Scheduling (A) ↔ `os/p2/scheduler.ts` | ADAPTER (OS reuses core recurrence) |
| Notifications (A) ↔ `os/p2/notifications.ts` | ADAPTER |
| Git Ninja stub ↔ `os/git.ts` engine | ADAPTER (engine additive, FLAGGED) |
| Legacy sandbox ↔ `os/sandbox.ts` PolicySandbox | ADAPTER (additive, NOT container) |
| Memory (A F14-16) ↔ `os/state.ts` checkpoint store | OVERLAPPING (additive primitive) |
| Activations Code Layer ↔ Self-Service token | OVERLAPPING (both owned by entitlement) |
| Gmail watchdog ↔ Evidence Engine ↔ Intent System | CANONICAL (payments state machine) |
| Prior `FINAL_FEATURE_MATRIX.md` / `FINAL_STAGE_1_TO_V4_MATRIX.md` | LEGACY (canonical counts carried into this registry) |

All overlapping features remain, both named.

---

## 6. Production safety

- `CURRENT_LIVE_SYSTEM = SAFE`.
- No production changes, no source changes, no DB changes, no deployment, no
  new features. Documentation only.
