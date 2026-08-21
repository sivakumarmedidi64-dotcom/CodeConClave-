/**
 * CodeConClave — remote-control service tests (PHASE 4B).
 * Covers: explicit 8-hour remote sessions (idempotent per device), immediate
 * revocation (clears screenshot authorization), screenshot authorization
 * (fresh 15-minute grant on ACTIVE sessions only), and the honest screenshot
 * attempt (typed adapter returns null on this platform — never simulated).
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
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import {
  authorizeScreenshot,
  createRemoteSession,
  requestScreenshot,
  revokeRemoteSession,
} from '../modules/remote/service.js';
import { AuditAction } from '@codeconclave/shared';

const USER_ID = 'usr_remote1';
const DEVICE_ID = 'dev_remote1';
const SESSION_ID = 'rms_abc123';

function pairedDeviceRow(): Record<string, unknown> {
  return { id: DEVICE_ID, name: 'laptop', state: 'PAIRED', capabilities: ['terminal_exec'] };
}

function activeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    device_id: DEVICE_ID,
    state: 'ACTIVE',
    started_at: '2026-01-01T00:00:00Z',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    last_active_at: '2026-01-01T00:00:00Z',
    screenshot_authorized: false,
    screenshot_auth_expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
});

afterEach(() => {
  db.state.resolve = null;
});

describe('createRemoteSession — explicit 8h authorization', () => {
  it('creates an ACTIVE 8-hour session for a paired device and audits it', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM devices WHERE id')) return [pairedDeviceRow()];
      if (text.includes('FROM remote_sessions') && text.includes('ORDER BY created_at DESC')) return [];
      if (text.includes('FROM remote_sessions') && text.includes('WHERE id = $1')) return [activeRow()];
      return null;
    };
    const session = await createRemoteSession(USER_ID, DEVICE_ID);
    expect(session.id).toMatch(/^rms_/);
    expect(session.state).toBe('ACTIVE');
    expect(session.deviceName).toBe('laptop');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO remote_sessions'));
    expect(insert).toBeDefined();
    expect(insert!.params[3]).toBe(8 * 60 * 60 * 1000); // 8h TTL
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.REMOTE_SESSION_CREATED }));
  });

  it('reuses an existing ACTIVE session idempotently (no duplicate insert)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM devices WHERE id')) return [pairedDeviceRow()];
      if (text.includes('ORDER BY created_at DESC')) return [activeRow()];
      return null;
    };
    const session = await createRemoteSession(USER_ID, DEVICE_ID);
    expect(session.id).toBe(SESSION_ID);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO remote_sessions'))).toBe(false);
  });

  it('refuses for an unpaired or foreign device', async () => {
    db.state.resolve = () => [];
    await expect(createRemoteSession(USER_ID, 'dev_other')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('revokeRemoteSession — immediate revocation', () => {
  it('marks the session REVOKED, clears screenshot authorization, audits', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING id') ? [{ id: SESSION_ID }] : null);
    await revokeRemoteSession(USER_ID, SESSION_ID);
    const update = db.state.calls.find((c) => c.text.includes("SET state = 'REVOKED'"));
    expect(update).toBeDefined();
    expect(update!.text).toContain('screenshot_authorized = false');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.REMOTE_SESSION_REVOKED }));
  });

  it('404s when the session is not ACTIVE or not owned', async () => {
    db.state.resolve = () => [];
    await expect(revokeRemoteSession(USER_ID, SESSION_ID)).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('authorizeScreenshot — explicit fresh grant', () => {
  it('grants a 15-minute screenshot authorization on an ACTIVE session', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING id') ? [{ id: SESSION_ID }] : null);
    await authorizeScreenshot(USER_ID, SESSION_ID);
    const update = db.state.calls.find((c) => c.text.includes('screenshot_authorized = true'));
    expect(update).toBeDefined();
    expect(update!.params[2]).toBe(15 * 60 * 1000);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.REMOTE_SCREENSHOT_AUTHORIZED }));
  });
});

describe('requestScreenshot — honest typed adapter', () => {
  it('refuses without an explicit screenshot authorization', async () => {
    db.state.resolve = () => [activeRow({ screenshot_authorized: false })];
    await expect(requestScreenshot(USER_ID, SESSION_ID)).rejects.toMatchObject({ errorCode: 'screenshot_not_authorized' });
  });

  it('refuses when the authorization grant has expired', async () => {
    db.state.resolve = () => [
      activeRow({ screenshot_authorized: true, screenshot_auth_expires_at: new Date(Date.now() - 1000).toISOString() }),
    ];
    await expect(requestScreenshot(USER_ID, SESSION_ID)).rejects.toMatchObject({ errorCode: 'screenshot_authorization_expired' });
  });

  it('refuses after revocation — no delivery', async () => {
    db.state.resolve = () => [activeRow({ state: 'ACTIVE', revoked_at: new Date().toISOString(), screenshot_authorized: true, screenshot_auth_expires_at: new Date(Date.now() + 60_000).toISOString() })];
    await expect(requestScreenshot(USER_ID, SESSION_ID)).rejects.toMatchObject({ errorCode: 'remote_session_revoked' });
  });

  it('with a fresh grant, the typed adapter honestly reports an unavailable capture source', async () => {
    db.state.resolve = () => [
      activeRow({ screenshot_authorized: true, screenshot_auth_expires_at: new Date(Date.now() + 60_000).toISOString() }),
    ];
    const result = await requestScreenshot(USER_ID, SESSION_ID);
    expect(result.source).toBe('unavailable');
    expect(result.image).toBeNull();
  });
});