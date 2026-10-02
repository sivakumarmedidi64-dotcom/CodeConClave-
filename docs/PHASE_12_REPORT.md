# PHASE 12 — Workspace Continuity: Persist/Restore, Multi-Device Reconciliation, "While You Were Away", Thinking Moon Upgrade + Free Limit Moon (Report)

## Status
COMPLETE. Real workspace continuity end-to-end: the workspace now restores
exactly where you left off on any device (current project, conversation,
chat mode, model, terminal session, chat scroll position), multi-device
conflicts are detected and reconciled deterministically server-side
(both devices lose nothing), and Home opens with a server-generated
"While You Were Away" summary — a real evidence-based absence digest
(completed/failed tasks, pending approvals, modified files, coworker runs,
memory/DNA updates, project activity, unread notifications) generated at
most once per configured frequency (daily/weekly/off, threshold configurable)
with a deterministic text always, an AI narrative only when a provider is
actually configured, and server-authoritative read/dismiss. The Thinking
Moon gained streaming-phase intensity, tab-hidden animation pause and a
proper status label; the separate Free Limit Moon is a new overlay that
appears only on a real server-reported free-limit transition (`SSE
limit_reached {showMoon:true}`), is persisted server-side (never replayed
on refresh) and includes real upgrade actions. Multi-device safety is
tested honestly: reconcile/restore/merge unit tests drive the real SQL
contract and real JSON payloads. Backend 671/671, shared 63/63, frontend
143/143, all typechecks and both production builds green. See Validation
and Blockers.

## Files created
- `database/migrations/0033_phase12_continuity.sql` — `return_to_work_summaries`
  table: id (`rtw_` prefix), owner_id (FK users, CASCADE), generated_at,
  absence_start/end, project_id (FK projects, SET NULL), frequency,
  completed/failed/pending_approval/modified_file/discovery/memory_update/
  dna_update/project_activity/unread_notification counts, evidence jsonb,
  summary_text, ai_generated, read/read_at, dismissed/dismissed_at,
  created_at; index (owner_id, generated_at DESC); RLS policy
  `USING (owner_id = app.uid())`.
