# PHASE 13 — Real Ideas Workspace + Brainstorming Foundation, Unified History, Data Centre Enhancement, Cleanup Recommendations, Gain Trash, Unified Activity Feed (Report)

## Status
COMPLETE. The Ideas workspace is now real: full idea CRUD with statuses,
priorities, tags, categories, assignment (with notifications), voting,
comments, archive/restore and trash — scoped by owner, project membership or
ACTIVE team membership. The Brainstorming foundation creates sessions,
manages host/participants (invites notified), captures proposals as real
ideas with `brainstorm://` provenance, and generates ideas ONLY through the
AI gateway: providers checked, raw model text parsed and validated against a
strict zod schema, and only then persisted — `ai_unavailable`/`ai_generation_invalid`
are honest, nothing is ever trusted as state directly from model output.
History is a read-only union of the four authorized persisted event sources
(audit_logs + project/file/team activity) with keyword/source/action/actor/
date/starred filters, detail view and persistent stars. The Data Centre now
reports real entity counts, retention, an honest backup state, and cleanup
recommendations that are regenerated deterministically and NEVER applied
automatically (explicit resolve/dismiss only). The unified Gain Trash shows
all six soft-delete systems in one list with the shared 30-day window,
single/bulk restore, and permanent delete that refuses `dependency_conflict`
while anything still references the item (files via the existing
`permanentDeleteFile`, ideas cascade votes/comments by design). The activity
feed (Home/project/team scopes) aggregates existing event tables with
read-time deduplication — no duplicate event rows are ever written. Global
search finds ideas; assignments and invites reuse Phase 4A delivery.
Backend 752/752, frontend 166/166, shared unchanged-but-rebuilt, all
typechecks and both production builds green. Migrations 0034/0035 are
static-only — see Blockers.

## Files created
- `database/migrations/0034_phase13_ideas_brainstorm.sql` — `ideas`
  (id `ide_`, owner_id FK users, team_id/project_id nullable FKs, title,
  description, tags text[], category, priority CHECK, status CHECK,
  assignee_id FK users, archived, deleted_at, vote_count/comment_count
  defaults, ai_generated, provenance, references jsonb, timestamps +
  `set_updated_at()`), `idea_votes` (UNIQUE (idea_id, user_id)), `idea_comments`,
  `brainstorming_sessions`, `brainstorming_participants` (UNIQUE
  (session_id, user_id)), `brainstorming_ideas` (UNIQUE (session_id,
  idea_id)); indexes on status/priority/assignee/owner + voting; RLS
  `app.uid()` policies; FKs CASCADE so votes/comments die with the idea.
- `database/migrations/0035_phase13_cleanup_history.sql` — `cleanup_recommendations`
  (id `cln_`, owner_id, candidate_type, reason, storage_impact_bytes,
  affected jsonb, reversible, authorization_level, status, created_at,
  resolved_at) and `history_stars` (owner_id, source, event_id, created_at,
  UNIQUE (owner_id, source, event_id)) with RLS.
- `backend/src/modules/ideas/service.ts` + `routes.ts` — list with filters
  (q/status/priority/category/tag/project/team/assignee/archived/trashed),
  create (project/team authz via `requireProjectRole`/`requireTeamRole`),
  get/update, vote (idempotent toggle + counter), comments
  (add/list/delete-own), archive, trash, restore; `IDEA_TENANT_SQL`
  (owner OR project member OR ACTIVE team member) applied on every read;
  `notifyAssignee` + `idea.assigned` audit; every mutation audited.
- `backend/src/modules/brainstorming/service.ts` + `routes.ts` — sessions
  (create/list/detail/complete/archive), participants (host-only invites,
  `brainstorm.invite` notification), capture (real idea, provenance
  `brainstorm://<session>`), `generateIdeas` (configuredProviders gate →
  `completeWithFallback` → fence-stripping JSON.parse → zod
  `generatedIdeaSchema` → per-idea create with provenance
  `brainstorm://<session>/ai`, count capped; failures throw
  `ai_unavailable`/`ai_generation_invalid` and persist nothing).
- `backend/src/modules/history/service.ts` + `routes.ts` — union builder
  with globally unique placeholders, per-source authz (self audit,
  member projects, ACTIVE team members), filters incl. `starred`
  (EXISTS history_stars), sort asc/desc, detail with per-source
  authorization, `POST/DELETE /:source/:eventId/star`.
- `backend/src/modules/recommendations/service.ts` + `routes.ts` — five
  candidate classes derived from real tenant queries (stale trashed files,
  duplicate-content files via EXISTS, stale conversations, superseded
  memories, conflicted DNA, stale ideas, expired notifications, obsolete
  artifacts, orphaned file versions), deterministic regeneration (DELETE
  ACTIVE + reinsert, idempotent), list/resolve/dismiss (`cleanup.resolved`
  audit); nothing is ever auto-applied.
- `backend/src/modules/trash/service.ts` + `routes.ts` — unified 30-day
  union across files/projects/conversations/memories/dna/ideas with
  best-effort `deleted_by` lookup, `expiresAt` computed, restore/bulk
  restore dispatching to the existing per-module restores, purge/bulk purge
  with `assertNoLiveReferences` (`dependency_conflict`, tasks/files/
  conversations/memories for projects; messages for conversations; sources/
  relationships for memories; versions/conflicts for DNA; votes/comments
  cascade for ideas; files through the existing `permanentDeleteFile`),
  `purgeExpired` reusing the file sweep and skipping blocked items.
