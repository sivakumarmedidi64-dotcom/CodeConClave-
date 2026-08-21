# PHASE 9 — Teams Collaboration (Report)

## Status
COMPLETE. Server-side team authority is now real and enforced across the
existing subsystems: teams module with invitations (expiry sweep), member
roles (owner/admin/editor/viewer/guest) + suspension/revocation, lifecycle
(rename, description, settings, archive/restore), team-scoped activity and
stats, shared projects (attach/detach + access integration in `getProject`/
`listProjects`), shared conversations (share/unshare + access integration in
`getConversation`/`listConversations`/`searchConversations` + archive/trash
manage-gates), team memory (list + prompt-retrieval + route), team-scoped
global search (`teamId`/`memberId` filters), team notifications
(invitations, member joins, task assignment/completion) and audit. The
pre-existing Phase 6 team DNA module (membership-scoped read, MAIN/BRANCH/
merge) was verified and is now surfaced in the rewritten TeamsPage, which is
a full team workspace (create, members + role management + suspend/remove,
invitations + cancel, rename/description, archive/restore, stats, shared
projects/conversations, activity, DNA create/branch/merge). Migration 0031
remains static-only (PostgreSQL runtime unavailable). Nothing is claimed as
production-ready; see Blockers.

## Files created
- `backend/src/foundation/teams-9.test.ts` — 42-test Phase 9 contract suite:
  team lifecycle (create/rename/description/settings/archive/restore),
  roles and membership isolation, invitations (invite/duplicate/pending/
  invalid-role/owner-invite/accept/reject/cancel/expire sweep/list-mine),
  member management (role change, last-owner protection, remove/revoke/
  suspend), shared projects (attach/detach/foreign-owner denial/team-scoped
  lists/`getProject` fallback), shared conversations (share/unshare/read
  access/`listConversations` includeTeams/archive-trash gates/team list),
  team memory (membership gate + SQL shape), team DNA merge role
  restriction, team search (member gate + scoped clauses), team task
  notifications, stats/activity, watchdog wiring.
- `docs/PHASE_9_REPORT.md` — this report.

## Files modified
- `backend/src/modules/teams/service.ts` — full module reviewed and fixed
  while finally being typechecked and tested: pre-existing `notify`
  signature errors at ~lines 133/347/530/579 (2-arg calls → full
  `(userId, type, title, opts)`), missing `await` on `teamHasOnlyOwner`
  (made owner demotion always throw `last_owner`), `notifyTeamMembers`/
  `notifyTeamMembersAbout` typed to the `NotificationType` value union.
  `teamRoleFor` returns the raw ACTIVE role string (legacy `'member'`
  passthrough) with `requireTeamRole` casting to `TeamRoleType` for
  canonical-role gates.
- `backend/src/modules/teams/routes.ts` — fixed `TeamRole.MEMBER` →
  `TeamRole.EDITOR` default and `rejectInvitationRoute` →
  `rejectInvitation`.
- `backend/src/workers/watchdog.ts` — `expireInvitations` sweep added
  (`out.invitationsExpired`, SYSTEM-scope audit, expired rows transition to
  `EXPIRED`).
- `backend/src/modules/projects/service.ts` — `getProject` falls back to
  team membership (`SELECT 1 FROM team_members WHERE team_id = $1 AND
  user_id = $2 AND status = 'ACTIVE'`) only when the row has `team_id`;
  `listProjects` base clause extended with
  `OR p.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1
  AND status = 'ACTIVE')`.
- `backend/src/modules/conversations/service.ts` — `ConversationRow.team_id`,
  `toConversationJson.teamId`; `getConversation` team clause; `listConversations`
  4th param `includeTeams`; `searchConversations` team scope;
  `updateConversation`/`softDeleteConversation` require
  `requireTeamRole(userId, team_id, [OWNER, ADMIN])` for archive/trash when
  the conversation is team-shared and the caller is not its owner.
- `backend/src/modules/memory/service.ts` + `routes.ts` —
  `listTeamMemories(userId, teamId, opts)` and
  `retrieveTeamMemoriesForPrompt(userId, teamId, limit)` (membership-gated
  via `teamRoleFor`; team/type/search/minConfidence filters;
  `contradiction_state <> 'CONFIRMED'` gate), route
  `GET /api/v1/memory/team/:teamId` registered before `GET /:id`.
- `backend/src/modules/search/service.ts` + `routes.ts` — `teamId`/`memberId`
  filters; membership gate returns empty results for non-members;
  `teamScope`/`memberScope` clause helpers applied to file, project,
  conversation, memory, task and artifact blocks; routes pass the new
  filters through.
- `backend/src/modules/execution/tasks.ts` — team task notifications:
  `createTask` fans out `TEAM_TASK_ASSIGNED` on assignment,
  `setTaskStatus` fans out `TEAM_TASK_COMPLETED` on completion (both after a
  `SELECT team_id FROM projects` check, wrapped in try/catch, only when the
  project is team-shared).
- `frontend/src/lib/types.ts` — Phase 9 wire types: `TeamRole`,
  `TeamMemberStatus`, `InvitationState`, `Team` (snake_case row),
  `TeamMember` (joined users row), `TeamInvitation`, `TeamActivityItem`,
  `TeamStats`.
- `frontend/src/pages/TeamsPage.tsx` — rewritten as a full team workspace
  (see Frontend).
