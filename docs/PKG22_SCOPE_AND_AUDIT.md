# PKG-22 — ADVANCED CODE WORKSPACE — Scope & Audit

**Theme:** EDITOR + CODE NAVIGATION + MULTI-FILE DEVELOPMENT + REFACTORING
**Status:** SCOPE CONFIRMED (this document) → GATE (`docs/CODECONCLAVE_PKG22_GATE.md`)

---

## 1. Registry coverage — exact IDs (NOT invented)

PKG-22 does not invent registry IDs. The canonical registry
(`CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md`) and `FINAL_FEATURE_MATRIX.md`
have **no** named feature or numbered ID for: a code editor, a file-explorer
panel, symbol navigation (go-to-definition / find-references / outline), code
(grep) search, multi-file editing (tabs / split panes), diagnostics navigation,
a diff viewer, or a refactoring tool. Those concerns were absent from the
canonical registry (the closest entries are FLAGGED/ROADMAP and were not
implemented as a workspace).

PKG-22 therefore reuses the existing anchors that genuinely overlap, and
declares the genuinely new workspace layer with a text label — no fabricated ID.

| Registry ID | Capability | Current State | Existing Foundation | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|---|
| F19 / F20 (Matrix) | File Mgmt + Versioning & Rollback | PASS/LIVE | `modules/files` (`/api/v1/files`) | upload-store, no in-place code editing/reading on disk | read/write workspace-root code files with version awareness | VERIFIED (workspace layer) |
| Group A — Search | Search | LIVE | `modules/search` (`/api/v1/search`) | global multi-type search, not project-disk grep | project-wide + current-file content search over workspace root | VERIFIED (workspace layer) |
| F34 / F90 (Matrix) | Terminal + Local Terminal Execution | PASS/LIVE | `modules/runtime` (`/api/v1/runtime`) | commands only; no file I/O on the workspace root | reuse `projectWorkspaceRoot`/`assertProjectAccess` as the workspace boundary | VERIFIED (reused) |
| Group B — Smart File Picker | file picker | FLAGGED | not mounted | FLAGGED | multi-file open/tabs/recent/restore in workspace | PARTIAL (workspace layer) |
| Group B — Workspace Context Sidebar | context sidebar | FLAGGED | not mounted | FLAGGED | bounded AI editor context + memory | PARTIAL (workspace layer) |
| Group B — Real-Time Diff | diff viewer | FLAGGED | `os/diff.ts` (canonical) | flagged | reuse canonical diff for workspace review | VERIFIED (reused) |
| Group C #6 Code Smell Agent | quality findings | COMPLETED (PKG-14) | `modules/quality-intelligence` | findings not navigable from editor | surface per-file findings -> clickable line nav | VERIFIED (reused) |
| Group C #20 Cost-Aware Refactoring | optimization | COMPLETED (PKG-16) | `modules/optimization-intelligence` | not wired into editor | surface as advisory diagnostics | PARTIAL (reused) |
| Group C #28 Refactoring Recipes / F98 | refactoring | listed/V4F | `engineering-intelligence/refactoringWizard.ts` (not mounted) | operates on upload-store, unmounted, brittle diff gen | **NEW** safe symbol-rename refactor over workspace root with PLAN->PREVIEW->DIFF->REVIEW->APPLY and honest BLOCKED | PARTIAL (workspace layer) |
| Group C #5 Workspace Graph Query | symbol/reference lookups | PARTIAL | `engineering-intelligence/codeSearchOracle.ts` | upload-store, unmounted, not disk | **NEW** HEURISTIC symbol scanner over workspace root (outline/def/ref/imports) | HEURISTIC |
| B1 review loop | review authority | PASS/LIVE | `modules/reviews` | server-authoritative hunks over upload-store | reuse hunk semantics for workspace review (canonical diff), no parallel authority | VERIFIED (reused) |
| Git Integration (Group B) | git history | PARTIAL (`os/git.ts`) | review `commit` via runtime git engine | no workspace file history | honest Git availability check; `GIT_HISTORY=UNAVAILABLE` when no repo | UNAVAILABLE / ENVIRONMENT_BLOCKED |
| **NEW (no fabricated ID)** | Advanced Code Workspace (`modules/workspace/*`) | — | none (no editor exists) | full gap | multi-file workspace, navigation, search, symbols, safe edit + review, safe rename, diagnostics, memory, AI context, cross-file, persistence | PARTIAL→VERIFIED per capability |

