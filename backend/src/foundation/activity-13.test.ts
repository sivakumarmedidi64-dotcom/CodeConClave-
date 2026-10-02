/**
 * CodeConClave — Phase 13 activity feed tests: home/project/team scopes over
 * existing persisted event tables, read-time deduplication and authorization.
 * DB mocked.
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
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

import { getActivityFeed } from '../modules/activity/service.js';

function activityRow(over: Record<string, unknown> = {}) {
  return {
    source: 'project_activity',
    event_id: 'pact_1',
    action: 'project.created',
    actor_user_id: 'u1',
    project_id: 'prj_1',
    team_id: null,
    resource_type: 'project',
    resource_id: 'prj_1',
    created_at: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('home scope', () => {
  it('aggregates the four sources with tenant authorization', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM (')) {
        return [
          activityRow(),
          activityRow({ source: 'file_activity', event_id: 'fa_1', action: 'file.uploaded', resource_type: 'file', resource_id: 'fil_1' }),
          activityRow({ source: 'team_activity', event_id: 'tact_1', action: 'team.member_joined', team_id: 'tm_1', project_id: null, resource_id: 'tm_1' }),
          activityRow({ source: 'audit', event_id: 'aud_1', action: 'memory.created', resource_type: 'memory', resource_id: 'mem_1' }),
        ];
      }
      return null;
    };
    const { events, total } = await getActivityFeed('u1', { scope: 'home' });
    expect(total).toBe(4);
    const union = db.state.calls.find((c) => c.text.includes('UNION ALL'))!.text;
    expect(union).toContain('project_activity pa WHERE pa.project_id IN');
    expect(union).toContain('file_activity fa WHERE fa.project_id IN');
    expect(union).toContain('team_activity ta WHERE ta.team_id IN');
    expect(union).toContain('audit_logs a WHERE a.actor_user_id = $1');
  });

  it('deduplicates the same underlying event recorded in two tables', async () => {
    const sameTime = new Date('2026-01-02T00:00:00Z');
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM (')) {
        return [
          activityRow({ source: 'audit', event_id: 'aud_1', action: 'file.uploaded', resource_id: 'fil_1', created_at: sameTime }),
          activityRow({ source: 'file_activity', event_id: 'fa_1', action: 'file.uploaded', resource_id: 'fil_1', created_at: sameTime }),
        ];
      }
      return null;
    };
    const { events, total } = await getActivityFeed('u1', { scope: 'home' });
    expect(events).toHaveLength(1);
    expect(total).toBe(1);
    expect(events[0].source).toBe('audit');
  });

  it('caps the feed with an SQL LIMIT', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT * FROM (')) {
        return Array.from({ length: 10 }, (_, i) => activityRow({ event_id: `pact_${i}`, action: `a.${i}` }));
      }
      return null;
    };
    const { events } = await getActivityFeed('u1', { scope: 'home', limit: 3 });
    expect(events).toHaveLength(10); // mock ignores the LIMIT; the cap is enforced in SQL
    const call = db.state.calls.find((c) => c.text.includes('SELECT * FROM ('));
    expect(call!.params[1]).toBe(3);
    expect(call!.text).toContain('LIMIT $2');
  });
});

describe('project scope', () => {
  it('requires a projectId and membership', async () => {
    await expect(getActivityFeed('u1', { scope: 'project' })).rejects.toMatchObject({ errorCode: 'project_required' });
    db.state.resolve = (text) => {
      if (text.includes('SELECT\n       EXISTS (SELECT 1 FROM projects')) return [{ is_owner: false, member_role: null }];
      return null;
    };
    await expect(getActivityFeed('u1', { scope: 'project', projectId: 'prj_1' })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('returns project + file activity for a member', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT\n       EXISTS (SELECT 1 FROM projects')) return [{ is_owner: true, member_role: null }];
      if (text.includes('SELECT * FROM (')) return [activityRow()];
      return null;
    };
    const { events } = await getActivityFeed('u1', { scope: 'project', projectId: 'prj_1' });
    expect(events).toHaveLength(1);
    const union = db.state.calls.find((c) => c.text.includes('UNION ALL'))!.text;
    expect(union).toContain('pa.project_id = $2');
    expect(union).toContain('fa.project_id = $2');
    expect(union).not.toContain('audit_logs');
  });
});

describe('team scope', () => {
  it('requires teamId and ACTIVE membership', async () => {
    await expect(getActivityFeed('u1', { scope: 'team' })).rejects.toMatchObject({ errorCode: 'team_required' });
    db.state.resolve = (text) => {
      if (text.includes("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")) return [];
      return null;
    };
    await expect(getActivityFeed('u1', { scope: 'team', teamId: 'tm_1' })).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('returns team + shared project activity for a member', async () => {
    db.state.resolve = (text) => {
      if (text.includes("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")) return [{ role: 'owner' }];
      if (text.includes('SELECT * FROM (')) return [activityRow({ source: 'team_activity', team_id: 'tm_1', project_id: null, resource_id: 'tm_1' })];
      return null;
    };
    const { events } = await getActivityFeed('u1', { scope: 'team', teamId: 'tm_1' });
    expect(events).toHaveLength(1);
    const union = db.state.calls.find((c) => c.text.includes('UNION ALL'))!.text;
    expect(union).toContain('ta.team_id = $2');
    expect(union).toContain('JOIN projects p ON p.id = pa.project_id');
    expect(union).toContain('WHERE p.team_id = $2');
  });
});

describe('validation', () => {
  it('rejects unknown scopes', async () => {
    await expect(getActivityFeed('u1', { scope: 'galaxy' as never })).rejects.toMatchObject({ errorCode: 'invalid_scope' });
  });
});