/**
 * CodeConClave — workspace foundation tests (PHASE 3).
 * Covers: versioned workspace state (upsert, optimistic-lock 409 conflicts,
 * read-back, owner scoping), preferences merge + conflict detection,
 * server-authoritative usage counters and free-limit checks.
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
  setWorkspaceState,
  getWorkspaceState,
  getWorkspaceStateDetailed,
  listWorkspaceState,
  updatePreferences,
  getPreferences,
  getPreferencesDetailed,
  incrementUsage,
  getUsage,
  checkFreeLimits,
  contextIndicator,
} from '../modules/workspace/service.js';

function wsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ws1',
    owner_id: 'u1',
    key: 'current_conversation',
    value: { conversationId: 'c1' },
    version: 2,
    updated_at: new Date(),
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

describe('workspace state — versioned persistence + conflict detection', () => {
  it('upserts a key on first write with version 1 and echoes the value', async () => {
    db.state.resolve = (text) => (text.includes('INSERT INTO workspace_state') ? [wsRow({ version: 1 })] : null);
    const entry = await setWorkspaceState('u1', 'current_conversation', { conversationId: 'c1' });
    expect(entry).toMatchObject({ key: 'current_conversation', value: { conversationId: 'c1' }, version: 1 });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO workspace_state'))!;
    expect(insert.params[1]).toBe('u1');
    expect(insert.text).toContain('ON CONFLICT (owner_id, key)');
    expect(JSON.parse(String(insert.params[3]))).toEqual({ conversationId: 'c1' });
  });

  it('bumps version on a second write (upsert path)', async () => {
    db.state.resolve = (text) => (text.includes('INSERT INTO workspace_state') ? [wsRow({ version: 3 })] : null);
    const entry = await setWorkspaceState('u1', 'current_conversation', { conversationId: 'c2' });
    expect(entry.version).toBe(3);
  });

  it('optimistic lock: matching baseVersion updates in place and bumps the version', async () => {
    db.state.resolve = (text) => (text.includes('UPDATE workspace_state SET value') ? [wsRow({ version: 3 })] : null);
    const entry = await setWorkspaceState('u1', 'current_conversation', { conversationId: 'c3' }, 2);
    expect(entry.version).toBe(3);
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE workspace_state SET value'))!;
    expect(upd.text).toContain('version = $4');
    expect(upd.params[3]).toBe(2);
  });

  it('optimistic lock: stale baseVersion raises 409 workspace_conflict with current state', async () => {
    db.state.resolve = (text) => {
      if (text.includes('UPDATE workspace_state SET value')) return [];
      if (text.includes('SELECT key, value, version, updated_at FROM workspace_state')) return [wsRow()];
      return null;
    };
    await expect(setWorkspaceState('u1', 'current_conversation', { conversationId: 'c4' }, 1)).rejects.toMatchObject({
      status: 409,
      errorCode: 'workspace_conflict',
      details: { current: expect.objectContaining({ version: 2 }) },
    });
  });

  it('read paths are owner-scoped and detailed variant returns the version', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT value FROM workspace_state')) return [{ value: { conversationId: 'c1' } }];
      if (text.includes('SELECT key, value, version, updated_at')) return [wsRow()];
      return null;
    };
    await expect(getWorkspaceState('u1', 'current_conversation')).resolves.toEqual({ conversationId: 'c1' });
    const detail = await getWorkspaceStateDetailed('u1', 'current_conversation');
    expect(detail?.version).toBe(2);
    const list = await listWorkspaceState('u1');
    expect(list[0]).toMatchObject({ key: 'current_conversation', version: 2 });
    for (const c of db.state.calls) {
      if (c.text.includes('FROM workspace_state')) expect(c.text).toContain('owner_id = $1');
    }
  });
});

describe('preferences — merge + conflict detection', () => {
  it('merges new keys over existing prefs and returns the merged record', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT prefs, version, updated_at FROM user_preferences')) {
        return [{ prefs: { theme: 'dark' }, version: 1, updated_at: new Date() }];
      }
      if (text.includes('INSERT INTO user_preferences')) return [];
      return null;
    };
    const merged = await updatePreferences('u1', { theme: 'light', sound: 'off' });
    expect(merged).toEqual({ theme: 'light', sound: 'off' });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_preferences'))!;
    expect(insert.text).toContain('ON CONFLICT (owner_id)');
    expect(JSON.parse(String(insert.params[2]))).toEqual({ theme: 'light', sound: 'off' });
  });

  it('keeps existing keys when not overridden (continuity contract)', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT prefs, version, updated_at FROM user_preferences')
        ? [{ prefs: { theme: 'dark', sound: 'on' }, version: 1, updated_at: new Date() }]
        : null;
    await expect(updatePreferences('u1', { sound: 'off' })).resolves.toEqual({ theme: 'dark', sound: 'off' });
  });

  it('stale baseVersion raises 409 preferences_conflict', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT prefs, version, updated_at FROM user_preferences')
        ? [{ prefs: { theme: 'dark' }, version: 3, updated_at: new Date() }]
        : null;
    await expect(updatePreferences('u1', { theme: 'light' }, 1)).rejects.toMatchObject({
      status: 409,
      errorCode: 'preferences_conflict',
    });
  });

  it('empty store returns {} and detailed variant null', async () => {
    await expect(getPreferences('u1')).resolves.toEqual({});
    await expect(getPreferencesDetailed('u1')).resolves.toBeNull();
  });
});

describe('usage counters + free limits (server-authoritative)', () => {
  it('increments a daily counter and reads it back', async () => {
    db.state.resolve = (text) => {
      if (text.includes('INSERT INTO usage_counters')) return [{ value: 3 }];
      if (text.includes('SELECT name, value FROM usage_counters')) return [{ name: 'daily_messages', value: '3' }];
      return null;
    };
    await expect(incrementUsage('u1', 'daily_messages', 3)).resolves.toBe(3);
    await expect(getUsage('u1')).resolves.toMatchObject({ daily_messages: 3 });
  });

  it('free users hit the rolling window message limit', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('FROM free_usage_windows')) return [{ window_start: new Date(Date.now() - 3600_000), used: 1000 }];
      return null;
    };
    const check = await checkFreeLimits('u1', 'message');
    expect(check).toMatchObject({ ok: false, reason: 'daily_message_limit', plan: 'free' });
  });

  it('pro users are never limited', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'pro' }];
      return null;
    };
    await expect(checkFreeLimits('u1', 'message')).resolves.toMatchObject({ ok: true, plan: 'pro' });
  });

  it('project kind enforces the project count cap', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('SELECT name, value FROM usage_counters')) return [];
      if (text.includes('SELECT count(*)::int AS n FROM projects')) return [{ n: 10 }];
      return null;
    };
    await expect(checkFreeLimits('u1', 'project')).resolves.toMatchObject({ ok: false, reason: 'project_limit' });
  });
});

describe('context indicator', () => {
  it('reports memory/dna presence and last active project', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT value FROM workspace_state')) return [{ value: { projectId: 'p1' } }];
      if (text.includes('FROM memories')) return [{ n: 2 }];
      if (text.includes('FROM dna')) return [{ n: 0 }];
      return null;
    };
    const ctx = await contextIndicator('u1');
    expect(ctx).toMatchObject({ memoryLoaded: true, memoryCount: 2, dnaCount: 0, project: { projectId: 'p1' } });
  });
});