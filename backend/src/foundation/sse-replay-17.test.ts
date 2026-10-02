/**
 * CodeConClave — SSE Last-Event-ID replay tests (PHASE 17).
 * The chat SSE stream now emits `id: msg_<messageId>` on `done`; a follow-up
 * request carrying `Last-Event-ID: msg_<id>` replays the assistant/coworker
 * messages persisted after that anchor (missed while disconnected) as delta
 * frames with their own ids. This file pins the replay contract:
 *   - replay returns ONLY messages after the anchor, in ASC order
 *   - anchor must exist, be undeleted, and belong to the requesting user's
 *     conversation (ownership is enforced in SQL — no tenant breakout)
 *   - malformed ids / unknown anchors / wrong conversations replay nothing
 *   - user messages are never replayed; deleted messages are never replayed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? [], rowCount: (rows ?? []).length };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { replayMissedMessages } from '../modules/conversations/service.js';

function anchorRow(createdAt: Date) {
  return { created_at: createdAt };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('replayMissedMessages — SSE Last-Event-ID replay', () => {
  it('replays only assistant/coworker messages persisted after the anchor, ASC, with ids', async () => {
    const anchorAt = new Date('2026-08-15T10:00:00Z');
    db.state.resolve = (text, params) => {
      if (text.includes('JOIN conversations c')) return [anchorRow(anchorAt)];
      if (text.includes('role IN')) {
        return [
          { id: 'm_after1', content: 'missed answer A' },
          { id: 'm_after2', content: 'missed answer B' },
        ];
      }
      return null;
    };
    const replayed = await replayMissedMessages('u1', 'c1', 'msg_m_anchor');
    expect(replayed).toEqual([
      { id: 'm_after1', content: 'missed answer A' },
      { id: 'm_after2', content: 'missed answer B' },
    ]);
    const replayCall = db.state.calls.find((c) => c.text.includes('role IN'))!;
    expect(replayCall.text).toContain('created_at > $2');
    expect(replayCall.text).toContain('ORDER BY created_at ASC');
    expect(replayCall.params).toEqual(['c1', anchorAt]);
    const anchorCall = db.state.calls.find((c) => c.text.includes('JOIN conversations c'))!;
    expect(anchorCall.text).toContain('c.owner_id = $3');
    expect(anchorCall.params).toEqual(['m_anchor', 'c1', 'u1']);
  });

  it('replays nothing when the anchor belongs to a different user (ownership enforced in SQL)', async () => {
    db.state.resolve = (text) => (text.includes('JOIN conversations c') ? [] : null);
    const replayed = await replayMissedMessages('u_attacker', 'c_other_owner', 'msg_m_anchor');
    expect(replayed).toEqual([]);
    const anchorCall = db.state.calls.find((c) => c.text.includes('JOIN conversations c'))!;
    expect(anchorCall.params[2]).toBe('u_attacker');
  });

  it('replays nothing for a malformed Last-Event-ID (no msg_ prefix or empty anchor)', async () => {
    expect(await replayMissedMessages('u1', 'c1', 'evt_42')).toEqual([]);
    expect(await replayMissedMessages('u1', 'c1', 'msg_')).toEqual([]);
    expect(await replayMissedMessages('u1', 'c1', '')).toEqual([]);
    expect(db.state.calls).toHaveLength(0);
  });

  it('replays nothing without a conversation id', async () => {
    expect(await replayMissedMessages('u1', undefined, 'msg_m_anchor')).toEqual([]);
    expect(db.state.calls).toHaveLength(0);
  });

  it('replays nothing when the anchor message is unknown or deleted', async () => {
    db.state.resolve = (text) => (text.includes('JOIN conversations c') ? [] : null);
    expect(await replayMissedMessages('u1', 'c1', 'msg_m_ghost')).toEqual([]);
  });

  it('passes the anchor timestamp as a strict lower bound (never replays the anchor)', async () => {
    const anchorAt = new Date('2026-08-15T10:00:00Z');
    db.state.resolve = (text, params) => {
      if (text.includes('JOIN conversations c')) return [anchorRow(anchorAt)];
      if (text.includes('role IN')) {
        const rows = [
          { id: 'm_anchor', content: 'the anchor itself', created_at: anchorAt },
          { id: 'm_after1', content: 'real missed message', created_at: new Date('2026-08-15T10:01:00Z') },
        ];
        return rows.filter((r) => r.created_at.getTime() > (params[1] as Date).getTime());
      }
      return null;
    };
    const replayed = await replayMissedMessages('u1', 'c1', 'msg_m_anchor');
    expect(replayed.map((r) => r.id)).toEqual(['m_after1']);
    const replayCall = db.state.calls.find((c) => c.text.includes('role IN'))!;
    expect(replayCall.text).toContain('created_at > $2');
    expect(replayCall.params[1]).toBe(anchorAt);
  });
});