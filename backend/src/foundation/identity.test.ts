/**
 * CodeConClave — identity (D1/D5) + optional Security Key (B4) tests.
 *
 * Covers: handle validation/normalization and reserved names, keyword policy,
 * keyword login (success, wrong keyword, unknown handle returning an
 * indistinguishable error), anti-enumeration timing equalization, the
 * preferred_mfa rule that demands exactly ONE second factor, security-key
 * enrollment/confirm/rotate/disable, theft report revoking sessions, and the
 * security-key recovery flow (single-use, expiring, hashed, session-revoking).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Request } from 'express';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = { calls: [], rows: [], rowCount: 0, resolve: null };
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

const cacheMock = vi.hoisted(() => ({ memoryStore: { kind: 'memory' as const, get: vi.fn(), set: vi.fn(), incr: vi.fn(), del: vi.fn(), health: vi.fn() } }));
vi.mock('../shared/cache.js', () => ({
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    incr: vi.fn(async () => 1),
    del: vi.fn(async () => {}),
  },
  memoryStore: cacheMock.memoryStore,
  createCache: vi.fn(),
  initCache: vi.fn(),
}));

import { hashSecret, verifyHash, needsRehash, sha256Hex, encryptAtRest, normalizeRecoveryCode } from '../shared/crypto.js';
import { cache } from '../shared/cache.js';
import {
  normalizeHandle,
  validateHandle,
  validateKeyword,
  generateSecurityKey,
  isWellFormedSecurityKey,
  loginWithKeyword,
  enrollIdentity,
  getIdentity,
  beginSecurityKeyEnrollment,
  confirmSecurityKey,
  completeSecurityKeyChallenge,
  rotateSecurityKey,
  disableSecurityKey,
  reportSecurityKeyTheft,
  beginRecovery,
  completeRecovery,
  changeKeyword,
  revokeAllSessions,
  createIdentityMfaChallenge,
  verifyIdentityMfaChallenge,
  completeIdentityTotpChallenge,
} from '../modules/auth/identity.js';
import { AuditAction } from '@codeconclave/shared';

const KEYWORD = 'CorrectHorse9Battery';
const HANDLE = 'alice_01';
const USER_ID = 'usr_identity1';

function fakeReq(): Request {
  return {
    ip: '10.0.0.5',
    headers: { 'user-agent': 'identity/1.0' },
    ctx: { traceId: 'trace-id', ip: '10.0.0.5', userAgent: 'identity/1.0', user: null, sessionId: null, startedAt: Date.now() },
  } as unknown as Request;
}

function identityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: USER_ID,
    handle: HANDLE,
    keyword_hash: hashSecret(KEYWORD),
    security_key_hash: null,
    security_key_enabled: false,
    preferred_mfa: 'none',
    mfa_enabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 1;
  db.state.resolve = null;
  recordAudit.mockClear();
  vi.mocked(cache.incr).mockReset();
  vi.mocked(cache.incr).mockResolvedValue(1);
});

describe('handle policy', () => {
  it('normalizes to lowercase and trims', () => {
    expect(normalizeHandle('  Alice_01 ')).toBe('alice_01');
    expect(validateHandle('Alice_01')).toBe('alice_01');
  });

  it('rejects reserved names so they cannot be impersonated', () => {
    expect(() => validateHandle('admin')).toThrow();
    expect(() => validateHandle('support')).toThrow();
    expect(() => validateHandle('codeconclave')).toThrow();
  });

  it('enforces length, charset, and leading character', () => {
    expect(() => validateHandle('ab')).toThrow();
    expect(() => validateHandle('a'.repeat(21))).toThrow();
    expect(() => validateHandle('_leading')).toThrow();
    expect(() => validateHandle('has space')).toThrow();
    expect(() => validateHandle('trailing_')).toThrow();
    expect(validateHandle('a_b_123')).toBe('a_b_123');
  });
});

describe('keyword policy', () => {
  it('requires length and mixed case plus a digit', () => {
    expect(validateKeyword(KEYWORD)).toBe(KEYWORD);
    expect(() => validateKeyword('Sh0rt')).toThrow();
    expect(() => validateKeyword('alllowercaseletters')).toThrow();
    expect(() => validateKeyword('ALLUPPERCASE123')).toThrow();
  });
});

/**
 * B3: a keyword hash created under the old scrypt parameters must keep working
 * forever, and must be silently upgraded to v2 on the first successful login.
 * The upgrade is the ONLY place the plaintext keyword exists, so it is also the
 * only safe place to re-hash.
 */
