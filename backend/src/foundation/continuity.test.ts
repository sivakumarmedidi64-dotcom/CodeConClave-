/**
 * CodeConClave — continuity foundation tests (workspace state, preferences,
 * usage, free limits). Covers: state upsert + read, preferences merge, usage
 * counter increments, server-authoritative free-limit checks, and the
 * free-limit Moon gate. The Phase 12 return-to-work suite lives in
 * return-to-work-12.test.ts. DB mocked; the memory cache is real (in-process).
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

import { env } from '../config/env.js';
import { WorkspaceStateKey } from '@codeconclave/shared';
import {
  setWorkspaceState,
  getWorkspaceState,
  listWorkspaceState,
  getPreferences,
  updatePreferences,
  incrementUsage,
  checkFreeLimits,
  shouldShowFreeLimitMoon,
} from '../modules/workspace/service.js';

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
});

describe('workspace state — upsert + read', () => {
  it('setWorkspaceState upserts per (owner, key)', async () => {
    await setWorkspaceState('u1', WorkspaceStateKey.LAST_ACTIVE_PROJECT, { projectId: 'p1' });
    const call = db.state.calls.find((c) => c.text.includes('INSERT INTO workspace_state'))!;
    expect(call.text).toContain('ON CONFLICT (owner_id, key) DO UPDATE');
    expect(call.params[1]).toBe('u1');
    expect(call.params[2]).toBe(WorkspaceStateKey.LAST_ACTIVE_PROJECT);
    expect(JSON.parse(call.params[3] as string)).toEqual({ projectId: 'p1' });
  });

  it('getWorkspaceState returns null when unset', async () => {
    await expect(getWorkspaceState('u1', WorkspaceStateKey.RETURN_TO_WORK)).resolves.toBeNull();
  });

  it('getWorkspaceState returns the stored value and scopes by owner', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM workspace_state') && text.includes('WHERE owner_id = $1')) {
        return [{ value: { projectId: 'p1' } }];
      }
      return null;
    };
    const value = await getWorkspaceState('u1', WorkspaceStateKey.LAST_ACTIVE_PROJECT);
    expect(value).toEqual({ projectId: 'p1' });
    const call = db.state.calls.find((c) => c.text.includes('FROM workspace_state'))!;
    expect(call.text).toContain('owner_id = $1 AND key = $2');
  });
});

describe('preferences — deep merge', () => {
  it('merges new prefs over stored ones', async () => {
    db.state.resolve = (text) => (text.includes('FROM user_preferences') ? [{ prefs: { theme: 'dark' } }] : null);
    const merged = await updatePreferences('u1', { sound: 'off' });
    expect(merged).toEqual({ theme: 'dark', sound: 'off' });
    const call = db.state.calls.find((c) => c.text.includes('INSERT INTO user_preferences'))!;
    expect(JSON.parse(call.params[2] as string)).toEqual({ theme: 'dark', sound: 'off' });
  });
});

describe('usage counters — server-authoritative', () => {
  it('increments atomically via ON CONFLICT and returns the value', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING value') ? [{ value: 5 }] : null);
    const value = await incrementUsage('u1', 'daily_messages', 3);
    expect(value).toBe(5);
    const call = db.state.calls.find((c) => c.text.includes('INSERT INTO usage_counters'))!;
    expect(call.text).toContain('usage_counters.value + EXCLUDED.value');
    expect(call.params[4]).toBe(3);
  });
});

describe('free-limit checks', () => {
  it('pro users are never limited', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'pro' }];
      return null;
    };
    const check = await checkFreeLimits('u1', 'message');
    expect(check.ok).toBe(true);
    expect(check.plan).toBe('pro');
  });

  it('blocks free users at the daily message limit', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('FROM usage_counters')) return [{ name: 'daily_messages', value: String(env.FREE_DAILY_MESSAGES) }];
      return null;
    };
    const check = await checkFreeLimits('u1', 'message');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('daily_message_limit');
  });

  it('blocks free users at the project limit', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('FROM projects')) return [{ n: env.FREE_MAX_PROJECTS }];
      return null;
    };
    const check = await checkFreeLimits('u1', 'project');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('project_limit');
  });
});

describe('moon gate — free-limit shown once per day', () => {
  it('returns true once then false for the same day', async () => {
    const first = await shouldShowFreeLimitMoon('u1');
    const second = await shouldShowFreeLimitMoon('u1');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});