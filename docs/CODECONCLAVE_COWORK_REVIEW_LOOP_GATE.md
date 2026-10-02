# CodeConClave — Cowork Safety Review Loop (B1)

## Architecture

The review loop is a **server-authoritative, user-gated safety layer** over the
existing cowork execution pipeline. It reuses every canonical OS primitive
(StateStore, EventBus, Supervisor, ResourceGovernor, StopRules, GitFacade,
SandboxExecutor) without creating parallel systems.

```
AI execution (existing cowork)
  → patch/diff generation (modules/reviews/diff.ts, os/diff.ts)
    → review API (modules/reviews/{service,routes}.ts)
      → user decides hunks (accept/reject per hunk or all)
        → safe apply via uploadFile (modules/files/service.ts)
          → run tests via PolicySandboxExecutor
            → optional undo (reversible operation)
              → optional git commit (GitFacade + GitEngine, no push)
```

## Data Flow

1. **Create review** — POST `/api/v1/reviews` with taskId, files[]. Each file
   includes `path`, `baseContent`, `proposedContent`. The server snapshots both,
   computes the diff via `diffLines` (os/diff.ts), splits hunks with 3-line
   context, and persists everything in `cowork_reviews`, `cowork_review_files`,
   `cowork_review_hunks`.

2. **Read review** — GET `/api/v1/reviews/:id` returns the full review with
   hunks in hunk_order. GET `/api/v1/reviews/:id/status` returns summary only.

3. **Decide hunks** — POST `/api/v1/reviews/:id/hunks/:hunkId/accept` or
   `.../reject`. Bulk: `accept-all` or `reject-all`. Each decision re-computes
   the review status.

4. **Apply** — POST `/api/v1/reviews/:id/apply`. Applies accepted hunks to
   workspace files via `uploadFile`. Stale-workspace files (hash mismatch)
   fail closed with FAILED status.

5. **Run tests** — POST `/api/v1/reviews/:id/run-tests`. Executes the test
   command through `PolicySandboxExecutor` in a materialized worktree.

6. **Undo** — POST `/api/v1/reviews/:id/undo`. Restores applied files from
   base content if the workspace hasn't diverged.

7. **Commit** — POST `/api/v1/reviews/:id/commit`. Requires a message, runs
   through `GitFacade.init/addAll` then `GitEngine.commit`. No push.

8. **Cancel** — POST `/api/v1/reviews/:id/cancel`. Terminal state.

## Security Chain

Every mutating endpoint passes:
- `requireAuth` middleware (session cookie)
- `requireReview` (ownership check via `owner_id`)
- Per-file path canonicalization through `canonicalize()` (os/p2/stop-rules.ts)
  which rejects traversal, absolute paths outside root, and null bytes
- StopRules evaluation with feature provider `'stop_rules'` (enforced, not
  advisory)
- ResourceGovernor slot acquisition where applicable
- Hash-based staleness detection: base_sha256 must match workspace file

## State Machine

```
Review:  DRAFT → READY_FOR_REVIEW → PARTIALLY_REVIEWED → APPLIED
           → TESTING → TEST_PASSED | TEST_FAILED → COMMITTED | UNDONE
         Any active state → FAILED | CANCELLED

Hunk:    PENDING → ACCEPTED | REJECTED
         ACCEPTED → APPLIED | FAILED | INVALIDATED
         Any → (on stale conflict) → INVALIDATED
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/reviews | Create review |
| GET | /api/v1/reviews?projectId=X | List reviews |
| GET | /api/v1/reviews/:id | Get review with hunks |
| GET | /api/v1/reviews/:id/status | Get status summary |
| POST | /api/v1/reviews/:id/hunks/accept-all | Accept all hunks |
| POST | /api/v1/reviews/:id/hunks/reject-all | Reject all hunks |
| POST | /api/v1/reviews/:id/hunks/:hunkId/accept | Accept one hunk |
| POST | /api/v1/reviews/:id/hunks/:hunkId/reject | Reject one hunk |
| POST | /api/v1/reviews/:id/apply | Apply accepted hunks |
| POST | /api/v1/reviews/:id/run-tests | Run sandboxed tests |
| POST | /api/v1/reviews/:id/undo | Undo applied changes |
| POST | /api/v1/reviews/:id/commit | Commit via git facade |
| POST | /api/v1/reviews/:id/cancel | Cancel review |

## Frontend Flow

- `/reviews` — ReviewListPage: project selector, review cards with status/progress
- `/reviews/:id` — ReviewDetailPage: hunks with diff, accept/reject buttons,
  accept-all/reject-all, apply, run tests, undo (double-click confirm),
  commit (message required), cancel

All states are server-read. No client-side optimism.

## Git Behavior

- `GitFacade.init(worktree)` creates a private per-review worktree
- `GitFacade.addAll(worktree)` stages all changes
- `GitEngine.commit(message)` produces the commit, returns hash from
  `[branch hash] message` output
- No push, no auto-merge, no auto-commit
- Git is disabled by default (`AIOS_GIT_ENABLED=false`)

## Test Behavior

Tests run only after successful apply. The test command executes through
`PolicySandboxExecutor` with the project's configured `allowedCommands`.
The sandbox enforces timeout and command allow-list. The result includes
exit code, stdout/stderr, duration, and timedOut flag.

## Undo Semantics

- Requires the review to be in APPLIED/TESTING/TEST_PASSED/TEST_FAILED
- Verifies current workspace hash matches applied_sha256 for each file
- If workspace has diverged (external edits), undo is refused
- Only restores changes attributable to this review (base content)
- Preserves unrelated user changes by targeting individual files

## Failure Modes

- **Stale workspace**: If workspace file hash differs from base_sha256 at
  apply time, the review is marked FAILED and no files are modified.
- **Partial apply failure**: The review records which hunks succeeded and
  which failed. `applyError` field captures the error.
- **Test failure**: Review moves to TEST_FAILED. Commit is blocked.
- **Git disabled**: Commit returns `aios_git_denied`. Review stays at
  TEST_PASSED. User can still undo.
- **Undo divergence**: If applied files have been externally modified,
  undo returns `review_diverged`.
- **Protected path**: StopRules deny writes to `.git/`, `node_modules/`.
- **Empty base (new file)**: Review handles new-file creation correctly;
  apply copies proposed content byte-exact.

## Limitations

- The review frontend does not yet appear in the sidebar navigation (routes
  are wired but no sidebar entry was added to avoid modifying 25+ sidebar items)
- The review list requires `?project=` query parameter or auto-selects the
  first project
- Git commit is limited to single-review scope (no multi-review squash)
- Test execution requires `AIOS_SANDBOX_ALLOWED_COMMANDS` to include the
  test command (default is empty → tests fail closed unless configured)

## Verification Results

```
BACKEND SUITE:   120 files, 2136 passed, 3 skipped (baseline: 116/2087/3)
REVIEW SUITE:    4 tests (diff 14 + service 18 + runtime 14 + routes 3 + perf 4 = 53)
FRONTEND SUITE:  54 files, 307 passed, 1 pre-existing flaky (baseline: 52/298)
FEATURES_REMOVED: 0
NO_TESTS_WEAKENED: true
```

The 1 frontend failure is a pre-existing timer-dependent test in an existing
suite, not in the new review tests. All 9 review frontend tests pass.