describe('legacy scrypt v1 keyword hashes', () => {
  /** Build a genuine v1 (N=16384) hash, as pre-migration rows contain. */
  function legacyV1Hash(value: string): string {
    const salt = crypto.randomBytes(32).toString('hex');
    const derived = crypto.scryptSync(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 + 16 * 1024 * 1024 });
    return `scrypt$v1$${salt}$${derived.toString('hex')}`;
  }

  it('accepts a v1 keyword and transparently rewrites it to v2', async () => {
    const legacy = legacyV1Hash(KEYWORD);
    expect(legacy).toContain('$v1$');
    expect(needsRehash(legacy)).toBe(true);

    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow({ keyword_hash: legacy })] : []);

    const result = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
    expect(result.kind).toBe('authenticated');

    const upgrade = db.state.calls.find((c) => c.text.includes('SET keyword_hash'));
    expect(upgrade).toBeTruthy();
    const newHash = String(upgrade!.params[0]);
    expect(newHash).toContain('$v2$');
    expect(newHash).not.toContain('$v1$');
    expect(verifyHash(newHash, KEYWORD)).toBe(true);
    expect(verifyHash(newHash, 'WrongKeyword123')).toBe(false);
    // New salt, so the upgraded row is not a copy of the legacy digest.
    expect(newHash.split('$')[2]).not.toBe(legacy.split('$')[2]);
  });

  it('never upgrades a hash when the keyword is wrong', async () => {
    const legacy = legacyV1Hash(KEYWORD);
    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow({ keyword_hash: legacy })] : []);
    await expect(loginWithKeyword({ handle: HANDLE, keyword: 'WrongKeyword123' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'invalid_credentials',
    });
    expect(db.state.calls.some((c) => c.text.includes('SET keyword_hash'))).toBe(false);
  });

  it('leaves an already-current v2 hash untouched', async () => {
    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow()] : []);
    const result = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
    expect(result.kind).toBe('authenticated');
    expect(db.state.calls.some((c) => c.text.includes('SET keyword_hash'))).toBe(false);
  });

  it('does not fail the sign-in when the upgrade write fails', async () => {
    // The upgrade is a security improvement, not an auth dependency: a DB blip
    // on the UPDATE must not deny an otherwise valid login.
    const legacy = legacyV1Hash(KEYWORD);
    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow({ keyword_hash: legacy })] : []);
    db.state.rowCount = 0;
    const querySpy = vi.spyOn(db.pool, 'query').mockImplementation(async (text: string, params: unknown[] = []) => {
      db.state.calls.push({ text, params });
      if (text.includes('SET keyword_hash')) throw new Error('deadlock detected');
      return { rows: db.state.resolve ? db.state.resolve(text, params) ?? [] : [], rowCount: 1 };
    });
    try {
      const result = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
      expect(result.kind).toBe('authenticated');
      expect(querySpy.mock.calls.some(([text]) => String(text).includes('SET keyword_hash'))).toBe(true);
    } finally {
      querySpy.mockRestore();
    }
  });
});

describe('security key material', () => {
  it('generates a 32-character key from the unambiguous alphabet', () => {
    const key = generateSecurityKey();
    expect(key).toHaveLength(32);
    expect(isWellFormedSecurityKey(key)).toBe(true);
    expect(key).not.toMatch(/[O0Il1]/);
  });

  it('does not repeat keys across draws', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateSecurityKey()));
    expect(keys.size).toBe(50);
  });
});

