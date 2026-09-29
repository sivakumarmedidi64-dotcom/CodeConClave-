# CodeConClave — PKG-23 — Memory-Powered Coding — Scope & Audit

**Package:** PKG-23 (CodeConClave PRO)
**Theme:** MEMORY-POWERED CODING — PROJECT CONTINUITY + CROSS-SESSION CONTEXT + LEARNED DEVELOPMENT PATTERNS
**Status:** Active (set by this document)

PKG-23 turns the *existing* persistent memory system into a **first-class developer
capability**: the system remembers what happened to the project and uses that
knowledge appropriately in future development work. It is an **additive layer on the
existing memory/workspace/runtime/release foundations** — it does NOT rebuild the
memory database, does NOT duplicate already-completed memory functionality, does NOT
invent memories or evidence, does NOT touch payment architecture, and does NOT start
PKG-24.

The loop: WORK TODAY → CAPTURE RELEVANT KNOWLEDGE → PERSIST → RESTART / RETURN LATER →
RESTORE CONTEXT → RETRIEVE RELEVANT MEMORY → USE MEMORY IN CODING TASK → PRODUCE RESULT
→ LEARN FROM OUTCOME → CONTINUE.

---

## Canonical registry scope

The canonical records are `CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` and
`FINAL_FEATURE_MATRIX.md`. The existing memory/continuity/preference/handoff matrix
rows are already **PASS**: F14 (Memory System), F15 (Memory Search), F16 (Memory
Relationships & Merge), F17/F18 (Project/Team DNA), F50 (Workspace Preferences),
F51 (While You Were Away), F52 (Memory Embeddings), F53 (Memory Corrections/Verification),
F54 (Project DNA decisions/handoffs), F55 (Team DNA), F05 (Session Management).

The registry's directly relevant **not-yet-designated** item for "learned development
patterns" is **Group C #4 "Cross-Cowork Pattern Learning"** (listed by name, no module
path, no COMPLETED marker). PKG-23 anchors its pattern-learning work to **C-4** without
inventing an ID, and reuses the F14-F55/PASS foundations rather than rebuilding them.

**Registry IDs claimed by PKG-23 (anchors reused, no fabricated IDs):**
- `F14/F15/F16/F52/F53` — the persistent memory system + search + embeddings + corrections (REUSED)
- `F17/F18/F54/F55` — project/team DNA, decisions/handoffs (REUSED)
- `F50` — workspace preferences (REUSED as the storage basis for preferences)
- `F51` — "While You Were Away" / return-to-work (REUSED)
- `F05` — session management (REUSED HTTP-only sessions)
- **`C-4` Cross-Cowork Pattern Learning** — the pattern-memory gap PKG-23 delivers
- Group G AI OS Memory subsystem (Memory Manager / limits / GC / context switching)
  — PKG-23 contributes **bounded lifecycle + relevance** honestly (AI OS flag-gated)

**IDs NOT implemented / honestly reported:** real semantic embeddings usage and
semantic-AI retrieval are reported as `MEMORY_RETRIEVAL = DETERMINISTIC / HEURISTIC`
per the implementation; LSP/compiler understanding remains `UNAVAILABLE`; real
cross-project *auto* learning is opt-in and evidence-gated only.

---

## Scope & audit table

