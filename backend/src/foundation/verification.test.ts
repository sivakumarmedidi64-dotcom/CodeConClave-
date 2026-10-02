/**
 * CodeConClave — email verification tests (PHASE 2).
 * Covers: send (token hashed at rest, audit, outbox delivery payload),
 * already-verified short-circuit, resend throttle (60s interval), hourly
 * cap, single-use verification, expired-token rejection, unknown-token
 * rejection, reuse rejection, race-safe USED transition, and audit events
 * for sent/verified/failed. DB, cache, outbox and audit are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: 1 };
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

import {
  sendVerificationEmail,
  verifyEmailToken,
  verificationStatus,
  RESEND_MIN_INTERVAL_MS,
  MAX_SENDS_PER_HOUR,
} from '../modules/auth/verification.js';
import { sha256Hex } from '../shared/crypto.js';
import { AuditAction } from '@codeconclave/shared';

const TOKEN = 'a'.repeat(64);

function fakeReq(ip: string): Request {
  return {
    ip,
    headers: { 'user-agent': 'verification/1.0' },
    ctx: { traceId: 'trace-1', ip, userAgent: 'verification/1.0', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  cache.get.mockReset();
  cache.set.mockReset();
  cache.incr.mockReset();
  cache.incr.mockResolvedValue(1);
  cache.get.mockResolvedValue(null);
  enqueueOutbox.mockClear();
  recordAudit.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SEND verification email', () => {
  it('persists a hashed token (never raw), audits sent, and enqueues the email', async () => {
    db.state.resolve = (text) => (text.includes('FROM users') ? [{ email: 'alice@example.com', email_verified: false }] : null);
    const result = await sendVerificationEmail('u1', fakeReq('10.0.0.1'));
    expect(result.sent).toBe(true);
    expect(result.alreadyVerified).toBe(false);
    expect(result.resendableAfterMs).toBe(RESEND_MIN_INTERVAL_MS);

    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO email_verifications'))!;
    expect(insert.params[1]).toBe('u1');
    const stored = insert.params[2] as string;
    expect(/^[0-9a-f]{64}$/.test(stored)).toBe(true);
    expect(stored).not.toContain(TOKEN);
    expect(insert.text).toContain('now() + ($4 || \' milliseconds\')::interval');

    expect(cache.set).toHaveBeenCalledWith(expect.stringContaining('verif:last:u1'), expect.any(String), expect.any(Number));
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_EMAIL_VERIFICATION_SENT, actorUserId: 'u1' }),
    );
    expect(enqueueOutbox).toHaveBeenCalledWith(
      'auth.email_verification',
      expect.objectContaining({
        channel: 'email',
        to: 'alice@example.com',
        subject: expect.stringContaining('Verify'),
        html: expect.stringContaining('/verify-email?token='),
      }),
    );
  });

  it('short-circuits when the email is already verified (no insert, no email)', async () => {
    db.state.resolve = (text) => (text.includes('FROM users') ? [{ email: 'alice@example.com', email_verified: true }] : null);
    const result = await sendVerificationEmail('u1', fakeReq('10.0.0.1'));
    expect(result.alreadyVerified).toBe(true);
    expect(result.sent).toBe(false);
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO email_verifications'))).toHaveLength(0);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('throws verification_throttled when a send happened within the interval', async () => {
    db.state.resolve = (text) => (text.includes('FROM users') ? [{ email: 'alice@example.com', email_verified: false }] : null);
    cache.get.mockResolvedValue(String(Date.now() - 10_000));
    await expect(sendVerificationEmail('u1', fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'verification_throttled',
      status: 429,
    });
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO email_verifications'))).toHaveLength(0);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('throws verification_rate_limited past the hourly cap', async () => {
    db.state.resolve = (text) => (text.includes('FROM users') ? [{ email: 'alice@example.com', email_verified: false }] : null);
    cache.incr.mockResolvedValue(MAX_SENDS_PER_HOUR + 1);
    await expect(sendVerificationEmail('u1', fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'verification_rate_limited',
      status: 429,
    });
  });
});

describe('VERIFY token — single use, expiry, failures', () => {
  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ev1',
      user_id: 'u1',
      status: 'PENDING',
      expires_at: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  it('verifies a valid token: marks USED and sets email_verified in one tenant-scoped tx', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM email_verifications')) return [pendingRow()];
      if (text.includes('UPDATE email_verifications SET status')) return [{ id: 'ev1' }];
      return null;
    };
    await verifyEmailToken(TOKEN, fakeReq('10.0.0.1'));
    const mark = db.state.calls.find((c) => c.text.includes('UPDATE email_verifications SET status'))!;
    expect(mark.text).toContain("status = 'USED'");
    expect(mark.text).toContain("status = 'PENDING'");
    expect(mark.text).toContain('RETURNING id');
    const userUpdate = db.state.calls.find((c) => c.text.includes('UPDATE users SET email_verified'))!;
    expect(userUpdate).toBeDefined();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_EMAIL_VERIFIED }));
  });

  it('rejects an already-used token and audits the failure', async () => {
    db.state.resolve = (text) => (text.includes('FROM email_verifications') ? [pendingRow({ status: 'USED', used_at: new Date() })] : null);
    await expect(verifyEmailToken(TOKEN, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'verification_used',
      status: 400,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_EMAIL_VERIFICATION_FAILED, detail: { reason: 'already_used' } }),
    );
    expect(db.state.calls.filter((c) => c.text.includes('UPDATE email_verifications'))).toHaveLength(0);
  });

  it('rejects an expired token and audits the failure', async () => {
    db.state.resolve = (text) => (text.includes('FROM email_verifications') ? [pendingRow({ expires_at: new Date(Date.now() - 1000) })] : null);
    await expect(verifyEmailToken(TOKEN, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'verification_expired',
      status: 400,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_EMAIL_VERIFICATION_FAILED, detail: { reason: 'expired' } }),
    );
  });

  it('rejects an unknown token and audits the failure', async () => {
    await expect(verifyEmailToken('bogus', fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'verification_invalid',
      status: 400,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_EMAIL_VERIFICATION_FAILED, detail: { reason: 'invalid_token' } }),
    );
  });

  it('rejects a concurrent double-verify (race-safe USED transition)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM email_verifications')) return [pendingRow()];
      if (text.includes('UPDATE email_verifications SET status')) return []; // lost the race
      return null;
    };
    await expect(verifyEmailToken(TOKEN, fakeReq('10.0.0.1'))).rejects.toMatchObject({
      errorCode: 'verification_used',
      status: 400,
    });
  });

  it('looks the token up by SHA-256 hash, never by raw token', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM email_verifications')) return [pendingRow()];
      if (text.includes('UPDATE email_verifications SET status')) return [{ id: 'ev1' }];
      return null;
    };
    await verifyEmailToken('raw-visible-token', fakeReq('10.0.0.1'));
    const lookup = db.state.calls.find((c) => c.text.includes('FROM email_verifications'))!;
    expect(lookup.params[0]).toBe(sha256Hex('raw-visible-token'));
    expect(lookup.params[0]).not.toBe('raw-visible-token');
  });
});

describe('STATUS', () => {
  it('returns verification status for the user', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT email_verified FROM users')) return [{ email_verified: false }];
      if (text.includes('FROM email_verifications')) return [{ created_at: new Date('2026-01-01T00:00:00Z'), expires_at: new Date('2026-01-02T00:00:00Z') }];
      return null;
    };
    const status = await verificationStatus('u1');
    expect(status.emailVerified).toBe(false);
    expect(status.lastSentAt).toBe('2026-01-01T00:00:00.000Z');
    expect(status.lastExpiresAt).toBe('2026-01-02T00:00:00.000Z');
  });
});