/**
 * CodeConClave — watchdog stale-recovery regression tests.
 *
 * The sweeper previously refreshed EVERY RUNNING heartbeat before looking for
 * stale ones, so recoverStaleTasks could never fire and a crashed worker's
 * task stayed RUNNING forever. The sweep must only reclaim; liveness comes
 * from the worker's own touchTask. Claim also stamps started_at so the
 * timeout sweep bounds tasks that crash before beginAttempt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], rows: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const resolved = state.resolve ? state.resolve(text, params) : null;
    const rows = resolved ?? state.rows;
    return { rows, rowCount: rows.length };
  };
  return {
    state,
    pool: { query },
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    withTenant: (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
vi.mock('../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sweepOnce } from '../workers/watchdog.js';
import { claimNextTask, recoverStaleTasks } from '../shared/queue.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('watchdog stale recovery is live (no heartbeat whitewash)', () => {
  it('sweepOnce never refreshes RUNNING heartbeats itself', async () => {
    db.state.resolve = () => [];
    const out = await sweepOnce();
    expect(out).not.toHaveProperty('heartbeats');
    const whitewash = db.state.calls.filter((c) =>
      c.text.includes('UPDATE tasks SET last_heartbeat_at = now() WHERE'),
    );
    expect(whitewash).toEqual([]);
  });

  it('sweepOnce still runs the stale-recovery sweep', async () => {
    db.state.resolve = (text) => (text.includes('recovered_heartbeat_timeout') ? [{ id: 'tsk_old' }] : []);
    const out = await sweepOnce();
    expect(out.recovered).toBe(1);
  });

  it('a crashed worker task (stale heartbeat) is reclaimed to CREATED', async () => {
    db.state.resolve = (text) =>
      text.includes('recovered_heartbeat_timeout') ? [{ id: 'tsk_crashed' }] : [];
    expect(await recoverStaleTasks(30_000)).toBe(1);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain("SET status = 'CREATED'");
    expect(sql).toContain("WHERE status = 'RUNNING'");
    expect(sql).toContain('last_heartbeat_at < now()');
  });

  it('claim stamps started_at so the timeout sweep bounds pre-attempt crashes', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING') ? [{ id: 'tsk_1' }] : null);
    await claimNextTask('worker-1', 1);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain("status = 'RUNNING'");
    expect(sql).toContain('started_at = COALESCE(started_at, now())');
  });
});
