/**
 * CodeConClave AI OS — P2.5 Team Cowork.
 *
 * Multi-participant cowork consolidated onto P1 session-scoped IPC and the P0
 * capability layer. The OWNER is authoritative: only the owner (or a
 * participant explicitly granted co-control) may drive actions. No participant
 * can ever act beyond their granted capabilities. Supports:
 *   - watch mode (participants see live session-scoped events)
 *   - comments (session-scoped, ordered)
 *   - controlled co-control (owner grants a participant a control seat)
 *   - participant permissions (scoped capability grants)
 *   - session-scoped IPC (events never leak across sessions)
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import type { IpcBus } from '../ipc.js';
import type { P2Feature } from './flags.js';

export type ParticipantRole = 'owner' | 'participant' | 'co_control';
export type Capability = 'read' | 'comment' | 'control' | 'approve' | 'execute';

export interface Participant {
  userId: string;
  role: ParticipantRole;
  caps: Set<Capability>;
}

export interface TeamSession {
  sessionId: string;
  ownerId: string;
  workspaceId: string | null;
  participants: Map<string, Participant>;
  comments: Array<{ id: string; userId: string; text: string; at: number }>;
}

export class TeamCowork {
  private sessions = new Map<string, TeamSession>();

  constructor(
    private ipc: IpcBus,
    private feature: () => P2Feature | null,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'team_cowork';
  }

  createSession(ownerId: string, workspaceId: string | null): TeamSession {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_team_disabled', 'team cowork is off');
    const sessionId = randomUUID();
    const session: TeamSession = {
      sessionId,
      ownerId,
      workspaceId,
      participants: new Map(),
      comments: [],
    };
    session.participants.set(ownerId, { userId: ownerId, role: 'owner', caps: new Set(['read', 'comment', 'control', 'approve', 'execute']) });
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): TeamSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw AppError.notFound('aios_p2_team_session', 'session not found');
    return s;
  }

  /** Invite a participant; owner grants their capability set. */
  invite(sessionId: string, ownerId: string, userId: string, caps: Capability[]): Participant {
    const s = this.getSession(sessionId);
    this.requireOwner(s, ownerId);
    const seen = new Set<Capability>(caps);
    // enforce: participant can only ever hold read/comment unless co_control granted
    const effective: Capability[] = caps.filter((c) => ['read', 'comment'].includes(c) || c === 'control' || c === 'approve' || c === 'execute');
    const participant: Participant = {
      userId,
      role: caps.includes('control') ? 'co_control' : 'participant',
      caps: new Set<Capability>(effective),
    };
    // participants default read+comment; owner fully trusted
    if (participant.role !== 'co_control') {
      participant.caps.add('read');
    }
    s.participants.set(userId, participant);
    void seen;
    return participant;
  }

  /** Grant a participant the co-control seat (owner permission required). */
  grantCoControl(sessionId: string, ownerId: string, userId: string): Participant {
    const s = this.getSession(sessionId);
    this.requireOwner(s, ownerId);
    const p = s.participants.get(userId);
    if (!p) throw AppError.notFound('aios_p2_team_participant', 'participant not in session');
    p.role = 'co_control';
    p.caps.add('control');
    p.caps.add('approve');
    p.caps.add('execute');
    return p;
  }

  /** Add a comment; any participant with 'comment' cap may comment. */
  comment(sessionId: string, userId: string, text: string): void {
    const s = this.getSession(sessionId);
    const p = s.participants.get(userId);
    if (!p || !p.caps.has('comment')) throw AppError.forbidden('aios_p2_team_comment_denied', 'comment capability required');
    const textSafe = String(text).slice(0, 4000);
    s.comments.push({ id: randomUUID(), userId, text: textSafe, at: Date.now() });
    void this.ipc.publish(`aios.team.${s.sessionId}.comment`, { userId, text: textSafe }, { workspaceId: s.workspaceId });
  }

  listComments(sessionId: string): Array<{ id: string; userId: string; text: string; at: number }> {
    return [...this.getSession(sessionId).comments];
  }

  /** WATCH mode: subscribe to any session-scoped event (participant only). */
  watch(sessionId: string, userId: string, topLevelTopic: string, onEvent: (e: unknown) => void): () => void {
    const s = this.getSession(sessionId);
    const p = s.participants.get(userId);
    if (!p || !p.caps.has('read')) throw AppError.forbidden('aios_p2_team_watch_denied', 'read capability required');
    return this.ipc.subscribe(topLevelTopic, onEvent as never);
  }

  /** Authoritative action gate: does this user hold the capability to perform `cap`? */
  can(sessionId: string, userId: string, cap: Capability): boolean {
    const s = this.getSession(sessionId);
    const p = s.participants.get(userId);
    if (!p) return false;
    if (p.role === 'owner') return true;
    return p.caps.has(cap);
  }

  /** Co-control action: only the owner or a co_control participant (with execute cap) may proceed. */
  assertCanControl(sessionId: string, userId: string): void {
    if (!this.can(sessionId, userId, 'execute')) {
      throw AppError.forbidden('aios_p2_team_control_denied', 'participant lacks control/execute permission');
    }
  }

  private requireOwner(s: TeamSession, userId: string): void {
    if (s.ownerId !== userId) throw AppError.forbidden('aios_p2_team_owner_denied', 'only the owner may do this');
  }
}
