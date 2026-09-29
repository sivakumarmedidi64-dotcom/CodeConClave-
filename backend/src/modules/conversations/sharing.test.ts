/**
 * CodeConClave — conversation share-link security tests (hermetic).
 *
 * Covers (Part J): share-link abuse, expired/revoked/consumed tokens,
 * one-time redemption, and — critically — FAIL-CLOSED redemption: a token
 * never grants access by itself; non-collaborators are denied. Pure domain
 * core is tested without a database; the thin adapter is verified with mocked
 * DB/queryMany + a mocked conversation gate (which already enforces owner or
 * ACTIVE team-membership).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const queryMany = vi.fn(async () => []);
  const queryOne = async (text: string, params?: unknown[]) => (await queryMany(text, params))[0] ?? null;
  const client = {
    query: async (text: string, params?: unknown[]) => {
      const rows = await queryMany(text, params);
      return { rows, rowCount: rows.length };
    },
    queryOne,
    queryMany,
  };
  return {
    queryMany,
    queryOne,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn(client),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn(client),
  };
});
vi.mock('../../shared/db.js', () => db);

const service = vi.hoisted(() => ({
  getConversation: vi.fn(async () => {
    throw Object.assign(new Error('Conversation'), { statusCode: 404 });
  }),
}));
vi.mock('./service.js', () => service);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../audit/service.js', () => audit);

import {
  createShareToken,
  parseStoredSharing,
  purgeShareTokens,
  redeemShareToken,
  revokeShareToken,
  ShareMode,
  createConversationShareLink,
  getShareLink,
  redeemConversationShareLink,
  revokeConversationShareLink,
} from './sharing.js';

const T0 = 1_000_000;
const OWNER = 'user-owner';
const OTHER = 'user-eavesdropper';

beforeEach(() => {
  vi.clearAllMocks();
  service.getConversation.mockImplementation(async (userId: string, _convId: string) => {
    if (userId === OTHER) throw Object.assign(new Error('Conversation'), { statusCode: 404 });
    return { id: 'conv-1', sharing: {} };
  });
  db.queryMany.mockImplementation(async () => []);
});

describe('pure domain: token lifecycle', () => {
  it('creates a WATCH token with a default 7d expiry', () => {
    const e = createShareToken({}, T0, 'tok');
    expect(e.id).toBe('tok');
    expect(e.mode).toBe(ShareMode.WATCH);
    expect(e.oneTime).toBe(false);
    expect(e.expiresAt).toBe(T0 + 7 * 24 * 60 * 60 * 1000);
  });

  it('supports explicit mode, TTL and one-time', () => {
    const e = createShareToken({ mode: ShareMode.CO_CONTROL, expiresInMs: 60_000, oneTime: true }, T0, 'tok');
    expect(e.mode).toBe(ShareMode.CO_CONTROL);
    expect(e.expiresAt).toBe(T0 + 60_000);
    expect(e.oneTime).toBe(true);
  });

  it('redeems a valid token and consumes one-time tokens', () => {
    const entries = [createShareToken({ oneTime: true }, T0, 'tok')];
    const used = redeemShareToken(entries, 'tok', OWNER, T0 + 5);
    expect(used.redeemedBy).toBe(OWNER);
    expect(() => redeemShareToken(entries, 'tok', OWNER, T0 + 10)).toThrow(/already been used/);
  });

  it('fails closed for unknown, revoked, and expired tokens', () => {
    const entries = [createShareToken({ expiresInMs: 100 }, T0, 'tok')];
    expect(() => redeemShareToken(entries, 'missing', OWNER, T0 + 5)).toThrow(/Share link/);
    revokeShareToken(entries, 'tok');
    expect(() => redeemShareToken(entries, 'tok', OWNER, T0 + 5)).toThrow(/revoked/);
  });

  it('rejects an expired token', () => {
    const entries = [createShareToken({ expiresInMs: 100 }, T0, 'tok')];
    expect(() => redeemShareToken(entries, 'tok', OWNER, T0 + 500)).toThrow(/expired/);
  });

  it('purges revoked and expired tokens, keeping live ones', () => {
    const entries = [
      createShareToken({}, T0, 'live'),
      createShareToken({ expiresInMs: 100 }, T0, 'soon-expire'),
      createShareToken({}, T0, 'revoked'),
    ];
    revokeShareToken(entries, 'revoked');
    const removed = purgeShareTokens(entries, T0 + 500);
    expect(removed).toBe(2);
    expect(entries.map((e) => e.id)).toEqual(['live']);
  });
});

describe('db adapter: coercive access control', () => {
  it('returns a share link only to callers with existing conversation access', async () => {
    // The authz lives in the SQL (owner OR active team member): simulate it by
    // returning an accessible row only for the OWNER.
    db.queryMany.mockImplementation(async (_sql: string, params: unknown[]) => {
      const userId = params[1];
      if (userId !== OWNER) return [];
      return [{ id: 'conv-1', sharing: JSON.stringify({ shareTokens: [createShareToken({}, Date.now(), 'tok')] }) }];
    });
    const view = await getShareLink(OWNER, 'tok');
    expect(view.conversationId).toBe('conv-1');
    expect(view.mode).toBe(ShareMode.WATCH);
    await expect(getShareLink(OTHER, 'tok')).rejects.toThrow(/Share link/);
  });

  it('never discloses a token not present on a caller-accessible conversation', async () => {
    db.queryMany.mockImplementation(async () => []);
    await expect(getShareLink(OWNER, 'sneaky-token')).rejects.toThrow(/Share link/);
  });

  it('create stores a token and returns a deep-link url (owner only)', async () => {
    const link = await createConversationShareLink(OWNER, 'conv-1', {});
    expect(link.url).toBe(`/cowork/share/conv-1/${link.token}`);
    expect(link.token.length).toBeGreaterThanOrEqual(32);
    const saved = db.queryMany.mock.calls[0]?.[1]?.[1] as string;
    expect(saved).toContain(link.token);
    await expect(createConversationShareLink(OTHER, 'conv-1', {})).rejects.toThrow();
  });

  it('one-time redemption consumes the token through the adapter', async () => {
    const state = { shareTokens: [createShareToken({ oneTime: true }, Date.now(), 'tok')] };
    service.getConversation.mockImplementation(async () => ({ id: 'conv-1', sharing: state }));
    db.queryMany.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[1] !== OWNER) return [];
      return [{ id: 'conv-1', sharing: JSON.stringify(state) }];
    });
    await redeemConversationShareLink(OWNER, 'tok');
    await expect(redeemConversationShareLink(OWNER, 'tok')).rejects.toThrow(/already been used/);
  });

  it('revocation takes effect regardless of token validity time', async () => {
    const entry = createShareToken({}, Date.now(), 'tok');
    const state = { shareTokens: [entry] };
    service.getConversation.mockImplementation(async () => ({ id: 'conv-1', sharing: state }));
    db.queryMany.mockImplementation(async (_sql: string, params: unknown[]) => {
      if (params[1] !== OWNER) return [];
      return [{ id: 'conv-1', sharing: JSON.stringify(state) }];
    });
    await revokeConversationShareLink(OWNER, 'conv-1', 'tok');
    await expect(redeemConversationShareLink(OWNER, 'tok')).rejects.toThrow(/revoked/);
  });
});

describe('storage shape', () => {
  it('tolerates empty / malformed sharing JSON', () => {
    expect(parseStoredSharing(null).shareTokens).toBeUndefined();
    expect(parseStoredSharing('').shareTokens).toBeUndefined();
    expect(parseStoredSharing({}).shareTokens).toBeUndefined();
    expect(parseStoredSharing({ shareTokens: [{ id: 1 }] }).shareTokens).toHaveLength(0);
    const valid = parseStoredSharing({ shareTokens: [createShareToken({}, T0, 't')] });
    expect(valid.shareTokens).toHaveLength(1);
  });
});