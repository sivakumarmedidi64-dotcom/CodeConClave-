# PHASE 6 — Memory + DNA + Real Retrieval + Provenance (Report)

## Status
COMPLETE. The real persistent memory system (EPISODIC/SEMANTIC/PROCEDURAL/
PROJECT/TEAM with source labels, confidence, contradiction enforcement),
Project DNA with versioning/conflicts/team branches, REAL embeddings (never
fabricated vectors), memory search (FULL_TEXT / VECTOR / HYBRID with honest
degradation), provenance (append-only corrections trail + change summaries),
wrong-memory handling, relationships, chat integration (scoped memory + DNA
context), Context Inspector wiring, migration 0028, and the Phase 6 test suite
are implemented and validated. All 553 pre-existing tests still pass; 44 new
Phase 6 tests were added (597 total). Nothing is claimed as production-ready;
see PostgreSQL runtime + External blockers.

## Files created
- `database/migrations/0028_phase6_memory_dna.sql` — static-only migration (see Database migrations).
- `backend/src/modules/ai/embeddings.ts` — `EmbeddingProvider` interface + OpenAI `text-embedding-3-small` (1536 dims), `getEmbeddingProvider()` (null without a key — honest), `embedText`, `isVectorValid` dimension validation, `resetEmbeddingProvider` test hook.
- `backend/src/modules/memory/context.ts` — `retrieveScopedContext(userId, {projectId, memoryLimit, dnaLimit})` combining confidence-gated memory + MAIN DNA for the chat pipeline.
- `backend/src/modules/dna/team.ts` — team DNA service: `saveTeamDna`, `getTeamDna` (membership-scoped), `listTeamDna`, `updateTeamDna`, `createTeamBranch`, `mergeTeamBranches` (conflict detection), `resolveTeamDnaConflict`, `teamDnaVersions`. Permissions: any member edits/branches; owner/admin merges + resolves.
- `backend/src/foundation/memory-6.test.ts` — 27 Phase 6 memory tests.
- `backend/src/foundation/dna-6.test.ts` — 17 Phase 6 DNA/team DNA tests.
- `docs/PHASE_6_REPORT.md` — this report.

## Files modified
- `shared/src/constants.ts` — `MemoryEmbeddingStatus` (NONE/QUEUED/FAILED/READY), `MemoryVerificationState` (UNVERIFIED/VERIFIED/REJECTED), `MemoryScope` (PERSONAL/PROJECT/TEAM), `MemoryRelation` (supports/contradicts/derived_from/supersedes/source_of), `MemorySearchMode` (VECTOR/FULL_TEXT/HYBRID), `TeamDnaStatus`, `TeamDnaConflictState`; new audit codes (`memory.corrected`, `memory.merged`, `memory.relationship_added`, `memory.verified`, `memory.rejected`, `memory.embedded`, `dna.team_created`, `dna.team_branch_created`, `dna.team_merged`, `dna.team_conflict_resolved`).
- `shared/src/domain/models.ts` — `Memory` gains optional `embeddingStatus`, `embeddingModel`, `verificationState`, `scope`.
- `shared/src/contracts.ts` — `memorySearchSchema` (mode/filters/limit), `memoryCorrectionSchema`, `memoryMergeSchema`, `memoryRelationshipSchema`, `teamDnaSchema`.
- `backend/src/modules/memory/service.ts` — `ensureEmbedding` (QUEUED → embed → READY with model+dimensions / FAILED, never a fake vector; wired into `createMemory`), `processEmbeddingQueue` (bounded background batch), `searchMemories` (VECTOR/FULL_TEXT/HYBRID + RRF fusion, owner-scoped, current-project default, type/confidence/verification/contradiction filters, honest `modeUsed`), `correctMemory`, `mergeMemories` (supersedes + never erases), `verifyMemory`, `addMemoryRelationship`/`listMemoryRelationships`, `recordMemoryCorrection` (append-only trail also written by flag_wrong/edit/delete/restore paths); `toMemoryJson` now emits the Phase 6 fields. All pre-existing exported functions keep their exact SQL/params (memory.test.ts unchanged and green).
- `backend/src/modules/memory/routes.ts` — `POST /search` (mode + filters, returns `modeUsed`), `POST /merge`, `POST /relationships`, `POST /queue/process`, `POST /:id/correct`, `POST /:id/verify`, `GET /:id/relationships`.
- `backend/src/modules/dna/service.ts` — `retrieveDnaForPrompt` (MAIN, non-conflicting, labeled), `autoSaveTaskDna` (fire-and-forget, internally caught), `updateDna` now accepts `changeSummary` (written to the block + the version snapshot).
- `backend/src/modules/dna/routes.ts` — team endpoints (`GET/POST /team...`, branch, merge, conflicts/resolve, versions) registered before `/:id`; `PATCH /:id` accepts `changeSummary`.
- `backend/src/modules/teams/service.ts` — `teamRoleFor(userId, teamId)` → owner/admin/member/null.
- `backend/src/modules/execution/orchestrator.ts` — after `setTaskStatus(task.id, 'COMPLETED')`, a fire-and-forget `autoSaveTaskDna` persists a PROJECT_CONTEXT block (never blocks or fails the task).
- `backend/src/modules/conversations/chat.ts` — `buildMessages` now uses `retrieveScopedContext` (memory + DNA blocks labeled "context only; verify before relying").
- `backend/src/modules/workspace/service.ts` — `contextIndicator` now reports `dnaVersion` (max version) and `memorySourceRefs` (distinct provenance count) alongside memoryCount/dnaCount (safe: workspace tests use `toMatchObject`).
- `backend/src/foundation/ai-gateway-5.test.ts` — added a mock for `../modules/memory/context.js` (retrieveScopedContext → empty context); chat tests unchanged otherwise and green.

