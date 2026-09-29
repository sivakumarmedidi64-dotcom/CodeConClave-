# CodeConClave — PKG-11 Team Collaboration Gate (`Groups B + C`, 8 capabilities)

Canonical basis: `CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Groups A–L, ≥342).
Group B = Cowork/Product (Team Cowork, Team Invites, Async Handoff, Live Presence).
Group C = Intelligence items 36–40 (Team Skill Matrix, Code Ownership Inference,
Cross-Team Context Sync, Async Collaboration Queue, Conflict Resolution Debate).

This gate is additive — no feature was removed, renamed, or merged
(`FEATURES_REMOVED = 0`), and every completed capability is confirmed by
server-authoritative implementation + tests (never interface-only claims).

---

## 1. Scope

### Group B (Cowork / Product — PKG-11 contributions)

| Capability | Prior Status | Status Now | Evidence |
|---|---|---|---|
| Team Cowork | FLAGGED (watch/co-control already built PKG-01-09) | COMPLETED | `os/p2/team-cowork.ts` (PKG-01-09) + `modules/teamcollab/service.ts` (PKG-11 presence, handoff, queue, context) |
| Team Invites | LIVE (unchanged) | LIVE | `modules/teams/service.ts` — invite/accept/reject/cancel/revoke/expiry |
| Async Handoff | PARTIAL | COMPLETED | `modules/teamcollab/service.ts` — `createHandoff/acceptHandoff/updateHandoff/listHandoffs`; persisted via `StateStore` |
| Live Presence | PARTIAL | COMPLETED | `modules/teamcollab/service.ts` — heartbeat-derived presence (ONLINE/IDLE/BUSY/OFFLINE); fresh only; never fabricated |
| Notifications | LIVE (unchanged) | LIVE | `modules/notifications` — reused; team-collab emits `team.task_assigned` on handoff assignment |

### Group C (Intelligence items 36–40)

| # | Capability | Status Now | Evidence |
|---|---|---|---|
| 36 | Team Skill Matrix | COMPLETED | `modules/teamcollab/service.ts` — `publishTeamSkill/listTeamSkills` (visible-only); `team-intel.ts` skill routing |
| 37 | Code Ownership Inference | COMPLETED | `modules/teamcollab/service.ts` — `setOwnership/listOwnership` (workspace-relative, team-scoped) |
| 38 | Cross-Team Context Sync | COMPLETED | `modules/teamcollab/service.ts` — `writeContext/listContext` (SHARED scope only; private memory never surfaced) |
| 39 | Async Collaboration Queue | COMPLETED | `modules/teamcollab/service.ts` — `enqueue/setQueueStatus/listQueue`; bounded at `MAX_QUEUE_ITEMS=500` |
| 40 | Conflict Resolution Debate | COMPLETED | PKG-07 debate engine `agents/debates.ts` + `teamcollab/service.ts` `recordConflict` (team-side evidence) |

---

## 2. Team model

Teams are canonical user groups backed by the `teams` and `team_members` tables.
Roles: `OWNER`, `ADMIN`, `EDITOR`, `VIEWER`, `GUEST` (ranked). Team RBAC is
re-resolved server-side on every operation via `requireTeamRole()` from the
existing `modules/teams/service.ts`. The teamcollab module adds NO role hierarchy
of its own and never bypasses the teams-service RBAC gate.

---

## 3. Membership & RBAC

Every mutation in `TeamCollaboration` (presence, handoff, queue, context, ownership,
skills, conflicts) calls `this.teamAccess.requireRole(actorId, teamId, roles)`,
which re-resolves the caller's team membership from the DB-backed `team_members`
table on every call. Role restrictions:

| Operation | Minimum Role |
|---|---|
| Heartbeat / listPresence | any member (OWNER → GUEST) |
| listHandoffs / listQueue / listContext / listOwnership / listTeamSkills | any member |
| createHandoff | OWNER / ADMIN / EDITOR |
| acceptHandoff | handoff recipient OR OWNER / ADMIN |
| updateHandoff (complete/cancel) | OWNER / ADMIN / EDITOR |
| enqueue / setQueueStatus | OWNER / ADMIN / EDITOR |
| writeContext | OWNER / ADMIN / EDITOR |
| publishTeamSkill | OWNER / ADMIN / EDITOR |
| setOwnership | OWNER / ADMIN / EDITOR |
| recordConflict | OWNER / ADMIN / EDITOR |

Non-members: **denied on every operation (fail-closed)**.

---

## 4. Invitations

Team invitations are handled by the existing `modules/teams/service.ts` (LIVE,
unchanged). PKG-11 does NOT add or duplicate invitation logic. Handoff assignment
notifications are emitted to invited members; acceptance follows standard
team-membership rules.

---

## 5. Sharing & co-control

Existing share links (`conversations/sharing.ts`, WATCH/COMMENT/CO_CONTROL) are
unchanged. PKG-11 adds:

- **Async handoff**: structured cowork/task handoff preserving workspaceId,
  taskContext, files[], memoryRefs[], reviewState, status (OPEN → ACCEPTED →
  COMPLETED/FAILED/CANCELLED). Shared with team via `handoff.*` IPC topic.
- **Shared context**: explicit `writeContext` entries (SHARED scope), persisted
  via StateStore. Private memory is never surfaced or referenced through the
  team context API.

---

## 6. Presence (honest, heartbeat-derived)

`heartbeat(userId, teamId, signal)` records a timestamped presence entry.
`listPresence()` derives state from heartbeat freshness:

| Time since last heartbeat | Derived state |
|---|---|
| ≤ `PRESENCE_ONLINE_WINDOW_MS` (5 min) | ONLINE (when signal=active) |
| ≤ `PRESENCE_IDLE_WINDOW_MS` (30 min) | IDLE (when signal=active) |
| > `PRESENCE_IDLE_WINDOW_MS` | OFFLINE |
| signal=busy (any freshness ≤ idle window) | BUSY |

Presence is NEVER fabricated as ONLINE when the heartbeat is stale.
StateStore persistence means presence survives across service restarts
(honest stale → OFFLINE when window elapsed).

---

## 7. Watch

Existing `os/p2/team-cowork.ts` watch mechanism (PKG-01-09) is unchanged. PKG-11
adds NO duplicate watch system. Watch state is derived from the existing
`team-cowork.ts` co-watch entries, not from the presence system.

---

## 8. Async Handoff

| State | Transition |
|---|---|
| OPEN | Initial (createHandoff) |
| ACCEPTED | acceptHandoff (by recipient or admin) |
| COMPLETED | updateHandoff (by creator) |
| FAILED | updateHandoff (by creator) |
| CANCELLED | updateHandoff (by creator) |

Handoffs are persisted via StateStore (`teamcollab:handoff:{teamId}`).
Assignment notifications are emitted to the recipient (via `notifyTeamMembers`).
Handoff audit is written via `recordAudit` with `team.project_shared` action.

---

## 9. Shared Context (explicit, isolated from private memory)

`writeContext` stores SHARED-scoped entries only. `listContext` filters to
`scope === 'SHARED'`. Private memory (per-user workspace memory, DNA, skill
definitions) is NEVER referenced, included, or leaked through the team
context API. The collaboration module has NO access to or surface for
private memory. Context entries carry `authorUserId` for attribution.

---

## 10. Team Skill Visibility

`publishTeamSkill` allows editors+ to register team-visible skills.
`listTeamSkills` returns only skills where `visible === true`. Private skills
(not published via the team skill API) are never surfaced. Skills are
StateStore-persisted (`teamcollab:skills:{teamId}`), not read from the user's
private skill registry.

---

## 11. Code Ownership

`setOwnership` accepts workspace-relative path → ownerUserId + confidence.
`listOwnership` returns all ownership entries for the team. Ownership is
workspace-relative (paths never escape the workspace scope). Ownership
entries are team-scoped and never leak between teams. Updated entries
replace by path (deduplication).

---

## 12. Conflict Coordination

`recordConflict` captures team disagreement evidence (topic, evidence[],
participants[]) and writes an audit record. The actual debate execution
lives in the PKG-07 debate engine (`modules/agents/debates.ts`, DEBATE_STATES:
PENDING/IN_DEBATE/JUDGING/COMPLETED/FAILED/CANCELLED/...). The teamcollab
module does NOT duplicate the debate engine; it captures team-side evidence
only.

---

## 13. Collaboration Queue (bounded, async)

`enqueue(title, assigneeId?)` adds to queue. `setQueueStatus` transitions:
QUEUED → ASSIGNED → IN_PROGRESS → COMPLETED | FAILED | CANCELLED.
Queue is bounded at `MAX_QUEUE_ITEMS = 500`; enqueue beyond the limit
throws `AppError.conflict('teamcollab_queue_full')`. Items are team-scoped
and never leak between teams. Persisted via StateStore.

---

## 14. Notifications

Team-collab emits notifications using the existing `notifyTeamMembers` helper
(from `modules/teams/service.ts`) when a handoff is assigned (type:
`team.task_assigned`, via `modules/notifications`). Notifications are
server-confirmed and never fabricated.

---

## 15. Security

### Authorization
Every operation re-resolves team RBAC server-side. Non-members receive 403.
Removed/stale members (roleOrNull = null) are denied on every operation.

### Private Memory Protection
The team context API exposes only SHARED-scoped entries. Private per-user
memory is never accessed, referenced, or surfaced by the teamcollab module.

### Private Skill Protection
`listTeamSkills` returns only `visible === true` skills. Private/unpublished
skills are never exposed to team members.

### Privilege Escalation Protection
No role-change surface exists in the teamcollab module. Viewers cannot write
to context, queue, ownership, skills, or conflicts. The collaboration module
does NOT delegate to any external process or allow self-promotion.

### Fail-Closed
Unknown team member → denied. Missing role → denied. Invalid handoff/queue
status → `AppError.badRequest`. Handoff not found → 404. Non-recipient
accepting handoff → 403. Non-creator completing handoff → 403.

### Desktop
Desktop `teamCollab` surface is read-only (presence/skills/queue/report).
No write operations cross the context-isolation boundary. Capability label:
`team.collaboration` (additionally registered in desktop `CapabilityId` union).

---

## 16. Audit

All mutations write audit records via the existing `recordAudit` function
(`modules/audit/service.ts`). Actions:
- `team.project_shared` with `action: 'handoff.created'`
- `team.member_added` with `action: 'handoff.accepted'`
- `team.project_shared` with `action: 'queue.enqueue'`
- `team.memory_added` with `action: 'team.context_written'`
- `team.conversation_shared` with `action: 'team.context_accessed'`
- `team.permission_changed` with `action: 'team.skill_published'`
- `team.permission_changed` with `action: 'team.conflict_recorded'`

Audit records carry `scope: 'TEAM'`, `actorUserId`, `tenantId = teamId`.

---

## 17. Persistence

All team collaboration state is persisted via the `StateStore` interface
(os/state.ts). Keys are namespaced: `teamcollab:{feature}:{teamId}`.

| Feature | Key Pattern | Schema |
|---|---|---|
| presence | `teamcollab:presence:{teamId}` | `Record<string, MemberPresence>` |
| handoff | `teamcollab:handoff:{teamId}` | `Handoff[]` |
| queue | `teamcollab:queue:{teamId}` | `QueueItem[]` |
| context | `teamcollab:context:{teamId}` | `TeamContextEntry[]` |
| ownership | `teamcollab:ownership:{teamId}` | `OwnershipEntry[]` |
| skills | `teamcollab:skills:{teamId}` | `SkillItem[]` |

Tests use `MemoryStateStore` (deterministic, no DB). Production uses the
Postgres-backed StateStore.

---

## 18. IPC (EventBus)

On mutations, the teamcollab service publishes events via `IpcBus`:
- `aios.team.{teamId}.presence`
- `aios.team.{teamId}.handoff`
- `aios.team.{teamId}.queue`
- `aios.team.{teamId}.context`
- `aios.team.{teamId}.ownership`
- `aios.team.{teamId}.skills`

These are observability hooks only; no renderer subscribes directly. The
EventBus is the existing `os/ipc.ts` IpcBus (no fake realtime).

---

## 19. Desktop

The desktop surface (preload/api.ts) exposes a read-only `teamCollab` block:
- `support()` — honest availability report (available=true, source='desktop-report',
  capabilities=['presence','skills','queue'])
- `presence(teamId)` — read-only presence snapshot (returns honest empty shape;
  real data served by backend)
- `skills(teamId)` — read-only visible skills (empty shape; real data from backend)
- `queue(teamId)` — read-only queue snapshot (empty shape; real data from backend)

All four are allow-listed channels with `team.collaboration` capability label.
The desktop handler (`desktop/app.ts`) returns honest shapes without fabricating
member data.

---

## 20. Limitations

1. **No realtime presence push**: presence is heartbeat-derived and client-polled;
   the EventBus publishes an event but there is no WebSocket push to the renderer.
2. **No handoff resume**: handoff tracks task context but does not automatically
   restore workspace state to the recipient.
3. **Conflict recording is evidence-only**: the actual debate execution lives in
   PKG-07 (`agents/debates.ts`); teamcollab does not invoke the debate engine.
4. **Queue is bounded**: `MAX_QUEUE_ITEMS=500`; unbounded growth is prevented by
   failing closed on the 501st enqueue.
5. **Desktop presence/skills/queue return empty shapes**: real data is served by
   the backend HTTP API; desktop provides the channel surface only.

---

## 21. Test results

### Backend

| File | Tests | Result |
|---|---|---|
| `modules/teamcollab/security.test.ts` | 13 | PASS |
| `modules/teamcollab/service.test.ts` | 15 | PASS |
| **Backend teamcollab total** | **28** | **PASS** |

Key areas tested:
- Fail-closed non-member denial (every feature)
- Viewer cannot write (handoff/queue/context/skills/ownership/conflict)
- Guest can read presence/handoffs/queue but cannot create context
- Handoff: recipient or admin may accept; only creator may complete/cancel
- Cross-team (cross-workspace) data isolation (presence, queue, context)
- Private memory never exposed (SHARED-only context filtering)
- Private skills never exposed (visible-only skill filtering)
- Queue bounded growth (fail-safe at MAX_QUEUE_ITEMS)
- Presence honest heartbeat: ONLINE → IDLE → OFFLINE transitions
- State persistence across service instances (MemoryStateStore)
- Privilege escalation: viewer cannot promote self

### Frontend

| File | Tests | Result |
|---|---|---|
| `components/TeamCollabPanel.test.tsx` | 4 | PASS |

Key areas tested:
- Honest presence state and online count from backend
- Empty state rendering (no members, no work)
- Error state (backend unreachable)
- Correct endpoints queried for teamId

### Desktop

| File | Tests | Result |
|---|---|---|
| `preload/api.test.ts` | 7 | PASS |
| Full desktop suite | 58 | PASS |

Key areas tested:
- Frozen bridge with exact method set (includes teamcollab)
- No generic IPC primitives exposed
- Channel mapping: teamcollab.support/presence/skills/queue → cc:teamcollab:*
- Payload forwarding: only teamId forwarded (no free-form IPC)

### Typecheck

| Workspace | Result |
|---|---|
| backend | EXIT 0 |
| frontend | EXIT 0 |
| desktop | EXIT 0 |