### Registry summary (mirrors PKG-19/20/21 convention)

- `REGISTRY_IDS_COMPLETED` (reused): F19/F20, Group A Search, F34/F90, B1 review loop, Group C #6, #20, `os/diff.ts`.
- `REGISTRY_IDS_PARTIAL`: Group B Smart File Picker, Workspace Context Sidebar, Real-Time Diff, Group C #5/#28, Git Integration.
- `REGISTRY_IDS_BLOCKED`: none.
- `REGISTRY_IDS_NOT_IMPLEMENTED`: none (no fake IDs).
- `REGISTRY_IDS_NEW` (honest, no fabricated ID): `workspace` module adds the Advanced Code Workspace layer (editor state, workspace-root file read/write with version awareness, content search, HEURISTIC symbols, reviewed edits, safe rename, diagnostics navigation, memory, AI context, cross-file detection, persistence) not previously present as a real workspace.

---

## 2. Editor audit (actual measured state)

| Concern | State | Notes |
|---|---|---|
| File tree | PARTIAL | `FilesPage.tsx` tree + `/api/v1/files/tree` (upload-store). No disk-workspace tree. |
| File opening | MISSING | No in-app code editor. |
| Tabs | MISSING | No tab model. |
| Multiple open files | MISSING | No multi-file state. |
| Split panes | MISSING | No split editor. |
| Syntax highlighting | MISSING | No Monaco/CodeMirror/highlighter in any package.json. |
| Line numbers | MISSING | — |
| Folding | MISSING | — |
| Bracket matching | MISSING | — |
| Indentation | MISSING | no editor |
| Undo/redo | MISSING | no editor (files service has version rollback on upload-store only) |
| Save behavior | PARTIAL | upload overwrite→new version on upload-store; no in-editor save |
| Unsaved-state indication | MISSING | — |
| Keyboard navigation | UNAVAILABLE | Command Palette exists (F82) but not tied to a workspace |
| Search (project-wide) | PARTIAL | `modules/search` global multi-type; no disk grep |
| Symbol navigation | UNAVAILABLE | `codeSearchOracle` unmounted and upload-store scoped; no editor |
| Diagnostics | PARTIAL | quality/security/optimization panels exist but unmounted/not navigable to code |
| Diff viewer | PARTIAL | canonical `os/diff.ts` + B1 hunks exist server-side; no editor diff UI |
| B1 hunk review | PARTIAL | `ReviewDetailPage.tsx` + `/api/v1/reviews` exist; not connected to an editor |
| History | PARTIAL | files versions + review commit via runtime git; no workspace file history |
| File versioning | PARTIAL | upload-store versioning; not for edited code files |
| Large-file behavior | PARTIAL | quality security caps 2MiB; no workspace read cap |
| Error states | PARTIAL | AppError/ErrorBoundary exist |

**Bottom line:** the backend intelligence/review/diff foundations are strong and
reusable, but there is **no code editor and no multi-file workspace anywhere**.
PKG-22 builds the workspace layer (the real gap) on top of those foundations.

---

## 3. Architecture

New backend module `backend/src/modules/codeworkspace/` (the path `/api/v1/workspace`
is already taken by the existing pre-existing workspace state/preferences module,
so the code workspace is mounted at `/api/v1/codeworkspace`).

- `security.ts` — workspace-root confinement (reuse runtime `projectWorkspaceRoot`
  + `assertProjectAccess`), path-traversal protection, protected-path blocking,
  binary/large-file safeguards.
- `fs.ts` — tree/list/read/write of workspace-root files (version-aware:
  client-supplied base sha256 must match to avoid silently overwriting user work).
- `state.ts` — persisted multi-file workspace state (tabs, pinned, active,
  order, split, restored cursor, recent, last-session) in `workspaces` /
  `workspace_tabs` tables.
