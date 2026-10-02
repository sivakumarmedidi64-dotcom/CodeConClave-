/**
 * CodeConClave — passwordless email OTP auth tests.
 * Covers: hashed-at-rest codes, outbox delivery payload, email normalization,
 * anti-enumeration (identical responses for known/unknown addresses), resend
 * cooldown, per-email and per-IP hourly caps, active-code revocation on new
 * issue, single-use consumption, expiry, attempt locking, new-account
 * provisioning (user + FREE entitlement + preferences), existing-account
 * sign-in, MFA preservation (challenge, never a session), audit events, and
 * cross-surface consistency (repeated sign-ins resolve to the same account).
 * DB, cache, outbox, audit and the auth service are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';
import { hashSecret } from '../shared/crypto.js';
import { otpRequestSchema, otpVerifySchema } from '@codeconclave/shared';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 1,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  return {
    state,
    pool: { query },
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const cache = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  incr: vi.fn(async () => 1),
  del: vi.fn(async () => {}),
}));
vi.mock('../shared/cache.js', () => ({ cache }));

const enqueueOutbox = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox }));

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const USER = {
  id: 'u1',
  email: 'alice@example.com',
  emailVerified: true,
  displayName: null,
  avatarUrl: null,
  googleSub: null,
  role: null,
  primaryUseCase: null,
  mfaEnabled: false,
  rbacRole: 'member',
  planId: 'free',
  entitlementState: 'FREE',
};

const svc = vi.hoisted(() => ({
  createMfaChallenge: vi.fn((userId: string) => `mfa_ch_${userId}`),
  createSessionForUser: vi.fn(async () => ({ token: 'sess-token', sessionId: 'ses_1' })),
  getUserById: vi.fn(async () => USER),
  hookSuspiciousSession: vi.fn(async () => {}),
}));
vi.mock('../modules/auth/service.js', () => svc);

import { requestOtp, verifyOtp, RESEND_MIN_INTERVAL_MS, MAX_ATTEMPTS } from '../modules/auth/otp.js';
import { AuditAction } from '@codeconclave/shared';

const CODE_OK = '123456';
const CODE_BAD = '999999';

function fakeReq(ip = '10.0.0.1'): Request {
  return {
    ip,
    headers: { 'user-agent': 'otp/1.0' },
    ctx: { traceId: 'trace-1', ip, userAgent: 'otp/1.0', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

function otpRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'otp_1',
    email: 'alice@example.com',
    code_hash: hashSecret(CODE_OK),
    status: 'PENDING',
    attempts: 0,
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    used_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

function setupResolve(opts: { existing?: boolean; otp?: Record<string, unknown> | null } = {}) {
  db.state.resolve = (text: string) => {
    if (text.includes('FROM users')) return opts.existing ? [{ id: 'u1' }] : [];
    if (text.startsWith('SELECT * FROM email_otps')) return opts.otp ? [opts.otp] : [];
    if (text.includes('RETURNING id')) return opts.otp ? [{ id: (opts.otp.id as string) ?? 'otp_1' }] : [];
    return null;
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 1;
  db.state.resolve = null;
  cache.get.mockReset();
  cache.set.mockReset();
  cache.incr.mockReset();
  cache.incr.mockResolvedValue(1);
  cache.get.mockResolvedValue(null);
  enqueueOutbox.mockClear();
  recordAudit.mockClear();
  svc.createMfaChallenge.mockClear();
  svc.createSessionForUser.mockClear();
  svc.createSessionForUser.mockResolvedValue({ token: 'sess-token', sessionId: 'ses_1' });
  svc.getUserById.mockClear();
  svc.getUserById.mockResolvedValue(USER);
  svc.hookSuspiciousSession.mockClear();
});

// ---------------------------------------------------------------- request

describe('REQUEST otp', () => {
  it('persists only a scrypt hash (never the raw code), audits, and enqueues a code email', async () => {
    setupResolve();
    const result = await requestOtp({ email: 'alice@example.com' }, fakeReq());
    expect(result.sent).toBe(true);
    expect(result.resendableAfterMs).toBe(RESEND_MIN_INTERVAL_MS);
    expect(result.expiresInSeconds).toBe(600);

    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO email_otps'))!;
    expect(insert.params[1]).toBe('alice@example.com');
    const stored = insert.params[2] as string;
    expect(stored.startsWith('scrypt$v2$')).toBe(true);

    expect(enqueueOutbox).toHaveBeenCalledWith(
      'auth.email_otp',
      expect.objectContaining({
        channel: 'email',
        to: 'alice@example.com',
        subject: expect.stringContaining('sign-in'),
      }),
    );
    const payload = enqueueOutbox.mock.calls[0][1] as { userId?: string; html: string };
    expect(payload.userId).toBeUndefined();
    expect(payload.html).toMatch(/\d{6}/);
    const rawCode = payload.html.match(/\d{6}/)![0];
    expect(stored).not.toContain(rawCode);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_OTP_REQUESTED, actorUserId: null, tenantId: null }),
    );
  });

  it('attaches the existing account id to the outbox payload for audit attribution', async () => {
    setupResolve({ existing: true });
    await requestOtp({ email: 'alice@example.com' }, fakeReq());
    const payload = enqueueOutbox.mock.calls[0][1] as { userId: string };
    expect(payload.userId).toBe('u1');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'u1', tenantId: 'u1' }));
  });

  it('normalizes email casing before storing and sending', async () => {
    setupResolve();
    await requestOtp({ email: '  Alice@EXAMPLE.COM  ' }, fakeReq());
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO email_otps'))!;
    expect(insert.params[1]).toBe('alice@example.com');
    const payload = enqueueOutbox.mock.calls[0][1] as { to: string };
    expect(payload.to).toBe('alice@example.com');
  });

  it('returns an identical response for known and unknown addresses (anti-enumeration)', async () => {
    setupResolve({ existing: true });
    const known = await requestOtp({ email: 'alice@example.com' }, fakeReq());
    setupResolve();
    const unknown = await requestOtp({ email: 'stranger@example.com' }, fakeReq());
    expect(unknown).toEqual(known);
  });

  it('enforces the 60s resend cooldown per email', async () => {
    cache.get.mockResolvedValue(String(Date.now() - 5_000));
    setupResolve();
    await expect(requestOtp({ email: 'alice@example.com' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_throttled',
    });
  });

  it('enforces the per-email hourly cap', async () => {
    cache.incr.mockResolvedValueOnce(4);
    setupResolve();
    await expect(requestOtp({ email: 'alice@example.com' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_rate_limited',
    });
  });

  it('enforces the per-IP hourly cap', async () => {
    cache.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(11);
    setupResolve();
    await expect(requestOtp({ email: 'alice@example.com' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_ip_rate_limited',
    });
  });

  it('revokes any previously issued active code before issuing a new one', async () => {
    setupResolve();
    await requestOtp({ email: 'alice@example.com' }, fakeReq());
    const revoke = db.state.calls.find((c) => c.text.includes("status = 'REVOKED'"));
    expect(revoke).toBeDefined();
    expect(revoke!.text).toContain("status = 'PENDING'");
  });

  it('fails closed when the rate-limit store is unavailable', async () => {
    cache.incr.mockRejectedValueOnce(new Error('redis down'));
    setupResolve();
    await expect(requestOtp({ email: 'alice@example.com' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'rate_limit_unavailable',
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO email_otps'))).toBe(false);
  });

  it('rejects malformed emails at the contract boundary', () => {
    expect(() => otpRequestSchema.parse({ email: 'not-an-email' })).toThrow();
    expect(() => otpVerifySchema.parse({ email: 'a@b.com', code: '12345' })).toThrow();
    expect(() => otpVerifySchema.parse({ email: 'a@b.com', code: '123456' })).not.toThrow();
  });
});

// ---------------------------------------------------------------- verify

describe('VERIFY otp', () => {
  it('signs an EXISTING account in, keeps the same user id, and marks the email verified', async () => {
    setupResolve({ existing: true, otp: otpRow() });
    const result = await verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq());

    expect(result).toMatchObject({ sessionToken: 'sess-token', sessionId: 'ses_1' });
    expect((result as { user: typeof USER }).user.id).toBe('u1');
    expect(svc.createSessionForUser).toHaveBeenCalledWith('u1', expect.anything());

    const verifyUpdate = db.state.calls.find((c) => c.text.includes('UPDATE users SET email_verified'));
    expect(verifyUpdate!.params).toEqual(['u1']);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO users'))).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO entitlements'))).toBe(false);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_OTP_VERIFIED, actorUserId: 'u1', detail: { via: 'otp' } }),
    );
  });

  it('auto-provisions a NEW account (user + FREE entitlement + preferences) with email_verified true', async () => {
    setupResolve({ existing: false, otp: otpRow() });
    const result = await verifyOtp({ email: 'newbie@example.com', code: CODE_OK }, fakeReq());
    expect(result).toMatchObject({ sessionToken: 'sess-token' });

    const userInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO users'))!;
    expect(userInsert.params[1]).toBe('newbie@example.com');
    expect(userInsert.text).toContain('email_verified');
    expect(userInsert.text).toContain('true');

    const username = userInsert.params[0] as string;
    const entInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO entitlements'))!;
    const prefInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_preferences'))!;
    expect(entInsert.params[1]).toBe(username);
    expect(entInsert.text).toContain("'free','FREE'");
    expect(prefInsert.params[1]).toBe(username);
    expect(svc.createSessionForUser).toHaveBeenCalled();
  });

  it('consumes the code atomically (single-use) and rejects a concurrent double-use', async () => {
    setupResolve({ existing: true, otp: otpRow() });
    await verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq());

    const consume = db.state.calls.find((c) => c.text.includes("status = 'USED'"));
    expect(consume).toBeDefined();
    expect(consume!.text).toContain("status = 'PENDING'");

    // A race where the UPDATE returns no rows must fail closed, not sign in.
    db.state.resolve = (text) => {
      if (text.includes('FROM users')) return [{ id: 'u1' }];
      if (text.startsWith('SELECT * FROM email_otps')) return [otpRow()];
      return [];
    };
    await expect(verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_invalid',
    });
    expect(svc.createSessionForUser).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong code, increments the attempt counter, and audits the failure', async () => {
    setupResolve({ existing: true, otp: otpRow({ attempts: 1 }) });
    await expect(verifyOtp({ email: 'alice@example.com', code: CODE_BAD }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_invalid',
    });
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE email_otps SET attempts'));
    expect(upd).toBeDefined();
    expect(upd!.params[1]).toBe(2);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_OTP_FAILED, actorUserId: 'u1', detail: { reason: 'invalid_code' } }),
    );
  });

  it('revokes the code after the max attempts are exhausted', async () => {
    setupResolve({ existing: true, otp: otpRow({ attempts: MAX_ATTEMPTS - 1 }) });
    await expect(verifyOtp({ email: 'alice@example.com', code: CODE_BAD }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_invalid',
    });
    const revoke = db.state.calls.filter((c) => c.text.includes("status = 'REVOKED'"));
    expect(revoke.length).toBeGreaterThan(0);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_OTP_FAILED, detail: { reason: 'invalid_code' } }),
    );
  });

  it('rejects an exhausted code without further guessing', async () => {
    setupResolve({ existing: true, otp: otpRow({ attempts: MAX_ATTEMPTS }) });
    await expect(verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_invalid',
    });
    const revoke = db.state.calls.find((c) => c.text.includes("status = 'REVOKED'"));
    expect(revoke).toBeDefined();
  });

  it('rejects an expired code and revokes it', async () => {
    setupResolve({ existing: true, otp: otpRow({ expires_at: new Date(Date.now() - 1000) }) });
    await expect(verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq())).rejects.toMatchObject({
      errorCode: 'otp_invalid',
    });
    const revoke = db.state.calls.find((c) => c.text.includes("status = 'REVOKED'"));
    expect(revoke).toBeDefined();
    expect(svc.createSessionForUser).not.toHaveBeenCalled();
  });

  it('returns the same generic error for an unknown address and a missing code (anti-enumeration)', async () => {
    setupResolve({ existing: false, otp: null });
    const err1 = await verifyOtp({ email: 'stranger@example.com', code: CODE_OK }, fakeReq()).catch((e) => e);

    setupResolve({ existing: true, otp: otpRow() });
    const err2 = await verifyOtp({ email: 'alice@example.com', code: CODE_BAD }, fakeReq()).catch((e) => e);

    expect(err1.errorCode).toBe('otp_invalid');
    expect(err2.errorCode).toBe('otp_invalid');
    expect(String(err2.message)).toBe(String(err1.message));
  });

  it('normalizes email casing on verify', async () => {
    setupResolve({ existing: true, otp: otpRow() });
    await verifyOtp({ email: '  ALICE@EXAMPLE.COM  ', code: CODE_OK }, fakeReq());
    const otpSelect = db.state.calls.find((c) => c.text.startsWith('SELECT * FROM email_otps'));
    expect(otpSelect!.params[0]).toBe('alice@example.com');
  });

  it('preserves MFA: an enabled account gets a challenge and NEVER a session', async () => {
    svc.getUserById.mockResolvedValue({ ...USER, mfaEnabled: true });
    setupResolve({ existing: true, otp: otpRow() });
    const result = await verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq());
    expect(result).toMatchObject({ mfaRequired: true, userId: 'u1' });
    expect(String((result as { challengeToken: string }).challengeToken)).toContain('u1');
    expect(svc.createSessionForUser).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_OTP_VERIFIED }));
  });

  it('is cross-surface consistent: consecutive sign-ins for the same email hit the same account', async () => {
    // Web session.
    setupResolve({ existing: true, otp: otpRow() });
    const web = await verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq('1.1.1.1'));
    // Desktop session, same email, a minute later.
    setupResolve({ existing: true, otp: otpRow() });
    const desktop = await verifyOtp({ email: 'alice@example.com', code: CODE_OK }, fakeReq('2.2.2.2'));

    expect((web as { user: typeof USER }).user.id).toBe((desktop as { user: typeof USER }).user.id);
    expect(svc.createSessionForUser).toHaveBeenCalledTimes(2);
    expect(svc.createSessionForUser).toHaveBeenCalledWith('u1', expect.anything());
    // The existing account is preserved — no re-provisioning on the second login.
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO users')).length).toBe(0);
  });
});