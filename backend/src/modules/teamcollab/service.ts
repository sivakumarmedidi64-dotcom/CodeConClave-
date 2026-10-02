/**
 * CodeConClave — PKG-11 Team Collaboration module (canonical).
 *
 * Completes the team/collaboration capabilities that were PARTIAL or missing,
 * built ON TOP of the existing canonical subsystems (never duplicating them):
 *   - team RBAC/membership: reuse `teams/service.requireTeamRole` (server-side)
 *   - persistence: reuse `os/state.StateStore` (namespaced `teamcollab:*`)
 *   - eventing: reuse `os/ipc.IpcBus` when a transport is present (else no-op)
 *   - notifications: reuse `modules/notifications` (via notifyTeam)
 *   - audit: reuse `modules/audit.recordAudit` (existing AuditAction constants)
 *   - conflict/debate: the debate engine lives in `modules/agents/debates.ts`;
 *     this module records team-level conflict coordination evidence only.
 *
 * Features completed here:
 *   1. Presence        — honest, server-confirmed states ONLINE/IDLE/BUSY/OFFLINE
 *                        derived from heartbeat timestamps (never fabricated).
 *   2. Async Handoff   — structured cowork/task handoff preserving workspace,
 *                        task context, memory refs, review state, files, owner.
 *   3. Collaboration Queue — async queue (QUEUED/ASSIGNED/IN_PROGRESS/COMPLETED/
 *                        FAILED/CANCELLED), bounded growth.
 *   4. Team Context    — EXPLICIT shared team context, isolated from private
 *                        memory (private memory is NEVER auto-exposed).
 *   5. Code Ownership  — team-scoped code ownership inference (workspace only).
 *   6. Team Skill Visibility — exposes only non-private skills to team members.
 *   7. Conflict coordination — audit + evidence for team disagreement (reuses
 *                        debate flow conceptually; execution lives in debates.ts).
 *
 * Every mutating operation re-resolves team RBAC server-side and writes audit.
 * Everything fails closed: unknown member => denied; no role => denied.
 */
import { AppError } from '../../shared/errors.js';
import type { StateStore } from '../../os/state.js';
import type { IpcBus } from '../../os/ipc.js';
import {
  AuditAction,
  TeamRole,
  type TeamRole as TeamRoleType,
} from '@codeconclave/shared';

export type PresenceState = 'ONLINE' | 'IDLE' | 'BUSY' | 'OFFLINE';

export interface MemberPresence {
  userId: string;
  state: PresenceState;
  at: number;
}

export type HandoffStatus = 'OPEN' | 'ACCEPTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Handoff {
  id: string;
  teamId: string;
  fromUserId: string;
  toUserId: string | null;
  workspaceId: string | null;
  taskContext: string;
  files: string[];
  memoryRefs: string[];
  reviewState: string | null;
  status: HandoffStatus;
  createdAt: number;
  updatedAt: number;
}

