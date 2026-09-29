/**
 * CodeConClave — usage foundation tests (PHASE 4A).
 * Covers: measured/estimated usage events, tenant isolation, plan limits
 * (free vs pro/team/enterprise), dashboard overview shape, and the rule
 * that usage is server-authoritative (never derived from client input).
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
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

import {
  recordUsage,
  getUsageOverview,
  incrementUsage,
  getUsage,
  checkFreeLimits,
  getStorageUsage,
  consumeFreeMessage,
  getRollingFreeUsage,
} from '../modules/workspace/service.js';
import { env } from '../config/env.js';

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ue1',
    owner_id: 'u1',
    name: 'messages',
    bucket: '2026-01-01',
    measured: true,
    unit: 'count',
    quantity: '1',
    meta: {},
    created_at: new Date(),
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
  vi.unstubAllGlobals();
});

describe('recordUsage — measured vs estimated', () => {
  it('writes a measured event and rolls it into the daily counter', async () => {
    await recordUsage('u1', 'messages', 2);
    const event = db.state.calls.find((c) => c.text.includes('INSERT INTO usage_events'))!;
    expect(event.params[1]).toBe('u1');
    expect(event.params[4]).toBe(true);
    expect(Number(event.params[5])).toBe(2);
    const counter = db.state.calls.find((c) => c.text.includes('INSERT INTO usage_counters'))!;
    expect(counter.text).toContain('ON CONFLICT (owner_id, name, bucket)');
    expect(counter.params[4]).toBe(2);
  });

  it('writes estimated events without touching counters', async () => {
    await recordUsage('u1', 'compute_cost_usd', 0.0042, { measured: false, unit: 'usd', meta: { modelId: 'm1' } });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO usage_events'))).toBe(true);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO usage_counters'))).toBe(false);
  });

  it('is tenant-scoped: owner_id is always the caller, never client input', async () => {
    await recordUsage('u1', 'tasks', 1);
    const event = db.state.calls.find((c) => c.text.includes('INSERT INTO usage_events'))!;
    expect(event.params[1]).toBe('u1');
    expect(event.params[2]).toBe('tasks');
  });
});

describe('getUsageOverview — dashboard payload', () => {
  it('aggregates measured usage, estimated compute and plan from the server', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'pro' }];
      if (text.includes('FROM usage_events')) {
        return [
          eventRow({ name: 'messages', quantity: '4', measured: true }),
          eventRow({ name: 'ai_input_tokens', quantity: '1200', measured: true, unit: 'tokens' }),
          eventRow({ name: 'ai_output_tokens', quantity: '300', measured: true, unit: 'tokens' }),
          eventRow({ name: 'compute_cost_usd', quantity: '0.01', measured: false, unit: 'usd' }),
        ];
      }
      if (text.includes('SELECT name, value FROM usage_counters')) return [{ name: 'messages', value: '4' }];
      if (text.includes('COALESCE(SUM(value), 0)')) return [{ value: '2048' }];
      return null;
    };
    const overview = await getUsageOverview('u1');
    expect(overview.plan).toBe('pro');
    expect(overview.measured.messagesToday).toBe(4);
    expect(overview.measured.aiInputTokens).toBe(1200);
    expect(overview.measured.aiOutputTokens).toBe(300);
    expect(overview.measured.storageBytes).toBe(2048);
    expect(overview.estimated).toEqual({ computeCostUsd: 0.01, sources: 1 });
    expect(overview.limits).toMatchObject({ dailyMessages: expect.any(Number), maxProjects: expect.any(Number), storageGb: expect.any(Number) });
    expect(overview.resetDate).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00.000Z$/);
  });

  it('never invents numbers: empty events yield zeros, not guesses', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('FROM usage_events')) return [];
      if (text.includes('SELECT name, value FROM usage_counters')) return [];
      if (text.includes('COALESCE(SUM(value), 0)')) return [{ value: '0' }];
      return null;
    };
    const overview = await getUsageOverview('u1');
    expect(overview.measured.messagesToday).toBe(0);
    expect(overview.estimated.computeCostUsd).toBe(0);
    expect(overview.estimated.sources).toBe(0);
  });

  it('counters override event sums for limit-relevant counters (server truth)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('FROM usage_events')) return [eventRow({ name: 'messages', quantity: '2' })];
      if (text.includes('SELECT name, value FROM usage_counters')) return [{ name: 'messages', value: '7' }];
      if (text.includes('COALESCE(SUM(value), 0)')) return [{ value: '0' }];
      return null;
    };
    const overview = await getUsageOverview('u1');
    expect(overview.measured.messagesToday).toBe(7);
  });
});

describe('plan limits — free vs pro/team/enterprise', () => {
  it('free users are limited once the rolling window is exhausted', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('FROM free_usage_windows')) return [{ window_start: new Date(Date.now() - 3600_000), used: 1000 }];
      return null;
    };
    await expect(checkFreeLimits('u1', 'message')).resolves.toMatchObject({ ok: false, reason: 'daily_message_limit', plan: 'free' });
  });

  it('pro, team and enterprise are never free-limited', async () => {
    for (const plan of ['pro', 'team', 'enterprise']) {
      db.state.resolve = (text) =>
        text.includes('SELECT plan_id FROM users') ? [{ plan_id: plan }] : null;
      await expect(checkFreeLimits('u1', 'message')).resolves.toMatchObject({ ok: true, plan });
    }
  });

  it('usage counters remain tenant-scoped', async () => {
    db.state.resolve = (text) => (text.includes('FROM usage_counters') ? [{ name: 'daily_messages', value: '1' }] : null);
    await incrementUsage('u2', 'daily_messages');
    await getUsage('u2');
    const read = db.state.calls.find((c) => c.text.includes('FROM usage_counters'))!;
    expect(read.params[0]).toBe('u2');
  });

  it('getStorageUsage is scoped to the caller', async () => {
    db.state.resolve = (text) => (text.includes('COALESCE(SUM(value), 0)') ? [{ value: '512' }] : null);
    await expect(getStorageUsage('u1')).resolves.toBe(512);
    const call = db.state.calls.find((c) => c.text.includes('COALESCE(SUM(value), 0)'))!;
    expect(call.params[0]).toBe('u1');
  });
});

describe('rolling free-usage window', () => {
  it('a fresh user starts with a full window', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM free_usage_windows')) return [];
      return null;
    };
    const usage = await getRollingFreeUsage('u1');
    expect(usage.used).toBe(0);
    expect(usage.limit).toBe(env.FREE_DAILY_MESSAGES);
    expect(usage.windowHours).toBe(env.FREE_USAGE_WINDOW_HOURS);
    expect(usage.remaining).toBe(env.FREE_DAILY_MESSAGES);
    expect(usage.windowStart).toBeNull();
  });

  it('consumes a message and reports remaining', async () => {
    db.state.resolve = (text) => {
      const t = text.toLowerCase();
      if (t.includes('insert into free_usage_windows')) return [{ used: 2, window_start: new Date() }];
      if (t.includes('from free_usage_windows')) return [];
      return null;
    };
    const result = await consumeFreeMessage('u1');
    expect(result.accepted).toBe(true);
    expect(result.usage.used).toBe(2);
    expect(result.usage.remaining).toBe(env.FREE_DAILY_MESSAGES - 2);
  });

  it('rejects when the window is exhausted (atomic guard)', async () => {
    db.state.resolve = (text) => {
      const t = text.toLowerCase();
      if (t.includes('insert into free_usage_windows')) return [];
      if (t.includes('from free_usage_windows')) return [{ window_start: new Date(Date.now() - 3600_000), used: env.FREE_DAILY_MESSAGES }];
      return null;
    };
    const result = await consumeFreeMessage('u1');
    expect(result.accepted).toBe(false);
    expect(result.usage.remaining).toBe(0);
  });

  it('surfaces the window deadline', async () => {
    const windowStart = new Date(Date.now() - 3600_000);
    db.state.resolve = (text) => (text.includes('FROM free_usage_windows') ? [{ window_start: windowStart, used: 3 }] : null);
    const usage = await getRollingFreeUsage('u1');
    expect(usage.windowStart).toBe(windowStart.toISOString());
    expect(usage.resetsAt).toBe(new Date(windowStart.getTime() + env.FREE_USAGE_WINDOW_HOURS * 3600_000).toISOString());
    expect(usage.remaining).toBe(env.FREE_DAILY_MESSAGES - 3);
  });

  it('overview includes the rolling window fields', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('FROM usage_events')) return [];
      if (text.includes('FROM usage_counters')) return [];
      if (text.includes('COALESCE(SUM(value), 0)')) return [{ value: '0' }];
      if (text.includes('FROM free_usage_windows')) return [{ window_start: new Date(Date.now() - 1000), used: 4 }];
      return null;
    };
    const overview = await getUsageOverview('u1');
    expect(overview.rolling.used).toBe(4);
    expect(overview.rolling.limit).toBe(env.FREE_DAILY_MESSAGES);
    expect(overview.rolling.windowHours).toBe(env.FREE_USAGE_WINDOW_HOURS);
    expect(overview.rolling.remaining).toBe(env.FREE_DAILY_MESSAGES - 4);
  });
});