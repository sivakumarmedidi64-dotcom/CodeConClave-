/**
 * CodeConClave — PHASE 16 performance instrumentation tests.
 * The instrumentation hooks (queue wait, memory retrieval, API latency) record
 * real measurements into the metrics snapshot. No claims are made about
 * production latency here — the hooks are verified to record, and the report
 * separates TARGET from MEASURED.
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

const retrieveMemoriesForPrompt = vi.hoisted(() => vi.fn(async () => ['mem 1']));
vi.mock('../modules/memory/service.js', () => ({ retrieveMemoriesForPrompt }));
const retrieveDnaForPrompt = vi.hoisted(() => vi.fn(async () => ['dna 1']));
vi.mock('../modules/dna/service.js', () => ({ retrieveDnaForPrompt }));

import { claimNextTask } from '../shared/queue.js';
import { retrieveScopedContext } from '../modules/memory/context.js';
import { apiLatency } from '../middleware/perf.js';
import { metricSnapshot, resetMetrics } from '../observability/metrics.js';
import express from 'express';
import type { Server } from 'node:http';

function taskRow(id: string, createdMsAgo: number): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    owner_id: 'u1',
    title: 't',
    risk_level: 'LOW',
    execution_mode: 'CLOUD',
    created_at: new Date(Date.now() - createdMsAgo),
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  resetMetrics();
});

afterEach(() => {
  db.state.resolve = null;
});

describe('queue wait instrumentation', () => {
  it('records queue_wait_ms when tasks are claimed', async () => {
    db.state.rows = [taskRow('tsk_1', 5_000), taskRow('tsk_2', 2_000)];
    const claimed = await claimNextTask('worker', 2);
    expect(claimed).toHaveLength(2);
    expect(claimNextTask).toBeDefined();
    const avg = metricSnapshot()['latency:queue_wait_ms'];
    expect(avg).toBeGreaterThanOrEqual(3_000); // (5000+2000)/2
    expect(avg).toBeLessThanOrEqual(3_600);
  });

  it('records nothing when the queue is empty', async () => {
    db.state.rows = [];
    await claimNextTask('worker', 1);
    expect(metricSnapshot()['latency:queue_wait_ms']).toBeUndefined();
  });
});

describe('memory retrieval instrumentation', () => {
  it('records memory_retrieve_ms for scoped context retrieval', async () => {
    await retrieveScopedContext('u1', { projectId: 'p1' });
    expect(retrieveMemoriesForPrompt).toHaveBeenCalledWith('u1', 'p1', 8);
    expect(metricSnapshot()['latency:memory_retrieve_ms']).toBeGreaterThanOrEqual(0);
  });
});

describe('API latency middleware', () => {
  it('records per-route latency under the route pattern', async () => {
    const app = express();
    app.use(apiLatency());
    app.get('/ping/:id', (_req, res) => {
      res.json({ ok: true });
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/ping/abc`);
      expect(res.status).toBe(200);
      const ms = metricSnapshot()['latency:api_GET_/ping/:id'];
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(typeof ms).toBe('number');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('records unmatched routes as unknown, never raw user input', async () => {
    const app = express();
    app.use(apiLatency());
    app.use((_req, res) => {
      res.status(404).end();
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      await fetch(`http://127.0.0.1:${port}/no/such/route`);
      expect(metricSnapshot()['latency:api_GET_unknown']).toBeGreaterThanOrEqual(0);
      expect(Object.keys(metricSnapshot()).some((k) => k.includes('/no/such/route'))).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});