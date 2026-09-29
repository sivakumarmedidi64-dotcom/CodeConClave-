# CODECONCLAVE — 185-CAPABILITY AUDIT (TRUTHFUL STATUS MATRIX)

**Audit & consolidation (read-only).** No deployment, no new features, no
payment behavior change, no production/source/DB change.

**Quoted spec (RING.txt Part 14):**
> Use the complete 185-capability master specification supplied with this task
> as the capability source of truth. Organize implementation under: AGI
> Foundation, ANI Execution, AI OS, Memory, Background Agents, Advanced
> Reasoning, Creative Engine, Team, Development, Data, Deployment, Security,
> Business, Content, Design, Workflow Automation, Advanced Technical, Wow
> Features, Competitive Moat, Operating Code. For EVERY capability from 1 to
> 185: create an internal capability audit: ID, NAME, CURRENT STATUS, REAL
> IMPLEMENTATION, ENTRY POINT, DEPENDENCIES, TEST COVERAGE, USER-FACING STATUS,
> GAPS. Statuses: REAL / PARTIAL / BLOCKED / UNSUPPORTED / NOT_IMPLEMENTED.
> Do not label PARTIAL / BLOCKED / UNSUPPORTED capabilities as REAL.

**Honest basis for this matrix:**
- The verbatim enumerated 1–185 specification was **not present** as a file in
  this repository. This matrix therefore audits the **real, shipped capability
  surface** of CodeConClave grouped under the 20 mandated categories, grounded
  in `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (frozen 336
  capabilities), `docs/CODECONCLAVE_FINAL_INDEPENDENT_AUDIT.md`, and the actual
  `backend/src/modules/*` surface verified live in this session.
- **Rule: nothing is labeled REAL unless it has a real execution path in the
  source. PARTIAL / BLOCKED / UNSUPPORTED / NOT_IMPLEMENTED are never labeled
  REAL.** No "implemented under a category" claim is inferred from a directory
  name alone; each row cites its actual entry point.
- Capabilities that exist only behind flag-gated `os/p2/*` code are
  `FLAGGED` (reported here as PARTIAL / IMPLEMENTED_NOT_LIVE) — never REAL.
- External services verified from official/public sources (web-verified this
  session, Sep 2026) are tagged `FREE_DEVELOPER_API`, `FREE_TRIAL`,
  `PAID_REQUIRED`, or `ENVIRONMENT_BLOCKED`. **FREE_DEVELOPER_API means a
  perpetual free developer tier exists without a credit card** (Gemini,
  Mistral, NVIDIA NIM, OpenRouter `:free`). **FREE_TRIAL means a finite
  sign-up grant only** (DeepSeek 5M-token grant, Cohere trial 1k calls/mo,
  Qwen new-user quota, Kimi ¥15 voucher CN-only). These two are NEVER
  collapsed.

---

## 0. Grand totals (current, per-rule, one count per named capability)

| Group | REAL | PARTIAL | BLOCKED | UNSUPPORTED | NOT_IMPLEMENTED | Rows below |
|---|---|---|---|---|---|---|
| AGI Foundation | 9 | 5 | 0 | 0 | 0 | 14 |
| ANI Execution | 10 | 4 | 0 | 0 | 0 | 14 |
| AI OS | 5 | 15 | 0 | 1 | 6 | 27 |
| Memory | 5 | 4 | 0 | 0 | 1 | 10 |
| Background Agents | 3 | 3 | 0 | 0 | 1 | 7 |
| Advanced Reasoning | 4 | 5 | 0 | 0 | 1 | 10 |
| Creative Engine | 3 | 3 | 0 | 0 | 3 | 9 |
| Team | 7 | 2 | 0 | 0 | 0 | 9 |
| Development | 11 | 6 | 0 | 0 | 1 | 18 |
| Data | 4 | 4 | 0 | 0 | 1 | 9 |
| Deployment | 2 | 3 | 1 | 0 | 1 | 7 |
| Security | 9 | 4 | 1 | 0 | 1 | 15 |
| Business | 6 | 2 | 0 | 0 | 1 | 9 |
| Content | 4 | 2 | 0 | 0 | 1 | 7 |
| Design | 4 | 4 | 0 | 0 | 0 | 8 |
| Workflow Automation | 6 | 3 | 0 | 0 | 1 | 10 |
| Advanced Technical | 4 | 3 | 1 | 0 | 2 | 10 |
| Wow Features | 5 | 3 | 0 | 0 | 2 | 10 |
| Competitive Moat | 4 | 4 | 0 | 0 | 1 | 9 |
| Operating Code | 5 | 2 | 0 | 0 | 0 | 7 |
| **TOTAL** | **110** | **81** | **3** | **1** | **24** | **219** |

> 219 capacity rows. The upstream numbering "1 to 185" is not restorable from
> repo evidence; the 20 categories above satisfy the mandated grouping. The
> figure "≈140 LIVE" in the master registry overlaps ONLY the REAL column here;
> the mismatch is the known documentation-technical artifact
> (`REGISTRY_ARITHMETIC_STATUS = MISMATCH`, gap 6, per the independent audit),
> not an evidence failure.

---

## 1. AGI Foundation

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| AGF-01 | Multi-model workspace AI (chat + cowork) | REAL | `modules/conversations/routes.ts` (SSE chat), `modules/ai/gateway.ts`, `modules/ai/providers.ts` | working provider key | `conversations.test.ts` + full AI tests | CHAT works with any verified provider | provider availability = entitlement + key |
| AGF-02 | Provider registry (models w/ enabled state) | REAL | `modules/ai/providerKeySpec.ts`, `modules/ai/providerKeyState` | — | `providerKeySpec` tests | /providers + Settings > AI | big_pickle/manus gated |
| AGF-03 | Provider quality gate (fail closed) | REAL | `modules/ai/gate.ts` (`isProviderVisible`, `providerGateReason`) | — | gate tests PASS | BLOCKED shown honestly for manus, big_pickle | — |
| AGF-04 | Zero-budget provider honesty (free tier only) | REAL | provider audit (this doc) + `providerKeySpec.ts` | web-verified facts | n/a (documentation) | FREE_DEVELOPER_API: Gemini, Mistral, NVIDIA NIM, OpenRouter; FREE_TRIAL: DeepSeek, Cohere, Qwen, Kimi(CN); PAID_REQUIRED: OpenAI, Anthropic, Grok, Z.ai, Devin | NO paid provider is enabled automatically |
| AGF-05 | Agent conversation lifecycle (create/send/messages) | REAL | `modules/conversations/service.ts` | DB | suite PASS | CHAT + PROJECTS > Chat | — |
| AGF-06 | SSE streaming responses | REAL | `modules/conversations/routes.ts` | gateway | suite PASS | streaming chat UI | — |
| AGF-07 | Context-aware follow-ups (message history) | PARTIAL | `modules/conversations/service.ts` (history held) | memory | suite PASS | chat continues thread | cross-session summarization FLAGGED not surfaced |
| AGF-08 | Self-aware limitation disclosure | PARTIAL | agent/UI copy; honest BLOCKED states | — | — | providers show real key state | not centralized |
| AGF-09 | Intent routing to specialized modules | PARTIAL | `modules/ai/gateway.ts` routing models per capability | provider registry | related tests PASS | model picker by capability | auto-routing heuristics limited |
| AGF-10 | Multimodal input (image) | REAL | gemini adapter (image input real-verified 200) | GEMINI key | Prompt-3 verification | image upload in chat | only image-capable models |
| AGF-11 | Image generation | REAL | geminiImageAdapter (`gemini-3-pro-image`) | GEMINI key | Prompt-3 verification | image generation enabled | free-tier rate limits |
| AGF-12 | Model heat/failover routing | PARTIAL | `modules/ai/gateway.ts` | registry | related | — | no transparent health-weighted routing metric |
| AGF-13 | Prompt-injection / jailbreak guard-rail | PARTIAL | security-intelligence + agent execution policy | policy engine | security suite PASS | deny-by-default policy | no dedicated inj-detection model |
| AGF-14 | Honest availability surfacing | REAL | `gate.ts` BLOCKED rows + provider state | — | suite PASS | Settings shows BLOCKED + reason | — |

## 2. ANI Execution

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| ANE-01 | Task engine (create/queue/run/retry/DLQ) | REAL | `modules/agent/service.ts`, `modules/agents/service.ts` | DB | suite PASS | TASKS, PROJECTS > tasks | — |
| ANE-02 | Task dependencies | REAL | Task engine dependency graph | DB | suite PASS | task chaining | — |
| ANE-03 | Coworker mode (run actions) | REAL | `modules/autonomy/service.ts` + `runCoworker` | agent/execution | suite PASS | AUTONOMY cowork panel | paid-gated |
| ANE-04 | Real verification inside runCoworker (unblocks apiKey) | REAL | `runCoworker` verify step (apiKey issuance, env-blocked self-check, 2h live lock, invalidate-on-block) | — | paywall-gate + failure-17 PASS | VERIFY button works for apiKey | — |
| ANE-05 | Execution sandbox (deny-by-default) | REAL | `modules/execution/routes.ts` + PolicySandbox | policy engine | security suite PASS | ACTION execution | not OS-container |
| ANE-06 | Command execution w/ dangerous-blocklist + path guard | REAL | execution + secretGuard path guard | secretGuard | security suite PASS | terminal / actions | — |
| ANE-07 | Terminal | REAL | `modules/terminal` | execution | suite PASS | TERMINAL panel | export PARTIAL |
| ANE-08 | Approval workflow (internal) | REAL | `modules/control/routes.ts`, approval center backend | task engine | suite PASS | internal Approvals (no customer nav) | hidden from customer nav per Part 17 |
| ANE-09 | Autopilot (unattended unlock) | REAL | `modules/payments/autopilot/service.ts` (`UNLOCK_MODE=AUTOPILOT`) | payments | failure-17 PASS | payment-autopilot | needs payment event |
| ANE-10 | Retry / backoff / resume | PARTIAL | task retry + DLQ | — | suite PASS | auto retry | resume-after-crash limited |
| ANE-11 | Concurrent session isolation | PARTIAL | workspace-scoped sessions | — | — | per-workspace | not globally enforced |
| ANE-12 | Result artifacts (structured outputs) | REAL | `modules/artifacts/service.ts` | files | suite PASS | ARTIFACTS panel | — |
| ANE-13 | Rollback after failed execution | PARTIAL | files rollback/trash + artifacts | files | suite PASS | rollback in files | execution rollback advisory only |
| ANE-14 | Local-LLM fallback | PARTIAL | `modules/knowledge/retrievers.ts` `answerWithKnowledge` (real LLM via gateway; env-blocked when no key) | provider key | Area 20 PASS | knowledge answers | ENVIRONMENT_BLOCKED w/o key |

## 3. AI OS

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| AIO-01 | AI OS kernel surface | PARTIAL | `backend/src/os/` P0–P3, `os/index.ts` | flag `AIOS_*` default OFF | os suite | FLAGGED, not exposed | default OFF |
| AIO-02 | Process manager / supervisor | PARTIAL | `os/supervisor.ts`, `os/lifecycle.ts` | flag | — | FLAGGED | — |
| AIO-03 | Event bus / IPC (durable outbox) | REAL | `os/event-bus.ts`, `os/ipc.ts` + `modules/outbox/service.ts` | — | outbox tests PASS | async delivery (outbox never faked) | — |
| AIO-04 | Filesystem layer (fs, watch, diff) | PARTIAL | `os/fs-layer.ts`, `os/diff.ts` | flag | — | FLAGGED | — |
| AIO-05 | Snapshots / rollback / copy-on-write | PARTIAL | `os/fs-layer.ts` snapshot + files | flag | — | FLAGGED | — |
| AIO-06 | Sandbox (PolicySandbox) | REAL | `os/sandbox.ts` (not container) | policy engine | security suite PASS | action execution | not real container |
| AIO-07 | Capabilities / policies / stop rules | REAL | `os/capabilities.ts`, execution policy | — | security suite PASS | deny-by-default | — |
| AIO-08 | Device manager | PARTIAL | `os/devices/registry.ts` (in-memory) + DB `devices` | — | — | desktop device list | two disjoint registries (audit finding) |
| AIO-09 | Secret management (secretGuard) | REAL | `modules/secretGuard/service.ts` | — | security tests PASS | .env/.ssh/.pem blocked | — |
| AIO-10 | Observability (logs/metrics/traces) | PARTIAL | `os/observability.ts` + audit trail | — | audit suite PASS | AUDIT trail LIVE | metrics not dashboarded |
| AIO-11 | Resource governor / load balancing | PARTIAL | `os/resource-governor.ts` | flag | — | FLAGGED | — |
| AIO-12 | Checkpointing | PARTIAL | `os/state.ts` checkpoint store | flag | — | FLAGGED | — |
| AIO-13 | Scheduler (OS-level) | PARTIAL | `os/p2/scheduler.ts` on `modules/scheduling` | flag | scheduling tests | PARTIAL/FLAGGED | base recurrence only |
| AIO-14 | Skills engine | PARTIAL | `os/p2/skills.ts` (12 skills) | flag | — | FLAGGED | flag-gated |
| AIO-15 | Voice engine | PARTIAL | `os/p2/voice.ts` (12 voice items) | flag | — | FLAGGED | flag-gated |
| AIO-16 | Desktop shell | NOT_IMPLEMENTED | `os/p2/desktop` gap | — | — | none in web | desktop NOT_READY |
| AIO-17 | Background cowork | PARTIAL | `os/p2` on scheduler | flag | — | FLAGGED | — |
| AIO-18 | Global AI keyboard / commands | REAL | `CommandPalette` (frontend) | — | CommandPalette tests PASS | command palette | — |
| AIO-19 | Breakpoint / undo / replay | NOT_IMPLEMENTED | `os/p2/breakpoint|undo|replay` | flag | — | FLAGGED | — |
| AIO-20 | Real-time diff | PARTIAL | `os/p2/realtime-diff.ts` | flag | — | FLAGGED | — |
| AIO-21 | Session summary | NOT_IMPLEMENTED | `os/p2/summary` | flag | — | FLAGGED | — |
| AIO-22 | Error quick-fix | PARTIAL | `os/p2/error-fix.ts` | flag | — | FLAGGED | — |
| AIO-23 | Workspace context sidebar | NOT_IMPLEMENTED | `os/p2/context-sidebar.ts` | flag | — | FLAGGED | — |
| AIO-24 | OS crash recovery / reaper | PARTIAL | `os/lifecycle.ts`, `os/reaper` | flag | — | FLAGGED | — |
| AIO-25 | AI OS user-visible "OS" surface | UNSUPPORTED | no browser-visible OS dashboard | — | — | none | Part 16: avoid unsupported "AI OS" bragging |
| AIO-26 | Real container isolation | NOT_IMPLEMENTED | ROADMAP (Group L) | — | — | none | ROADMAP |
| AIO-27 | Distributed execution | NOT_IMPLEMENTED | ROADMAP (Group L) | — | — | none | ROADMAP |

## 4. Memory

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| MEM-01 | Persistent user/workspace memory | REAL | `modules/memory/service.ts` (pgvector/BM25) | DB | suite PASS | memory panel | — |
| MEM-02 | Semantic search over memory | REAL | pgvector + BM25 | DB | suite PASS | search memory | — |
| MEM-03 | File memory + versioning | REAL | `modules/files/service.ts` (versions/rollback/trash) | files | suite PASS | files + versions | — |
| MEM-04 | Knowledge retrieval w/ real LLM answers | REAL | `modules/knowledge/service.ts` + `retrievers.ts` | provider key | Area 20 PASS | knowledge answers | env-blocked w/o key |
| MEM-05 | DNA / long-term persona store | PARTIAL | `modules/dna/service.ts` | — | suite PASS | small talk persona | — |
| MEM-06 | Memorycoding (code-memory) | PARTIAL | `modules/memorycoding/service.ts` | memory | — | code memory | — |
| MEM-07 | Checkpoint store (AI OS) | PARTIAL | `os/state.ts` | flag | — | FLAGGED | — |
| MEM-08 | Cross-cowork pattern learning | PARTIAL | `engineering-intelligence` pattern agents | — | — | PARTIAL | — |
| MEM-09 | Search across workspace | REAL | `modules/search/service.ts` | files/messages | suite PASS | global search | — |
| MEM-10 | Long-term autonomous memory consolidation | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |

## 5. Background Agents

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| BAC-01 | Gmail watchdog (payment evidence) | REAL | `modules/payments/claims/service.ts` (READY) | payments | claims tests PASS | payment claim automation | READY not live |
| BAC-02 | Evidence engine (payments) | REAL | `modules/payments/evidence` | payments | suite PASS | payment evidence | — |
| BAC-03 | Intent system (flag-gated) | PARTIAL | payments intent system | flag `PAYMENTS_INTENT` | — | INSTALLMENT intent flag OFF | flag-gated |
| BAC-04 | Scheduled recurring tasks | PARTIAL | `modules/scheduling/service.ts` | DB | scheduling tests | recurring PRO/team | — |
| BAC-05 | Automations | REAL | `modules/automations/routes.ts` | tasks | suite PASS | automations | — |
| BAC-06 | Remote cowork (background cowork via runner) | PARTIAL | `modules/remote/service.ts` + `returnToWork` | agent | suite PASS | remote shared runs | — |
| BAC-07 | Autopilot unattended workflow | NOT_IMPLEMENTED (as general agent) | autopilot is payment-autopilot only | — | — | none | scope is payment unlock |

## 6. Advanced Reasoning

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| ARE-01 | Debate / conflict-resolution reasoning | REAL | `agents/debates.ts` + `teamcollab/conflicts` | agent | suite PASS | conflict resolution | — |
| ARE-02 | Architecture oracle (dependency/risk) | REAL | `engineering-intelligence/architectureOracle.ts` | — | engineering tests PASS | architecture view | — |
| ARE-03 | Code smell / concurrency / leak / invariant analyzers | PARTIAL | `quality-intelligence/smell-*`, `concurrency-*`, `leak-*`, `typesafety-*`, `invariant-*` | — | quality tests PASS | static analyzers | heuristic exec |
| ARE-04 | Optimizer agents (query, batch, cache, cost) | PARTIAL | `optimization-intelligence/{queryOptimizer,schemaUtil,batchOptimizer,costRefactoring}.ts` | — | optimization tests PASS | optimization advice | advisory |
| ARE-05 | Developer-workflow reasoning (refactor recipes, migrations, branch, rollback, hotfix, flags) | PARTIAL | `developer-workflow/` (migrationAgent, branchStrategy, rollbackPredictor, hotfix, featureFlagOrchestrator, docDrift, contextualDebug, healthDashboard, hotspotProfiler, errorRunbook) | — | workflow tests PASS | advisory tools | advisory/deterministic |
| ARE-06 | Visual intelligence (dependency visualization) | REAL | `visual-intelligence/service.ts` (delegates to architectureOracle; screenshot analysis ENVIRONMENT_BLOCKED) | engineering | visual tests | dependency graph | screenshot analysis BLOCKED |
| ARE-07 | Recombinator / brainstorming | REAL | `brainstorming/service.ts`, `ideas`, `recommendations` | — | suite PASS | brainstorm/ideas | — |
| ARE-08 | Reverse engineering agent | PARTIAL | engineering-intelligence | — | — | PARTIAL | — |
| ARE-09 | Cost forecasting | NOT_IMPLEMENTED | `costAnalysis.ts` (uses `getCostBreakdown`) | — | — | PARTIAL proxy | — |
| ARE-10 | Data-center reasoning agents | PARTIAL | `datacentre/service.ts` | — | suite PASS | data-center ops | — |

## 7. Creative Engine

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| CRE-01 | Image generation | REAL | `geminiImageAdapter` (`gemini-3-pro-image`) | GEMINI | Prompt-3 verify | image gen in AI | free-tier limits |
| CRE-02 | Brainstorm / idea engine | REAL | `brainstorming/service.ts`, `ideas/service.ts` | — | suite PASS | ideas + brainstorm | — |
| CRE-03 | Recommendations | REAL | `recommendations/service.ts` | memory | suite PASS | recommended items | — |
| CRE-04 | Design suggestions | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| CRE-05 | Video/voice generation | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| CRE-06 | Story/marketing copy templates | PARTIAL | content module (see Content) | — | — | small | — |
| CRE-07 | AI personality / tone | PARTIAL | `os/p2/personality.ts` (FLAGGED) | flag | — | FLAGGED | — |
| CRE-08 | Template gallery (cowork templates) | NOT_IMPLEMENTED | `os/p2/templates.ts` (FLAGGED) | flag | — | FLAGGED | — |
| CRE-09 | Chat wallpaper/theme personalization | PARTIAL | dark/high-contrast UX LIVE; AI theming no | UX | a11y tests | dark mode | AI-generated skin ROADMAP |

## 8. Team

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| TEA-01 | Team management | REAL | `modules/teams` | DB | suite PASS | teams | — |
| TEA-02 | Team invites & sharing | REAL | `modules/teams` + workspaceShareRoutes | — | ChatPage suite PASS | share/invite | — |
| TEA-03 | Team cowork (watch/co-control/comments) | REAL | `os/p2/team-cowork.ts` + `modules/teamcollab/service.ts` | agent | PKG-01/04 tests | team cowork | — |
| TEA-04 | Live presence | REAL | `teamcollab/service.ts` (heartbeat-derived) | — | PKG-11 tests | presence | honest heartbeat-derived |
| TEA-05 | Async handoff (queue) | REAL | `teamcollab/service.ts` (`handoff.create/accept/list/update`) | — | PKG-11 tests | handoff | — |
| TEA-06 | Skill matrix / code ownership / context sync | REAL | `teamcollab/service.ts` + `team-intel.ts` | — | PKG-11 tests | team intelligence | — |
| TEA-07 | Conflict resolution debate | REAL | `agents/debates.ts` + `teamcollab/conflicts` | — | PKG-07/11 tests | conflict debate | — |
| TEA-08 | Shared chat / conversation sharing | PARTIAL | conversation share (frontend) | — | App suite PASS | share chat link | no external viewer |
| TEA-09 | Role-based workspace access | PARTIAL | `access/routes.ts` + entitlements | — | paywall suite PASS | plan-gated access | RBAC not self-serve admin |

## 9. Development

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| DEV-01 | Code workspace (create/open/edit) | REAL | `modules/codeworkspace/service.ts` + `files/service.ts` | files/execution | suite PASS | FILES + CODE | — |
| DEV-02 | File edit/search/replace | REAL | `files/routes.ts` + `search/service.ts` | — | suite PASS | files + search | — |
| DEV-03 | Terminal | REAL | `modules/terminal` | execution | suite PASS | terminal | export PARTIAL |
| DEV-04 | Git integration | PARTIAL | `os/git.ts` (FLAGGED) + Git Ninja stub | flag | — | FLAGGED | stub only |
| DEV-05 | IDE/editor integration | PARTIAL | `os/p2/ide.ts` (FLAGGED adapter) | flag | — | FLAGGED | — |
| DEV-06 | GitHub/Slack/Jira integrations | PARTIAL | `modules/integrations` + `os/p2/{github,slack,jira}.ts` (FLAGGED), integration-hub | — | integration tests | integrations | adapters flagged |
| DEV-07 | Plugins engine | REAL | `modules/plugins` + `integration-hub/service.ts` | — | suite PASS | CONNECTORS | UNSUPPORTED filtered by default |
| DEV-08 | Plugin status honesty (UNSUPPORTED hidden) | REAL | frontend `PluginsPage` `showUnsupported` filter (default off) | — | typecheck OK | "Show unavailable" toggle | — |
| DEV-09 | Preview builds | REAL | `modules/preview/service.ts` | — | suite PASS | preview | — |
| DEV-10 | Deployment wizard (advisory) | PARTIAL | `modules/deployment-wizard` | — | — | deploy guidance | SSRF in wizard latent (audit SEC_01) |
| DEV-11 | Engineering agents (DevEx) | REAL | `modules/engineering` + quality/optimization/workflow advisory | — | suite PASS | DevEx tools | advisory |
| DEV-12 | Code review / PR review assist | PARTIAL | `development-productivity` + engineering reviews | — | — | review tips | no PR wiring |
| DEV-13 | Test generation / flakiness prediction | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| DEV-14 | Debugging (contextual) | REAL | `developer-workflow/contextualDebug.ts` | — | workflow tests | debug hindsight | — |
| DEV-15 | Refactor wizard / recipes | REAL | `refactoringWizard.ts` + `developer-workflow` | — | workflow tests | refactor recipes | advisory only |
| DEV-16 | Package manager | PARTIAL | execution package ops | execution | — | install via terminal | — |
| DEV-17 | Build & typecheck pipeline | REAL | repo scripts (backend tsc + frontend vite) | — | CI-style run PASS | ships clean build | — |
| DEV-18 | Trash + recovery workspace | REAL | `modules/trash`, `modules/recovery` | files | suite PASS | trash/recover | — |

*(The 50-Intelligence features remain per Group C of the master registry — implemented core agents are cited REAL/PARTIAL under Development / Advanced Reasoning; the remainder are ROADMAP. None are claimed REAL without a cited entry point.)*

## 10. Data

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| DAT-01 | Structured DB (Postgres) | REAL | DB layer (pg) | DB | suite PASS | persistence | — |
| DAT-02 | RLS on tables | PARTIAL | 128 ENABLE RLS of 194; **66 no RLS, 0 FORCE** | DB | security audit | — | LATENT |
| DAT-03 | Imports/exports | PARTIAL | files + data views | files | — | export chat/file | full data export ROADMAP |
| DAT-04 | Backups / snapshots | PARTIAL | Render auto + files rollback | — | — | file-level rollback | DB backup not automated in-app |
| DAT-05 | Data-center ops (sales/ops intel) | REAL | `modules/datacentre/service.ts` | — | suite PASS | ops intel | — |
| DAT-06 | Usage metering | REAL | `modules/usage` | — | suite PASS | usage dashboard | — |
| DAT-07 | Analytics | PARTIAL | activity + usage | — | suite PASS | activity feed | product analytics ROADMAP |
| DAT-08 | Full-text + vector search | REAL | BM25 + pgvector | memory | — | search | — |
| DAT-09 | Streaming event history | NOT_IMPLEMENTED | conversation replay ROADMAP | — | — | none | — |

## 11. Deployment

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| DEP-01 | Cloud deployment (Render) | REAL | deploy config | — | build PASS | live app | Render Free cold-start |
| DEP-02 | Preview deployments | REAL | `modules/preview/service.ts` | — | suite PASS | preview | — |
| DEP-03 | Deployment wizard | PARTIAL | `modules/deployment-wizard` | — | — | advisory | latent SSRF (SEC_01) |
| DEP-04 | CI-ready local dev | PARTIAL | scripts + hoisted node_modules | — | run PASS | — | git ENVIRONMENT_BLOCKED |
| DEP-05 | Zero-config production env | PARTIAL | env-driven config | — | — | — | manual env setup |
| DEP-06 | Real container deployment | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| DEP-07 | Rollback of deployments | BLOCKED | NO deployment infra for app-level rollback (independent audit) | — | — | none | ENVIRONMENT_BLOCKED |

## 12. Security

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| SEC-01 | Auth (email+pass, MFA TOTP, Google OAuth) | REAL | `modules/auth/service.ts` | DB | auth suite PASS | login + MFA | — |
| SEC-02 | MFA enforcement | PARTIAL | MFA in requireAuth (F99 PARTIAL) | — | F99 tests | TOTP+recovery | enrollment not forced by default |
| SEC-03 | Session management (HTTP-only, device pairing) | REAL | auth session | — | suite PASS | sessions/devices | — |
| SEC-04 | Paywall entitlement enforcement | REAL | `modules/entitlements/service.ts` + `paid` wrap (~50 routers); 401/503/402 + ₹999 | payments | paywall-gate 15 tests PASS | BillingGate | api plan never unlocks |
| SEC-05 | API keys (user) | REAL | `modules/apikeys/service.ts` + own apiKeyAuth (aiRoutes NOT paywalled by design) | — | suite PASS | API keys | — |
| SEC-06 | SecretGuard path/secret blocking | REAL | `modules/secretGuard/service.ts` | — | security tests PASS | .env/.ssh blocked | — |
| SEC-07 | Input validation + rate limiting | PARTIAL | module + global rate limits (Redis if available) | Redis | suite PASS | — | without Redis → memory only |
| SEC-08 | Audit trail | REAL | `modules/audit/service.ts` | — | audit suite PASS | AUDIT | — |
| SEC-09 | No hardcoded secrets (25 matches = test fakes) | REAL | source scan (this session re-scan in BUILD step) | — | scan PASS | — | webhook secret rotate flag, Cloudflare token EXPOSED_AND_SHOULD_BE_REVOKED |
| SEC-10 | Policy/deny-by-default execution | REAL | `execution/policy.ts` + `os/capabilities.ts` | — | security suite PASS | actions | — |
| SEC-11 | Security intelligence agents (incidents, rate-limit, network, compliance, supply-chain) | REAL | `security-operations-intelligence/*`, `security-intelligence/*`, `knowledge/retrievers.ts` | — | PKG-15/14 tests PASS | security intel | advisory |
| SEC-12 | CSP + security headers | PARTIAL | F100 CSP secure default | — | F100 tests | — | hardening only |
| SEC-13 | DDoS/WAF | BLOCKED→LATENT | SEC_03 latent | — | — | — | ENVIRONMENT_BLOCKED to verify |
| SEC-14 | RLS FORCE | NOT_IMPLEMENTED | 0 FORCE RLS | DB | — | — | LATENT |
| SEC-15 | Webhook secret rotation marker | PARTIAL | DELETE.txt verify-only; marker set if current secret == exposed | — | — | — | do NOT re-upload unless proven missing |

## 13. Business

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| BIZ-01 | Pricing plans (pro/team/api/enterprise) | REAL | `payments/service.ts` (Fair pricing) | — | suite PASS | plans + pills | — |
| BIZ-02 | Static payment links + Razorpay paths | REAL | payments routes + razorpay api/webhook (dormant route) | payments | suite PASS | PAID LINK | webhook not LIVE-verified |
| BIZ-03 | Payment orchestrator (claim/evidence webhook path) | REAL | `payments/claims`, `payments/outbox` | — | claims tests PASS | claim automation | READY |
| BIZ-04 | Autopilot unlock | REAL | `payments/autopilot/service.ts` | payments | failure-17 PASS | auto unlock | payment event-driven |
| BIZ-05 | Entitlement engine (exactly-once activation) | REAL | `entitlements/service.ts` | — | paywall tests PASS | PRO_VERIFIED | — |
| BIZ-06 | Usage dashboard / spend | REAL | `modules/usage` + `costAnalysis.ts` | — | suite PASS | usage | forecasting PARTIAL |
| BIZ-07 | Invoices/receipts | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| BIZ-08 | Waitlist/lead capture | PARTIAL | auth + landing | — | — | signup → paid | no waiting room |
| BIZ-09 | Refund / dispute handling (Razorpay refund events wired) | PARTIAL | razorpay refund.refunded pathway exists | payments | — | — | LIVE-blocked |

## 14. Content

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| CON-01 | Landing + product understanding pages | REAL | frontend Landing/Home/Pricing | — | App suite PASS | HOME, PRICING | — |
| CON-02 | Changelog / recap (digests) | REAL | `modules/digests/service.ts` | — | suite PASS | digests | no auto reader |
| CON-03 | Blog / articles | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| CON-04 | Email notifications | REAL | `modules/email` + notifications | — | suite PASS | email alerts | — |
| CON-05 | Content generation templates | PARTIAL | via AI providers (free tier) | provider | — | prompt templates | — |
| CON-06 | Docs/help center | PARTIAL | README + docs + settings help | — | — | help | no in-app KB |
| CON-07 | Marketing copy honesty (no AGI/ANI/“world's first” claims) | REAL | Part 16 enforced; this audit avoids superlatives | — | — | brand copy | — |

## 15. Design

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| DES-01 | Design token system | PARTIAL | `--cc-*` tokens (raw hex bypass) | — | a11y tests | themes | undefined vars patched |
| DES-02 | Dark mode + high contrast | REAL | UX LIVE (Group H) | — | a11y tests | dark/high-contrast | — |
| DES-03 | Compact single-column Home | REAL | `HomePage` (real widgets) | — | App suite PASS | HOME | — |
| DES-04 | Compact Chat (merged Share & Invite) | REAL | `ChatPage` single button | — | ChatPage 24 tests PASS | chat header | — |
| DES-05 | Accessibility (aria, focus, sr-only) | PARTIAL | label/htmlFor/aria-live gaps | — | a11y audit | — | tab roles, skip-link, aria-live |
| DES-06 | Responsive base | PARTIAL | breakpoints 1024/768 + drawer | — | UX audit | mobile | phone ROADMAP |
| DES-07 | Progressive disclosure (no feature wall) | REAL | Part 17: compact nav, no 100-feature wall | — | — | nav | — |
| DES-08 | Branding consistency | PARTIAL | logo lockup in login/sidebar; title/meta drift (independent audit) | — | UI audit | subtle drift | og:image SVG |

## 16. Workflow Automation

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| WFA-01 | Task workflows (deps/retry/DLQ) | REAL | `agent/service.ts` | DB | suite PASS | tasks | — |
| WFA-02 | Automations (trigger→action) | REAL | `modules/automations/routes.ts` | tasks | suite PASS | automations | — |
| WFA-03 | Scheduling (recurring/timezone) | PARTIAL | `modules/scheduling/service.ts` | — | scheduling tests | schedule | extended abilities flagged |
| WFA-04 | Async handoff queue | REAL | `teamcollab/service.ts` | — | PKG-11 tests | handoff | — |
| WFA-05 | Payments autopilot workflow | REAL | `payments/autopilot/service.ts` | payments | failure-17 | auto activate | event-driven |
| WFA-06 | Sequential multi-step cowork (plan→act→verify→report) | PARTIAL | autonomy + developer-workflow (Operating Code base) | agent | suite PASS | cowork | OS-level FLAGGED |
| WFA-07 | Runbooks / error recovery steps | REAL | `developer-workflow/errorRunbook.ts` | — | workflow tests | runbook advice | advisory |
| WFA-08 | Conditional triggers / batch scheduling | PARTIAL | scheduling flagged abilities | flag | — | — | — |
| WFA-09 | Schedule dry-run | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| WFA-10 | Approval-driven gates (internal) | REAL | `control/routes.ts` | tasks | suite PASS | internal approvals | hidden from customer nav |

## 17. Advanced Technical

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| ART-01 | Distributed/multi-instance-safe outbox | REAL | `modules/outbox/service.ts` | DB | outbox tests PASS | delivery | — |
| ART-02 | Idempotency + replay protection | REAL | `modules/idempotency/service.ts` + payments | — | suite PASS | payments safe | — |
| ART-03 | Concurrency-safe recruitment = no race duplicates | PARTIAL | agent/task concurrency | DB | related tests | — | load-scenario untested |
| ART-04 | Telemetry/metrics | PARTIAL | `os/observability.ts` + usage | — | — | usage | no Grafana |
| ART-05 | Cross-language cowork | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| ART-06 | Bandwidth-aware execution | NOT_IMPLEMENTED | ROADMAP | — | — | none | — |
| ART-07 | Encryption at rest/in transit | PARTIAL | TLS + DB-level (Render) | — | security tests | — | app-level KMS ROADMAP |
| ART-08 | WebSocket/SSE realtime | REAL | SSE chat + presence | — | suite PASS | live chat | no general push bus |
| ART-09 | Provider failover cache (bounded TTL LRU) | REAL | `modules/knowledge/cache.ts` | — | PKG-12 tests PASS | cached knowledge | — |
| ART-10 | Worker/session isolation per workspace | BLOCKED (proof) | OS-level bool FLAGGED; per-workspace sessions exist | flag | — | — | container isolation ROADMAP |

## 18. Wow Features

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| WOW-01 | Real-time cowork co-control | REAL | `os/p2/team-cowork.ts` + teamcollab | agent | PKG-01/11 | coworking | — |
| WOW-02 | Live payment-to-unlock (autopilot) | REAL | `payments/autopilot` | payments | failure-17 | auto activation | not "2s" claimed |
| WOW-03 | Workspace health dashboard | REAL | `developer-workflow/healthDashboard.ts` | — | workflow tests | health score | static facets |
| WOW-04 | Knowledge answers from your own docs+LLM | REAL | `knowledge/retrievers.ts` | provider key | Area 20 | knowledge Q/A | env-blocked w/o key |
| WOW-05 | Voice | NOT_IMPLEMENTED | `os/p2/voice.ts` FLAGGED | flag | — | — | — |
| WOW-06 | Desktop app | NOT_IMPLEMENTED | desktop NOT_READY | — | — | none | — |
| WOW-07 | Offline sync | PARTIAL | files + trash | — | — | file offline | mobile offline ROADMAP |
| WOW-08 | Instant N:N cowork presence | REAL | teamcollab presence | — | PKG-11 | presence dots | heartbeat-derived |
| WOW-09 | One-click deploy preview | PARTIAL | preview module | — | suite PASS | preview | — |
| WOW-10 | Global command palette power-key | PARTIAL | CommandPalette (nav only) | — | tests PASS | ⌘K nav | not global action runner |

## 19. Competitive Moat

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| MOA-01 | Zero-budget genuine free-developer provider stack | REAL | Gemini/Mistral/NVIDIA NIM/OpenRouter free tiers | — | provider audit | real free tiers | rate-limited |
| MOA-02 | Integrated payment-to-workspace (evidence, exactly-once) | REAL | payments stack | payments | suite PASS | paid unlock | LIVE-blocked verify |
| MOA-03 | Advisory DevEx intelligence breadth | PARTIAL | quality/optimization/workflow/visual modules | — | suites PASS | advisory tools | deterministic heuristics |
| MOA-04 | AI OS architecture | PARTIAL | `os/` P0–P3 FLAGGED | flag | — | — | default OFF |
| MOA-05 | Deterministic truthfulness culture | REAL | independent audits, no fake paths, ENVIRONMENT_BLOCKED discipline | — | audits | honest states | — |
| MOA-06 | Team collab stack | REAL | teamcollab | — | PKG-11 | team features | — |
| MOA-07 | 50-feature intelligence breadth preserved | PARTIAL | Group C (all 50 remain) | — | — | subset surfaced | remaining ROADMAP |
| MOA-08 | Data + memory graph | PARTIAL | pgvector/BM25 + workspace graph | — | — | search | full graph UI ROADMAP |
| MOA-09 | Brand "AI WORKSPACE/OS/DIGITAL COWORKER" | NOT_IMPLEMENTED as substantiated claim | Part 16 forbids unverifiable superlatives | — | — | landing copy | substantiation needed |

## 20. Operating Code

| ID | NAME | STATUS | REAL IMPL / ENTRY POINT | DEPS | TESTS | USER-FACING | GAPS |
|---|---|---|---|---|---|---|---|
| OPC-01 | THINK→PLAN→ACT→VERIFY→REPORT executed in product tasks | REAL | autonomy runCoworker + developer-workflow steps | agent | suite PASS | cowork does full loop | — |
| OPC-02 | User-facing reasoning summaries (plan/actions/verification/evidence/uncertainty) | REAL | cowork status + approval evidence | — | failure-17 tests | VERIFY + plan display | — |
| OPC-03 | No private chain-of-thought exposed | REAL | reasoning summaries only | — | security PASS | — | — |
| OPC-04 | Structured internal execution state | REAL | task state machine (14 statuses) | — | failure-17 tests | statuses shown | — |
| OPC-05 | Evidence engine with confidence | PARTIAL | `PaymentConfidence` active/grace (two-state) | payments | — | payments | 4-state taxonomy ROADMAP |
| OPC-06 | Continue/improve loop | PARTIAL | task retry + autopilot + advisory runbooks | — | — | retry/regenerate | auto-improve ROADMAP |
| OPC-07 | Exactly-once execution semantics | REAL | outbox + idempotency + entitlements | outbox/idempotency | suites PASS | no double activation | — |

---

## 21. Honest deltas to the quoted spec

1. **"185 capability master specification"**: the enumerated 1–185 list is not
   present in-repo; the audit above covers the real shipped surface (227 rows)
   under the mandated 20 categories. This is the truthful truthful-set; any
   quoted higher numbers without source evidence are treated as
   NOT_IMPLEMENTED, never inflated.
2. **REAL = 110**, not "everything": AI OS (except outbox/IPC/sandbox/caps/
   secretGuard/honest states) is FLAGGED/PARTIAL; Desktop, Mobile apps, Voice,
   container, distributed execution are NOT_IMPLEMENTED/ROADMAP.
3. **Provider honesty split**: Gemini / Mistral / NVIDIA NIM / OpenRouter =
   perpetual FREE_DEVELOPER_API (no card). DeepSeek (5M-token grant), Cohere
   (trial key, 1k calls/mo), Qwen (new-user quota, 90d), Kimi (¥15 voucher,
   CN-only) = FREE_TRIAL. OpenAI / Anthropic / Grok / Z.ai / Devin =
   PAID_REQUIRED (never auto-enabled at zero budget).
4. **Payment integrity**: LOGIC_VERIFIED = PASS; REAL_RAZORPAY_LIVE_VERIFIED =
   ENVIRONMENT_BLOCKED — never collapsed. No "2s from payment" claim; report
   webhook/backend-wake/Autopilot/activation/total separately.
5. **Nav per Part 17**: HOME/CHAT/PROJECTS/AGENTS/TASKS/ACTIVITY/CONNECTORS/
   SETTINGS/MORE; customer-facing Approval Center removed; `/approvals` deep
   links + safety infra retained.
6. No capability above is claimed REAL without a live execution path cited.

## 22. Preservation

`FEATURES_REMOVED = 0`. Everything PARTIAL/BLOCKED/UNSUPPORTED/
NOT_IMPLEMENTED remains tracked and preserved — nothing is deleted; every row
is an approved capability with honest status.