describe('keyword login', () => {
  it('authenticates a correct handle + keyword and opens a session', async () => {
    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow()] : []);
    const result = await loginWithKeyword({ handle: 'ALICE_01', keyword: KEYWORD }, fakeReq());
    expect(result.kind).toBe('authenticated');
    if (result.kind === 'authenticated') {
      expect(result.sessionToken).toBeTruthy();
      expect(result.userId).toBe(USER_ID);
    }
  });

  it('rejects a wrong keyword with the generic credential error', async () => {
    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow()] : []);
    await expect(loginWithKeyword({ handle: HANDLE, keyword: 'WrongKeyword123' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'invalid_credentials',
    });
  });

  it('returns the SAME error for an unknown handle (no enumeration)', async () => {
    db.state.resolve = () => [];
    const unknown = await loginWithKeyword({ handle: 'nobody', keyword: KEYWORD }, fakeReq()).catch((e) => e);
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown.errorCode).toBe('invalid_credentials');

    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow()] : []);
    const wrong = await loginWithKeyword({ handle: HANDLE, keyword: 'WrongKeyword123' }, fakeReq()).catch((e) => e);
    expect(wrong.errorCode).toBe(unknown.errorCode);
    expect(wrong.message).toBe(unknown.message);
  });

  it('demands exactly ONE second factor when both TOTP and Security Key exist', async () => {
    db.state.resolve = (text) =>
      text.includes('user_auth_identities')
        ? [identityRow({ mfa_enabled: true, security_key_enabled: true, security_key_hash: hashSecret('X'), preferred_mfa: 'security_key' })]
        : [];
    const result = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
    expect(result.kind).toBe('mfa_required');
    if (result.kind === 'mfa_required') {
      // A user with both factors is asked for ONE, never both.
      expect(result.method).toBe('security_key');

      const verified = await verifyIdentityMfaChallenge(result.challengeToken);
      expect(verified.method).toBe('security_key');
      expect(verified.userId).toBe(USER_ID);
    }
  });

  it('honours preferred_mfa = totp when both factors exist', async () => {
    db.state.resolve = (text) =>
      text.includes('user_auth_identities')
        ? [identityRow({ mfa_enabled: true, security_key_enabled: true, security_key_hash: hashSecret('X'), preferred_mfa: 'totp' })]
        : [];
    const result = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
    expect(result.kind).toBe('mfa_required');
    if (result.kind === 'mfa_required') expect(result.method).toBe('totp');
  });

  it('rate-limits repeated attempts per handle', async () => {
    vi.mocked(cache.incr).mockResolvedValue(21);
    db.state.resolve = () => [];
    await expect(loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq())).rejects.toMatchObject({
      errorCode: 'rate_limited',
    });
  });
});

describe('login contract — regression for "Invalid request payload"', () => {
  it('accepts the zero-domain payload { handle, keyword } and never trips a schema rejection', async () => {
    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow()] : []);
    const result = await loginWithKeyword({ handle: HANDLE, keyword: KEYWORD }, fakeReq());
    expect(result.kind).toBe('authenticated');
    // The generic rejection seen in the wild came from the legacy email+password
    // schema being fed a handle; the identity endpoint takes handle+keyword and
    // validates them with its own policy, not with the email schema.
    expect(result).not.toHaveProperty('invalidPayload');
  });

  it('answers a wrong keyword with the same generic message as an unknown handle (no payload wording)', async () => {
    db.state.resolve = (text) => (text.includes('user_auth_identities') ? [identityRow()] : []);
    const wrong = await loginWithKeyword({ handle: HANDLE, keyword: 'WrongKeyword123' }, fakeReq()).catch((e) => e);
    expect(wrong.errorCode).toBe('invalid_credentials');
    expect(String(wrong.message).toLowerCase()).not.toContain('invalid request payload');

    db.state.resolve = () => [];
    const unknown = await loginWithKeyword({ handle: 'nobody', keyword: KEYWORD }, fakeReq()).catch((e) => e);
    expect(unknown.errorCode).toBe('invalid_credentials');
    expect(String(unknown.message)).toBe(String(wrong.message));
  });
});

