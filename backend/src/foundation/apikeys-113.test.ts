/**
 * CodeConClave — user API key provisioning foundation tests.
 * Covers the full key lifecycle: creation (raw secret returned once, SHA-256
 * hash stored, masked prefix), listing (never returns the raw secret), revoke
 * (closed on access), and key resolution (valid / revoked / expired / unknown).
 * DB interaction mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    return { rows: rows ?? state.rows };
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

import { sha256Hex } from '../shared/crypto.js';
import {
  createUserApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  resolveUserApiKey,
  makeApiKeySecret,
} from '../modules/apikeys/service.js';

const USER_ID = 'usr_api1';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ak_abc',
    name: 'CI pipeline',
    key_prefix: 'cc_live_abcd',
    created_at: new Date('2026-01-01T00:00:00Z'),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoke_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  // Default: caller holds a PRO_VERIFIED API Access ('api') entitlement so the
  // product gate passes; individual tests override as needed.
  db.state.resolve = (text) =>
    text.includes('FROM entitlements') ? [{ state: 'PRO_VERIFIED' }]
    : text.includes('count(*)') ? [{ n: 0 }]
    : null;
  recordAudit.mockClear();
});

afterEach(() => {
  db.state.resolve = null;
});

describe('makeApiKeySecret', () => {
  it('produces a prefixed secret with the expected shape', () => {
    const secret = makeApiKeySecret();
    expect(secret).toMatch(/^cc_live_[a-z0-9]{24}$/);
  });

  it('never embeds SAHARSH or any brand suffix in the secret', () => {
    for (let i = 0; i < 50; i++) {
      expect(makeApiKeySecret()).not.toContain('SAHARSH');
      expect(makeApiKeySecret()).toMatch(/^cc_live_[a-z0-9]{24}$/);
    }
  });

  it('produces distinct secrets across calls', () => {
    expect(makeApiKeySecret()).not.toBe(makeApiKeySecret());
  });
});

describe('createUserApiKey — provisioning', () => {
  it('creates a key: raw secret returned once, only the SHA-256 hash stored', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM entitlements') ? [{ state: 'PRO_VERIFIED' }]
      : text.includes('count(*)') ? [{ n: 0 }]
      : text.includes('SELECT * FROM user_api_keys WHERE id') ? [row()]
      : null;
    const result = await createUserApiKey(USER_ID, '  CI pipeline  ');
    expect(result.key).toMatch(/^cc_live_[a-z0-9]{24}$/);
    expect(result.id).toBe('ak_abc'); // id comes from the stored row
    expect(result.name).toBe('CI pipeline');

    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_api_keys'));
    expect(insert).toBeDefined();
    const insertParams = insert!.params as unknown[];
    expect(insertParams[3]).toBe(sha256Hex(result.key));
    expect(insertParams[4]).toBe(result.key.slice(0, 12));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'api_key.created' }));
  });

  it('rejects an empty/whitespace name', async () => {
    await expect(createUserApiKey(USER_ID, '   ')).rejects.toMatchObject({ errorCode: 'api_key_name_required' });
  });

  it('fails closed without a PRO_VERIFIED API Access entitlement', async () => {
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [{ state: 'PRO_PENDING' }] : null);
    await expect(createUserApiKey(USER_ID, 'x')).rejects.toMatchObject({ errorCode: 'api_access_required' });
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO user_api_keys'));
    expect(inserts).toHaveLength(0);
  });

  it('honours max active keys', async () => {
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [{ state: 'PRO_VERIFIED' }] : text.includes('count(*)') ? [{ n: 20 }] : null);
    await expect(createUserApiKey(USER_ID, 'x')).rejects.toMatchObject({ errorCode: 'api_key_limit_reached' });
  });

  it('supports an expiry date', async () => {
    db.state.resolve = (text) => (text.includes('FROM entitlements') ? [{ state: 'PRO_VERIFIED' }] : text.includes('count(*)') ? [{ n: 0 }] : text.includes('SELECT * FROM user_api_keys WHERE id') ? [row({ expires_at: null })] : null);
    await createUserApiKey(USER_ID, 'x', 30);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_api_keys'));
    expect(insert!.params[5]).not.toBeNull();
  });
});

describe('listUserApiKeys — masking', () => {
  it('lists keys without ever exposing the raw secret', async () => {
    db.state.rows = [row(), row({ id: 'ak_2', name: 'laptop' })];
    const keys = await listUserApiKeys(USER_ID);
    expect(keys).toHaveLength(2);
    keys.forEach((k) => {
      expect(k).not.toHaveProperty('key');
      expect(k.keyPrefix).toMatch(/^cc_live_/);
    });
    const call = db.state.calls.find((c) => c.text.includes('FROM user_api_keys WHERE owner_id'));
    expect(call!.params[0]).toBe(USER_ID);
  });
});

describe('revokeUserApiKey — revocation', () => {
  it('revokes a key owned by the caller and records a reason', async () => {
    db.state.resolve = (text) => {
      if (text.includes('WHERE id = $1 AND owner_id = $2')) return [row({ revoked_at: null })];
      if (text.includes('WHERE id = $1') && text.includes('last_used_at')) return null;
      if (text.includes('UPDATE') === false && text.includes('FROM user_api_keys WHERE id')) return [row({ revoked_at: new Date('2026-01-02T00:00:00Z'), revoke_reason: 'leaked' })];
      return null;
    };
    await revokeUserApiKey(USER_ID, 'ak_abc', 'leaked');
    const update = db.state.calls.find((c) => c.text.includes('revoked_at = now()'));
    expect(update).toBeDefined();
    expect(update!.params[2]).toBe('leaked');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'api_key.revoked' }));
  });

  it('fails closed when the key belongs to another owner', async () => {
    db.state.resolve = () => null;
    await expect(revokeUserApiKey(USER_ID, 'ak_x', '')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('is idempotent for an already-revoked key', async () => {
    db.state.resolve = (text) => (text.includes('WHERE id = $1 AND owner_id = $2') ? [row({ revoked_at: new Date(), revoke_reason: 'x' })] : null);
    const view = await revokeUserApiKey(USER_ID, 'ak_abc', '');
    expect(view.revokedAt).not.toBeNull();
    const updates = db.state.calls.filter((c) => c.text.includes('revoked_at = now()'));
    expect(updates).toHaveLength(0);
  });
});

describe('resolveUserApiKey — key-based lookup', () => {
  it('resolves a valid key to its owner', async () => {
    const secret = makeApiKeySecret();
    db.state.resolve = (text) => (text.includes('WHERE key_hash = $1') ? [{ id: 'ak_abc', owner_id: USER_ID, revoked_at: null, expires_at: null }] : null);
    const resolved = await resolveUserApiKey(secret);
    expect(resolved).toEqual({ ownerId: USER_ID, keyId: 'ak_abc' });
    const lookup = db.state.calls.find((c) => c.text.includes('WHERE key_hash = $1'));
    expect(lookup!.params[0]).toBe(sha256Hex(secret));
  });

  it('returns null for an unknown key', async () => {
    db.state.resolve = () => null;
    expect(await resolveUserApiKey('cc_live_unknown')).toBeNull();
  });

  it('returns null for a revoked key', async () => {
    db.state.resolve = () => [{ id: 'ak_abc', owner_id: USER_ID, revoked_at: new Date(), expires_at: null }];
    expect(await resolveUserApiKey('cc_live_abc')).toBeNull();
  });

  it('returns null for an expired key', async () => {
    db.state.resolve = () => [{ id: 'ak_abc', owner_id: USER_ID, revoked_at: null, expires_at: new Date(Date.now() - 1000) }];
    expect(await resolveUserApiKey('cc_live_abc')).toBeNull();
  });
});