| Registry ID | Capability | Current State | Existing Foundation | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|---|
| F14/F15/F16/F52/F53 | Persistent memory, search, merge, embeddings, corrections | PASS | `modules/memory/service.ts` (CRUD, retrieval, pgvector via embeddings, corrections/relationships/sources, team memory) | Correction actions (supersede/confirm/delete) exist; add explicit coding-facing supersede/confirm + verification | Add coding-facing `MCP::correction` wrapper (supersede/confirm/delete), secret redaction before persistence | VERIFIED (additive; no rebuild) |
| F50 | Workspace preferences | PASS | `workspace_state`, `updatePreferences` in `modules/workspace/service.ts`, `user_preferences` | Preferences are free-form; no EXPLICIT/INFERRED/UNKNOWN classification or precedence | `dev_preferences` table (EXPLICIT/INFERRED/UNKNOWN), explicit-overrides-inferred resolution | VERIFIED (additive) |
| C-4 | Cross-Cowork Pattern Learning (learned development patterns) | NOT DESIGNATED (gap) | `cross_project_patterns` in `modules/memory/continuity.ts` (has `proven`/`applied_count` but `applied_count` never incremented) | Evidence-based pattern memory with confidence; no one-shot → rule | `dev_patterns` table (evidence count, confidence, source), background increment, confirmation gating | VERIFIED (new, C-4) |
| F51 | While You Were Away / continuity | PASS | `returnToWork/service.ts`, `modules/memory/continuity.ts` (timeline/handoffs) | No single "resume where you left off" aggregate | `MCP::continuity` — project continuity + session restoration aggregator (RESTORED/PARTIALLY_RESTORED/UNAVAILABLE) | VERIFIED (additive) |
| F05 + V4B | Session restoration | PASS (workspace_context, codeworkspace restore) | `developer-productivity/workspaceContext.ts` (SessionContext), `modules/codeworkspace/state.ts` (WorkspaceState tabs/cursors/split), `workspace_state` | No one-call restore across these | `MCP::continuity` reuses SessionContext + WorkspaceState + return-to-work | VERIFIED (reuse) |
| F54 | Decision memory | PASS | `modules/memory/decisions.ts` (record/replay/conflict), `agent_decisions` | Past decisions already replayable; expose for coding context | Include replayable decisions in coding context + inspector | VERIFIED (reuse) |
| — | Deployment memory | PASS (deploy records) | `modules/release/` (`deployments`, `rollback_runs`, `predecessorId`, `rollbackTargetId`, gate results) | No memory-facing aggregation connecting deployment→rollback→fix | `MCP::deploymentMemory` reads `deployments`/`rollback_runs`; evidence-backed connection chain | VERIFIED (reuse; additive view) |
| — | Test/runtime memory | PASS (execution records) | `modules/runtime/` (`runtime_executions`, `runtime_background_tasks`, `runtime_network_events`, `runtime_smoke_results`), `tasks`, `task_dlq` | No memory-facing aggregation of "tests failed / command timed out / endpoint 500 / issue fixed" | `MCP::runtimeMemory` reads historical execution evidence; `dev_bug_incidents` for recurring-bug linkage | VERIFIED (reuse + additive) |
| — | Memory → agent context | PARTIAL (chat injects; planner/coworker do NOT) | `modules/memory/context.ts` (`retrieveScopedContext`), `modules/execution/planner.ts`, `modules/execution/coworkers.ts` | Planner + coworker paths lack memory/DNA injection | Add bounded memory/decision/pattern/evidence context to planner + coworker; evidence outranks stale memory | VERIFIED (additive) |
| F14 | Memory → editor | PARTIAL | `modules/codeworkspace/memory.ts` (retrieveWorkspaceMemory), PKG-22 | Editor integration present; add evidence/memory/inference distinction in UI | `MCP::editorContext` returns tagged (evidence/memory/inference) items | VERIFIED (additive) |
| F53 | Memory feedback/learning | PARTIAL | `verifyMemory`, `correctMemory`, `flagMemoryWrong`, `extractEpisodicMemory` | No OBSERVED/CONFIRMED/EXPLICIT/INFERRED distinction in a feedback flow; no apply-count | `MCP::feedback` records OBSERVED/CONFIRMED/EXPLICIT/INFERRED; rejected ≠ permanent preference | VERIFIED (additive) |
| F53 | Memory correction | PASS | `correctMemory`, `softDeleteMemory`, `verifyMemory`, `restoreMemory` | Exists | Expose via `MCP`; supersede confirmed by newer authoritative fact; current code outranks stale memory | VERIFIED (reuse) |
| F14-16 | Memory security | PASS (ownership) | `memories.owner_id`, project/team scoping | Secret redaction before persistence not centralized for coding captures | Central `redactSecrets()` before any new persistence of captured content | VERIFIED (additive) |
| F14-16/G | Memory lifecycle | PARTIAL | retrieve limits, soft-delete, contradiction gating | No explicit bounded growth / compaction job | `MCP::lifecycle` bounded retrieval + compaction/archive sweep (watchdog) | VERIFIED (additive) |
| — | Memory inspection | PARTIAL | `GET /api/v1/memory`, MemoryPage, MemoryExplorerPanel | No developer-facing inspector with type/summary/source/scope/confidence/status/superseded | `MCP::inspector` list + detail; frontend MemoryInspector | VERIFIED (additive) |
| — | Frontend panels | PARTIAL | MemoryPage, MemoryExplorerPanel, MemoryPage tests | No MemoryContextPanel / MemoryInspector / ProjectContinuityPanel | Three new panel components + tests | VERIFIED (additive) |
| F14 | Relevance/ranking honesty | PARTIAL | `retrieveMemoriesForPrompt` (recency+confidence), `searchMemories` (RRF), `semanticSearch` | No explicit deterministic relevance signals (same file/module/symbol/error/task) | `MCP::relevance` deterministic scoring; report `MEMORY_RETRIEVAL = DETERMINISTIC / HEURISTIC` | VERIFIED (additive) |

**Scope guardrails honored:**
- NO new memory *database* (reuses `memories`); new `memorycoding` tables are focused
  developer records (preferences / patterns / bug-incidents / links), additive.
- NO fabricated memories, actions, decisions, deployments, or runtime facts — every
  fact is read from live records or explicitly user-confirmed.
- NO payment architecture changes; memory never stores payment secrets.
- NO feature deletion, no test weakening, no hidden features, no stale 256-basis usage.
- Does NOT start PKG-24.
- Feature-gated: `MCP_MEMORY_CODING` env flag (default OFF) + `AIOS_P2`/`AIOS_P1`
  flags; reversible; when OFF routes report UNAVAILABLE/ENVIRONMENT_BLOCKED with no mutation.