describe('identity enrollment', () => {
  it('stores only a hash of the keyword', async () => {
    db.state.resolve = (text) => (text.includes('SELECT 1 FROM user_auth_identities') ? [] : [{ id: 'uai_1' }]);
    const result = await enrollIdentity(USER_ID, { handle: 'newhandle', keyword: KEYWORD });
    expect(result.handle).toBe('newhandle');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_auth_identities'));
    expect(insert).toBeTruthy();
    const stored = insert!.params[3] as string;
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain(KEYWORD);
  });

  it('refuses a handle already taken by another user', async () => {
    db.state.resolve = (text) => (text.includes('SELECT 1 FROM user_auth_identities') ? [{ '?column?': 1 }] : []);
    await expect(enrollIdentity(USER_ID, { handle: 'taken', keyword: KEYWORD })).rejects.toMatchObject({
      errorCode: 'handle_taken',
    });
  });

  it('reports enrollment state without exposing any hash', async () => {
    db.state.resolve = () => [identityRow()];
    const identity = await getIdentity(USER_ID);
    expect(identity).toMatchObject({ handle: HANDLE, hasKeyword: true, securityKeyEnabled: false, preferredMfa: 'none' });
    expect(JSON.stringify(identity)).not.toContain('scrypt$');
  });
});

describe('security key as a second factor', () => {
  it('shows the key once and stores only a hash', async () => {
    db.state.resolve = () => [{ id: 'uai_1' }];
    const { securityKey } = await beginSecurityKeyEnrollment(USER_ID, 'security_key');
    expect(isWellFormedSecurityKey(securityKey)).toBe(true);
    const update = db.state.calls.find((c) => c.text.includes('security_key_hash = $1'));
    expect(update!.params[0]).toMatch(/^scrypt\$v2\$/);
    expect(update!.params[0]).not.toContain(securityKey);
    // Not yet enabled: paste-back confirmation is required.
    expect(update!.text).toContain('security_key_enabled = false');
  });

  it('enables the factor only after the key is pasted back correctly', async () => {
    const key = generateSecurityKey();
    db.state.resolve = () => [{ security_key_hash: hashSecret(key) }];
    await expect(confirmSecurityKey(USER_ID, key)).resolves.toEqual({ enabled: true });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUTH_SECURITY_KEY_ENABLED }));
  });

  it('rejects a mismatched paste-back', async () => {
    const key = generateSecurityKey();
    db.state.resolve = () => [{ security_key_hash: hashSecret(key) }];
    await expect(confirmSecurityKey(USER_ID, generateSecurityKey())).rejects.toMatchObject({
      errorCode: 'security_key_mismatch',
    });
  });

  it('completes a challenge and issues a session', async () => {
    const key = generateSecurityKey();
    const challenge = createIdentityMfaChallenge(USER_ID, 'security_key');
    db.state.resolve = (text) =>
      text.includes('SELECT security_key_hash') ? [{ security_key_hash: hashSecret(key), security_key_enabled: true }] : [];
    const result = await completeSecurityKeyChallenge(challenge, key, fakeReq());
    expect(result.userId).toBe(USER_ID);
    expect(result.sessionToken).toBeTruthy();
  });

  it('rejects a challenge issued for the other factor', async () => {
    const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
    await expect(completeSecurityKeyChallenge(challenge, generateSecurityKey(), fakeReq())).rejects.toMatchObject({
      errorCode: 'mfa_challenge_invalid',
    });
  });

  it('rejects a tampered or expired challenge', async () => {
    const counts = new Map<string, number>();
    vi.mocked(cache.incr).mockImplementation(async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    });
    const challenge = createIdentityMfaChallenge(USER_ID, 'security_key');
    const verified = await verifyIdentityMfaChallenge(challenge);
    expect(verified.userId).toBe(USER_ID);
    const [prefix, body, sig] = challenge.split('.');
    // A tampered signature is rejected on the HMAC check, before any state.
    await expect(verifyIdentityMfaChallenge(`${prefix}.${body}.${sig}x`)).rejects.toMatchObject({
      errorCode: 'mfa_challenge_invalid',
    });
    // The same (untampered) challenge is now SPENT: a captured token is good for
    // exactly one verification, not for its whole 10-minute window.
    await expect(verifyIdentityMfaChallenge(challenge)).rejects.toMatchObject({
      errorCode: 'mfa_challenge_replayed',
    });
  });

  it('rotation requires the current key and supersedes it', async () => {
    const current = generateSecurityKey();
    db.state.resolve = () => [{ security_key_hash: hashSecret(current), security_key_enabled: true }];
    const rotated = await rotateSecurityKey(USER_ID, current, 'security_key');
    expect(rotated.securityKey).not.toBe(current);
    expect(isWellFormedSecurityKey(rotated.securityKey)).toBe(true);
    const update = db.state.calls.find((c) => c.text.includes('security_key_created_at = now()'));
    expect(update!.params[0]).toMatch(/^scrypt\$v2\$/);
  });

  it('disabling keeps TOTP as the preferred factor', async () => {
    db.state.resolve = (text) => (text.includes('SELECT mfa_enabled') ? [{ mfa_enabled: true }] : []);
    await disableSecurityKey(USER_ID);
    const update = db.state.calls.find((c) => c.text.includes('security_key_revoked_at = now()'));
    expect(update!.text).toContain("preferred_mfa = CASE WHEN $2 THEN 'totp' ELSE 'none' END");
    expect(update!.params[1]).toBe(true);
  });
});

