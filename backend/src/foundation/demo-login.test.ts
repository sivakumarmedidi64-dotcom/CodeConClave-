/**
 * CodeConClave — TEMPORARY DEMO auto-login (`POST /api/v1/auth/demo-login`).
 *
 * The silent demo sign-in exists ONLY for the temporary demo deployment. This
 * suite pins the two things that make it safe:
 *   A. OFF — with TEMPORARY_DEMO_MODE unset/false it fails closed (404) and
 *      writes NOTHING (no user, no session). Production auth is unchanged.
 *   B. ON  — it signs into exactly ONE dedicated demo account, issues a real
 *      session, and audits the login. It never touches any other account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? [], rowCount: (rows ?? []).length };
  };
  return {
    state,
    pool: { query },
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const envMock = vi.hoisted(() => ({
  env: {
    PAYMENT_FOUNDER_EMAIL: 'medidisaharsh@gmail.com',
    JWT_SECRET: 'test_secret_at_least_16_chars',
    AUTH_SESSION_TTL_DAYS: 30,
    // Mutable: each test flips it the way an operator flips the env var.
    TEMPORARY_DEMO_MODE: 'false' as string | undefined,
  },
}));
vi.mock('../config/env.js', () => envMock);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { demoLogin, DEMO_ACCOUNT_EMAIL } from '../modules/auth/service.js';
import { AuditAction } from '@codeconclave/shared';

function fakeReq(ip = '10.0.0.1'): Request {
  return {
    ip,
    headers: { 'user-agent': 'foundation/1.0' },
    ctx: { traceId: 'trace-1', ip, userAgent: 'foundation/1.0', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

const DEMO_ROW = {
  id: 'u_demo',
  email: DEMO_ACCOUNT_EMAIL,
  email_verified: true,
  display_name: 'Demo',
  avatar_url: null,
  google_sub: null,
  role: null,
  primary_use_case: null,
  mfa_enabled: false,
  rbac_role: 'member',
  plan_id: 'free',
  entitlement_state: 'FREE',
};

/** Resolve the queries demoLogin makes for an existing demo account. */
function stubDb(): void {
  db.state.resolve = (text) => {
    if (text.includes('INSERT INTO users')) return [];
    if (text.includes('SELECT id FROM users WHERE lower(email)')) return [{ id: 'u_demo' }];
    if (text.includes('INSERT INTO entitlements')) return [];
    if (text.includes('INSERT INTO user_preferences')) return [];
    if (text.includes('INSERT INTO sessions')) return [];
    if (text.includes('SELECT * FROM users WHERE id = $1')) return [DEMO_ROW];
    if (text.includes('FROM devices')) return [];
    return [];
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  recordAudit.mockClear();
  envMock.env.TEMPORARY_DEMO_MODE = 'false';
});

describe('demoLogin — temporary demo auto-login', () => {
  it('A. fails closed (404) and writes nothing while the demo flag is OFF', async () => {
    stubDb();
    await expect(demoLogin(fakeReq())).rejects.toMatchObject({ errorCode: 'not_found', status: 404 });
    const wroteUsers = db.state.calls.some((c) => c.text.includes('INSERT INTO users'));
    const wroteSessions = db.state.calls.some((c) => c.text.includes('INSERT INTO sessions'));
    expect(wroteUsers).toBe(false);
    expect(wroteSessions).toBe(false);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('treats any non-true flag value as OFF (fail closed)', async () => {
    stubDb();
    for (const raw of ['', '0', 'no', 'off', 'FALSE']) {
      envMock.env.TEMPORARY_DEMO_MODE = raw;
      await expect(demoLogin(fakeReq())).rejects.toMatchObject({ errorCode: 'not_found' });
    }
  });

  it('B. signs into the dedicated demo account and issues a real session when ON', async () => {
    envMock.env.TEMPORARY_DEMO_MODE = 'true';
    stubDb();
    const result = await demoLogin(fakeReq());
    expect(result.user.email).toBe(DEMO_ACCOUNT_EMAIL);
    expect(result.user.id).toBe('u_demo');
    expect(result.sessionToken).toBeTruthy();
    expect(result.sessionId).toBeTruthy();

    const sessionInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'));
    expect(sessionInsert).toBeTruthy();

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_LOGIN, detail: expect.objectContaining({ via: 'temporary_demo_autologin' }) }),
    );
  });

  it('B. only ever touches the fixed demo account — never an arbitrary account', async () => {
    envMock.env.TEMPORARY_DEMO_MODE = 'true';
    stubDb();
    await demoLogin(fakeReq());
    const lookups = db.state.calls.filter((c) => c.text.includes('lower(email)'));
    expect(lookups.length).toBeGreaterThan(0);
    for (const call of lookups) {
      expect(call.params).toContain(DEMO_ACCOUNT_EMAIL);
    }
    const userInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO users'));
    for (const call of userInserts) {
      expect(call.params).toContain(DEMO_ACCOUNT_EMAIL);
    }
  });

  it('B. is idempotent — creating the demo account twice still yields one sign-in session', async () => {
    envMock.env.TEMPORARY_DEMO_MODE = 'true';
    stubDb();
    const first = await demoLogin(fakeReq());
    const second = await demoLogin(fakeReq());
    expect(first.user.id).toBe(second.user.id);
    const sessionInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions'));
    expect(sessionInserts.length).toBe(2); // one session per sign-in, same user
  });
});
