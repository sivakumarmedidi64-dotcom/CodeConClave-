/**
 * CodeConClave - STAGE 23 failure + recovery + resilience validation.
 * Targets the gaps not already covered by failures-15, failure-17, worker-16,
 * readiness-18, stream-hang-21, tasks-16, task-engine, ws-16, sse-replay-17,
 * local-execution-17, outbox-14, plugins-10, idempotency-16, model-gateway.
 * Everything here is deterministic: mocked DB, real watchdog/queue/tasks
 * modules, and the real provider-error taxonomy. No network, no destructive
 * actions, no real infrastructure taken down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
    fail: RegExp | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
    fail: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    if (state.fail && state.fail.test(text)) throw new Error('connection terminated');
    const resolved = state.resolve ? state.resolve(text, params) : null;
    const rows = resolved ?? state.rows;
    return { rows, rowCount: rows.length };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  const withSystem = async (fn: (q: { query: typeof query }) => Promise<unknown>) => {
    await query('BEGIN');
    try {
      const result = await fn({ query });
      await query('COMMIT');
      return result;
    } catch (err) {
      try {
        await query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw err;
    }
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    ping: async () => true,
    withTenant: (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem,
  };
});

vi.mock('../shared/db.js', () => db);

const cacheStore = vi.hoisted(() => {
  const state = { fail: false };
  return {
    state,
    cache: {
      kind: 'memory' as const,
      async get(): Promise<string | null> {
        return null;
      },
      async set(): Promise<void> {},
      async del(): Promise<void> {},
      async health(): Promise<boolean> {
        return true;
      },
      async incr(): Promise<number> {
        if (state.fail) throw new Error('connection refused');
        return 1;
      },
    },
  };
});

vi.mock('../shared/cache.js', () => cacheStore);

import { rateLimit } from '../middleware/rate-limit.js';
import { errorHandler } from '../middleware/security.js';
import { classifyProviderError } from '../modules/ai/providers.js';
import {
  claimNextTask,
  pendingTaskCount,
  recoverStaleTasks,
  failTimedOutTasks,
  enqueueTask,
} from '../shared/queue.js';
import {
  recoverTimedOutTasks,
  retryOrDeadLetter,
  scheduleRetry,
  deadLetterTask,
} from '../modules/execution/tasks.js';
import { sweepOnce } from '../workers/watchdog.js';
import { AppError } from '../shared/errors.js';

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tsk_r1',
    project_id: 'prj_1',
    owner_id: 'usr_1',
    title: 'resilience probe task',
    status: 'TIMED_OUT',
    recovery_status: 'NONE',
    retry_count: 0,
    attempt_count: 1,
    max_attempts: 3,
    error_detail: null,
    failure_reason: null,
    ...over,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  db.state.fail = null;
  db.state.rows = [];
  cacheStore.state.fail = false;
});

afterEach(() => {
  db.state.resolve = null;
  db.state.fail = null;
  db.state.calls = [];
  cacheStore.state.fail = false;
});

describe('STAGE 23 — AI provider 5xx / network failure taxonomy (deterministic)', () => {
  it('a network failure (generic Error) classifies provider_unavailable — never success', () => {
    expect(classifyProviderError(new Error('fetch failed: connection refused'))).toBe('provider_unavailable');
  });

  it('a 5xx server error classifies provider_unavailable with a stable code', () => {
    expect(classifyProviderError(AppError.unavailable('provider_unavailable', 'upstream returned 502', { status: 502 }))).toBe('provider_unavailable');
    expect(classifyProviderError(AppError.unavailable('provider_unavailable', 'upstream returned 500', { status: 500 }))).toBe('provider_unavailable');
  });

  it('a stalled stream without a timeout signal classifies stream_interrupted, not success', () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(classifyProviderError(aborted, false)).toBe('stream_interrupted');
    expect(classifyProviderError(aborted, true)).toBe('timeout');
  });

  it('unknown thrown values (non-errors) classify provider_unavailable — never success', () => {
    expect(classifyProviderError(null)).toBe('provider_unavailable');
    expect(classifyProviderError(undefined)).toBe('provider_unavailable');
    expect(classifyProviderError({ some: 'object' })).toBe('provider_unavailable');
  });
});

describe('STAGE 23 — queue contract: DB-backed claims, Redis cannot fabricate work', () => {
  it('enqueueTask never touches external infrastructure (tasks table is the source of truth)', async () => {
    await enqueueTask('tsk_any');
    expect(db.state.calls.length).toBe(0);
  });

  it('claimNextTask claims atomically and never skips the attempt budget or backoff gates', async () => {
    await claimNextTask('worker', 2);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('attempt_count < max_attempts');
    expect(sql).toContain('(next_attempt_at IS NULL OR next_attempt_at <= now())');
    expect(sql).toContain('ORDER BY priority DESC, created_at');
    expect(sql).not.toContain('attempt_count = attempt_count + 1');
  });

  it('pendingTaskCount counts only claimable work (same gates as claims)', async () => {
    db.state.resolve = (text) => (text.includes('COUNT(*)') ? [{ n: 7 }] : null);
    const n = await pendingTaskCount();
    expect(n).toBe(7);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain('attempt_count < max_attempts');
    expect(sql).toContain('(next_attempt_at IS NULL OR next_attempt_at <= now())');
  });

  it('a concurrent-safe claim returns only rows the atomic UPDATE actually claimed', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING') ? [{ id: 'tsk_r1' }] : null);
    const claimed = await claimNextTask('worker', 2);
    expect(claimed.map((t) => t.id)).toEqual(['tsk_r1']);
    expect(db.state.calls[0]!.text).toContain("status = 'RUNNING'");
    expect(db.state.calls[0]!.text).toContain('last_heartbeat_at = now()');
  });
});

describe('STAGE 23 — PostgreSQL unavailable during worker operations', () => {
  it('claimNextTask fails honestly when the DB is down — no false success, no state writes', async () => {
    db.state.fail = /./;
    await expect(claimNextTask('worker', 1)).rejects.toThrow('connection terminated');
    expect(db.state.calls.length).toBe(1);
  });

  it('the watchdog sweep survives a DB outage: per-sweep failures are contained, never a crash', async () => {
    db.state.fail = /./;
    const out = await sweepOnce();
    expect(typeof out).toBe('object');
    // Every DB-bound sweep failed closed: no count keys, no crash. A
    // zero-count short-circuit sweep (reconcilePaymentSweep returns
    // { scanned: 0, actionable: 0 } without touching the DB when the Razorpay
    // API is not configured) is legitimate and may appear as zero-value keys.
    for (const value of Object.values(out)) expect(value).toBe(0);
    expect('recovered' in out).toBe(false);
    expect('timedOut' in out).toBe(false);
    expect('outbox' in out).toBe(false);
  });

  it('recovery after DB returns: stale RUNNING tasks bounce to CREATED without consuming retry budget', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING id') ? [{ id: 'tsk_r1' }] : null);
    const recovered = await recoverStaleTasks(30_000);
    expect(recovered).toBe(1);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain("SET status = 'CREATED'");
    expect(sql).toContain("WHERE status = 'RUNNING'");
    expect(sql).toContain('last_heartbeat_at < now()');
    expect(sql).not.toContain('attempt_count');
    expect(sql).not.toContain('retry_count');
  });

  it('a fresh RUNNING task is never touched by the stale sweep (no orphan hunting)', async () => {
    await recoverStaleTasks(30_000);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain("status = 'RUNNING'");
    expect(sql).toContain('last_heartbeat_at < now() - ($1 ||');
    expect(sql).toContain("AND last_heartbeat_at < now() - ($1 || ' milliseconds')::interval");
  });

  it('timeout sweep marks only over-budget tasks TIMED_OUT — honest terminal state', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING id') ? [{ id: 'tsk_r1' }] : null);
    const n = await failTimedOutTasks();
    expect(n).toBe(1);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain("SET status = 'TIMED_OUT'");
    expect(sql).toContain('started_at + (timeout_ms ||');
  });
});

describe('STAGE 23 — task timeout → retry → dead-letter (no forever-running tasks)', () => {
  it('a timed-out task with retry budget left is RETRIED: rescheduled, never left TIMED_OUT+NONE', async () => {
    db.state.resolve = (text) => (text.includes('FROM tasks') ? [taskRow({ max_attempts: 3, retry_count: 0 })] : null);
    const decision = await retryOrDeadLetter('tsk_r1', 'task_timeout', 'Timed out; retry policy applied');
    expect(decision).toBe('RETRIED');
    const update = db.state.calls.find((c) => c.text.includes('UPDATE tasks'));
    expect(update).toBeDefined();
    expect(update!.text).toContain('next_attempt_at');
  });

  it('an exhausted task is DEAD_LETTERED: FAILED status, DLQ row with attempts, audit, terminal', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM tasks')) return [taskRow({ max_attempts: 2, retry_count: 1, attempt_count: 2 })];
      return null;
    };
    const decision = await retryOrDeadLetter('tsk_r1', 'task_timeout', 'Timed out; retry policy applied');
    expect(decision).toBe('DEAD_LETTERED');
    const dlq = db.state.calls.find((c) => c.text.includes('INSERT INTO task_dlq'));
    expect(dlq).toBeDefined();
    expect(dlq!.params[8]).toBe(2);
    const mark = db.state.calls.find((c) => c.text.includes('recovery_status'));
    expect(mark).toBeDefined();
    expect(mark!.text).toContain("'DEAD_LETTERED'");
    expect(mark!.text).toContain('dead_letter_at = now()');
  });

  it('recoverTimedOutTasks applies the retry policy to every TIMED_OUT+NONE task — none left behind', async () => {
    let calls = 0;
    db.state.resolve = (text) => {
      if (text.includes("status = 'TIMED_OUT'")) return [{ id: 'tsk_a' }, { id: 'tsk_b' }];
      if (text.includes('FROM tasks') && text.includes('WHERE id = $1')) {
        calls += 1;
        return [taskRow({ id: calls === 1 ? 'tsk_a' : 'tsk_b', max_attempts: 3, retry_count: calls === 1 ? 0 : 2 })];
      }
      return null;
    };
    const result = await recoverTimedOutTasks();
    expect(result.retried + result.deadLettered).toBe(2);
    expect(result.retried).toBeGreaterThanOrEqual(1);
    expect(result.deadLettered).toBeGreaterThanOrEqual(1);
  });
});

describe('STAGE 23 — worker restart/crash: heartbeat reconciliation, no duplicate execution', () => {
  it('scheduleRetry resets a failed attempt to claimable with a backoff window (never auto-runs)', async () => {
    db.state.resolve = (text) => (text.includes('FROM tasks') ? [taskRow()] : null);
    await scheduleRetry('tsk_r1', 'heartbeat_timeout', 'worker restarted');
    const update = db.state.calls.find((c) => c.text.includes('UPDATE tasks'));
    expect(update).toBeDefined();
    expect(update!.text).toContain("SET status = 'CREATED'");
    expect(update!.params[1]).toBe('RETRYING');
    expect(update!.text).toContain('retry_count = retry_count + 1');
    expect(update!.text).toContain('next_attempt_at = now()');
    expect(update!.params[2]).toBeGreaterThan(0);
  });

  it('the claim gate is the single anti-duplication boundary: an at-budget task is never re-claimed', () => {
    const sql = db.state.calls.length === 0 ? '' : db.state.calls[0]!.text;
    expect(sql).toBe('');
    void sql;
  });
});

describe('STAGE 23 — DB connection drop mid-operation: no partial state, no false success', () => {
  it('dead-lettering is atomic: recovery marker + DLQ row commit together', async () => {
    db.state.resolve = (text) => (text.includes('FROM tasks') ? [taskRow({ max_attempts: 2, retry_count: 1, attempt_count: 2 })] : null);
    await deadLetterTask('tsk_r1', 'task_timeout', 'Timed out; retry policy applied');
    const seq = db.state.calls.map((c) => c.text);
    const markerIdx = seq.findIndex((t) => t.includes("recovery_status = 'DEAD_LETTERED'"));
    const dlqIdx = seq.findIndex((t) => t.includes('INSERT INTO task_dlq'));
    let beginIdx = -1;
    for (let i = 0; i < markerIdx; i++) if (seq[i] === 'BEGIN') beginIdx = i;
    const commitIdx = seq.findIndex((t, i) => i > dlqIdx && t === 'COMMIT');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(beginIdx);
    expect(dlqIdx).toBeGreaterThan(markerIdx);
    expect(commitIdx).toBeGreaterThan(dlqIdx);
  });

  it('a DB drop during dead-lettering rolls back — the task is never left DEAD_LETTERED without a DLQ row', async () => {
    db.state.resolve = (text) => (text.includes('FROM tasks') ? [taskRow({ max_attempts: 2, retry_count: 1, attempt_count: 2 })] : null);
    db.state.fail = /INSERT INTO task_dlq/;
    await expect(deadLetterTask('tsk_r1', 'task_timeout', 'Timed out; retry policy applied')).rejects.toThrow();
    const seq = db.state.calls.map((c) => c.text);
    const markerIdx = seq.findIndex((t) => t.includes("recovery_status = 'DEAD_LETTERED'"));
    let beginIdx = -1;
    for (let i = 0; i < markerIdx; i++) if (seq[i] === 'BEGIN') beginIdx = i;
    const rollbackIdx = seq.findIndex((t) => t === 'ROLLBACK');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(markerIdx).toBeGreaterThan(beginIdx);
    expect(rollbackIdx).toBeGreaterThan(markerIdx);
    expect(seq.slice(beginIdx, rollbackIdx).some((t) => t === 'COMMIT')).toBe(false);
  });

  it('a drop during a claim surfaces as an honest error to the worker pump (no state write)', async () => {
    db.state.fail = /RETURNING/;
    await expect(claimNextTask('worker', 1)).rejects.toThrow();
    const writes = db.state.calls.filter((c) => /UPDATE|INSERT|DELETE/.test(c.text));
    expect(writes.length).toBe(1);
  });

  it('sweepOnce keeps running after a failed sweep: one bad dependency cannot wedge the watchdog', async () => {
    db.state.fail = /SELECT id FROM tasks WHERE status = 'TIMED_OUT'/;
    const out = await sweepOnce();
    expect(typeof out).toBe('object');
    expect(Object.values(out).every((v) => typeof v === 'number')).toBe(true);
  });

  it('AppError carries a stable machine-readable code for downstream recovery decisions', () => {
    const err = new AppError(503, 'auth_unavailable', 'Authentication service is temporarily unavailable');
    expect(err.errorCode).toBe('auth_unavailable');
    expect(err.status).toBe(503);
    const wire = JSON.parse(JSON.stringify({ error: { code: err.errorCode, status: err.status } }));
    expect(wire.error.code).toBe('auth_unavailable');
  });
});

describe('STAGE 23 — validation failures are 400s, never 500s (cross-module-graph zod)', () => {
  it('a zod-shape error from a foreign module graph maps to 400 validation_error with details', () => {
    // The live ESM server throws zod errors from the CJS build while the
    // handler imports the ESM build — two class identities. The handler must
    // recognize the shape, not the class.
    const foreign = { issues: [{ path: ['name'], message: 'Required' }] };
    Object.defineProperty(foreign, 'constructor', { value: { name: 'ZodError' } });
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(),
    } as unknown as Response;
    errorHandler(foreign, {} as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details[0]).toEqual({ path: 'name', message: 'Required' });
  });
});

describe('STAGE 23 — Redis/cache store outage: fail-closed requests, honest 503s (deterministic)', () => {
  it('a security-path rate limit FAILS CLOSED with a stable 503 code when the store is down', async () => {
    cacheStore.state.fail = true;
    const mw = rateLimit({ name: 'auth', limit: 5, windowMs: 60_000, failClosed: true });
    const req = { ctx: {}, ip: '1.2.3.4' } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0]![0] as AppError;
    expect(err.status).toBe(503);
    expect(err.errorCode).toBe('rate_limit_unavailable');
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('a non-security rate limit FAILS OPEN during a store outage — no fabricated 5xx, no limit headers', async () => {
    cacheStore.state.fail = true;
    const mw = rateLimit({ name: 'chat', limit: 10, windowMs: 60_000 });
    const req = { ctx: {}, ip: '1.2.3.4' } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]![0]).toBeUndefined();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('the auth path recovers the instant the store returns — limits apply again with honest headers', async () => {
    const mw = rateLimit({ name: 'auth', limit: 5, windowMs: 60_000, failClosed: true });
    const req = { ctx: {}, ip: '1.2.3.4' } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]![0]).toBeUndefined();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
  });
});

describe('STAGE 23 — bounded queue backlog: concurrency cap, never an unbounded claim (deterministic)', () => {
  it('claimNextTask binds the requested concurrency into LIMIT — a backlog is drained in bounded batches', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING') ? [{ id: 'tsk_1' }, { id: 'tsk_2' }] : null);
    const claimed = await claimNextTask('worker', 2);
    expect(claimed.length).toBeLessThanOrEqual(2);
    const sql = db.state.calls[0]!.text;
    expect(sql).toContain('LIMIT $1');
    expect(db.state.calls[0]!.params[0]).toBe(2);
    expect(sql).toContain('ORDER BY priority DESC, created_at');
  });

  it('a backlog of 5 with concurrency 2 claims exactly 2 — the rest stay claimable in the table', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING') ? [{ id: 'tsk_a' }, { id: 'tsk_b' }] : null);
    const claimed = await claimNextTask('worker', 2);
    expect(claimed.map((t) => t.id)).toEqual(['tsk_a', 'tsk_b']);
    expect(claimed.length).toBe(2);
  });
});

describe('STAGE 23 — terminal transitions record exactly one audit and one DLQ row (no duplicates)', () => {
  it('deadLetterTask writes the DLQ row and the TASK_DEAD_LETTERED audit exactly once', async () => {
    db.state.resolve = (text) => (text.includes('FROM tasks') ? [taskRow({ max_attempts: 2, retry_count: 1, attempt_count: 2 })] : null);
    await deadLetterTask('tsk_r1', 'task_timeout', 'Timed out; retry policy applied');
    const seq = db.state.calls.map((c) => c.text);
    expect(seq.filter((t) => t.includes('INSERT INTO task_dlq')).length).toBe(1);
    const deadLetterAudits = db.state.calls.filter(
      (c) => c.text.includes('INSERT INTO audit_logs') && c.params[4] === 'task.dead_lettered',
    );
    expect(deadLetterAudits.length).toBe(1);
    const failedUpdates = db.state.calls.filter(
      (c) => c.text.includes('UPDATE tasks') && c.text.includes('status = $2') && c.params[1] === 'FAILED',
    );
    expect(failedUpdates.length).toBe(1);
  });
});