/**
 * CodeConClave — workspace share link foundation tests.
 * Covers: public share creation (unique token, visibility/mode), private share,
 * listing, revocation, and public resolution (valid / expired / revoked / one-time).
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

import {
  createWorkspaceShare,
  listWorkspaceShares,
  revokeWorkspaceShare,
  resolvePublicShare,
} from '../modules/workspace/shares-service.js';

const OWNER = 'usr_ws1';
const PROJECT = 'prj_abc';

function wsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wsh_abc',
    owner_id: OWNER,
    project_id: PROJECT,
    token: 'a'.repeat(48),
    visibility: 'PUBLIC',
    mode: 'WATCH',
    created_at: new Date('2026-01-01T00:00:00Z'),
    expires_at: null,
    one_time: false,
    revoked_at: null,
    redeemed_by: null,
    redeemed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  recordAudit.mockClear();
});

afterEach(() => {
  db.state.resolve = null;
});

describe('createWorkspaceShare — provisioning', () => {
  it('creates a share with a unique token and public visibility', async () => {
    db.state.resolve = (text) => (text.includes('SELECT * FROM workspace_shares WHERE id') ? [wsRow()] : null);
    const share = await createWorkspaceShare(OWNER, PROJECT);
    expect(share.id).toBe('wsh_abc');
    expect(share.token).toMatch(/^[0-9a-f]{48}$/);
    expect(share.visibility).toBe('PUBLIC');
    expect(share.mode).toBe('WATCH');
    expect(share.url).toBe(`/share/${share.token}`);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace_share.created' }));
  });

  it('supports private visibility', async () => {
    db.state.resolve = (text) => (text.includes('SELECT * FROM workspace_shares WHERE id') ? [wsRow({ visibility: 'PRIVATE' })] : null);
    const share = await createWorkspaceShare(OWNER, PROJECT, { visibility: 'PRIVATE' });
    expect(share.visibility).toBe('PRIVATE');
  });

  it('supports one-time + CO_CONTROL mode', async () => {
    db.state.resolve = (text) => (text.includes('SELECT * FROM workspace_shares WHERE id') ? [wsRow({ one_time: true, mode: 'CO_CONTROL' })] : null);
    const share = await createWorkspaceShare(OWNER, PROJECT, { oneTime: true, mode: 'CO_CONTROL' });
    expect(share.oneTime).toBe(true);
    expect(share.mode).toBe('CO_CONTROL');
  });
});

describe('listWorkspaceShares', () => {
  it('lists active shares for a project', async () => {
    db.state.rows = [wsRow(), wsRow({ id: 'wsh_2', token: 'b'.repeat(48) })];
    const shares = await listWorkspaceShares(OWNER, PROJECT);
    expect(shares).toHaveLength(2);
    const call = db.state.calls.find((c) => c.text.includes('FROM workspace_shares WHERE owner_id'));
    expect(call!.params).toEqual([OWNER, PROJECT]);
  });
});

describe('revokeWorkspaceShare', () => {
  it('revokes an active share', async () => {
    db.state.resolve = (text) => {
      if (text.includes('WHERE id = $1 AND owner_id = $2')) return [wsRow()];
      return null;
    };
    await revokeWorkspaceShare(OWNER, 'wsh_abc');
    const update = db.state.calls.find((c) => c.text.includes('revoked_at = now()'));
    expect(update).toBeDefined();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'workspace_share.revoked' }));
  });

  it('fails closed on a share owned by someone else', async () => {
    db.state.resolve = () => null;
    await expect(revokeWorkspaceShare(OWNER, 'wsh_x')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('resolvePublicShare — unauthenticated lookup', () => {
  it('resolves a valid public share', async () => {
    db.state.resolve = (text) => (text.includes('WHERE token = $1') ? [wsRow()] : null);
    const share = await resolvePublicShare('a'.repeat(48));
    expect(share).not.toBeNull();
    expect(share!.projectId).toBe(PROJECT);
    expect(share!.mode).toBe('WATCH');
  });

  it('returns null for an unknown token', async () => {
    db.state.resolve = () => null;
    expect(await resolvePublicShare('z'.repeat(48))).toBeNull();
  });

  it('returns null for a revoked share', async () => {
    db.state.resolve = () => [wsRow({ revoked_at: new Date() })];
    expect(await resolvePublicShare('a'.repeat(48))).toBeNull();
  });

  it('returns null for an expired share', async () => {
    db.state.resolve = () => [wsRow({ expires_at: new Date(Date.now() - 1000) })];
    expect(await resolvePublicShare('a'.repeat(48))).toBeNull();
  });

  it('returns null for a private share', async () => {
    db.state.resolve = () => [wsRow({ visibility: 'PRIVATE' })];
    expect(await resolvePublicShare('a'.repeat(48))).toBeNull();
  });
});