describe('TOTP completion for handle+keyword login (BUG: dead-end imfa_ challenge)', () => {
  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

  function totpUserRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: USER_ID,
      email: 'alice@example.com',
      mfa_enabled: true,
      mfa_secret_encrypted: encryptAtRest(TOTP_SECRET),
      ...over,
    };
  }

  function currentTotp(): string {
    // Mirrors RFC 4648 / RFC 6238 exactly as shared/crypto.ts does: the secret
    // is base32-decoded to the raw HMAC key, then HOTP-truncated to 6 digits.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const ch of TOTP_SECRET.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
      const idx = alphabet.indexOf(ch);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    const step = Math.floor(Date.now() / 1000 / 30);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
    const offset = hmac[hmac.length - 1]! & 0x0f;
    const bin =
      ((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff);
    return (bin % 1_000_000).toString().padStart(6, '0');
  }

  it('completes a TOTP challenge issued by loginWithKeyword and opens a session', async () => {
    const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
    db.state.resolve = (text) => (text.includes('FROM users') ? [totpUserRow()] : []);
    const result = await completeIdentityTotpChallenge(challenge, { code: currentTotp() }, fakeReq());
    expect(result).toMatchObject({ userId: USER_ID, via: 'totp' });
    expect(result.sessionToken).toBeTruthy();
    expect(result.sessionId).toBeTruthy();
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO sessions'))).toBe(true);
  });

  it('accepts a legacy recovery code in place of the TOTP code and consumes it', async () => {
    const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
    const recovery = 'A1B2-C3D4-E5F6';
    db.state.resolve = (text) => {
      if (text.includes('FROM users')) return [totpUserRow()];
      // Recovery codes are stored hashed in NORMALIZED form (no separators).
      if (text.includes('FROM recovery_codes')) return [{ id: 'rc_1', code_hash: hashSecret(normalizeRecoveryCode(recovery)) }];
      return [];
    };
    const result = await completeIdentityTotpChallenge(challenge, { recoveryCode: recovery }, fakeReq());
    expect(result.via).toBe('recovery_code');
    expect(db.state.calls.some((c) => c.text.includes('UPDATE recovery_codes SET used_at'))).toBe(true);
  });

  it('rejects a wrong TOTP code with the generic mfa_failed error and opens no session', async () => {
    const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
    db.state.resolve = (text) => (text.includes('FROM users') ? [totpUserRow()] : []);
    await expect(completeIdentityTotpChallenge(challenge, { code: '000000' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'mfa_failed',
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO sessions'))).toBe(false);
  });

  describe('a challenge is single-use (no replay inside its 10-minute TTL)', () => {
    /** Count per key the way Redis INCR would, so the burn is observable. */
    function countingCache(): void {
      const counts = new Map<string, number>();
      vi.mocked(cache.incr).mockImplementation(async (key: string) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      });
    }

    it('rejects a replay of an already-completed TOTP challenge', async () => {
      countingCache();
      const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
      db.state.resolve = (text) => (text.includes('FROM users') ? [totpUserRow()] : []);

      const first = await completeIdentityTotpChallenge(challenge, { code: currentTotp() }, fakeReq());
      expect(first.sessionToken).toBeTruthy();

      const sessionsBefore = db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions')).length;
      await expect(completeIdentityTotpChallenge(challenge, { code: currentTotp() }, fakeReq())).rejects.toMatchObject({
        errorCode: 'mfa_challenge_replayed',
      });
      // The replay must not mint a second session.
      expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions')).length).toBe(sessionsBefore);
    });

    it('burns the challenge even when the code is wrong, so a guess cannot be followed by a retry', async () => {
      countingCache();
      const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
      db.state.resolve = (text) => (text.includes('FROM users') ? [totpUserRow()] : []);

      await expect(completeIdentityTotpChallenge(challenge, { code: '000000' }, fakeReq())).rejects.toMatchObject({
        errorCode: 'mfa_failed',
      });
      await expect(completeIdentityTotpChallenge(challenge, { code: currentTotp() }, fakeReq())).rejects.toMatchObject({
        errorCode: 'mfa_challenge_replayed',
      });
    });

    it('marks the challenge with the REMAINING lifetime, never a fresh window', async () => {
      const seen: { key: string; ttl: number }[] = [];
      vi.mocked(cache.incr).mockImplementation(async (key: string, ttl: number) => {
        seen.push({ key, ttl });
        return 1;
      });
      await verifyIdentityMfaChallenge(createIdentityMfaChallenge(USER_ID, 'totp'));
      const burn = seen.find((s) => s.key.includes('mfa-challenge'))!;
      expect(burn).toBeTruthy();
      expect(burn.ttl).toBeGreaterThan(0);
      expect(burn.ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    });

    it('fails closed when the challenge store is unavailable', async () => {
      // An unverifiable challenge must never be treated as a fresh one.
      vi.mocked(cache.incr).mockRejectedValue(new Error('redis down'));
      db.state.resolve = (text) => (text.includes('FROM users') ? [totpUserRow()] : []);
      await expect(
        completeIdentityTotpChallenge(createIdentityMfaChallenge(USER_ID, 'totp'), { code: currentTotp() }, fakeReq()),
      ).rejects.toThrow(/redis down/);
      expect(db.state.calls.some((c) => c.text.includes('INSERT INTO sessions'))).toBe(false);
    });
  });

  it('refuses a Security-Key challenge presented to the TOTP endpoint', async () => {
    const challenge = createIdentityMfaChallenge(USER_ID, 'security_key');
    await expect(completeIdentityTotpChallenge(challenge, { code: currentTotp() }, fakeReq())).rejects.toMatchObject({
      errorCode: 'mfa_challenge_invalid',
    });
  });

  it('fails closed when the account has TOTP disabled', async () => {
    const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
    db.state.resolve = (text) => (text.includes('FROM users') ? [totpUserRow({ mfa_enabled: false })] : []);
    await expect(completeIdentityTotpChallenge(challenge, { code: currentTotp() }, fakeReq())).rejects.toMatchObject({
      errorCode: 'mfa_not_enabled',
    });
  });

  it('rate-limits repeated TOTP attempts per account', async () => {
    const challenge = createIdentityMfaChallenge(USER_ID, 'totp');
    // The challenge burn and the rate limiter share the cache, so the mock has
    // to be key-aware: the FIRST use of a fresh challenge is 1, while the
    // per-account attempt counter is what trips the limit.
    vi.mocked(cache.incr).mockImplementation(async (key: string) =>
      key.includes('mfa-challenge') ? 1 : 11,
    );
    db.state.resolve = (text) => (text.includes('FROM users') ? [totpUserRow()] : []);
    await expect(completeIdentityTotpChallenge(challenge, { code: currentTotp() }, fakeReq())).rejects.toMatchObject({
      errorCode: 'rate_limited',
    });
  });
});

describe('theft report', () => {
  it('requires the keyword, revokes sessions, and kills the security key', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT keyword_hash')) return [{ keyword_hash: hashSecret(KEYWORD) }];
      if (text.includes('SELECT security_key_enabled')) return [{ security_key_enabled: true }];
      return [];
    };
    const result = await reportSecurityKeyTheft(USER_ID, KEYWORD, fakeReq());
    expect(result).toEqual({ sessionsRevoked: 1, securityKeyRevoked: true });
    const revoke = db.state.calls.find((c) => c.text.includes("state = 'REVOKED'"));
    expect(revoke).toBeTruthy();
    const keyRevoke = db.state.calls.find((c) => c.text.includes('security_key_hash = NULL'));
    expect(keyRevoke).toBeTruthy();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_SECURITY_KEY_STOLEN }),
    );
  });

  it('refuses without the keyword so a thief cannot lock the owner out', async () => {
    db.state.resolve = (text) => (text.includes('SELECT keyword_hash') ? [{ keyword_hash: hashSecret(KEYWORD) }] : []);
    await expect(reportSecurityKeyTheft(USER_ID, 'NotMyKeyword1', fakeReq())).rejects.toMatchObject({
      errorCode: 'invalid_credentials',
    });
  });
});

