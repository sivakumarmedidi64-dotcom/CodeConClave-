/**
 * CodeConClave — PHASE 16 task durability tests.
 * Attempt checkpoints (save/latest), the started_at stamp fix (the timeout
 * sweep is gated on started_at IS NOT NULL — long-running tasks must never
 * run forever), and heartbeat refresh between orchestrator stages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: 0 };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

import { beginAttempt, saveAttemptCheckpoint, latestCheckpoint } from '../modules/execution/tasks.js';

const TASK = 'tsk_16';
const ATTEMPT = 'atp_16';

function attemptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTEMPT,
    task_id: TASK,
    attempt_number: 1,
    started_at: new Date(),
    finished_at: null,
    result: null,
    error_code: null,
    output_summary: null,
    checkpoint: null,
    checkpointed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
});

afterEach(() => {
  db.state.resolve = null;
});

describe('beginAttempt — durability stamp', () => {
  it('stamps started_at on the first claim so the timeout sweep can fire', async () => {
    db.state.resolve = (text) => (text.includes('FROM task_attempts') ? [{ id: ATTEMPT }] : null);
    await beginAttempt(TASK);
    const bump = db.state.calls.find((c) => c.text.includes('attempt_count = attempt_count + 1'))!;
    expect(bump.text).toContain('started_at = COALESCE(started_at, now())');
    expect(bump.text).toContain('last_heartbeat_at = now()');
  });
});

describe('attempt checkpoints', () => {
  it('persists a checkpoint with stage progress and run ids', async () => {
    await saveAttemptCheckpoint(ATTEMPT, { stageIndex: 2, runIdsByOrder: { '0': 'crw_0', '1': 'crw_1' } });
    const update = db.state.calls.find((c) => c.text.includes('SET checkpoint = $2::jsonb'))!;
    expect(update).toBeDefined();
    const parsed = JSON.parse(update.params[1] as string) as { stageIndex: number; runIdsByOrder: Record<string, string> };
    expect(parsed.stageIndex).toBe(2);
    expect(parsed.runIdsByOrder['1']).toBe('crw_1');
  });

  it('returns the latest checkpoint of a previous attempt (never the current one)', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM task_attempts') && text.includes('checkpointed_at IS NOT NULL')
        ? [{ checkpoint: { stageIndex: 1, runIdsByOrder: { '0': 'crw_old' } } }]
        : null;
    const cp = await latestCheckpoint(TASK, 'atp_current');
    expect(cp).toEqual({ stageIndex: 1, runIdsByOrder: { '0': 'crw_old' } });
    const call = db.state.calls.find((c) => c.text.includes('checkpointed_at IS NOT NULL'))!;
    expect(call.params[1]).toBe('atp_current');
  });

  it('returns null when the previous checkpoint is missing or malformed', async () => {
    db.state.resolve = (text) => (text.includes('FROM task_attempts') ? [{ checkpoint: null }] : null);
    expect(await latestCheckpoint(TASK, 'atp_x')).toBeNull();
    db.state.resolve = (text) => (text.includes('FROM task_attempts') ? [{ checkpoint: { stageIndex: 'x' } }] : null);
    expect(await latestCheckpoint(TASK, 'atp_x')).toBeNull();
    db.state.resolve = (text) => (text.includes('FROM task_attempts') ? [] : null);
    expect(await latestCheckpoint(TASK, 'atp_x')).toBeNull();
  });

  it('drops non-string run ids from a checkpoint (defensive parse)', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM task_attempts')
        ? [{ checkpoint: { stageIndex: 3, runIdsByOrder: { '0': 'crw_ok', '1': 42, '2': null } } }]
        : null;
    const cp = await latestCheckpoint(TASK, 'atp_x');
    expect(cp?.runIdsByOrder).toEqual({ '0': 'crw_ok' });
    expect(cp?.stageIndex).toBe(3);
  });
});