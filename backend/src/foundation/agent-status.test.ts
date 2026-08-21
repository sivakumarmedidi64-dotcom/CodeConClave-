/**
 * CodeConClave — agent presence/status tests (PHASE 4B).
 * Presence is derived, never claimed: ONLINE only from a live hub socket,
 * STALE when heartbeats stopped within the staleness window, OFFLINE
 * otherwise. An offline agent never reports local execution as active.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: { calls: { text: string; params: unknown[] }[]; rows: unknown[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = {
    calls: [],
    rows: [],
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

import { devicePresence, listDeviceStatus, requireAgentOnline } from '../modules/agent/service.js';
import { Timeouts } from '@codeconclave/shared';
import { AppError } from '../shared/errors.js';

const NOW = Date.now();

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
});

describe('devicePresence', () => {
  it('is ONLINE only when the live hub socket says so', () => {
    expect(devicePresence(new Date().toISOString(), true, NOW)).toBe('ONLINE');
  });

  it('is STALE within the heartbeat window but not connected', () => {
    expect(devicePresence(new Date(NOW - 10_000).toISOString(), false, NOW)).toBe('STALE');
    expect(devicePresence(new Date(NOW - Timeouts.AGENT_PRESENCE_STALE_MS + 1).toISOString(), false, NOW)).toBe('STALE');
  });

  it('is OFFLINE beyond the window, with no heartbeat, or with garbage timestamps', () => {
    expect(devicePresence(new Date(NOW - 10 * 60 * 1000).toISOString(), false, NOW)).toBe('OFFLINE');
    expect(devicePresence(null, false, NOW)).toBe('OFFLINE');
    expect(devicePresence('not-a-date', false, NOW)).toBe('OFFLINE');
  });
});

describe('listDeviceStatus', () => {
  it('enriches rows with presence and remote capability from the live hub', async () => {
    const rows = [
      { id: 'dev_1', name: 'laptop', state: 'PAIRED', paired_at: '2026-01-01', last_seen_at: new Date().toISOString(), created_at: '2026-01-01', capabilities: ['file_read', 'terminal_exec'] },
      { id: 'dev_2', name: 'desktop', state: 'PAIRED', paired_at: '2026-01-01', last_seen_at: null, created_at: '2026-01-01', capabilities: ['file_read'] },
    ];
    db.state.resolve = () => rows;
    const online = vi.fn((_u: string, d: string) => d === 'dev_1');
    const devices = await listDeviceStatus('usr_test1', online);
    expect(devices[0]!.presence).toBe('ONLINE');
    expect(devices[0]!.remoteCapable).toBe(true);
    expect(devices[1]!.presence).toBe('OFFLINE');
    expect(devices[1]!.remoteCapable).toBe(false);
  });
});

describe('requireAgentOnline', () => {
  it('throws local_agent_offline when no live socket exists — never claims execution', () => {
    expect(() => requireAgentOnline('usr', 'dev_1', () => false)).toThrow(AppError);
    try {
      requireAgentOnline('usr', 'dev_1', () => false);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).toContain('offline');
    }
  });

  it('passes when the hub has a live socket', () => {
    expect(() => requireAgentOnline('usr', 'dev_1', () => true)).not.toThrow();
  });
});