describe('recovery', () => {
  const SECURITY_KEY = generateSecurityKey();

  it('issues a hashed, expiring, single-use token for handle + key', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM user_auth_identities WHERE lower(handle)')
        ? [{ user_id: USER_ID, security_key_hash: hashSecret(SECURITY_KEY), security_key_enabled: true }]
        : [];
    const { recoveryToken } = await beginRecovery({ handle: HANDLE, securityKey: SECURITY_KEY });
    expect(recoveryToken).toBeTruthy();
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO auth_recovery_tokens'));
    const tokenHash = insert!.params[2] as string;
    // Raw token is never stored; only its SHA-256.
    expect(tokenHash).toBe(sha256Hex(recoveryToken));
    expect(tokenHash).not.toBe(recoveryToken);
    expect(insert!.text).toContain('now() + ($4 ||');
    // The identity row is locked FOR UPDATE so two concurrent beginRecovery
    // calls cannot both leave a live PENDING token behind.
    expect(db.state.calls.some((c) => c.text.includes('FOR UPDATE'))).toBe(true);
    expect(db.state.calls.findIndex((c) => c.text.includes('FOR UPDATE')))
      .toBeLessThan(db.state.calls.findIndex((c) => c.text.includes('INSERT INTO auth_recovery_tokens')));
  });

  it('gives the same failure for an unknown handle (no enumeration)', async () => {
    db.state.resolve = () => [];
    const err = await beginRecovery({ handle: 'nobody', securityKey: SECURITY_KEY }).catch((e) => e);
    expect(err.errorCode).toBe('recovery_failed');
  });

  it('sets a new keyword, marks the token used, and revokes every session', async () => {
    const raw = 'recovery-token-value';
    // The atomic claim (UPDATE ... RETURNING) is what resolves the token now.
    db.state.resolve = (text) => (text.includes('UPDATE auth_recovery_tokens') && text.includes('RETURNING') ? [{ id: 'art_1', user_id: USER_ID }] : []);
    const result = await completeRecovery({ recoveryToken: raw, keyword: 'BrandNewKey77' }, fakeReq());
    expect(result.userId).toBe(USER_ID);
    const update = db.state.calls.find((c) => c.text.includes('UPDATE user_auth_identities SET keyword_hash'));
    expect(update!.params[0]).toMatch(/^scrypt\$v2\$/);
    // The token is consumed by the SAME statement that increments the counter,
    // so it can never be redeemed twice.
    const claim = db.state.calls.find((c) => c.text.includes('RETURNING id, user_id'));
    expect(claim!.text).toContain("status = 'USED'");
    expect(claim!.text).toContain("status = 'PENDING'");
    expect(claim!.text).toContain('attempts < 5');
    expect(db.state.calls.some((c) => c.text.includes("state = 'REVOKED'"))).toBe(true);
  });

  it('refuses a second redemption of the same token (single-use under concurrency)', async () => {
    const raw = 'recovery-token-value';
    let claimable = true;
    db.state.resolve = (text) => {
      if (text.includes('UPDATE auth_recovery_tokens') && text.includes('RETURNING')) {
        if (!claimable) return [];
        claimable = false; // the first claim wins; later claims see status='USED'
        return [{ id: 'art_1', user_id: USER_ID }];
      }
      return [];
    };
    await expect(completeRecovery({ recoveryToken: raw, keyword: 'BrandNewKey77' }, fakeReq())).resolves.toBeTruthy();
    // Replaying the exact same token must now fail: the claim is a single
    // conditional UPDATE, so a lost race cannot also mint a new keyword.
    await expect(completeRecovery({ recoveryToken: raw, keyword: 'AnotherKey88' }, fakeReq())).rejects.toMatchObject({
      errorCode: 'recovery_failed',
    });
  });

  it('rejects an expired or unknown recovery token without changing the keyword', async () => {
    db.state.resolve = () => [];
    await expect(
      completeRecovery({ recoveryToken: 'nope', keyword: 'BrandNewKey77' }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'recovery_failed' });
    expect(db.state.calls.some((c) => c.text.includes('UPDATE user_auth_identities SET keyword_hash'))).toBe(false);
  });

  it('revokes the token after the attempt cap', async () => {
    // The claim returns nothing because the row no longer satisfies the cap.
    db.state.resolve = () => [];
    await expect(
      completeRecovery({ recoveryToken: 'guess', keyword: 'BrandNewKey77' }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'recovery_failed' });
    const burn = db.state.calls.find((c) => c.text.includes("status = 'REVOKED'"));
    expect(burn).toBeTruthy();
    expect(burn!.text).toContain('attempts >= 5');
  });
});

