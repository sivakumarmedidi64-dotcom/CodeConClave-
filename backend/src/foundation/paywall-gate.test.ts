/**
 * CodeConClave — workspace entitlement gate (commercial paywall).
 *
 * The product has NO free application tier: an authenticated user reaches a
 * workspace router only while holding an ACTIVE VERIFIED paid entitlement
 * (Solo `pro` or Team `team`). API Access (`api`) is a SEPARATE entitlement
 * that never unlocks the workspace. Pending / expired / revoked and API-only
 * users all receive 402 payment_required — and a DB failure fails closed with
 * 503 rather than accidentally opening the gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => {
  const queryOne = vi.fn();
  const client = {
    query: async (text: string, params?: unknown[]) => {
      const row = await queryOne(text, params);
      const rows = row === undefined || row === null ? [] : [row];
      return { rows, rowCount: rows.length };
    },
    queryOne,
    queryMany: async (text: string, params?: unknown[]) => {
      const row = await queryOne(text, params);
      return row === undefined || row === null ? [] : [row];
    },
  };
  return {
    queryOne,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn(client),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn(client),
  };
});
const envMock = vi.hoisted(() => ({
  env: { PAYMENT_FOUNDER_EMAIL: 'medidisaharsh@gmail.com' },
}));
vi.mock('../shared/db.js', () => dbMock);
vi.mock('../config/env.js', () => envMock);

import { workspaceAccess, requireWorkspaceEntitlement } from '../middleware/entitlement.js';

async function runMiddleware(user: unknown): Promise<unknown> {
  const req = { ctx: { user } } as never;
  const next = vi.fn();
  const mw = requireWorkspaceEntitlement();
  await mw(req, {} as never, next as never);
  return next.mock.calls[0]?.[0];
}

/**
 * Route each query by its SQL so the founder check (a SEPARATE lookup of
 * email/email_verified/is_founder) cannot be satisfied by accident by the
 * plan_id lookup, and vice versa.
 */
function stubUser(row: { plan_id: string; entitlement_state: string }): void {
  dbMock.queryOne.mockImplementation(async (text: string) => {
    if (text.includes('is_founder')) return null; // not the founder
    if (text.includes('FROM users')) return row;
    return null;
  });
}

function stubFounder(
  user: { plan_id: string; entitlement_state: string },
  founder: { email: string; email_verified: boolean; is_founder: boolean },
): void {
  dbMock.queryOne.mockImplementation(async (text: string) => {
    if (text.includes('is_founder')) return founder;
    if (text.includes('FROM users')) return user;
    return null;
  });
}

function stubEntitlement(plan: string, state: string): void {
  dbMock.queryOne.mockImplementation(async (text: string) => {
    if (text.includes('is_founder')) return null;
    if (text.includes('FROM users')) return { plan_id: plan, entitlement_state: state };
    if (text.includes('FROM entitlements')) return { state, expires_at: null };
    return null;
  });
}

beforeEach(() => {
  dbMock.queryOne.mockReset();
});