- `frontend/src/styles/global.css` — `.cc-badge` pill style.

## Teams
- Invitations: `inviteMember` looks up the invitee by email (registered users
  only), dedupes on pending/accepted invitations (`invitation_duplicate`),
  validates role (`invalid_role`), refuses inviting the owner, records
  `team.invitation_created` audit; `acceptInvitation` (owner-only rejects
  invitation to own team), `rejectInvitation`, `cancelInvitation` (owner/
  admin), `expireInvitations` sweep; `listInvitations` (owner/admin) and
  `listMyInvitations` (any member — the sidebar badge contract).
- Members: `teamMembers` returns rows joined with users (email, display_name,
  invited_by, joined_at); `changeMemberRole` (owner/admin; `invalid_role`;
  `last_owner` when demoting the final owner), `suspendMember`
  (`cannot_suspend_owner`), `revokeMembership`, `removeTeamMember`
  (owner/admin; `cannot_remove_owner`). Non-canonical roles are rejected by
  `requireTeamRole` for manage operations.
- Lifecycle: `renameTeam`/`updateTeamDescription`/`updateTeamSettings`
  (owner/admin), `archiveTeam`/`restoreTeam` (owner only), `listTeams` with
  my role, `getTeam` membership-scoped.
- Stats/activity: `teamStats` returns persisted counts (members, projects,
  pending invitations, activities); `listTeamActivity` reads `team_activity`
  joined with actor display names.
- Shared projects: `attachProjectToTeam` (owner/admin; project owner or
  editor role; no-op idempotent when already attached), `detachProjectFromTeam`
  (owner/admin), `listTeamProjects` membership-scoped.
- Shared conversations: `shareConversationWithTeam` (conversation owner or
  owner/admin role; idempotent), `unshareConversationFromTeam`,
  `listTeamConversations` membership-scoped.
- Notifications: `notifyTeamMembers`/`notifyTeamMembersAbout` fan out to all
  ACTIVE members except an optional actor; used for invitations
  (`TEAM_INVITATION`), membership (`TEAM_MEMBER_JOINED`/
  `TEAM_MEMBER_REMOVED`), team messages, and task events
  (`TEAM_TASK_ASSIGNED`/`TEAM_TASK_COMPLETED`).

## Team DNA
- The Phase 6 `team_dna` module (membership-scoped reads, MAIN/BRANCH scope,
  conflict detection, owner/admin-only merge) is unchanged and remains the
  server-side authority; its routes (`GET /api/v1/dna/team/:teamId`,
  `POST /team`, `POST /team/:teamId/branch`, `POST /team/:teamId/merge`)
  are now consumed by the TeamsPage.

## Frontend
- TeamsPage is a complete workspace: create team (name + description);
  sidebar list with archived marker; header with stats cards; members table
  with role select (owner/admin), suspend/remove, joined date; invite form
  with role picker (owner/admin/editor/viewer/guest); pending invitations
  with cancel; shared projects (attach from own projects, unshare); shared
  conversations; team DNA (add MAIN block, branch a block, owner/admin merge
  to MAIN, conflict badges); activity feed. Manage controls are gated by the
  caller's role computed from the members list against the authenticated
  user. The 18-item sidebar is unchanged.

## Database migrations
- No new migration was required: the teams schema (`teams`, `team_members`,
  `team_invitations`, `team_activity`, `team_dna`) and the Phase 9 additions
  (`projects.team_id`, `conversations.team_id`) ship in earlier migrations
  (0023–0031). Migration 0031 remains static-only.
- IMPORTANT: PostgreSQL runtime is NOT available in this environment. The
  migrations were validated for SQL syntax only and never applied. Do not
  claim runtime migration success.

## Tests
- `teams-9.test.ts` (42): create-team SQL/audit/notify shape; owner/admin/
  editor/viewer/guest role semantics; last-owner protection; invitation
  lifecycle incl. expiry sweep and my-invitations; member suspend/remove/
  revoke; shared project attach/detach/denial + `getProject`/`listProjects`
  integration; conversation share/unshare + access + archive/trash gates;
  team memory membership gate + SQL; DNA merge role restriction (403);
  search member gate + scoped clauses; task assignment/completion
  notifications; stats/activity; watchdog wiring.
- Pre-existing suites remain green (notably `dna-6.test.ts`, which drove the
  `teamRoleFor` raw-role behavior for legacy `'member'`).

## Validation
- shared: typecheck PASS, build PASS, 63/63 tests (56 pre-existing + 7
  Phase 9 contracts).
- local-agent: unchanged 49/49 tests, build PASS.
- backend: typecheck PASS, build PASS, 584/584 tests (542 pre-existing +
  42 new).
- frontend: typecheck PASS, build PASS, 62/62 tests.
- Total: 758/758.

## Blockers
- PostgreSQL runtime unavailable — migrations 0023–0031 are static-validated
  only; runtime DDL, RLS behavior, and the team-scoped queries are
  unverified against a live database.
- No real storage/provider credentials; only the in-memory adapters are
  exercised by tests.
- No lint scripts configured in any workspace — typecheck + build are the
  enforced gates.
- Team search/memory rely on dynamic module imports to avoid loading the
  notifications dependency chain in test files that mock it; acceptable,
  but a hard dependency injection layer would be cleaner in production.