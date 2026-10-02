/**
 * CodeConClave — PKG-25 — autonomy ownership-boundary regression tests.
 *
 * The real-infrastructure proof harness must anchor to the CALLER's own
 * projects only. When a userId is passed to `runRealHarness`, the anchor query
 * must be scoped with `owner_id = $1` and, when the caller owns no project, the
 * harness must report anchorFound=false — never fall back to another tenant's
 * project (no cross-user privilege escalation when the gate is enabled).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    projects: Array<{ owner_id: string; pid: string }>;
  } = {
    calls: [],
    projects: [],
  };
  const selectRows = (text: string, params: unknown[]): Array<Record<string, unknown>> => {
    if (text.includes('FROM projects p')) {
      const owned = state.projects.filter((r) => r.owner_id === String(params[0]));
      return owned.length ? [owned[0]] : [];
    }
    return [];
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = selectRows(text, params);
    return { rows, rowCount: rows.length };
  };
  const queryMany = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    return selectRows(text, params);
  };
  const client = { query, queryMany, queryOne: async () => null };
  return {
    state,
    pool: { query },
    queryMany,
    queryOne: async () => null,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn(client),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn(client),
  };
});
vi.mock('../../shared/db.js', () => db);

import { runRealHarness } from './harness-real.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.projects = [];
});

describe('real harness ownership boundary', () => {
it('scopes the anchor query to the requesting user (owner_id = $1)', async () => {
    db.state.projects = [
      { owner_id: 'u1', pid: 'prj-1' },
      { owner_id: 'u2', pid: 'prj-2' },
    ];
    await runRealHarness('u1');
    const anchorCall = db.state.calls.find((c) => c.text.includes('FROM projects p'))!;
    expect(anchorCall).toBeTruthy();
    expect(anchorCall.text).toContain('AND p.owner_id = $1');
    expect(anchorCall.params[0]).toBe('u1');
  });

  it('reports anchorFound=false when the caller owns no project (never borrows another tenant)', async () => {
    db.state.projects = [{ owner_id: 'u2', pid: 'prj-2' }];
    const result = await runRealHarness('u1');
    expect(result!.dbReachable).toBe(true);
    expect(result!.anchorFound).toBe(false);
    expect(result!.cleanup.detail).toContain('no anchor');
    const anchorCall = db.state.calls.find((c) => c.text.includes('FROM projects p'))!;
    expect(anchorCall.params[0]).toBe('u1');
  });
});