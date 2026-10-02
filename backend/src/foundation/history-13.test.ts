/**
 * CodeConClave — Phase 13 history tests: unified aggregation over audit +
 * project/file/team activity, authorization, filters, star/unstar and detail
 * resolution. DB mocked.
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

import { listHistory, getHistoryEvent, setHistoryStar } from '../modules/history/service.js';

function eventRow(over: Record<string, unknown> = {}) {
  return {
    source: 'audit',
    event_id: 'aud_1',
    action: 'file.uploaded',
    actor_user_id: 'u1',
    project_id: null,
    team_id: null,
    resource_type: 'file',
    resource_id: 'fil_1',
    detail: { path: '/a.txt' },
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

describe('listHistory — aggregation', () => {
  it('unions all four sources with tenant authorization', async () => {
    db.state.resolve = (text) => {
      if (text.includes('count(*)::int AS n')) return [{ n: 2 }];
      if (text.includes('SELECT * FROM (')) return [eventRow(), eventRow({ source: 'project_activity', event_id: 'pact_1', action: 'project.created', resource_type: 'project' })];
      if (text.includes('SELECT source, event_id FROM history_stars')) return [{ source: 'audit', event_id: 'aud_1' }];
      return null;
    };
    const result = await listHistory('u1');
    expect(result.total).toBe(2);
    const union = db.state.calls.find((c) => c.text.includes('UNION ALL'))!.text;
    expect(union).toContain('audit_logs a WHERE a.actor_user_id = $1');
    expect(union).toContain('project_activity pa WHERE pa.project_id IN');
    expect(union).toContain('file_activity fa WHERE fa.project_id IN');
    expect(union).toContain('team_activity ta WHERE ta.team_id IN');
    expect(union).toContain('team_members WHERE user_id = $1 AND status');
    const starred = result.events.find((e) => e.id === 'audit:aud_1')!;
    expect(starred.starred).toBe(true);
    expect(result.events.find((e) => e.id === 'project_activity:pact_1')!.starred).toBe(false);
  });

  it('does not aggregate sources the caller cannot see (authz is in the SQL)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('count(*)::int AS n')) return [{ n: 0 }];
      if (text.includes('SELECT * FROM (')) return [];
      return null;
    };
    await listHistory('u1');
    const union = db.state.calls.find((c) => c.text.includes('UNION ALL'))!.text;
    expect(union).toContain('owner_id = $1 OR id IN (SELECT project_id FROM project_members WHERE user_id = $1)');
    expect(union).toContain("status = 'ACTIVE'");
  });

  it('rejects an unknown source', async () => {
    await expect(listHistory('u1', { source: 'nope' })).rejects.toMatchObject({ errorCode: 'invalid_source' });
  });

  it('applies per-source filters (source/action/actor/date/starred/team)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('count(*)::int AS n')) return [{ n: 0 }];
      if (text.includes('SELECT * FROM (')) return [];
      return null;
    };
    await listHistory('u1', {
      source: 'team_activity',
      action: 'team.member_added',
      actorId: 'u2',
      teamId: 'tm_1',
      dateFrom: '2026-01-01T00:00:00Z',
      dateTo: '2026-02-01T00:00:00Z',
      starred: true,
      sort: 'asc',
      limit: 10,
      offset: 5,
    });
    const union = db.state.calls.find((c) => c.text.includes('FROM team_activity ta'))!.text;
    expect(union).toContain('ta.team_id = $');
    expect(union).toContain('ta.actor_user_id = $');
    expect(union).toContain('ta.action = $');
    expect(union).toContain('ta.created_at >=');
    expect(union).toContain('history_stars hs WHERE hs.owner_id = $1');
    expect(union).not.toContain('audit_logs');
    expect(union).not.toContain('project_activity pa');
    const rowsCall = db.state.calls.find((c) => c.text.includes('SELECT * FROM ('));
    expect(rowsCall!.text).toContain('ORDER BY e.created_at ASC');
  });

  it('supports keyword search against action and detail', async () => {
    db.state.resolve = (text) => {
      if (text.includes('count(*)::int AS n')) return [{ n: 0 }];
      if (text.includes('SELECT * FROM (')) return [];
      return null;
    };
    await listHistory('u1', { q: 'upload' });
    const union = db.state.calls.find((c) => c.text.includes('UNION ALL'))!.text;
    expect(union).toContain('ILIKE');
  });
});

describe('getHistoryEvent — detail', () => {
  it('resolves an authorized audit event with star state', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM audit_logs a WHERE a.id = $1 AND a.actor_user_id = $2')) return [eventRow()];
      if (text.includes('SELECT count(*)::int AS n FROM history_stars')) return [{ n: 1 }];
      return null;
    };
    const event = await getHistoryEvent('u1', 'audit', 'aud_1');
    expect(event.id).toBe('audit:aud_1');
    expect(event.action).toBe('file.uploaded');
    expect(event.starred).toBe(true);
  });

  it('hides events the caller is not authorized for', async () => {
    await expect(getHistoryEvent('u1', 'audit', 'aud_x')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('resolves a team_activity event only for ACTIVE members', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM team_activity ta')) return [eventRow({ source: 'team_activity', event_id: 'tact_1', action: 'team.created', team_id: 'tm_1' })];
      return null;
    };
    const event = await getHistoryEvent('u1', 'team_activity', 'tact_1');
    expect(event.teamId).toBe('tm_1');
  });
});

describe('setHistoryStar', () => {
  it('stars an event only after access verification and audits it', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM audit_logs a WHERE a.id = $1 AND a.actor_user_id = $2')) return [eventRow()];
      return null;
    };
    const result = await setHistoryStar('u1', 'audit', 'aud_1', true);
    expect(result.starred).toBe(true);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO history_stars'));
    expect(insert!.params).toContain('audit');
    expect(insert!.params).toContain('aud_1');
    expect(db.state.calls.some((c) => c.params.includes('history.starred'))).toBe(true);
  });

  it('unstars and audits the removal', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM audit_logs a WHERE a.id = $1 AND a.actor_user_id = $2')) return [eventRow()];
      return null;
    };
    const result = await setHistoryStar('u1', 'audit', 'aud_1', false);
    expect(result.starred).toBe(false);
    const del = db.state.calls.find((c) => c.text.includes('DELETE FROM history_stars'));
    expect(del!.params).toEqual(['u1', 'audit', 'aud_1']);
    expect(db.state.calls.some((c) => c.params.includes('history.unstarred'))).toBe(true);
  });

  it('cannot star an event without access', async () => {
    await expect(setHistoryStar('u1', 'audit', 'aud_x', true)).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});