- `backend/src/modules/returnToWork/service.ts` — the WYWA module:
  - `getReturnToWorkConfig`/`updateReturnToWorkConfig` — user preference
    `return_to_work` (`{frequency, thresholdHours, projectScope}`), defaults
    daily / 6h / no scope; threshold validated 1–168h; frequency whitelist.
  - `collectEvidence` — real tenant-scoped queries (completed tasks with
    attempt counts, FAILED/TIMED_OUT tasks with recovery_status, approvals
    pending review, `file_versions` count, coworker runs, memories, dna
    blocks, project activity, unread notifications, running task), optionally
    restricted to a configured project (`project_id = $3`).
  - `deterministicText` — stable summary line; `summarizeText` — AI narrative
    ONLY when `configuredProviders().length > 0` and `completeWithFallback`
    succeeds, with an evidence-only system prompt; failures fall back to
    deterministic text and `ai_generated=false` (never fabricated).
  - `generateReturnToWorkSummary` — one INSERT + re-SELECT, no side effects;
    `getReturnToWork` — `off` → no summary; absence (anchored at max of
    last_active and the latest summary's generated_at) below threshold →
    serve existing summary without regenerating; within frequency cap →
    `recent_summary`; otherwise generate.
  - `markReturnToWorkRead` / `dismissReturnToWork` — server-authoritative;
    dismissed summaries are never served again.
- `backend/src/foundation/return-to-work-12.test.ts` — 23 tests: deterministic
  merge (server wins scalars/arrays, client-only keys adopted, nested
  recursion, dropped-path reporting), reconcile (happy path, base-version
  conflict → merged write + both-device-lossless assertion driven by a real
  INSERT echo), restore, config validation, and the full WYWA surface
  (daily/weekly caps, off, threshold, evidence queries incl. project scope,
  read, dismiss, AI fallback + narrative, deterministic text).
- `frontend/src/components/FreeLimitMoon.tsx` — overlay dialog
  (`role="dialog"`, aria-modal): ~1s dim that returns to normal brightness,
   120px crescent, "Continue with Pro" (navigates to Settings) / "Maybe
   Later", Esc + focus management, signed-in name, reduced-motion fade-only
   variant; on mount it persists the display moment via
   `PUT /workspace/state/free_limit_moon {shownAt, date}` (best-effort).
- `frontend/src/components/FreeLimitMoon.test.tsx` — 5 tests: dialog
  semantics, server persistence (date format), focus + Escape, both buttons.
- `frontend/src/pages/HomePage.test.tsx` — rebuilt for the new API shape
  (7 tests: nothing-new, WYWA card counts + real-action buttons, expand +
  mark-read, dismiss + server call, continuity strip, error/retry).

## Files modified
- `shared/src/constants.ts` — `WorkspaceStateKey.LAST_ACTIVE = 'last_active'`,
  `FREE_LIMIT_MOON = 'free_limit_moon'`.
- `shared/src/contracts.ts` — `workspaceReconcileSchema`,
  `workspaceRestoreEntrySchema`, `workspaceRestoreSchema`,
  `returnToWorkConfigSchema` (+ exported types).
- `backend/src/shared/ids.ts` — `PREFIX.return_to_work = 'rtw'`.
- `backend/src/modules/workspace/service.ts` — `mergeWorkspaceValues`
  (deterministic: server wins scalars and arrays, client-only keys adopted,
  nested objects merged recursively, dropped paths reported), the public
  `reconcileWorkspaceState` (matching baseVersion → direct set; mismatch →
  merge + write + report `{entry, reconciled, dropped, currentVersion}`) and
  `restoreWorkspaceState` (bulk restore returning `{applied, conflicts}`);
  removed the old placeholder `returnToWorkSummary`; `contextIndicator`
  now reports real `relevantFiles` for the last active project.
- `backend/src/modules/workspace/routes.ts` — `POST /state/reconcile`,
  `POST /state/restore`, `GET /return-to-work` (new `{summary, eligibility}`
  shape), `GET|PUT /return-to-work/config`, `POST /return-to-work/:id/read`,
  `POST /return-to-work/:id/dismiss`.
- `backend/src/modules/conversations/routes.ts` — SSE `limit_reached` now
  carries the server-decided `{showMoon: true}` payload.
- `backend/src/foundation/continuity.test.ts` — updated for the new shape
  (9 tests green).
- `frontend/src/lib/sse.ts` — `limit_reached` data typed `{showMoon: boolean}`.
- `frontend/src/lib/types.ts` — `ReturnToWorkConfig`, `RecommendedAction`,
  `ReturnToWorkSummary`, `ReturnToWorkResponse`.
- `frontend/src/components/ThinkingMoon.tsx` — `streaming` prop (reduced
  intensity class once deltas flow), default label "CodeConClave is
  thinking", animation pause while the tab is hidden (visibilitychange),
  sr-only status preserved, reduced-motion static fallback.
- `frontend/src/styles/global.css` — thinking-moon 3D float keyframes
  (`rotateY(14deg)` + translateY), `--streaming`/`--paused` variants,
  free-limit overlay/card/moon styles + dim/appear keyframes + reduced-motion
  rules, continuity strip + WYWA card styles.
- `frontend/src/pages/ChatPage.tsx` — thinking phase state machine
  (`idle → thinking → streaming`), FreeLimitMoon mounted only on
  `limit_reached` with `showMoon:true` (Continue with Pro → `/settings`),
  conversation scroll position persisted (`conversation_scroll`, debounced
  500ms) and restored on reload (initial restore only, then bottom).
- `frontend/src/pages/TerminalPage.tsx` — active terminal session persisted
  (`terminal_tabs {activeId}`) and restored on mount.
- `frontend/src/pages/HomePage.tsx` — WYWA card gated on a non-dismissed
  server summary, count chips, real-action buttons (Review approvals →
  `/approvals`, Inspect failed tasks → `/work`), View Summary (marks read
  server-side) / Dismiss (server-side, card gone), continuity strip fed by
  `GET /workspace/context` (project, relevant files, memory, DNA).
- `frontend/src/App.tsx` — presence heartbeat: `PUT /workspace/state/
  last_active {at}` every 60s while the tab is visible (drives the absence
  window; client-only, server stays authoritative).
- `frontend/src/pages/ChatPage.test.tsx` — SSE `limit_reached` moon
  on/off tests + scroll-restore test (mock streamChat + scrollTo stubs).
- `frontend/src/components/ThinkingMoon.test.tsx` — new label + streaming +
  hidden/resume tests.
- `frontend/src/pages/TerminalPage.test.tsx` — restore-across-reload test.

## Validation
- `backend`: `npx vitest run` — 671/671 (39 files; continuity 9, new
  return-to-work-12 23); `npm run typecheck` clean.
- `shared`: `npm test` — 63/63; `npm run build` clean (backend consumes the
  rebuilt dist).
- `frontend`: `npm run typecheck` clean; `npm run build` (vite) clean;
  `npm test` — 143/143 (28 files).
- Honesty rules enforced: summary evidence is always real queried data, the
  AI narrative only exists when a provider is configured (tested with a
  fallback), the Free Limit Moon only mounts on a real server transition
  (tested both `showMoon` true/false), dismissed summaries are never shown,
  state writes stay side-effect free, and merge/reconcile behavior is
  asserted through the real SQL contract and real payloads.

## External blockers
- PostgreSQL runtime still unavailable in this environment: migration 0033
  is static-only (DDL + RLS) and unexercised against a live database.
- No live AI provider credentials: the AI narrative path is covered by
  contract tests; production will fall back to deterministic text exactly as
  designed.
- A live browser smoke run against real Postgres remains pending until the
  database is available.

## Next phase
- Phase 13 must not be started without instruction. Candidate follow-ups
  when instructed: live E2E once Postgres is available, and remaining
  continuity surfaces (e.g., auto-save of in-progress chat drafts, terminal
  tab set persistence) if desired.