## Real embeddings
- `getEmbeddingProvider()` returns NULL without an API key — the system never invents vectors. When configured it uses OpenAI `text-embedding-3-small` (1536 dimensions) and **rejects any response whose dimension count differs** (dimension validation is enforced in the provider AND via `isVectorValid` before any vector touches pgvector).
- Every memory creation runs `ensureEmbedding`: provider available → embed now and store `embedding = $1::vector, embedding_status = 'READY', embedding_model, embedding_dimensions`; no provider → `QUEUED` (honest backlog); provider failure → `FAILED` (never a fake vector). `processEmbeddingQueue` drains QUEUED rows in a bounded batch (`LIMIT`, default 20) and records successes/failures independently.
- Migration 0028 adds the status columns and an HNSW vector index (`vector_cosine_ops`, `WHERE embedding IS NOT NULL`) so the index only covers rows that actually have a vector.

## Memory search (real retrieval)
- `searchMemories(userId, {query, mode, projectId, searchAll, type, minConfidence, verification, contradiction, limit})` is always owner-scoped; default scope is CURRENT PROJECT ONLY (`project_id IS NULL` when no project is given, mirroring the existing list semantics). `searchAll` widens to project OR team memories.
- VECTOR: pgvector cosine (`embedding <=> $n::vector`) over READY rows. FULL_TEXT: Postgres FTS (`to_tsvector('simple', content) @@ plainto_tsquery('simple', $n)`) — always available. HYBRID: vector + FTS fused by reciprocal-rank fusion (k = 60), taking the top `limit`.
- Honest degradation: with no provider, VECTOR and HYBRID fall back to FULL_TEXT and the result reports `modeUsed` so the caller knows exactly which path ran. No fabricated scores, no fake vectors.
- Filters map to SQL conditions (`type`, `confidence >=`, `verification_state`, `contradiction_state`).

## Provenance + wrong memory
- `memory_corrections` is an append-only log (kind FLAG_WRONG/EDIT/MERGE/DELETE/RESTORE) written by `correctMemory`, `mergeMemories`, and the existing `flagMemoryWrong`/`updateMemory`/`softDeleteMemory`/`restoreMemory` paths — history is never rewritten.
- `flagMemoryWrong` / `correctMemory` mark the memory CONFIRMED + confidence 0 + verification REJECTED, create a USER_STATED correction memory linked by a `contradicts`/`supersedes` relationship, and audit the action. Merges supersede the target (`superseded_by_id`, `verification_state = 'REJECTED'`, `supersedes` relationship) without erasing it. Verification can be flipped explicitly via `verifyMemory` (VERIFIED/REJECTED with audit).
- DNA mutations carry `change_summary` (block + version snapshot), so every version has a recorded reason; `autoSaveTaskDna` records the completed-task DNA with the outcome.