describe('workspaceAccess (server-authoritative paid gate)', () => {
  it('unauthenticated → middleware short-circuits 401', async () => {
    const err = await runMiddleware(undefined);
    expect(err).toBeDefined();
    expect((err as { status: number }).status).toBe(401);
  });

  it('free user without any entitlement is locked out (NO_ENTITLEMENT)', async () => {
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('NO_ENTITLEMENT');
    expect(access.effectivePlan).toBe('free');
  });

  it('PRO_VERIFIED Solo (pro) unlocks the workspace', async () => {
    stubEntitlement('pro', 'PRO_VERIFIED');
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(true);
    expect(access.effectivePlan).toBe('pro');
    expect(access.reason).toBe('ACTIVE');
  });

  it('PRO_VERIFIED Team (team) unlocks the workspace', async () => {
    stubEntitlement('team', 'PRO_VERIFIED');
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(true);
    expect(access.effectivePlan).toBe('team');
  });

  it('pending payment (PRO_PENDING, no verified row) is locked out', async () => {
    stubEntitlement('pro', 'PRO_PENDING');
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('PENDING');
  });

  it('expired paid entitlement Never unlocks', async () => {
    stubEntitlement('pro', 'PRO_EXPIRED');
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('EXPIRED');
  });

  it('honours entitlements.expires_at so a stale PRO_VERIFIED row cannot be used forever', async () => {
    dbMock.queryOne.mockImplementation(async (text: string) => {
      if (text.includes('is_founder')) return null;
      if (text.includes('FROM users')) return { plan_id: 'pro', entitlement_state: 'PRO_VERIFIED' };
      if (text.includes('FROM entitlements')) {
        return { state: 'PRO_VERIFIED', expires_at: new Date(Date.now() - 60_000).toISOString() };
      }
      return null;
    });
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('EXPIRED');
  });

  it('treats an unparseable expires_at as expired (fail closed, not fail open)', async () => {
    dbMock.queryOne.mockImplementation(async (text: string) => {
      if (text.includes('is_founder')) return null;
      if (text.includes('FROM users')) return { plan_id: 'team', entitlement_state: 'PRO_VERIFIED' };
      if (text.includes('FROM entitlements')) return { state: 'PRO_VERIFIED', expires_at: 'not-a-date' };
      return null;
    });
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('EXPIRED');
  });

  it('API Access (api) alone NEVER unlocks the workspace (separate entitlement)', async () => {
    stubUser({ plan_id: 'api', entitlement_state: 'PRO_VERIFIED' });
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('API_ONLY');
  });

  it('revoked access stays locked', async () => {
    stubUser({ plan_id: 'free', entitlement_state: 'REVOKED' });
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('REVOKED');
  });

  it('the PROVISIONED founder unlocks the workspace with the team plan (no payment required)', async () => {
    stubFounder(
      { plan_id: 'free', entitlement_state: 'FREE' },
      { email: 'medidisaharsh@gmail.com', email_verified: true, is_founder: true },
    );
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(true);
    expect(access.effectivePlan).toBe('team');
    expect(access.reason).toBe('ACTIVE');
  });

  it('REFUSES the founder grant to an UNVERIFIED holder of the founder address (squatted inbox)', async () => {
    stubFounder(
      { plan_id: 'free', entitlement_state: 'FREE' },
      { email: 'medidisaharsh@gmail.com', email_verified: false, is_founder: true },
    );
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('NO_ENTITLEMENT');
  });

  it('REFUSES the founder grant to a verified holder who is NOT the provisioned founder', async () => {
    stubFounder(
      { plan_id: 'free', entitlement_state: 'FREE' },
      { email: 'medidisaharsh@gmail.com', email_verified: true, is_founder: false },
    );
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('NO_ENTITLEMENT');
  });

  it('REFUSES the founder grant when the configured address differs from the account', async () => {
    stubFounder(
      { plan_id: 'free', entitlement_state: 'FREE' },
      { email: 'attacker@evil.example', email_verified: true, is_founder: true },
    );
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('NO_ENTITLEMENT');
  });

  it('a non-founder free user stays locked regardless of uppercase/lowercase founder env', async () => {
    stubFounder(
      { plan_id: 'free', entitlement_state: 'FREE' },
      { email: 'someone.else@gmail.com', email_verified: true, is_founder: true },
    );
    const access = await workspaceAccess('usr-1');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('NO_ENTITLEMENT');
  });
});

describe('requireWorkspaceEntitlement middleware', () => {
  it('rejects locked-out users with 402 entitlement_required', async () => {
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    const err = await runMiddleware({ id: 'usr-1', rbacRole: 'member' });
    expect(err).toBeDefined();
    expect((err as { status: number }).status).toBe(402);
    expect((err as { errorCode: string }).errorCode).toBe('entitlement_required');
    expect((err as { message: string }).message).toContain('₹999');
  });

  it('passes paid users straight through', async () => {
    stubEntitlement('pro', 'PRO_VERIFIED');
    const err = await runMiddleware({ id: 'usr-1', rbacRole: 'member' });
    expect(err).toBeUndefined();
  });

  it('passes the PROVISIONED verified founder straight through', async () => {
    stubFounder(
      { plan_id: 'free', entitlement_state: 'FREE' },
      { email: 'medidisaharsh@gmail.com', email_verified: true, is_founder: true },
    );
    const err = await runMiddleware({ id: 'usr-1', rbacRole: 'owner' });
    expect(err).toBeUndefined();
  });

  it('denies an UNVERIFIED founder-address holder (founder squat)', async () => {
    stubFounder(
      { plan_id: 'free', entitlement_state: 'FREE' },
      { email: 'medidisaharsh@gmail.com', email_verified: false, is_founder: false },
    );
    const err = await runMiddleware({ id: 'usr-1', rbacRole: 'member' });
    expect((err as { status: number }).status).toBe(402);
  });

  it('fails closed with 503 when entitlement lookup errors', async () => {
    dbMock.queryOne.mockRejectedValue(new Error('db down'));
    const err = await runMiddleware({ id: 'usr-1', rbacRole: 'member' });
    expect(err).toBeDefined();
    expect((err as { status: number }).status).toBe(503);
    expect((err as { errorCode: string }).errorCode).toBe('entitlement_check_failed');
  });
});