/**
 * CodeConClave — zero-domain authentication tests.
 *
 * Covers the NEW zero-domain gaps (the handle+keyword+key core already had
 * 48 tests in identity.test.ts): registration auto-issues a 32-char account
 * key exactly once with hash-only storage; email-or-handle login resolves
 * either identifier with identical failures; unknown-device logins escalate
 * to a security-key challenge (reason surfaced, risk event recorded, never a
 * ban); recognized devices keep existing MFA semantics; key-challenge
 * failures are rate-limited and recorded; credential errors stay
 * indistinguishable (anti-enumeration); nothing in the path requires email
 * delivery.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
    devicePaired: boolean;
  } = { calls: [], resolve: null, devicePaired: false };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    if (text.includes('FROM devices')) {
      return { rows: state.devicePaired ? [{ id: 'dev-1' }] : [], rowCount: state.devicePaired ? 1 : 0 };
    }
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? [], rowCount: 1 };
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

const incrMock = vi.hoisted(() => vi.fn(async () => 1));
vi.mock('../shared/cache.js', () => ({
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    incr: incrMock,
    del: vi.fn(async () => {}),
  },
}));

import { hashSecret, verifyHash } from '../shared/crypto.js';
import { register } from '../modules/auth/service.js';
import {
  loginWithKeyword,
  completeSecurityKeyChallenge,
  generateSecurityKey,
  isWellFormedSecurityKey,
} from '../modules/auth/identity.js';

const KEYWORD = 'CorrectHorse9Battery';
const HANDLE = 'zero_hero';
const USER_ID = 'usr_zero1';

function fakeReq(deviceToken?: string): Request {
  return {
    ip: '10.0.0.5',
    headers: { 'user-agent': 'zero/1.0', ...(deviceToken ? { 'x-device-token': deviceToken } : {}) },
    ctx: { traceId: 't', ip: '10.0.0.5', userAgent: 'zero/1.0', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

function userRow() {
  return {
    id: USER_ID, email: 'zero@example.com', password_hash: hashSecret('Password12345!'),
    display_name: 'Zero', role: null, primary_use_case: null, email_verified: true,
    is_founder: false, mfa_enabled: false, rbac_role: 'member', plan_id: 'free',
    entitlement_state: 'FREE', created_at: new Date(), updated_at: new Date(),
  };
}

function identityRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID, handle: HANDLE, keyword_hash: hashSecret(KEYWORD),
    security_key_hash: null, security_key_enabled: false, preferred_mfa: 'none',
    mfa_enabled: false, ...overrides,
  };
}

function riskEvents() {
  return db.state.calls.filter((c) => c.text.includes('INSERT INTO auth_risk_events'));
}

beforeEach(() => {
  db.state.calls = [];
  db.state.resolve = null;
  db.state.devicePaired = false;
  recordAudit.mockClear();
  incrMock.mockReset();
  incrMock.mockResolvedValue(1);
});

describe('zero-domain registration', () => {
  it('issues a 32-char account key exactly once with hash-only storage', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [];
      if (text.includes('SELECT 1 FROM user_auth_identities WHERE lower(handle)')) return [];
      if (text.includes('SELECT * FROM users WHERE id')) return [userRow()];
      return [];
    };
    const res = await register(
      { email: 'zero@example.com', password: 'Password12345!', handle: HANDLE, keyword: KEYWORD },
      fakeReq(),
    );
    expect(res.securityKey).toBeDefined();
    expect(isWellFormedSecurityKey(res.securityKey!)).toBe(true);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_auth_identities'));
    expect(insert).toBeDefined();
    const storedHash = insert!.params[4] as string;
    expect(storedHash).not.toContain(res.securityKey!);
    expect(verifyHash(storedHash, res.securityKey!)).toBe(true);
  });

  it('issues no key for password-only registration', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [];
      if (text.includes('SELECT * FROM users WHERE id')) return [userRow()];
      return [];
    };
    const res = await register({ email: 'plain@example.com', password: 'Password12345!' }, fakeReq());
    expect(res.securityKey).toBeUndefined();
  });
});

describe('zero-domain risk escalation', () => {
  it('challenges unknown devices with the account key (never bans)', async () => {
    const key = generateSecurityKey();
    db.state.resolve = (text) => {
      if (text.includes('FROM user_auth_identities')) return [identityRow({ security_key_hash: hashSecret(key), security_key_enabled: true })];
      if (text.includes('FROM sessions')) return [];
      return [];
    };
    const res = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
    expect(res.kind).toBe('mfa_required');
    if (res.kind === 'mfa_required') {
      expect(res.method).toBe('security_key');
      expect(res.reason).toBe('unknown_device');
      expect(res.challengeToken.startsWith('imfa_')).toBe(true);
    }
    expect(riskEvents()).toHaveLength(1);
    expect(riskEvents()[0]!.params.slice(2, 4)).toEqual(['unknown_device', 'challenged']);
  });

  it('still demands the key on recognized devices (existing MFA semantic kept)', async () => {
    db.state.devicePaired = true;
    db.state.resolve = (text) => {
      if (text.includes('FROM user_auth_identities')) return [identityRow({ security_key_hash: hashSecret(generateSecurityKey()), security_key_enabled: true })];
      if (text.includes('FROM sessions')) return [];
      return [];
    };
    const res = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq('device-token-abc'));
    // An enabled key is always demanded (opted-in second factor); recognition
    // only controls the risk telemetry, not the gate.
    expect(res.kind).toBe('mfa_required');
    if (res.kind === 'mfa_required') {
      expect(res.method).toBe('security_key');
      expect(res.reason).toBeUndefined();
    }
    expect(riskEvents()).toHaveLength(0);
  });

  it('allows unknown devices when no key is enrolled (logged, not blocked)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM user_auth_identities')) return [identityRow()];
      if (text.includes('FROM sessions')) return [];
      return [];
    };
    const res = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
    expect(res.kind).toBe('authenticated');
    expect(riskEvents()[0]!.params.slice(2, 4)).toEqual(['unknown_device', 'allowed']);
  });

  it('records key-challenge failures without leaking which check failed', async () => {
    const key = generateSecurityKey();
    db.state.resolve = (text) => {
      if (text.includes('FROM user_auth_identities')) return [identityRow({ security_key_hash: hashSecret(key), security_key_enabled: true })];
      return [];
    };
    const challenge = (
      await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq())
    ) as { kind: 'mfa_required'; challengeToken: string };
    await expect(
      completeSecurityKeyChallenge(challenge.challengeToken, generateSecurityKey(), fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'invalid_credentials' });
    expect(riskEvents().some((c) => c.params[2] === 'key_challenge_failed')).toBe(true);
  });

  it('rate-limits credential guessing across the shared bucket', async () => {
    incrMock.mockResolvedValue(21);
    db.state.resolve = () => [];
    await expect(loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq())).rejects.toMatchObject({
      errorCode: 'rate_limited',
    });
  });

  it('keeps unknown-handle and wrong-keyword errors indistinguishable', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM user_auth_identities')) {
        return params[0] === 'nonexistent_zz' ? [] : [identityRow()];
      }
      return [];
    };
    const a = await loginWithKeyword({ handle: 'nonexistent_zz', keyword: KEYWORD }, fakeReq()).catch((e) => e);
    const b = await loginWithKeyword({ handle: HANDLE, keyword: 'WrongKeyword999' }, fakeReq()).catch((e) => e);
    expect(a.errorCode).toBe(b.errorCode);
    expect(a.message).toBe(b.message);
  });
});

describe('zero-domain email-or-handle login', () => {
  const EMAIL = 'zero@example.com';

  function emailResolve() {
    return (text: string, params: unknown[]) => {
      if (text.includes('FROM user_auth_identities') && text.includes('lower(i.handle)')) {
        // Handle lookup misses for the email string; identity found via account.
        return [];
      }
      if (text.includes('FROM users WHERE lower(email)')) {
        return params[0] === EMAIL ? [{ id: USER_ID }] : [];
      }
      if (text.includes('FROM user_auth_identities') && text.includes('i.user_id = $1')) {
        return [identityRow()];
      }
      if (text.includes('FROM sessions')) return [];
      return [];
    };
  }

  it('authenticates with the email label + keyword (no key enrolled)', async () => {
    db.state.resolve = emailResolve();
    const res = await loginWithKeyword({ handle: EMAIL, keyword: KEYWORD }, fakeReq());
    expect(res.kind).toBe('authenticated');
    if (res.kind === 'authenticated') expect(res.userId).toBe(USER_ID);
  });

  it('escalates email login on unknown devices when a key is enrolled', async () => {
    const key = generateSecurityKey();
    db.state.resolve = (text: string, params: unknown[]) => {
      if (text.includes('FROM user_auth_identities') && text.includes('lower(i.handle)')) return [];
      if (text.includes('FROM users WHERE lower(email)')) {
        return params[0] === EMAIL ? [{ id: USER_ID }] : [];
      }
      if (text.includes('FROM user_auth_identities') && text.includes('i.user_id = $1')) {
        return [identityRow({ security_key_hash: hashSecret(key), security_key_enabled: true })];
      }
      if (text.includes('FROM sessions')) return [];
      return [];
    };
    const res = await loginWithKeyword({ handle: EMAIL, keyword: KEYWORD }, fakeReq());
    expect(res.kind).toBe('mfa_required');
    if (res.kind === 'mfa_required') {
      expect(res.method).toBe('security_key');
      expect(res.reason).toBe('unknown_device');
    }
  });

  it('keeps unknown-email, unknown-handle, and wrong-keyword errors identical', async () => {
    db.state.resolve = (text: string, params: unknown[]) => {
      if (text.includes('FROM user_auth_identities') && text.includes('lower(i.handle)')) {
        return params[0] === HANDLE ? [identityRow()] : [];
      }
      if (text.includes('FROM users WHERE lower(email)')) return [];
      return [];
    };
    const a = await loginWithKeyword({ handle: 'ghost@example.com', keyword: KEYWORD }, fakeReq()).catch((e) => e);
    const b = await loginWithKeyword({ handle: 'ghost_handle', keyword: KEYWORD }, fakeReq()).catch((e) => e);
    const c = await loginWithKeyword({ handle: HANDLE, keyword: 'WrongKeyword999' }, fakeReq()).catch((e) => e);
    for (const [x, y] of [[a, b], [b, c]] as const) {
      expect(x.errorCode).toBe(y.errorCode);
      expect(x.message).toBe(y.message);
    }
    expect(a.errorCode).toBe('invalid_credentials');
  });
});
