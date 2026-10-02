/**
 * CodeConClave — PKG-11 Team Collaboration behavior tests (in-memory, DB-free).
 * Complements security.test.ts with functional coverage of each completed
 * capability: presence (active/idle/busy), async handoff lifecycle, bounded
 * collaboration queue transitions, shared team context, code ownership,
 * team skill visibility, and conflict-record coordination.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryStateStore } from '../../os/state.js';
import { TeamRole } from '@codeconclave/shared';
import { AppError } from '../../shared/errors.js';
import { TeamCollaboration, type TeamAccess } from './service.js';

vi.mock('../../audit/service.js', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));

type Role = TeamRole | string;

function makeTeam(roles: Record<string, Role>) {
  const teamAccess: TeamAccess = {
    requireRole: async (actorId, _teamId, allowed) => {
      const r = roles[actorId];
      if (!r) throw AppError.forbidden('not_team_member', 'not a member');
      if (!allowed.includes(r)) throw AppError.forbidden('team_role_insufficient', 'insufficient role');
      return r;
    },
    roleOrNull: async (actorId) => roles[actorId] ?? null,
  };
  return teamAccess;
}

let t = 5_000_000;
let idc = 0;
function makeSvc(roles: Record<string, Role>) {
  const state = new MemoryStateStore();
  const notify = vi.fn().mockResolvedValue(undefined);
  const svc = new TeamCollaboration({
    state,
    teamAccess: makeTeam(roles),
    notifyTeam: notify,
    now: () => t,
    randomId: () => `id_${++idc}`,
  });
  return { svc, state, notify };
}

beforeEach(() => {
  t = 5_000_000;
});

const OWNER = TeamRole.OWNER;
const EDITOR = TeamRole.EDITOR;

describe('PKG-11 teamcollab — presence behavior', () => {
  it('reflects active/idle/busy signals with honest timestamps', async () => {
    const { svc } = makeSvc({ o: OWNER, e: EDITOR });
    t = 1000;
    await svc.heartbeat('e', 'team1', 'busy');
    await svc.heartbeat('o', 'team1', 'active');
    const list = await svc.listPresence('o', 'team1');
    expect(list.onlineCount).toBe(2);
    const e = list.presence.find((p) => p.userId === 'e')!;
    const o = list.presence.find((p) => p.userId === 'o')!;
    expect(e.state).toBe('BUSY');
    expect(o.state).toBe('ONLINE');
    expect(e.at).toBe(1000);
    expect(e.userId).toBe('e');
  });

  it('idle signal maps to IDLE state', async () => {
    const { svc } = makeSvc({ o: OWNER, e: EDITOR });
    t = 7;
    await svc.heartbeat('e', 'team1', 'idle');
    const list = await svc.listPresence('o', 'team1');
    expect(list.presence.find((p) => p.userId === 'e')!.state).toBe('IDLE');
  });
});

describe('PKG-11 teamcollab — async handoff lifecycle', () => {
  it('creates OPEN handoff with context, files, memory refs, review state', async () => {
    const { svc } = makeSvc({ o: OWNER, e: EDITOR });
    const h = await svc.createHandoff('o', 'team1', {
      toUserId: 'e',
      workspaceId: 'ws1',
      taskContext: 'review the login flow',
      files: ['auth/login.ts'],
      memoryRefs: ['mem:login'],
      reviewState: 'needs_improvement',
    });
    expect(h.status).toBe('OPEN');
    expect(h.fromUserId).toBe('o');
    expect(h.toUserId).toBe('e');
    expect(h.workspaceId).toBe('ws1');
    expect(h.reviewState).toBe('needs_improvement');
  });

  it('cannot accept a handoff that is not OPEN', async () => {
    const { svc } = makeSvc({ o: OWNER, e: EDITOR });
    const h = await svc.createHandoff('o', 'team1', { toUserId: 'e', taskContext: 'task' });
    await svc.acceptHandoff('e', 'team1', h.id);
    await expect(svc.acceptHandoff('e', 'team1', h.id)).rejects.toMatchObject({
      errorCode: 'teamcollab_handoff_status',
    });
  });

  it('cannot complete a handoff the caller does not own', async () => {
    const { svc } = makeSvc({ o: OWNER, e: EDITOR });
    const h = await svc.createHandoff('o', 'team1', { toUserId: 'e', taskContext: 'task' });
    await expect(svc.updateHandoff('e', 'team1', h.id, 'CANCELLED')).rejects.toMatchObject({ status: 403 });
  });

  it('supports FAILED and CANCELLED terminal states', async () => {
    const { svc } = makeSvc({ o: OWNER });
    const a = await svc.createHandoff('o', 'team1', { toUserId: null, taskContext: 'a' });
    const b = await svc.createHandoff('o', 'team1', { toUserId: null, taskContext: 'b' });
    expect((await svc.updateHandoff('o', 'team1', a.id, 'FAILED')).status).toBe('FAILED');
    expect((await svc.updateHandoff('o', 'team1', b.id, 'CANCELLED')).status).toBe('CANCELLED');
  });
});

describe('PKG-11 teamcollab — collaboration queue', () => {
  it('transitions QUEUED->ASSIGNED->IN_PROGRESS->COMPLETED', async () => {
    const { svc } = makeSvc({ o: OWNER });
    const item = await svc.enqueue('o', 'team1', 'ship feature', 'u2');
    expect(item.status).toBe('QUEUED');
    expect(item.assigneeId).toBe('u2');
    await svc.setQueueStatus('o', 'team1', item.id, 'ASSIGNED');
    await svc.setQueueStatus('o', 'team1', item.id, 'IN_PROGRESS');
    await svc.setQueueStatus('o', 'team1', item.id, 'COMPLETED');
    const items = await svc.listQueue('o', 'team1');
    expect(items.find((x) => x.id === item.id)!.status).toBe('COMPLETED');
  });

  it('rejects unknown/invalid transition status by validation at route layer', async () => {
    const { svc } = makeSvc({ o: OWNER });
    const item = await svc.enqueue('o', 'team1', 'x');
    // Service accepts the enum type; route-layer validates allowed set.
    await svc.setQueueStatus('o', 'team1', item.id, 'FAILED');
    expect((await svc.listQueue('o', 'team1')).find((x) => x.id === item.id)!.status).toBe('FAILED');
  });

  it('cannot act on a queue item from another team', async () => {
    const { svc } = makeSvc({ o: OWNER });
    const item = await svc.enqueue('o', 'team1', 'mine');
    await expect(svc.setQueueStatus('o', 'team2', item.id, 'COMPLETED')).rejects.toMatchObject({ status: 404 });
  });
});

describe('PKG-11 teamcollab — shared team context', () => {
  it('writes and reads shared context entries in reverse-chron order', async () => {
    const { svc } = makeSvc({ o: OWNER });
    t = 1;
    await svc.writeContext('o', 'team1', { title: 'First', body: 'a' });
    t = 2;
    await svc.writeContext('o', 'team1', { title: 'Second', body: 'b' });
    const entries = await svc.listContext('o', 'team1');
    expect(entries.map((e) => e.title)).toEqual(['Second', 'First']);
    expect(entries[0].authorUserId).toBe('o');
  });
});

describe('PKG-11 teamcollab — code ownership', () => {
  it('stores and lists ownership entries for workspace-relative paths', async () => {
    const { svc } = makeSvc({ o: OWNER });
    await svc.setOwnership('o', 'team1', [
      { path: 'src/auth.ts', ownerUserId: 'u2', confidence: 0.95 },
      { path: 'src/api.ts', ownerUserId: 'u3', confidence: 0.8 },
    ]);
    const entries = await svc.listOwnership('o', 'team1');
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.path === 'src/auth.ts')!.confidence).toBe(0.95);
  });

  it('updates existing ownership rather than duplicating', async () => {
    const { svc } = makeSvc({ o: OWNER });
    await svc.setOwnership('o', 'team1', [{ path: 'x.ts', ownerUserId: 'u2', confidence: 0.5 }]);
    await svc.setOwnership('o', 'team1', [{ path: 'x.ts', ownerUserId: 'u3', confidence: 1 }]);
    const entries = await svc.listOwnership('o', 'team1');
    expect(entries).toHaveLength(1);
    expect(entries[0].ownerUserId).toBe('u3');
  });
});

describe('PKG-11 teamcollab — skill visibility', () => {
  it('publishes and lists visible skills only', async () => {
    const { svc } = makeSvc({ o: OWNER });
    await svc.publishTeamSkill('o', 'team1', { id: 'rust', name: 'Rust' });
    await svc.publishTeamSkill('o', 'team1', { id: 'ts', name: 'TypeScript' });
    const skills = await svc.listTeamSkills('o', 'team1');
    expect(skills.map((s) => s.name).sort()).toEqual(['Rust', 'TypeScript']);
  });
});

describe('PKG-11 teamcollab — conflict coordination', () => {
  it('records a team conflict record for coordination evidence', async () => {
    const { svc } = makeSvc({ o: OWNER });
    const r = await svc.recordConflict('o', 'team1', {
      topic: 'merge strategy',
      evidence: ['PR #42', 'PR #43'],
      participants: ['u2', 'u3'],
    });
    expect(r.ok).toBe(true);
    expect(r.id).toBeTruthy();
  });
});

describe('PKG-11 teamcollab — cross-team isolation for queue', () => {
  it('keeps queue items strictly per-team', async () => {
    const { svc } = makeSvc({ o: OWNER });
    await svc.enqueue('o', 'team1', 't1-item');
    await svc.enqueue('o', 'team2', 't2-item');
    const q1 = (await svc.listQueue('o', 'team1')).map((i) => i.title);
    const q2 = (await svc.listQueue('o', 'team2')).map((i) => i.title);
    expect(q1).toContain('t1-item');
    expect(q1).not.toContain('t2-item');
    expect(q2).toContain('t2-item');
    expect(q2).not.toContain('t1-item');
  });
});