- `search.ts` — project-wide + current-file content search: regex, case,
  context lines, ranking, limits, cancellation, caching. No unbounded memory.
- `symbols.ts` — HEURISTIC regex scanner: outline, go-to-definition (file:line),
  find-references, import relations, related files. Never claims LSP/compiler.
- `edit.ts` — safe edit pipeline: proposed(new content) → canonical diff →
  review (accept/reject hunks) → apply (version-conflict safe) → record
  `workspace_edits`. No silent overwrite; reviewed multi-file changes.
- `refactor.ts` — safe rename symbol (project-scoped via references) with
  PLAN→PREVIEW→DIFF→REVIEW→APPLY→RESULT; BLOCKED when not safely derivable.
- `diagnostics.ts` — aggregate existing quality/security/optimization findings,
  clickable -> file:line; honest HEURISTIC + provenance.
- `memory.ts` — workspace-scoped, permission-aware memory recall/context
  (reuse memory service), non-destructive.
- `context.ts` — bounded AI editor context (active file + nearby + related +
  diagnostics, capped), respects token/resource limits.
- `git.ts` — honest Git availability check; never fabricates history; when a
  `.git` is absent → `GIT_HISTORY = UNAVAILABLE`.
- `routes.ts`, `index.ts` — mounted at `/api/v1/workspace`.

New tables (migration `0064_workspace_editor.sql`): `workspaces`,
`workspace_tabs`, `workspace_edits`, `workspace_reviews`.

Frontend: new `CodeWorkspace.tsx` + `FileExplorer`, `EditorTabs`, `SplitEditor`,
`SymbolOutline`, `SearchPanel`, `DiagnosticsPanel`, `DiffPanel` (thin, reusing
existing panels where they exist), wired into a `CodeWorkspacePage`. Uses
existing `lib/api.ts` fetch layer. 6 frontend tests.

---

## 4. Honest capability states

- **Editor / multi-file / tab state / split / restore** — VERIFIED (persisted,
  tested). No syntax highlighting/LSP (honest NO — no Monaco/CodeMirror added;
  plain code display with line numbers).
- **Search** — VERIFIED (content search, regex, case, context, limits,
  cancellation, caching). No unbounded memory.
- **Symbol intelligence** — HEURISTIC (regex-based; never claimed as compiler/LSP).
- **Refactoring** — PARTIAL (safe rename only, PLAN→PREVIEW→DIFF→REVIEW→APPLY;
  other operations REPORT BLOCKED/unavailable).
- **Diagnostics** — PARTIAL (aggregates existing analyzers, HEURISTIC,
  navigable).
- **Diff / B1 integration** — VERIFIED (reuses canonical diff + B1 hunk
  semantics; no parallel authority).
- **Memory integration** — PARTIAL (workspace-scoped, non-destructive).
- **Cross-file intelligence** — PARTIAL (import/usage evidence only).
- **Git history** — UNAVAILABLE/ENVIRONMENT_BLOCKED (honest; never fabricated).
- **Performance** — PARTIAL (lazy reads, bounded search, cancellation, caches;
  measured by tests, no overstated targets).
- **Persistence** — PARTIAL (workspace tab/state persisted; per-user + per-project).

---

## 5. Test plan (30 cases)

open/close/reopen file, multi-tab, split, unsaved, save, undo/redo, conflict,
project search, regex search, symbol nav, diagnostics nav, safe rename,
refactor preview, refactor rejection, multi-file diff, B1 integration,
cross-file detection, memory isolation, user isolation, workspace isolation,
large-search cancellation, large-file protection, invalid access, path
traversal, Git-unavailable honesty, provider-unavailable honesty, no auto
source modification, state persistence. Plus regression.

## 6. Constraints honored

- Reuse (not rebuild) PKG-19 runtime boundary, PKG-20 env safety, PKG-21
  deployment history, payment architecture, existing search/review/intelligence.
- NO feature deletion, NO test weakening, NO fake capabilities, NO stale
  256-feature basis, NO payment rework. `PAYMENT_REGRESSION` must PASS.