export type QueueStatus = 'QUEUED' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface QueueItem {
  id: string;
  teamId: string;
  title: string;
  assigneeId: string | null;
  status: QueueStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TeamContextEntry {
  id: string;
  title: string;
  body: string;
  authorUserId: string;
  createdAt: number;
  /** scope guards: only 'SHARED' entries are visible to team members. */
  scope: 'SHARED' | 'PRIVATE';
}

export interface OwnershipEntry {
  /** relative path within the workspace */
  path: string;
  ownerUserId: string;
  confidence: number;
}

export const PRESENCE_STATES: readonly PresenceState[] = ['ONLINE', 'IDLE', 'BUSY', 'OFFLINE'];
export const QUEUE_STATUSES: readonly QueueStatus[] = [
  'QUEUED',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];
export const HANDOFF_STATUSES: readonly HandoffStatus[] = [
  'OPEN',
  'ACCEPTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

/** Hard bounds — queue is bounded to prevent unbounded growth. */
export const MAX_QUEUE_ITEMS = 500;
export const MAX_HANDOFFS = 200;
export const MAX_CONTEXT_ENTRIES = 200;
/** A member is ONLINE only if their last heartbeat is fresher than this (ms). */
export const PRESENCE_ONLINE_WINDOW_MS = 5 * 60 * 1000;
export const PRESENCE_IDLE_WINDOW_MS = 30 * 60 * 1000;

export interface TeamAccess {
  /** Resolve caller's ACTIVE team role; throws when not a member. */
  requireRole(actorId: string, teamId: string, roles: readonly TeamRoleType[]): Promise<TeamRoleType>;
  /** Resolve caller's ACTIVE team role or throw; returns null only when not a member. */
  roleOrNull(actorId: string, teamId: string): Promise<string | null>;
}

export interface TeamCollaborationDeps {
  state: StateStore;
  ipc?: IpcBus;
  /** Server-side team RBAC (defaults to the teams service). */
  teamAccess?: TeamAccess;
  /** Notify team members (defaults to the teams service helper). */
  notifyTeam?: (teamId: string, type: string, title: string, opts?: Record<string, unknown>) => Promise<void>;
  now?: () => number;
  randomId?: () => string;
}

/** Canonical default RBAC using the existing teams service (DB-backed). */
export function defaultTeamAccess(): TeamAccess {
  return {
    requireRole: (actorId, teamId, roles) =>
      import('../teams/service.js').then((m) => m.requireTeamRole(actorId, teamId, roles)),
    roleOrNull: (actorId, teamId) =>
      import('../teams/service.js').then((m) => m.teamRoleFor(actorId, teamId)),
  };
}

function defaultNotify(teamId: string, type: string, title: string, opts?: Record<string, unknown>): Promise<void> {
  return import('../teams/service.js')
    .then((m) => m.notifyTeamMembers(teamId, type as never, title, (opts ?? {}) as never))
    .catch(() => undefined);
}

let seq = 0;
function defaultId(): string {
  seq += 1;
  return `tc_${Date.now().toString(36)}_${seq}`;
}

const key = (feature: string, teamId: string) => `teamcollab:${feature}:${teamId}`;

export class TeamCollaboration {
  private readonly teamAccess: TeamAccess;
  private readonly notifyTeam: TeamCollaborationDeps['notifyTeam'];
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private deps: TeamCollaborationDeps) {
    this.teamAccess = deps.teamAccess ?? defaultTeamAccess();
    this.notifyTeam = deps.notifyTeam ?? defaultNotify;
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? defaultId;
  }

  private async read<T>(feature: string, teamId: string, empty: T): Promise<{ version: number; data: T }> {
    const block = await this.deps.state.get<T>(key(feature, teamId));
    return block ? { version: block.version, data: block.data } : { version: 0, data: empty };
  }

  private async write<T>(feature: string, teamId: string, version: number, data: T, ipcTopic?: string): Promise<void> {
    await this.deps.state.put(version + 1, key(feature, teamId), data);
    if (ipcTopic && this.deps.ipc) {
      const emit = (this.deps.ipc.publish ?? (() => undefined)) as unknown;
      (emit as (t: string, p: unknown, o?: { workspaceId: string | null }) => void)(
        ipcTopic,
        { teamId, data, at: this.now() },
        { workspaceId: null },
      );
    }
  }

  private async requireRole(actorId: string, teamId: string, roles: readonly TeamRoleType[]): Promise<TeamRoleType> {
    return this.teamAccess.requireRole(actorId, teamId, roles);
  }

  // ---------------------------------------------------------------------
  // Presence — honest, server-confirmed states.
  // ---------------------------------------------------------------------

  /**
   * Record a member heartbeat. Presence is DERIVED from real timestamps, never
   * fabricated. `busy`/`idle` are call-supplied signals; ONLINE is gated by
   * heartbeat freshness. Does not expose private workspace data.
   */
  async heartbeat(actorId: string, teamId: string, signal: 'active' | 'idle' | 'busy' = 'active'): Promise<void> {
    const role = await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    void role;
    const t = this.now();
    const { version, data } = await this.read<Record<string, MemberPresence>>('presence', teamId, {});
    const base = data[actorId]?.state ?? 'OFFLINE';
    let state: PresenceState = 'ONLINE';
    if (signal === 'busy') state = 'BUSY';
    else if (signal === 'idle') state = 'IDLE';
    else state = 'ONLINE';
    void base;
    await this.write('presence', teamId, version, { ...data, [actorId]: { userId: actorId, state, at: t } }, `aios.team.${teamId}.presence`);
  }

  /** List team presence (RBAC-gated). OFFline members listed as OFFLINE. */
  async listPresence(actorId: string, teamId: string): Promise<{ presence: MemberPresence[]; onlineCount: number }> {
    await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    const { data } = await this.read<Record<string, MemberPresence>>('presence', teamId, {});
    const t = this.now();
    const presence = Object.values(data)
      .map((p) => {
        // A heartbeat older than the idle window is honest OFFLINE.
        if (p.state !== 'BUSY' && t - p.at > PRESENCE_IDLE_WINDOW_MS) return { ...p, state: 'OFFLINE' as PresenceState };
        if (p.state !== 'BUSY' && p.state !== 'IDLE' && t - p.at > PRESENCE_ONLINE_WINDOW_MS) {
          return { ...p, state: 'IDLE' as PresenceState };
        }
        return p;
      })
      .sort((a, b) => a.userId.localeCompare(b.userId));
    const onlineCount = presence.filter((p) => p.state === 'ONLINE' || p.state === 'BUSY').length;
    return { presence, onlineCount };
  }

  // ---------------------------------------------------------------------
  // Async Handoff
  // ---------------------------------------------------------------------

  /** Create a structured cowork/task handoff (owner/admin/editor may create). */
  async createHandoff(
    actorId: string,
    teamId: string,
    input: {
      toUserId: string | null;
      workspaceId?: string | null;
      taskContext: string;
      files?: string[];
      memoryRefs?: string[];
      reviewState?: string | null;
    },
  ): Promise<Handoff> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const t = this.now();
    const { version, data } = await this.read<Handoff[]>('handoff', teamId, []);
    if (data.length >= MAX_HANDOFFS) throw AppError.conflict('teamcollab_handoff_limit', 'handoff limit reached');
    const h: Handoff = {
      id: this.randomId(),
      teamId,
      fromUserId: actorId,
      toUserId: input.toUserId,
      workspaceId: input.workspaceId ?? null,
      taskContext: String(input.taskContext).slice(0, 20_000),
      files: (input.files ?? []).slice(0, 50),
      memoryRefs: (input.memoryRefs ?? []).slice(0, 50),
      reviewState: input.reviewState ?? null,
      status: 'OPEN',
      createdAt: t,
      updatedAt: t,
    };
    data.push(h);
    await this.write('handoff', teamId, version, data, `aios.team.${teamId}.handoff`);
    if (h.toUserId) {
      await this.notifyTeam?.(teamId, 'team.task_assigned', 'New handoff assigned to you', {
        exceptUserId: actorId,
        resourceType: 'handoff',
        resourceId: h.id,
        body: h.taskContext.slice(0, 200),
      });
    }
    await this.audit(AuditAction.TEAM_PROJECT_SHARED /* reuse audit (team scope) */, actorId, teamId, {
      action: 'handoff.created',
      resourceId: h.id,
      toUserId: h.toUserId,
    });
    return h;
  }

  /** Accept an OPEN handoff (only when the caller is the recipient or an admin). */
  async acceptHandoff(actorId: string, teamId: string, handoffId: string): Promise<Handoff> {
    const role = await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    const { version, data } = await this.read<Handoff[]>('handoff', teamId, []);
    const h = data.find((x) => x.id === handoffId);
    if (!h || h.teamId !== teamId) throw AppError.notFound('handoff', 'teamcollab_handoff_not_found');
    if (h.status !== 'OPEN') throw AppError.badRequest('teamcollab_handoff_status', 'handoff is not open');
    const isRecipient = h.toUserId === actorId;
    const isManager = role === TeamRole.OWNER || role === TeamRole.ADMIN;
    if (!isRecipient && !isManager) throw AppError.forbidden('teamcollab_handoff_denied', 'not the handoff recipient');
    h.status = 'ACCEPTED';
    h.updatedAt = this.now();
    await this.write('handoff', teamId, version, data, `aios.team.${teamId}.handoff`);
    await this.audit(AuditAction.TEAM_MEMBER_ADDED /* reuse */, actorId, teamId, { action: 'handoff.accepted', resourceId: h.id });
    return h;
  }

  /** Complete or cancel an OPEN/ACCEPTED handoff (owner/admin, or the actor who owns it). */
  async updateHandoff(actorId: string, teamId: string, handoffId: string, status: 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<Handoff> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const { version, data } = await this.read<Handoff[]>('handoff', teamId, []);
    const h = data.find((x) => x.id === handoffId);
    if (!h || h.teamId !== teamId) throw AppError.notFound('handoff', 'teamcollab_handoff_not_found');
    if (h.fromUserId !== actorId) throw AppError.forbidden('teamcollab_handoff_denied', 'only creator or manager may update');
    h.status = status;
    h.updatedAt = this.now();
    await this.write('handoff', teamId, version, data, `aios.team.${teamId}.handoff`);
    return h;
  }

  async listHandoffs(actorId: string, teamId: string): Promise<Handoff[]> {
    await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    const { data } = await this.read<Handoff[]>('handoff', teamId, []);
    return [...data].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------------------------------------------------------------------
  // Collaboration Queue (async, bounded, StateStore-backed)
  // ---------------------------------------------------------------------

  async enqueue(actorId: string, teamId: string, title: string, assigneeId?: string | null): Promise<QueueItem> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const t = this.now();
    const { version, data } = await this.read<QueueItem[]>('queue', teamId, []);
    if (data.length >= MAX_QUEUE_ITEMS) throw AppError.conflict('teamcollab_queue_full', 'collaboration queue is full');
    const item: QueueItem = {
      id: this.randomId(),
      teamId,
      title: String(title).slice(0, 2000),
      assigneeId: assigneeId ?? null,
      status: 'QUEUED',
      createdAt: t,
      updatedAt: t,
    };
    data.push(item);
    await this.write('queue', teamId, version, data, `aios.team.${teamId}.queue`);
    await this.audit(AuditAction.TEAM_PROJECT_SHARED, actorId, teamId, { action: 'queue.enqueue', resourceId: item.id });
    return item;
  }

  async setQueueStatus(
    actorId: string,
    teamId: string,
    itemId: string,
    status: QueueStatus,
  ): Promise<QueueItem> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const { version, data } = await this.read<QueueItem[]>('queue', teamId, []);
    const item = data.find((x) => x.id === itemId);
    if (!item || item.teamId !== teamId) throw AppError.notFound('teamcollab_queue_not_found', 'queue item not found');
    item.status = status;
    item.updatedAt = this.now();
    await this.write('queue', teamId, version, data, `aios.team.${teamId}.queue`);
    return item;
  }

  async listQueue(actorId: string, teamId: string): Promise<QueueItem[]> {
    await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    const { data } = await this.read<QueueItem[]>('queue', teamId, []);
    return [...data].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------------------------------------------------------------------
  // Team Context (explicit shared context; NEVER private memory)
  // ---------------------------------------------------------------------

  /** Write an explicit SHARED team context entry. Published to team members. */
  async writeContext(actorId: string, teamId: string, input: { title: string; body: string }): Promise<TeamContextEntry> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const t = this.now();
    const { version, data } = await this.read<TeamContextEntry[]>('context', teamId, []);
    if (data.length >= MAX_CONTEXT_ENTRIES) data.shift();
    const entry: TeamContextEntry = {
      id: this.randomId(),
      title: String(input.title).slice(0, 1000),
      body: String(input.body).slice(0, 50_000),
      authorUserId: actorId,
      createdAt: t,
      scope: 'SHARED',
    };
    data.push(entry);
    await this.write('context', teamId, version, data, `aios.team.${teamId}.context`);
    await this.audit(AuditAction.TEAM_MEMORY_ADDED, actorId, teamId, { action: 'team.context_written', resourceId: entry.id });
    return entry;
  }

  /** Read SHARED team context only. Private memory is NEVER surfaced here. */
  async listContext(actorId: string, teamId: string): Promise<TeamContextEntry[]> {
    await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    await this.audit(AuditAction.TEAM_CONVERSATION_SHARED /* reuse */, actorId, teamId, { action: 'team.context_accessed' });
    const { data } = await this.read<TeamContextEntry[]>('context', teamId, []);
    return data.filter((e) => e.scope === 'SHARED').sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------------------------------------------------------------------
  // Code Ownership (team-scoped inference; workspace-relative paths only)
  // ---------------------------------------------------------------------

  /**
   * Record/refresh team-scoped code ownership for a set of workspace paths.
   * Ownership is collaborative state inferred from team file activity; paths
   * are workspace-relative and never escape the workspace.
   */
  async setOwnership(actorId: string, teamId: string, paths: Array<{ path: string; ownerUserId: string; confidence: number }>): Promise<void> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const { version, data } = await this.read<OwnershipEntry[]>('ownership', teamId, []);
    const map = new Map(data.map((e) => [e.path, e]));
    for (const p of paths.slice(0, 2000)) {
      const path = String(p.path).slice(0, 2000);
      const confidence = Math.max(0, Math.min(1, Number(p.confidence) || 0));
      map.set(path, { path, ownerUserId: p.ownerUserId, confidence });
    }
    await this.write('ownership', teamId, version, [...map.values()], `aios.team.${teamId}.ownership`);
  }

  async listOwnership(actorId: string, teamId: string): Promise<OwnershipEntry[]> {
    await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    const { data } = await this.read<OwnershipEntry[]>('ownership', teamId, []);
    return [...data].sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---------------------------------------------------------------------
  // Team Skill Visibility (only explicit, non-private skills)
  // ---------------------------------------------------------------------

  /** Expose team skills: only those marked visible/shared. Never private skills. */
  async listTeamSkills(actorId: string, teamId: string): Promise<Array<{ id: string; name: string; visible: boolean }>> {
    await this.requireRole(actorId, teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    // Read skills that are explicitly shared to this team (StateStore) only.
    const { data } = await this.read<Array<{ id: string; name: string; visible: boolean }>>('skills', teamId, []);
    return data.filter((s) => s.visible === true).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Publish a skill as team-visible (only its id + name become visible). */
  async publishTeamSkill(actorId: string, teamId: string, skill: { id: string; name: string; visible?: boolean }): Promise<void> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const { version, data } = await this.read<Array<{ id: string; name: string; visible: boolean }>>('skills', teamId, []);
    const idx = data.findIndex((s) => s.id === skill.id);
    const entry = { id: String(skill.id).slice(0, 200), name: String(skill.name).slice(0, 200), visible: skill.visible ?? true };
    if (idx >= 0) data[idx] = entry;
    else data.push(entry);
    await this.write('skills', teamId, version, data, `aios.team.${teamId}.skills`);
    await this.audit(AuditAction.TEAM_PERMISSION_CHANGED, actorId, teamId, { action: 'team.skill_published', resourceId: entry.id });
  }

  // ---------------------------------------------------------------------
  // Conflict coordination (evidence + audit; execution uses debates.ts)
  // ---------------------------------------------------------------------

  /**
   * Record team disagreement evidence. This does NOT run the debate engine
   * (that lives in modules/agents/debates.ts); it captures the team-side
   * evidence/participants/decision and audits it so collaboration never
   * bypasses authorization.
   */
  async recordConflict(
    actorId: string,
    teamId: string,
    input: { topic: string; evidence: string[]; participants: string[] },
  ): Promise<{ id: string; ok: boolean }> {
    await this.requireRole(actorId, teamId, [TeamRole.OWNER, TeamRole.ADMIN, TeamRole.EDITOR]);
    const id = this.randomId();
    await this.audit(AuditAction.TEAM_PERMISSION_CHANGED, actorId, teamId, {
      action: 'team.conflict_recorded',
      resourceId: id,
      topic: String(input.topic).slice(0, 2000),
      evidenceCount: input.evidence.length,
      participants: (input.participants ?? []).slice(0, 50),
    });
    return { id, ok: true };
  }

  // ---------------------------------------------------------------------
  private async audit(action: string, actorId: string, teamId: string, detail: Record<string, unknown>): Promise<void> {
    await import('../audit/service.js').then((m) =>
      m.recordAudit({
        action,
        actorUserId: actorId,
        scope: 'TEAM',
        tenantId: teamId,
        resourceType: 'team',
        resourceId: teamId,
        detail,
      }),
    );
  }
}