- `backend/src/modules/activity/service.ts` + `routes.ts` — home/project/
  team scopes over already-persisted event tables only; read-time dedup by
  `action|resource_id|createdAt ms`; authorization via
  `requireProjectRole`/`requireTeamRole`; `invalid_scope` guard.
- Backend tests (all DB-mocked, gateway-mocked): `ideas-13.test.ts` (20),
  `brainstorming-13.test.ts` (15), `history-13.test.ts` (10),
  `recommendations-13.test.ts` (6), `trash-13.test.ts` (9),
  `activity-13.test.ts` (8), `search-idea-13.test.ts` (5), `datacentre-13.test.ts` (8) — 81 tests covering tenant isolation, permission
  edges, idempotent votes, schema-fail/invalid-JSON/no-provider AI paths,
  reference checks, dedup, star lifecycle and honest backup/recommendation
  reporting.
- Frontend pages rebuilt/created: `IdeasPage.tsx` (Ideas + Brainstorm tabs:
  create/edit/status/priority/assign/vote/comments/archive/trash with
  confirm, session lifecycle, capture, AI generate with honest
  `ai_unavailable`), `HistoryPage.tsx` (timeline, source/action/actor/date/
  starred filters, star toggle, detail), `TrashPage.tsx` (unified tabs with
  counts, single/bulk restore, permanent delete confirmations, purge
  expired), `DataPage.tsx` (entity counts, retention, honest backup, cleanup
  recommendations with explicit resolve/dismiss + rescan, activity feed).
- Frontend tests: rebuilt `IdeasPage.test.tsx` (9) and `HistoryPage.test.tsx`
  (6), new `TrashPage.test.tsx` (7) and `DataPage.test.tsx` (4), plus new
  activity-feed/ideas-route tests in `HomePage.test.tsx` and `Topbar.test.tsx`.
- `docs/PHASE_13_REPORT.md` — this report.

## Files modified
- `shared/src/constants.ts` — `IdeaStatus`, `IdeaPriority`,
  `BrainstormSessionStatus`, `BrainstormGrouping`, `BrainstormParticipantRole`,
  `CleanupRecommendationStatus`, `CleanupCandidateType`, `TrashItemType`,
  `HistorySource`, `ActivityScope`, `IdeaRetention`; `AuditAction` additions
  (idea.*, brainstorm.*, cleanup.*, trash.restored, history.starred);
  `SearchEntity.IDEA`; `NotificationType.IDEA_ASSIGNED`, `BRAINSTORM_INVITE`.
- `shared/src/contracts.ts` — ideaCreate/Update/Vote/Archive/CommentCreate,
  brainstormCreate/ParticipantAdd/Capture/Generate, trashItem/BulkAction,
  cleanupResolve, historyListQuery, activityListQuery schemas (+ types).
- `backend/src/shared/ids.ts` — IDEA, IDEA_VOTE, IDEA_COMMENT, BRAINSTORM,
  BRAINSTORM_PARTICIPANT, BRAINSTORM_IDEA, CLEANUP, HISTORY_STAR prefixes.
- `backend/src/app.ts` — mounted `/api/v1/ideas`, `/api/v1/brainstorming`,
  `/api/v1/history`, `/api/v1/cleanup`, `/api/v1/trash`, `/api/v1/activity`.
- `backend/src/modules/search/service.ts` — new `idea` entity with the same
  tenant predicate plus project/team/tag filters and per-team authorization.
- `backend/src/modules/datacentre/service.ts` — `counts` (conversations/
  messages/memories/dna/dnaVersions/tasks/artifacts/projects/teams/
  notifications/auditEvents/ideas/brainstormSessions), `retention`,
  `recommendations` + `recommendationsByStatus`, `backup {available:false,
  note}` (honest: no provider configured).
- `frontend/src/lib/types.ts` — full Phase 13 type set incl.
  `DataCentreReportV2`; `SearchEntityType` gains `idea`.
- `frontend/src/pages/HomePage.tsx` — activity feed card (`/api/v1/activity
  scope=home`), Ideas quick action.
- `frontend/src/components/Topbar.tsx` — idea search results route to
  `/ideas`.

## Validation
- `shared`: `npm run build` clean (dist consumed by backend).
- `backend`: `npx vitest run` — 752/752 (47 files; Phase 13 files 81);
  `npm run typecheck` clean.
- `frontend`: `npm run typecheck` clean; `npm run build` (vite) clean;
  `npx vitest run` — 166/166 (30 files).
- Honesty rules enforced: AI-generated ideas only exist after
  provider-check + schema validation (tested: no provider → `ai_unavailable`,
  bad JSON/schema → `ai_generation_invalid`, nothing persisted); cleanup
  recommendations are never applied automatically; permanent deletes refuse
  `dependency_conflict`; history/activity are strictly read-only unions over
  persisted events with read-time dedup (no duplicate rows ever written);
  backup state admits nothing is configured; assignment/invite notifications
  reuse the real Phase 4A delivery path.

## External blockers
- PostgreSQL runtime still unavailable in this environment: migrations
  0034/0035 are static-only (DDL + RLS) and unexercised against a live
  database.
- No live AI provider credentials: brainstorming generation is covered by
  contract tests with mocked gateway/registry; production will surface
  `ai_unavailable` exactly as designed until a provider is configured.
- A live browser smoke run against real Postgres remains pending until the
  database is available.

## Next phase
- Phase 14 must not be started without instruction. Candidate follow-ups
  when instructed: live E2E once Postgres is available, and remaining
  idea surfaces (e.g., per-idea file attachments, richer brainstorm
  grouping UX) if desired.