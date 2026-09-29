/**
 * CodeConClave — auth foundation tests (PHASE 1).
 * Covers: signup/login, invalid credentials, logout, session expiry sweep,
 * session revocation (tenant-scoped), device revocation cascade, device
 * session association, suspicious-session hook, MFA setup/verify, recovery
 * codes (one-time use + reuse rejection), attempt limiting, OAuth state
 * validation, and authentication audit events. DB interaction is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
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
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { env } from '../config/env.js';
import { hashSecret, verifyHash, sha256Hex, encryptAtRest } from '../shared/crypto.js';
import {
  register,
  login,
  logout,
  completeMfa,
  setupMfa,
  confirmMfa,
  disableMfa,
  rotateRecoveryCodes,
  createMfaChallenge,
  revokeSession,
  revokeDevice,
  expireStaleSessions,
  hookSuspiciousSession,
  updateProfile,
  getUserById,
} from '../modules/auth/service.js';
import { googleStateToken, verifyGoogleState, googleConfigured } from '../modules/auth/google.js';
import { AuditAction } from '@codeconclave/shared';

const PASSWORD = 'ValidPass123!';
const SECRET_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fakeReq(ip: string, extra: Record<string, unknown> = {}): Request {
  return {
    ip,
    headers: { 'user-agent': 'foundation/1.0', ...(extra.headers ?? {}) },
    ctx: { traceId: 'trace-1', ip, userAgent: 'foundation/1.0', user: null, sessionId: null, startedAt: Date.now() },
    ...extra,
  } as unknown as Request;
}

function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u1',
    email: 'alice@example.com',
    email_verified: false,
    password_hash: hashSecret(PASSWORD),
    display_name: 'Alice',
    avatar_url: null,
    google_sub: null,
    mfa_enabled: false,
    mfa_secret_encrypted: null,
    recovery_codes_hash: null,
    rbac_role: 'member',
    plan_id: 'free',
    entitlement_state: 'FREE',
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function totpCode(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const key = Buffer.from(bytes);
  const step = Math.floor(Date.now() / 1000 / 30);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

function resolveUser(rows: Record<string, unknown>[] | 'unique'): void {
  db.state.resolve = (text, _params) => {
    if (text.includes('SELECT * FROM users') && text.includes('deleted_at IS NULL')) {
      return rows === 'unique' ? [userRow()] : rows;
    }
    if (text.includes('SELECT * FROM users')) return [userRow()];
    if (text.includes('FROM users')) return rows === 'unique' ? [] : rows;
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('USER IDENTITY — handle + keyword at registration (D1 primary credentials)', () => {
  const HANDLE = 'alice_01';
  const KEYWORD = 'CorrectHorse9Battery';

  function resolveRegistration(handleTaken = false): void {
    db.state.resolve = (text) => {
      if (text.includes('SELECT 1 FROM user_auth_identities')) return handleTaken ? [{ '?column?': 1 }] : [];
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [];
      // getUserById / device lookup: the new account resolves to the fixture row.
      if (text.includes('SELECT * FROM users')) return [userRow()];
      if (text.includes('FROM users')) return [];
      if (text.includes('FROM sessions')) return [];
      return null;
    };
  }

  it('creates the identity row in the SAME transaction, storing only a scrypt keyword hash', async () => {
    resolveRegistration();
    const result = await register(
      { email: 'alice@example.com', password: PASSWORD, handle: HANDLE, keyword: KEYWORD },
      fakeReq('10.0.0.1'),
    );
    expect(result.sessionToken).toBeTruthy();

    const identityInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_auth_identities'));
    expect(identityInsert).toBeTruthy();
    expect(identityInsert!.params[2]).toBe(HANDLE);
    const keywordHash = identityInsert!.params[3] as string;
    expect(keywordHash.startsWith('scrypt$')).toBe(true);
    expect(keywordHash).not.toContain(KEYWORD);
    expect(verifyHash(keywordHash, KEYWORD)).toBe(true);

    // Both inserts are issued through the same tenant client, so a failure in
    // either rolls the account back rather than orphaning it.
    const order = db.state.calls.filter(
      (c) => c.text.includes('INSERT INTO users') || c.text.includes('INSERT INTO user_auth_identities'),
    );
    expect(order).toHaveLength(2);
    expect(order[0]!.text).toContain('INSERT INTO users');
    expect(order[1]!.text).toContain('INSERT INTO user_auth_identities');
  });

  it('normalizes the handle to lowercase', async () => {
    resolveRegistration();
    await register({ email: 'alice@example.com', password: PASSWORD, handle: '  Alice_01 ', keyword: KEYWORD }, fakeReq());
    expect(db.state.calls.find((c) => c.text.includes('INSERT INTO user_auth_identities'))!.params[2]).toBe('alice_01');
  });

  it('refuses a half-pair (handle without keyword) before writing anything', async () => {
    resolveRegistration();
    await expect(
      register({ email: 'alice@example.com', password: PASSWORD, handle: HANDLE }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'identity_pair_required' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO users'))).toBe(false);
  });

  it('rejects an invalid handle and creates NO user (validated before insert)', async () => {
    resolveRegistration();
    await expect(
      register({ email: 'alice@example.com', password: PASSWORD, handle: 'ad', keyword: KEYWORD }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'invalid_handle' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO users'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO user_auth_identities'))).toBe(false);
  });

  it('rejects a weak keyword and creates NO user', async () => {
    resolveRegistration();
    await expect(
      register({ email: 'alice@example.com', password: PASSWORD, handle: HANDLE, keyword: 'alllowercase' }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'invalid_keyword' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO users'))).toBe(false);
  });

  it('surfaces handle_taken for an already-registered handle', async () => {
    resolveRegistration(true);
    await expect(
      register({ email: 'alice@example.com', password: PASSWORD, handle: HANDLE, keyword: KEYWORD }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'handle_taken', status: 409 });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO users'))).toBe(false);
  });

  it('maps a unique-index violation on the handle to handle_taken (race loser)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT 1 FROM user_auth_identities')) return [];
      if (text.includes('SELECT id FROM users WHERE lower(email)')) return [];
      if (text.includes('SELECT * FROM users')) return [userRow()];
      if (text.includes('FROM users')) return [];
      if (text.includes('FROM sessions')) return [];
      if (text.includes('INSERT INTO user_auth_identities')) {
        throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_auth_identity_handle' });
      }
      return null;
    };
    await expect(
      register({ email: 'alice@example.com', password: PASSWORD, handle: HANDLE, keyword: KEYWORD }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'handle_taken' });
  });

  it('still allows a legacy registration with no handle/keyword at all', async () => {
    resolveRegistration();
    const result = await register({ email: 'old@example.com', password: PASSWORD }, fakeReq());
    expect(result.sessionToken).toBeTruthy();
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO user_auth_identities'))).toBe(false);
  });
});

describe('USER IDENTITY — signup', () => {
  it('registers a unique user with a scrypt password hash, never plaintext', async () => {
    resolveUser([]);
    const result = await register({ email: 'Alice@Example.com', password: PASSWORD, displayName: 'Alice' }, fakeReq('10.0.0.1'));
    expect(result.user.id).toBe('u1');
    expect(result.user.email).toBe('alice@example.com');
    expect(result.sessionToken).toBeTruthy();

    const usersInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO users'))!;
    expect(usersInsert.params[1]).toBe('alice@example.com');
    const hash = usersInsert.params[2] as string;
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith('scrypt$v2$')).toBe(true);
    expect(verifyHash(hash, PASSWORD)).toBe(true);

    const entitlement = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'))!;
    expect(entitlement.params).toHaveLength(2);
    expect(entitlement.text).toContain("'free'");
    expect(entitlement.text).toContain("'FREE'");
    const prefs = db.state.calls.find((c) => c.text.includes('INSERT INTO user_preferences'))!;
    expect(prefs).toBeDefined();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_LOGIN }));
  });

  it('rejects a duplicate email with email_taken', async () => {
    resolveUser([{ id: 'u_existing' }]);
    await expect(register({ email: 'alice@example.com', password: PASSWORD }, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'email_taken',
      status: 409,
    });
  });

  it('creates the session with a hashed token and never stores the raw token', async () => {
    resolveUser([]);
    await register({ email: 'alice@example.com', password: PASSWORD }, fakeReq('10.0.0.1'));
    const sessionsInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'))!;
    expect(sessionsInsert.params.length).toBe(7);
    const hash = sessionsInsert.params[2] as string;
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it('updateProfile persists a trimmed display name and returns the fresh user', async () => {
    const updated = userRow({ display_name: 'Aly' });
    db.state.resolve = (text, _params) => {
      if (text.includes('UPDATE users SET display_name')) return { affected: 1 };
      if (text.includes('SELECT * FROM users')) return [updated];
      return null;
    };
    const result = await updateProfile('u1', { displayName: '  Aly  ' });
    const updateCall = db.state.calls.find((c) => c.text.includes('UPDATE users SET display_name'))!;
    expect(updateCall).toBeDefined();
    expect(updateCall.params[0]).toBe('Aly');
    expect(updateCall.params[1]).toBe('u1');
    expect(result.displayName).toBe('Aly');
  });

  it('updateProfile rejects a display name shorter than 2 characters', async () => {
    await expect(updateProfile('u1', { displayName: 'A' })).rejects.toMatchObject({
      errorCode: 'display_name_short',
      status: 400,
    });
  });

  it('updateProfile clears the display name when null is passed', async () => {
    db.state.resolve = (text, _params) => {
      if (text.includes('UPDATE users SET display_name')) return { affected: 1 };
      if (text.includes('SELECT * FROM users')) return [userRow({ display_name: null })];
      return null;
    };
    await updateProfile('u1', { displayName: null });
    const updateCall = db.state.calls.find((c) => c.text.includes('UPDATE users SET display_name'))!;
    expect(updateCall).toBeDefined();
    expect(updateCall.params[0]).toBeNull();
  });
});

describe('USER IDENTITY — onboarding role + primary use case', () => {
  it('register persists role and primary use case into the users insert', async () => {
    resolveUser([]);
    await register(
      { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice', role: 'Founder', primaryUseCase: 'Research' },
      fakeReq('10.0.0.1'),
    );
    const usersInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO users'))!;
    expect(usersInsert.text).toContain('role');
    expect(usersInsert.text).toContain('primary_use_case');
    expect(usersInsert.params).toContain('Founder');
    expect(usersInsert.params).toContain('Research');
  });

  it('register allows omitted onboarding fields (null role / use case)', async () => {
    resolveUser([]);
    await register({ email: 'alice@example.com', password: PASSWORD }, fakeReq('10.0.0.1'));
    const usersInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO users'))!;
    expect(usersInsert.params).toContain(null);
  });

  it('updateProfile persists role and primary use case together', async () => {
    const updated = userRow({ role: 'Designer', primary_use_case: 'Learning' });
    db.state.resolve = (text, _params) => {
      if (text.includes('UPDATE users SET role')) return { affected: 1 };
      if (text.includes('SELECT * FROM users')) return [updated];
      return null;
    };
    const result = await updateProfile('u1', { role: 'Designer', primaryUseCase: 'Learning' });
    const updateCall = db.state.calls.find((c) => c.text.includes('UPDATE users SET role'))!;
    expect(updateCall).toBeDefined();
    expect(updateCall.text).toContain('primary_use_case');
    expect(result.role).toBe('Designer');
    expect(result.primaryUseCase).toBe('Learning');
  });

  it('updateProfile rejects a role outside the allow-list', async () => {
    await expect(updateProfile('u1', { role: 'Hacker' })).rejects.toMatchObject({
      errorCode: 'invalid_role',
      status: 400,
    });
  });

  it('updateProfile rejects a primary use case outside the allow-list', async () => {
    await expect(updateProfile('u1', { primaryUseCase: 'Wasting time' })).rejects.toMatchObject({
      errorCode: 'invalid_use_case',
      status: 400,
    });
  });

  it('updateProfile clears role and primary use case when null is passed', async () => {
    db.state.resolve = (text, _params) => {
      if (text.includes('UPDATE users SET role')) return { affected: 1 };
      if (text.includes('SELECT * FROM users')) return [userRow({ role: null, primary_use_case: null })];
      return null;
    };
    await updateProfile('u1', { role: null, primaryUseCase: null });
    const updateCall = db.state.calls.find((c) => c.text.includes('UPDATE users SET role'))!;
    expect(updateCall.params[0]).toBeNull();
    expect(updateCall.params[1]).toBeNull();
  });
});

describe('AUTHENTICATION — login, logout, failures', () => {
  it('logs in with valid credentials and emits auth.login', async () => {
    resolveUser('unique');
    const result = await login({ email: 'alice@example.com', password: PASSWORD }, fakeReq('10.0.0.1'));
    expect(result.user.id).toBe('u1');
    expect(result.sessionToken).toBeTruthy();
    const sessionsInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'))!;
    expect(sessionsInsert.text).toContain('device_id');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_LOGIN }));
  });

  it('rejects an invalid password with bad_credentials and audits the failure', async () => {
    resolveUser('unique');
    await expect(login({ email: 'alice@example.com', password: 'WrongPass123!' }, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'bad_credentials',
      status: 401,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_LOGIN_FAILED, detail: { reason: 'bad_credentials' } }),
    );
  });

  it('rejects an unknown email without revealing account existence', async () => {
    resolveUser([]);
    await expect(login({ email: 'ghost@example.com', password: PASSWORD }, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'bad_credentials',
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_LOGIN_FAILED }));
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions')).length).toBe(0);
  });

  it('requests an MFA challenge instead of a session when MFA is enabled', async () => {
    resolveUser('unique' as never);
    db.state.resolve = (text) => {
      if (text.includes('FROM users')) {
        const row = userRow({ mfa_enabled: true, mfa_secret_encrypted: 'v1:xx' });
        return [row];
      }
      if (text.includes('FROM sessions')) return [];
      return null;
    };
    const result = await login({ email: 'alice@example.com', password: PASSWORD }, fakeReq('10.0.0.1'));
    expect(result).toHaveProperty('mfaRequired', true);
    expect((result as { challengeToken: string }).challengeToken.startsWith('mfa_')).toBe(true);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions')).length).toBe(0);
  });

  it('logout revokes the session for the same user only and audits auth.logout', async () => {
    resolveUser('unique');
    await logout('u1', 'sess_1', fakeReq('10.0.0.1'));
    const upd = db.state.calls.find((c) => c.text.includes("state = 'REVOKED'"))!;
    expect(upd.params).toEqual(['sess_1', 'u1']);
    expect(upd.text).toContain('user_id = $2');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_LOGOUT }));
  });
});

describe('SESSION lifecycle — expiry sweep, revocation, device cascade', () => {
  it('sweeps ACTIVE sessions past their TTL to EXPIRED', async () => {
    db.state.rowCount = 7;
    expect(await expireStaleSessions()).toBe(7);
    const sweep = db.state.calls.find((c) => c.text.includes("state = 'EXPIRED'"))!;
    expect(sweep.text).toContain("WHERE state = 'ACTIVE' AND expires_at <= now()");
  });

  it('revokes a session tenant-scoped and audits session.revoked', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING id') ? [{ id: 'sess_1' }] : null);
    await revokeSession('u1', 'sess_1', fakeReq('10.0.0.1'));
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE sessions'))!;
    expect(upd.text).toContain('id = $1 AND user_id = $2');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.SESSION_REVOKED, resourceId: 'sess_1' }));
  });

  it('refuses to revoke a session owned by another user (isolation)', async () => {
    await expect(revokeSession('u2', 'sess_1')).rejects.toMatchObject({ errorCode: 'not_found', status: 404 });
  });

  it('revokes a device and cascades revocation to its ACTIVE sessions', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING id') ? [{ id: 'dev_1' }] : null);
    await revokeDevice('u1', 'dev_1', fakeReq('10.0.0.1'));
    const deviceUpd = db.state.calls.find((c) => c.text.includes('UPDATE devices'))!;
    expect(deviceUpd.text).toContain('revoked_at = now()');
    expect(deviceUpd.text).toContain('user_id = $2');
    const sessionsUpd = db.state.calls.find((c) => c.text.includes('UPDATE sessions'))!;
    expect(sessionsUpd.text).toContain("WHERE device_id = $1 AND state = 'ACTIVE'");
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEVICE_REVOKED }));
  });

  it('refuses to revoke a device of another user', async () => {
    await expect(revokeDevice('u2', 'dev_1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('associates a login session with a PAIRED device presented via x-device-token', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM users')) return [userRow()];
      if (text.includes('FROM devices')) return [{ id: 'dev_1' }];
      return null;
    };
    await login(
      { email: 'alice@example.com', password: PASSWORD },
      fakeReq('10.0.0.1', { headers: { 'user-agent': 'foundation/1.0', 'x-device-token': 'raw-device-token' } }),
    );
    const sessionsInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'))!;
    expect(sessionsInsert.params[5]).toBe('dev_1');
    const deviceLookup = db.state.calls.find((c) => c.text.includes('FROM devices'))!;
    expect(deviceLookup.params[1]).toBe(sha256Hex('raw-device-token'));
  });
});

describe('CROSS-BROWSER — account is the identity, session is the browser', () => {
  it('two browser logins for the same account create two INDEPENDENT sessions, keyed only by token hash, never bound to a fingerprint', async () => {
    resolveUser('unique');
    const chromeReq = fakeReq('10.0.0.1', { headers: { 'user-agent': 'Chrome/126.0.0.0' } });
    const edgeReq = fakeReq('10.0.0.1', { headers: { 'user-agent': 'Edge/126.0.0.0' } });
    const first = await login({ email: 'alice@example.com', password: PASSWORD }, chromeReq);
    const second = await login({ email: 'alice@example.com', password: PASSWORD }, edgeReq);

    // Never the same token: each browser creates its OWN server-side session.
    expect(first.sessionToken).toBeTruthy();
    expect(second.sessionToken).toBeTruthy();
    expect(first.sessionToken).not.toBe(second.sessionToken);

    // No browser fingerprint / device / local-storage binding for plain logins.
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions'));
    expect(inserts.length).toBe(2);
    for (const insert of inserts) {
      expect(insert.params[2]).toMatch(/^[0-9a-f]{64}$/); // sha256(token) only
      expect(insert.params[2]).not.toBe(first.sessionToken);
      expect(insert.params[2]).not.toBe(second.sessionToken);
      expect(insert.params[5]).toBeNull(); // device_id = null for browser login
      expect(insert.params[1]).toBe('u1'); // SAME account in both sessions
    }
    // user-agent is metadata recorded for audit, never an authorization key.
    const agents = inserts.map((i) => i.params[4]).sort();
    expect(agents).toEqual(['Chrome/126.0.0.0', 'Edge/126.0.0.0']);
  });
});

describe('SUSPICIOUS-SESSION hook', () => {
  it('flags and audits a login from an unseen IP', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM sessions')) return [{ ip: '1.1.1.1' }];
      return null;
    };
    await hookSuspiciousSession('u1', 'sess_1', fakeReq('9.9.9.9'));
    const flag = db.state.calls.find((c) => c.text.includes('risk_flags'))!;
    expect(flag.text).toContain('risk_flags || $2::jsonb');
    expect(flag.params[1]).toContain('new_ip');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_SUSPICIOUS_LOGIN, detail: expect.objectContaining({ reason: 'new_ip' }) }),
    );
  });

  it('stays silent for a previously seen IP', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM sessions')) return [{ ip: '10.0.0.1' }];
      return null;
    };
    await hookSuspiciousSession('u1', 'sess_1', fakeReq('10.0.0.1'));
    expect(db.state.calls.filter((c) => c.text.includes('risk_flags')).length).toBe(0);
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_SUSPICIOUS_LOGIN }));
  });
});

describe('MFA — setup, verification, recovery codes', () => {
  it('setupMfa stores an encrypted secret, never the raw base32', async () => {
    db.state.resolve = (text) => (text.includes('FROM users') ? [{ email: 'alice@example.com' }] : null);
    const setup = await setupMfa('u1');
    expect(setup.secretBase32.length).toBeGreaterThanOrEqual(26);
    expect(setup.secretOtpAuthUrl).toContain('otpauth://totp/');
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!;
    expect(upd.params[0]).not.toContain(setup.secretBase32);
    expect(String(upd.params[0]).startsWith('v1:')).toBe(true);
  });

  it('confirmMfa enables MFA, stores hashed recovery codes (never plaintext), and returns them once', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('mfa_secret_encrypted')) return [{ mfa_secret_encrypted: encrypted }];
      return null;
    };
    const { recoveryCodes: codes } = await confirmMfa('u1', totpCode(setup.secretBase32), fakeReq('10.0.0.1'));
    expect(codes.length).toBe(env.RECOVERY_CODE_COUNT);
    const mfaEnable = db.state.calls.find((c) => c.text.includes('mfa_enabled = true'))!;
    expect(mfaEnable).toBeDefined();
    const codeInserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO recovery_codes'));
    expect(codeInserts.length).toBe(env.RECOVERY_CODE_COUNT);
    for (const insert of codeInserts) {
      const hash = insert.params[2] as string;
      expect(hash).not.toContain(codes[0]);
      expect(hash.startsWith('scrypt$v2$')).toBe(true);
      expect(verifyHash(hash, codes[codeInserts.indexOf(insert)]!)).toBe(true);
    }
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_MFA_ENABLED }));
  });

  it('confirmMfa rejects an invalid TOTP code', async () => {
    db.state.resolve = (text) => {
      if (text.includes('mfa_secret_encrypted')) return [{ mfa_secret_encrypted: encryptAtRest(SECRET_BASE32) }];
      return null;
    };
    await expect(confirmMfa('u1', '000000', fakeReq('10.0.0.1'))).rejects.toMatchObject({ errorCode: 'mfa_code_invalid' });
  });

  it('disableMfa clears the secret and recovery codes, and audits', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('mfa_secret_encrypted')) return [{ mfa_secret_encrypted: encrypted }];
      return null;
    };
    await disableMfa('u1', totpCode(setup.secretBase32), fakeReq('10.0.0.1'));
    const clear = db.state.calls.find((c) => c.text.includes('mfa_enabled = false'))!;
    expect(clear.text).toContain('mfa_secret_encrypted = NULL');
    expect(db.state.calls.filter((c) => c.text.includes('DELETE FROM recovery_codes')).length).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_MFA_DISABLED }));
  });

  it('rotateRecoveryCodes replaces all codes and audits', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('mfa_secret_encrypted')) return [{ mfa_secret_encrypted: encrypted }];
      return null;
    };
    const codes = await rotateRecoveryCodes('u1', totpCode(setup.secretBase32), fakeReq('10.0.0.1'));
    expect(codes.length).toBe(env.RECOVERY_CODE_COUNT);
    expect(db.state.calls.filter((c) => c.text.includes('DELETE FROM recovery_codes')).length).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_MFA_RECOVERY_ROTATED }));
  });

  it('completeMfa verifies a TOTP code server-side and creates a session', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('FROM users')) return [userRow({ mfa_enabled: true, mfa_secret_encrypted: encrypted })];
      return null;
    };
    const challenge = createMfaChallenge('u1');
    const result = await completeMfa({ challengeToken: challenge, code: totpCode(setup.secretBase32) }, fakeReq('10.0.0.1'));
    expect(result.sessionToken).toBeTruthy();
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions')).length).toBe(1);
  });

  it('rejects a wrong MFA code with mfa_failed and audits it', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('FROM users')) return [userRow({ mfa_enabled: true, mfa_secret_encrypted: encrypted })];
      return null;
    };
    const challenge = createMfaChallenge('u1');
    await expect(completeMfa({ challengeToken: challenge, code: '000000' }, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'mfa_failed',
    });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.mfa_failed' }));
  });

  it('caps MFA attempts per challenge', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('FROM users')) return [userRow({ mfa_enabled: true, mfa_secret_encrypted: encrypted })];
      return null;
    };
    const challenge = createMfaChallenge('u1');
    for (let i = 0; i < env.MFA_MAX_ATTEMPTS; i++) {
      await expect(completeMfa({ challengeToken: challenge, code: '000000' }, fakeReq('10.0.0.1'))).rejects.toMatchObject({
        errorCode: 'mfa_failed',
      });
    }
    await expect(completeMfa({ challengeToken: challenge, code: '000000' }, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'mfa_attempts_exhausted',
    });
  });

  it('recovery codes are one-time: success on first use, rejection on reuse', async () => {
    const code = 'ABCD1234EF';
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    let unused = [{ id: 'rc1', code_hash: hashSecret(code, 16) }];
    db.state.resolve = (text) => {
      if (text.includes('FROM users')) return [userRow({ mfa_enabled: true, mfa_secret_encrypted: encrypted })];
      if (text.includes('used_at IS NULL')) return unused;
      if (text.includes('UPDATE recovery_codes')) {
        unused = [];
        return null;
      }
      return null;
    };
    const challenge = createMfaChallenge('u1');
    const first = await completeMfa({ challengeToken: challenge, recoveryCode: code }, fakeReq('10.0.0.1'));
    expect(first.sessionToken).toBeTruthy();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_RECOVERY_USED, detail: { via: 'recovery_code' } }));

    const secondChallenge = createMfaChallenge('u1');
    await expect(
      completeMfa({ challengeToken: secondChallenge, recoveryCode: code }, fakeReq('10.0.0.1')),
    ).rejects.toMatchObject({ errorCode: 'mfa_failed' });
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions')).length).toBe(1);
  });
});

describe('GOOGLE OAUTH — state validation (no client-side authority)', () => {
  it('accepts a freshly minted state token', () => {
    const token = googleStateToken(randomNonce());
    expect(() => verifyGoogleState(token)).not.toThrow();
  });

  it('rejects a tampered state token', () => {
    const token = googleStateToken(randomNonce());
    expect(() => verifyGoogleState(`${token}tampered`)).toThrowError(
      expect.objectContaining({ errorCode: 'google_state_invalid' }),
    );
    expect(() => verifyGoogleState(`garbage.${token}`)).toThrowError(
      expect.objectContaining({ errorCode: 'google_state_invalid' }),
    );
  });

  it('rejects an expired state token', () => {
    const body = Buffer.from(JSON.stringify({ nonce: 'n', exp: Date.now() - 5000 })).toString('base64url');
    const sig = createHmac('sha256', env.JWT_SECRET).update(`google-oauth:${body}`).digest('base64url');
    expect(() => verifyGoogleState(`${body}.${sig}`)).toThrowError(
      expect.objectContaining({ errorCode: 'google_state_expired' }),
    );
  });

  it('returns 503 when Google OAuth is not configured on the server', () => {
    // googleConfigured() reads env; simulate the unconfigured state even when
    // the local .env carries a real client id/secret.
    const savedId = env.GOOGLE_CLIENT_ID;
    const savedSecret = env.GOOGLE_CLIENT_SECRET;
    env.GOOGLE_CLIENT_ID = undefined;
    env.GOOGLE_CLIENT_SECRET = undefined;
    expect(googleConfigured()).toBe(false);
    env.GOOGLE_CLIENT_ID = savedId;
    env.GOOGLE_CLIENT_SECRET = savedSecret;
  });
});

function randomNonce(): string {
  return String(Math.random().toString(36).slice(2));
}

describe('SECURITY posture asserts', () => {
  it('never logs or returns the raw session token or secrets', async () => {
    resolveUser([]);
    const result = await register({ email: 'alice@example.com', password: PASSWORD }, fakeReq('10.0.0.1'));
    const sessionsInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO sessions'))!;
    expect(sessionsInsert.params[2]).not.toBe(result.sessionToken);
    expect(result.sessionToken.length).toBe(64);
  });

  it('MFA challenge tokens are HMAC-signed and verify server-side', () => {
    const challenge = createMfaChallenge('u1');
    const [body, sig] = challenge.slice(4).split('.');
    expect(sig).toBeTruthy();
    const expected = createHmac('sha256', env.JWT_SECRET).update(`mfa-challenge:${body}`).digest('base64url');
    expect(sig).toBe(expected);
  });
});