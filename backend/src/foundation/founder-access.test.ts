/**
 * CodeConClave — founder access for the designated account.
 * The configured PAYMENT_FOUNDER_EMAIL signs in with the account's real
 * password (never an email-typed magic entry, never auto-provisioning).
 *
 * MUST fail closed. Founder entitlement (B2) requires ALL THREE of:
 *   1. the address equals PAYMENT_FOUNDER_EMAIL,
 *   2. users.email_verified = true, and
 *   3. users.is_founder = true — the explicit provisioning flag that only
 *      scripts/provision-founder.ts sets.
 * Registration explicitly writes is_founder = false and refuses the configured
 * founder address outright, so a squatted inbox can never be promoted by
 * typing the address. Every failure returns the same generic 403, so nothing
 * reveals whether an address is the founder or whether the account exists.
 * MFA is honored (challenge, never bypassed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

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
const envMock = vi.hoisted(() => ({
  env: {
    PAYMENT_FOUNDER_EMAIL: 'medidisaharsh@gmail.com',
    JWT_SECRET: 'test_secret_at_least_16_chars',
    AUTH_SESSION_TTL_DAYS: 30,
  },
}));
vi.mock('../config/env.js', () => envMock);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { founderAccess } from '../modules/auth/service.js';
import { AuditAction } from '@codeconclave/shared';
import { hashSecret } from '../shared/crypto.js';

const FOUNDER = 'medidisaharsh@gmail.com';
const FOUNDER_PW = 'founder-secret-password-2026';

function fakeReq(ip = '10.0.0.1'): Request {
  return {
    ip,
    headers: { 'user-agent': 'foundation/1.0' },
    ctx: { traceId: 'trace-1', ip, userAgent: 'foundation/1.0', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

function founderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u_founder',
    email: FOUNDER,
    email_verified: true,
    is_founder: true,
    password_hash: hashSecret(FOUNDER_PW),
    display_name: 'Founder',
    avatar_url: null,
    google_sub: null,
    mfa_enabled: false,
    mfa_secret_encrypted: null,
    recovery_codes_hash: null,
    rbac_role: 'owner',
    plan_id: 'free',
    entitlement_state: 'FREE',
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

/**
 * Resolve the founder-authority lookup (isFounderAccount) and the account
 * lookup separately, so a test can express "the account exists but is not the
 * provisioned founder" instead of relying on call order.
 */
function stubUsers(
  account: Record<string, unknown> | null,
  authority?: { email: string; email_verified: boolean; is_founder: boolean } | null,
): void {
  db.state.resolve = (text) => {
    if (text.includes('SELECT email, email_verified, is_founder')) {
      return authority === undefined && account ? [
        { email: account.email, email_verified: account.email_verified, is_founder: account.is_founder },
      ] : (authority ? [authority] : []);
    }
    if (text.includes('SELECT * FROM users') && text.includes('deleted_at IS NULL')) {
      return account ? [account] : [];
    }
    if (text.includes('FROM sessions')) return [];
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
});

describe('founderAccess — password-gated sign-in for the designated account', () => {
  it('fails closed for any non-founder email (403, never enumerates)', async () => {
    await expect(
      founderAccess({ email: 'stranger@example.com', password: 'whatever' }, fakeReq()),
    ).rejects.toMatchObject({
      errorCode: 'founder_access_denied',
      status: 403,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_LOGIN_FAILED, detail: expect.objectContaining({ reason: 'founder_access_denied' }) }),
    );
  });

  it('B: random user typing the founder email still must NOT be signed in without the password', async () => {
    stubUsers(founderRow());
    await expect(founderAccess({ email: FOUNDER, password: 'wrong-password' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'founder_access_denied',
      status: 403,
    });
    const sessionInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'));
    expect(sessionInsert).toBeUndefined();
  });

  it('fails closed (forbidden) when no founder email is configured', async () => {
    envMock.env.PAYMENT_FOUNDER_EMAIL = undefined;
    await expect(founderAccess({ email: FOUNDER, password: FOUNDER_PW }, fakeReq())).rejects.toMatchObject({
      errorCode: 'founder_access_denied',
    });
    envMock.env.PAYMENT_FOUNDER_EMAIL = FOUNDER;
  });

  it('never auto-provisions a missing founder account — forbidden instead', async () => {
    stubUsers(null);
    await expect(
      founderAccess({ email: 'founder@noaccount.com', password: FOUNDER_PW }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'founder_access_denied' });
    const userInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO users'));
    expect(userInsert).toBeUndefined();
  });

  it('matches the founder address case-insensitively and signs in with the correct password', async () => {
    stubUsers(founderRow());
    const result = await founderAccess({ email: 'MediDisAharsh@Gmail.com', password: FOUNDER_PW }, fakeReq());
    expect(result).toMatchObject({ user: expect.objectContaining({ email: FOUNDER, id: 'u_founder' }) });
    expect(result.sessionToken).toBeTruthy();
  });

  it('signs in the designated founder account and audits the login', async () => {
    stubUsers(founderRow());
    const result = await founderAccess({ email: FOUNDER, password: FOUNDER_PW }, fakeReq());
    expect(result.user.email).toBe(FOUNDER);
    expect(result.sessionToken).toBeTruthy();
    expect(result.sessionId).toBeTruthy();

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_LOGIN, detail: expect.objectContaining({ via: 'founder' }) }),
    );
  });

  it('REFUSES an UNVERIFIED founder-address account even with the correct password (squat)', async () => {
    // The account exists, the address matches, the password is right — but the
    // email was never verified, so it cannot be the real founder.
    stubUsers(founderRow({ email_verified: false }), { email: FOUNDER, email_verified: false, is_founder: true });
    await expect(founderAccess({ email: FOUNDER, password: FOUNDER_PW }, fakeReq())).rejects.toMatchObject({
      errorCode: 'founder_access_denied',
      status: 403,
    });
    const sessionInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'));
    expect(sessionInsert).toBeUndefined();
  });

  it('REFUSES a verified founder-address account that was never provisioned (is_founder = false)', async () => {
    stubUsers(founderRow({ is_founder: false }), { email: FOUNDER, email_verified: true, is_founder: false });
    await expect(founderAccess({ email: FOUNDER, password: FOUNDER_PW }, fakeReq())).rejects.toMatchObject({
      errorCode: 'founder_access_denied',
      status: 403,
    });
    const sessionInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'));
    expect(sessionInsert).toBeUndefined();
  });

  it('honors MFA: an enrolled founder goes through the TOTP challenge, never a free session', async () => {
    stubUsers(founderRow({ mfa_enabled: true }));
    const result = await founderAccess({ email: FOUNDER, password: FOUNDER_PW }, fakeReq());
    expect(result).toMatchObject({ mfaRequired: true });
    expect((result as { challengeToken: string }).challengeToken).toBeTruthy();
    const sessionInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'));
    expect(sessionInsert).toBeUndefined();
  });
});