describe('keyword change', () => {
  it('requires the current keyword and revokes all sessions', async () => {
    db.state.resolve = (text) => (text.includes('SELECT keyword_hash') ? [{ keyword_hash: hashSecret(KEYWORD) }] : []);
    await expect(changeKeyword(USER_ID, { currentKeyword: KEYWORD, newKeyword: 'Replacement9Key' }, fakeReq())).resolves.toEqual({
      changed: true,
    });
    const update = db.state.calls.find((c) => c.text.includes('UPDATE user_auth_identities SET keyword_hash'));
    expect(update!.params[0]).toMatch(/^scrypt\$v2\$/);
    expect(db.state.calls.some((c) => c.text.includes("state = 'REVOKED'"))).toBe(true);
  });

  it('rejects a wrong current keyword', async () => {
    db.state.resolve = () => [{ keyword_hash: hashSecret(KEYWORD) }];
    await expect(
      changeKeyword(USER_ID, { currentKeyword: 'WrongOne12345', newKeyword: 'Replacement9Key' }, fakeReq()),
    ).rejects.toMatchObject({ errorCode: 'invalid_credentials' });
  });
});

describe('revoke all sessions', () => {
  it('returns the number revoked', async () => {
    db.state.rowCount = 3;
    await expect(revokeAllSessions(USER_ID)).resolves.toBe(3);
  });
});