## Relationships
- `addMemoryRelationship` validates both endpoints, stores `relation` (supports/contradicts/derived_from/supersedes/source_of) with a clamped weight, and audits; `listMemoryRelationships` returns both directions of a memory's graph.

## DNA + versioning
- Personal DNA keeps its exact existing behavior (saveDna/updateDna/mergeBranches/conflicts — all dna.test.ts assertions intact). Added: prompt-safe `retrieveDnaForPrompt` (MAIN only, conflicts excluded), `change_summary` on updates (appended as separate params so existing SQL assertions hold), and `autoSaveTaskDna` hooked into the orchestrator after task COMPLETED (fire-and-forget; a failed DNA write can never fail a completed task).

## Team DNA
- `team_dna` / `team_dna_versions` / `team_dna_conflicts` with RLS scoping to team members (never globally visible). Roles: any member can create/edit MAIN blocks and create branches (EDITOR); owner/admin only can merge branches into MAIN and resolve conflicts. Conflict detection mirrors personal DNA (base moved on → both versions preserved, conflict row raised, explicit resolution required). Merge marks the branch MERGED with a snapshot + change summary + audit.

## Chat integration + Context Inspector
- Chat fast path now loads scoped context: project memory (confidence-gated, source-labeled) + MAIN DNA blocks, both framed as "context only; verify before relying". The ai-gateway chat test mock was extended for the new context module.
- `contextIndicator` (workspace) now exposes `dnaVersion` and `memorySourceRefs` alongside `memoryLoaded/memoryCount/dnaCount` — the Context Inspector signal for memory + DNA presence (frontend has no contextIndicator usage yet; wiring is backend-side as specified).

## Database migrations
- `0028_phase6_memory_dna.sql` (static): `memories` += `tenant_id` (backfilled from `app.uid()`, defaulted), `embedding_status` (CHECK NONE/QUEUED/FAILED/READY), `embedding_model`, `embedding_dimensions`, `verification_state` (CHECK UNVERIFIED/VERIFIED/REJECTED), `scope` (CHECK PERSONAL/PROJECT/TEAM, backfilled by team/project presence), `source_message_id`, `source_file_id`, `task_id`; HNSW index on embedding + GIN FTS index on content; `memory_corrections` table; `change_summary` on `dna`/`dna_versions`; `team_dna`, `team_dna_versions`, `team_dna_conflicts` + RLS policies.
- IMPORTANT: PostgreSQL runtime is NOT available in this environment. The migration is validated for SQL syntax only and was never applied. Do not claim runtime migration success.

## Tests
- `backend/src/foundation/memory-6.test.ts` (27): provider honesty, dimension validation, ensureEmbedding QUEUED/FAILED/READY (+ no fake vector ever), queue batch (+ failures don't abort), FULL_TEXT scoping/filters/searchAll, VECTOR pgvector SQL + honest degradation, HYBRID RRF fusion + degradation, correctMemory/flagMemoryWrong/mergeMemories/verifyMemory provenance, relationships, scoped chat context, JSON contract fields.
- `backend/src/foundation/dna-6.test.ts` (17): teamRoleFor roles, team DNA save/membership scoping/refusals/list/versions, branch creation, merge permission denial for members, clean owner merge, conflict preservation + resolution, prompt-safe retrieval, autoSaveTaskDna success + never-throws, change_summary on edits (with and without version bump).

## Validation
- shared: typecheck PASS, build PASS, 46/46 tests.
- local-agent: typecheck PASS, 49/49 tests.
- backend: typecheck PASS, build PASS, 440/440 tests (396 pre-existing + 44 new).
- frontend: typecheck PASS, build PASS, 62/62 tests.
- Total: 597/597.

## Blockers
- PostgreSQL runtime unavailable — migration 0028 was static-validated only; runtime migration, index performance, and RLS behavior are unverified.
- No real provider API keys — embedding tests mock the provider; in production without a key, memories stay QUEUED and search degrades honestly to FULL_TEXT.
- No lint scripts configured in any workspace — typecheck + build are the enforced gates.
- HYBRID search and HNSW recall are implemented per the spec (RRF fusion, cosine index) but were not benchmarked against a live database.