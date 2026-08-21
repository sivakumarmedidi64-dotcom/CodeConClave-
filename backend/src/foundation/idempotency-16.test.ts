/**
 * CodeConClave — PHASE 16 idempotency tests.
 * Idempotency-Key server-side dedupe for offline-synced state changes:
 * first execution runs, identical retries replay the stored response, a key
 * reused with a different payload is rejected, failures never replay, and the
 * watchdog sweep bounds table growth. The route helper honors replay without
 * re-running the handler and never reports success for a failed operation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: rows ? rows.length : state.rows.length };
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

import { beginIdempotent, completeIdempotent, failIdempotent, expireIdempotencyKeys, hashPayload } from '../modules/idempotency/service.js';
import { withIdempotency, idempotencyKeyFrom } from '../modules/idempotency/route.js';

const USER = 'usr_16';
const KEY = 'k_offline_1';

function keyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'idk_1',
    key: KEY,
    user_id: USER,
    op: 'approval.decide',
    payload_hash: hashPayload('approval.decide', { approvalId: 'app_1', decision: 'APPROVE' }),
    status: 'PENDING',
    response: null,
    created_at: new Date(),
    completed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
});

afterEach(() => {
  db.state.resolve = null;
});

describe('beginIdempotent', () => {
  it('returns new for an unknown key and stores a PENDING row', async () => {
    const result = await beginIdempotent({ key: KEY, userId: USER, op: 'approval.decide', payload: { approvalId: 'app_1', decision: 'APPROVE' } });
    expect(result.outcome).toBe('new');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO idempotency_keys'))!;
    expect(insert).toBeDefined();
    expect(insert.text).toContain('ON CONFLICT (user_id, key)');
  });

  it('replays the stored response for a completed identical retry', async () => {
    db.state.resolve = (text) => (text.includes('FROM idempotency_keys') ? [keyRow({ status: 'COMPLETED', response: { approval: { id: 'app_1' } } })] : null);
    const result = await beginIdempotent({ key: KEY, userId: USER, op: 'approval.decide', payload: { approvalId: 'app_1', decision: 'APPROVE' } });
    expect(result.outcome).toBe('replay');
    expect((result as { response: unknown }).response).toEqual({ approval: { id: 'app_1' } });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO idempotency_keys'))).toBe(false);
  });

  it('rejects a key reused with a different payload (never silently executes)', async () => {
    db.state.resolve = (text) => (text.includes('FROM idempotency_keys') ? [keyRow()] : null);
    await expect(
      beginIdempotent({ key: KEY, userId: USER, op: 'approval.decide', payload: { approvalId: 'app_2', decision: 'REJECT' } }),
    ).rejects.toMatchObject({ errorCode: 'idempotency_key_reused' });
  });

  it('rejects a previously FAILED key', async () => {
    db.state.resolve = (text) => (text.includes('FROM idempotency_keys') ? [keyRow({ status: 'FAILED' })] : null);
    await expect(
      beginIdempotent({ key: KEY, userId: USER, op: 'approval.decide', payload: { approvalId: 'app_1', decision: 'APPROVE' } }),
    ).rejects.toMatchObject({ errorCode: 'idempotency_key_failed' });
  });

  it('rejects an empty or oversized key', async () => {
    await expect(beginIdempotent({ key: '   ', userId: USER, op: 'o', payload: {} })).rejects.toMatchObject({ errorCode: 'invalid_idempotency_key' });
    await expect(beginIdempotent({ key: 'x'.repeat(200), userId: USER, op: 'o', payload: {} })).rejects.toMatchObject({ errorCode: 'invalid_idempotency_key' });
  });
});

describe('completeIdempotent / failIdempotent', () => {
  it('stores the response for replay', async () => {
    await completeIdempotent(KEY, USER, { ok: true });
    const update = db.state.calls.find((c) => c.text.includes('SET status = \'COMPLETED\''))!;
    expect(update).toBeDefined();
    expect(update.params[2]).toBe('{"ok":true}');
  });

  it('marks failures so they never replay', async () => {
    await failIdempotent(KEY, USER);
    const update = db.state.calls.find((c) => c.text.includes("SET status = 'FAILED'"))!;
    expect(update).toBeDefined();
  });
});

describe('expireIdempotencyKeys', () => {
  it('deletes keys older than the TTL window', async () => {
    db.state.rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const count = await expireIdempotencyKeys();
    expect(count).toBe(3);
    expect(db.state.calls.some((c) => c.text.includes('DELETE FROM idempotency_keys'))).toBe(true);
  });
});

describe('withIdempotency (route helper)', () => {
  it('executes without a key and reports the result', async () => {
    const result = await withIdempotency({
      op: 'approval.decide',
      key: undefined,
      userId: USER,
      payload: {},
      run: async () => ({ ok: true }),
    });
    expect(result).toEqual({ outcome: 'executed', response: { ok: true } });
  });

  it('executes once, completes the key, and replays on retry without re-running', async () => {
    let runs = 0;
    const run = async () => {
      runs++;
      return { approval: { id: 'app_1' } };
    };
    // First query sees no existing key; the post-insert select and the retry
    // see the completed row.
    let keyQueries = 0;
    db.state.resolve = (text) => {
      if (!text.includes('FROM idempotency_keys')) return null;
      keyQueries++;
      if (keyQueries === 1) return null;
      return [keyRow({ status: 'COMPLETED', response: { approval: { id: 'app_1' } } })];
    };
    const first = await withIdempotency({ op: 'approval.decide', key: KEY, userId: USER, payload: { approvalId: 'app_1', decision: 'APPROVE' }, run });
    expect(first.outcome).toBe('executed');
    expect(runs).toBe(1);
    const second = await withIdempotency({ op: 'approval.decide', key: KEY, userId: USER, payload: { approvalId: 'app_1', decision: 'APPROVE' }, run });
    expect(second.outcome).toBe('replay');
    expect(second.response).toEqual({ approval: { id: 'app_1' } });
    expect(runs).toBe(1);
  });

  it('marks the key failed and rethrows when the handler errors', async () => {
    await expect(
      withIdempotency({
        op: 'approval.decide',
        key: KEY,
        userId: USER,
        payload: {},
        run: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(db.state.calls.some((c) => c.text.includes("SET status = 'FAILED'"))).toBe(true);
  });
});

describe('idempotencyKeyFrom', () => {
  it('reads and trims the Idempotency-Key header', () => {
    expect(idempotencyKeyFrom({ headers: { 'idempotency-key': '  abc  ' } })).toBe('abc');
    expect(idempotencyKeyFrom({ headers: { 'idempotency-key': '  ' } })).toBeUndefined();
    expect(idempotencyKeyFrom({ headers: {} })).toBeUndefined();
  });
});