/**
 * CodeConClave — audit foundation tests.
 * Covers: append-only INSERT into audit_logs, system scope, failure
 * resilience (audit never takes the request down), filtering. DB mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
    fail: boolean;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
    fail: false,
  };
  const query = async (text: string, params: unknown[] = []) => {
    if (state.fail) throw new Error('connection refused');
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

import { recordAudit, listAudit } from '../modules/audit/service.js';
import { AuditAction } from '@codeconclave/shared';

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  db.state.fail = false;
});

describe('recordAudit — append-only system-scoped insert', () => {
  it('writes a single INSERT INTO audit_logs with full context', async () => {
    await recordAudit({
      action: AuditAction.MEMORY_CREATED,
      actorUserId: 'u1',
      scope: 'USER',
      tenantId: 'u1',
      resourceType: 'memory',
      resourceId: 'm1',
      detail: { source: 'USE_STATED' },
      ip: '127.0.0.1',
      correlationId: 'trace-1',
    });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO audit_logs'))!;
    expect(insert).toBeDefined();
    expect(insert.params[2]).toBe('USER');
    expect(insert.params[3]).toBe('u1');
    expect(insert.params[4]).toBe(AuditAction.MEMORY_CREATED);
    expect(insert.params[7]).toContain('USE_STATED');
    expect(insert.params[8]).toBe('127.0.0.1');
    expect(insert.params[10]).toBe('trace-1');
    expect(insert.params[11]).toBe(true);
  });

  it('records an explicit failure flag when the action did not succeed', async () => {
    await recordAudit({
      action: 'exec.failed',
      scope: 'USER',
      actorUserId: 'u1',
      tenantId: 'u1',
      success: false,
    });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO audit_logs'))!;
    expect(insert.params[11]).toBe(false);
  });

  it('never throws when the database write fails (request survives)', async () => {
    db.state.fail = true;
    await expect(
      recordAudit({ action: 'test.event', scope: 'SYSTEM', actorUserId: null }),
    ).resolves.toBeUndefined();
  });

  it('never issues UPDATE/DELETE — the audit log is append-only by construction', async () => {
    await recordAudit({ action: 'test.event', scope: 'SYSTEM' });
    expect(db.state.calls.every((c) => /INSERT INTO audit_logs/.test(c.text))).toBe(true);
  });
});

describe('audit module is statically append-only', () => {
  it('service source contains only INSERT INTO audit_logs among writes', () => {
    const srcPath = fileURLToPath(new URL('../modules/audit/service.ts', import.meta.url));
    const src = readFileSync(srcPath, 'utf8');
    expect(src).toMatch(/INSERT INTO audit_logs/);
    expect(src).not.toMatch(/UPDATE\s+audit_logs/i);
    expect(src).not.toMatch(/DELETE\s+FROM\s+audit_logs/i);
    expect(src).not.toMatch(/TRUNCATE|DROP TABLE/i);
  });
});

describe('listAudit — filtered reads', () => {
  it('filters by actor when provided', async () => {
    const rows = await listAudit({ userId: 'u1' });
    expect(rows).toEqual([]);
    const call = db.state.calls.find((c) => c.text.includes('FROM audit_logs'))!;
    expect(call.text).toContain('actor_user_id = $1');
    expect(call.params[0]).toBe('u1');
  });

  it('caps the limit at 200', async () => {
    await listAudit({ limit: 9999 });
    const call = db.state.calls.find((c) => c.text.includes('FROM audit_logs'))!;
    expect(call.params.at(-2)).toBe(200);
  });

  it('combines action/resource filters', async () => {
    await listAudit({ action: 'memory.created', resourceType: 'memory', resourceId: 'm1' });
    const call = db.state.calls.find((c) => c.text.includes('FROM audit_logs'))!;
    expect(call.text).toContain('action = $1');
    expect(call.text).toContain('resource_type = $2');
    expect(call.text).toContain('resource_id = $3');
  });
});