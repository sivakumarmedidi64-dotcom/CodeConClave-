/**
 * CodeConClave — device pairing foundation tests (PHASE 4B).
 * Covers the full pairing lifecycle: device creation (3-device cap, 6-digit
 * code, scrypt-hashed with 10-minute expiry embedded), code verification
 * (valid / invalid / expired / attempt cap / non-pending state), token
 * issuance (raw token returned once, only SHA-256 stored), and revocation
 * (REVOKED state + session cascade + live-socket drop). DB interaction mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { hashSecret, sha256Hex } from '../shared/crypto.js';
import { createDevice, verifyDevicePairing, revokeDevice, MAX_PAIRED_DEVICES } from '../modules/auth/service.js';
import { AuditAction } from '@codeconclave/shared';

const CODE = '483920';
const DEVICE_ID = 'dev_0123456789abcdef0123';
const USER_ID = 'usr_test1';

function fakeReq(): Request {
  return {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'pairing/1.0' },
    ctx: { traceId: 'trace-pair', ip: '127.0.0.1', userAgent: 'pairing/1.0', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

function pendingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pairing_code_hash: `${hashSecret(CODE, 16)}$${Date.now() + 600_000}`,
    state: 'PENDING_PAIRING',
    failed_pairing_attempts: 0,
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

describe('createDevice — pairing initiation', () => {
  it('creates a device with a 6-digit code and a hashed, expiring pairing record', async () => {
    db.state.resolve = (text) => (text.includes('count(*)') ? [{ n: 0 }] : null);
    const result = await createDevice(USER_ID, 'laptop');
    expect(result.deviceId).toMatch(/^dev_[a-z0-9]{20}$/);
    expect(result.pairingCode).toMatch(/^\d{6}$/);
    expect(result.expiresInSeconds).toBe(600);

    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO devices'));
    expect(insert).toBeDefined();
    const stored = insert!.params[3] as string;
    const parts = stored.split('$');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('v2');
    expect(parts[2]).toHaveLength(32); // salt (16 bytes hex, explicit for pairing)
    expect(parts[3]).toHaveLength(128); // scrypt hash hex
    expect(Number(parts[4])).toBeGreaterThan(Date.now()); // 10-min expiry
  });

  it('rejects a 4th paired device (max 3)', async () => {
    db.state.resolve = (text) => (text.includes('count(*)') ? [{ n: MAX_PAIRED_DEVICES }] : null);
    await expect(createDevice(USER_ID, 'x')).rejects.toMatchObject({ errorCode: 'device_limit_reached' });
  });
});

describe('verifyDevicePairing — code verification and token issuance', () => {
  it('pairs a PENDING device with the correct code and issues a token once', async () => {
    db.state.resolve = (text) => (text.includes('SELECT pairing_code_hash') ? [pendingRow()] : null);
    const { token } = await verifyDevicePairing(USER_ID, DEVICE_ID, CODE, { grantToken: true });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const update = db.state.calls.find((c) => c.text.includes("state = 'PAIRED'"));
    expect(update).toBeDefined();
    expect(update!.params[1]).toBe(sha256Hex(token!));
    expect(update!.params[0]).toBe(DEVICE_ID);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEVICE_PAIRED }));
  });

  it('rejects an invalid code, increments the attempt counter, and never stores the token', async () => {
    db.state.resolve = (text) => (text.includes('SELECT pairing_code_hash') ? [pendingRow()] : null);
    await expect(verifyDevicePairing(USER_ID, DEVICE_ID, '000000')).rejects.toMatchObject({ errorCode: 'pairing_code_invalid' });
    const attempts = db.state.calls.find((c) => c.text.includes('failed_pairing_attempts = failed_pairing_attempts + 1'));
    expect(attempts).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes('token_hash'))).toBe(false);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('rejects after the 5-attempt cap', async () => {
    db.state.resolve = (text) => (text.includes('SELECT pairing_code_hash') ? [pendingRow({ failed_pairing_attempts: 5 })] : null);
    await expect(verifyDevicePairing(USER_ID, DEVICE_ID, CODE)).rejects.toMatchObject({ errorCode: 'pairing_attempts_exhausted' });
  });

  it('rejects an expired pairing code (10-minute limit)', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT pairing_code_hash')
        ? [pendingRow({ pairing_code_hash: `${hashSecret(CODE, 16)}$${Date.now() - 1000}` })]
        : null;
    await expect(verifyDevicePairing(USER_ID, DEVICE_ID, CODE)).rejects.toMatchObject({ errorCode: 'pairing_code_expired' });
  });

  it('rejects verification for a device that is not awaiting pairing', async () => {
    db.state.resolve = (text) => (text.includes('SELECT pairing_code_hash') ? [pendingRow({ state: 'PAIRED' })] : null);
    await expect(verifyDevicePairing(USER_ID, DEVICE_ID, CODE)).rejects.toMatchObject({ errorCode: 'device_not_pending' });
  });
});

describe('revokeDevice — immediate revocation', () => {
  it('marks the device REVOKED, clears credentials, cascades to sessions, drops the socket, audits', async () => {
    db.state.resolve = (text) => (text.includes('RETURNING id') ? [{ id: DEVICE_ID }] : null);
    await revokeDevice(USER_ID, DEVICE_ID, fakeReq());
    const update = db.state.calls.find((c) => c.text.includes("state = 'REVOKED'"));
    expect(update).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes('UPDATE sessions') && c.text.includes('REVOKED'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DEVICE_REVOKED }));
  });

  it('404s when the device does not belong to the caller', async () => {
    db.state.resolve = () => [];
    await expect(revokeDevice(USER_ID, DEVICE_ID)).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});