/**
 * CodeConClave — TEMPORARY DEMO / EARLY ACCESS MODE (`TEMPORARY_DEMO_MODE`).
 *
 * TEMPORARY feature introduced for the Saturday Kuberns demonstration. It is a
 * SERVER-SIDE, READ-TIME allowance: the core workspace opens without a paid
 * entitlement while the flag is on, and full commercial enforcement returns the
 * moment the flag is off. Nothing here is permanent and nothing is destructive.
 *
 * The invariants this suite locks down:
 *   A. ON  — workspace opens; no payment/intent/entitlement row is written; the
 *            account is never described as having purchased anything.
 *   B. OFF — the exact pre-existing paywall behaviour returns (402
 *            entitlement_required) and FREE_LIMITS are restored verbatim.
 *   C. GOOGLE — customer Google sign-in stays removed and cannot mint a session;
 *            plugin OAuth is left intact.
 *   D. API ACCESS — the separate ₹9,999 API entitlement is NOT unlocked.
 *   E. SECURITY — rate limits, bounded AI/resource caps, no client-side bypass,
 *            and REVOKED stays revoked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const envMock = vi.hoisted(() => ({
  env: {
    PAYMENT_FOUNDER_EMAIL: 'medidisaharsh@gmail.com',
    // Mutable on purpose: every test flips the flag the way an operator would
    // flip an environment variable between deploys.
    TEMPORARY_DEMO_MODE: 'false' as string,
    FREE_DAILY_MESSAGES: 20,
    RATE_LIMIT_GLOBAL_PER_MIN: 300,
    RATE_LIMIT_AUTH_PER_MIN: 10,
    RATE_LIMIT_AUTH_IDENTITY_PER_MIN: 5,
    RATE_LIMIT_CHAT_PER_MIN: 60,
    AI_PREMIUM_BUDGET_USD_PER_DAY: 4,
    API_RATE_LIMIT_REQUESTS: 60,
    API_RATE_LIMIT_WINDOW_SECONDS: 60,
    API_MAX_DAILY_REQUESTS: 500,
    API_MAX_CONCURRENT_REQUESTS: 3,
  },
  // The real module exports a Set; the pre-existing paywall-gate mock omitted it,
  // which made `paymentTestUserIds.size` throw. Provide a real empty Set here.
  paymentTestUserIds: new Set<string>(),
}));

const dbMock = vi.hoisted(() => {
  const queryOne = vi.fn();
  const client = {
    query: async (text: string, params?: unknown[]) => {
      const row = await queryOne(text, params);
      const rows = row === undefined || row === null ? [] : [row];
      return { rows, rowCount: rows.length };
    },
    queryOne,
  };
  return {
    queryOne,
    client,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn(client),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn(client),
    pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  };
});

const cacheMock = vi.hoisted(() => ({
  cache: { incr: vi.fn(async () => 1), set: vi.fn(async () => undefined), get: vi.fn(async () => null), del: vi.fn() },
}));

const apikeyMock = vi.hoisted(() => ({
  resolveUserApiKey: vi.fn(),
  apiAccessEntitlementState: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../config/env.js', () => envMock);
vi.mock('../shared/cache.js', () => cacheMock);
vi.mock('../modules/apikeys/service.js', () => apikeyMock);
vi.mock('../shared/logger.js', () => loggerMock);

import { workspaceAccess, requireWorkspaceEntitlement } from '../middleware/entitlement.js';
import {
  DEMO_LIMITS,
  FREE_LIMITS,
  PRO_LIMITS,
  TEAM_LIMITS,
  limitsFor,
  temporaryDemoModeEnabled,
} from '../modules/entitlements/service.js';
import { apiKeyAuth } from '../middleware/api-key-auth.js';

const BACKEND_SRC = resolve(__dirname, '..');
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const FRONTEND_SRC = join(REPO_ROOT, 'frontend', 'src');

function setDemo(on: boolean): void {
  envMock.env.TEMPORARY_DEMO_MODE = on ? 'true' : 'false';
}

function stubUser(row: { plan_id: string; entitlement_state: string }): void {
  dbMock.queryOne.mockImplementation(async (text: string) => {
    if (text.includes('is_founder')) return null; // never the provisioned founder
    if (text.includes('FROM users')) return row;
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

async function runWorkspaceMiddleware(user: unknown): Promise<unknown> {
  const next = vi.fn();
  const mw = requireWorkspaceEntitlement();
  await mw({ ctx: { user } } as never, {} as never, next as never);
  return next.mock.calls[0]?.[0];
}

/** Every SQL string the code under test issued, for write-assertions. */
function issuedSql(): string[] {
  return dbMock.queryOne.mock.calls.map((c) => String(c[0]));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

beforeEach(() => {
  setDemo(false);
  dbMock.queryOne.mockReset();
  apikeyMock.resolveUserApiKey.mockReset();
  apikeyMock.apiAccessEntitlementState.mockReset();
});

// ===========================================================================
// A. TEMPORARY DEMO MODE = ON
// ===========================================================================
describe('A. TEMPORARY DEMO MODE ON — workspace is open, nothing is faked', () => {
  it('unlocks the workspace for a FREE user holding no entitlement', async () => {
    setDemo(true);
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    const access = await workspaceAccess('usr-demo');
    expect(access.unlocked).toBe(true);
    expect(access.reason).toBe('TEMPORARY_DEMO_MODE');
    expect(access.demoMode).toBe(true);
  });

  it('reports paymentRequired=false WITHOUT claiming a paid entitlement', async () => {
    setDemo(true);
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    const access = await workspaceAccess('usr-demo');
    // The two must be independent: open because of the flag, not because of money.
    expect(access.paymentRequired).toBe(false);
    expect(access.paidEntitlement).toBe(false);
  });

  it('never mirrors the account as a purchased plan', async () => {
    setDemo(true);
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    const access = await workspaceAccess('usr-demo');
    expect(access.planId).toBe('free');
    expect(access.effectivePlan).toBe('free');
    expect(access.entitlementState).toBe('FREE');
    expect(access.entitlementState).not.toBe('PRO_VERIFIED');
    expect(access.testBypass).toBe(false);
  });

  it('lets the workspace middleware through instead of 402', async () => {
    setDemo(true);
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    expect(await runWorkspaceMiddleware({ id: 'usr-demo', rbacRole: 'member' })).toBeUndefined();
  });

  it('writes NO payment, intent or entitlement row (read-time allowance only)', async () => {
    setDemo(true);
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    await workspaceAccess('usr-demo');
    await runWorkspaceMiddleware({ id: 'usr-demo', rbacRole: 'member' });
    const sql = issuedSql().join('\n');
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it('raises FREE caps to bounded DEMO_LIMITS so a demo can really use the product', () => {
    setDemo(true);
    expect(limitsFor('free')).toBe(DEMO_LIMITS);
    expect(DEMO_LIMITS.MAX_PROJECTS).toBeGreaterThan(1);
    expect(DEMO_LIMITS.COWORKER_TYPES.length).toBeGreaterThan(2);
  });

  it('leaves real paid plans on their paid limits', () => {
    setDemo(true);
    expect(limitsFor('pro')).toBe(PRO_LIMITS);
    expect(limitsFor('team')).toBe(TEAM_LIMITS);
  });

  it('still reports a genuine purchase honestly when one exists', async () => {
    setDemo(true);
    stubEntitlement('pro', 'PRO_VERIFIED');
    const access = await workspaceAccess('usr-paying');
    expect(access.unlocked).toBe(true);
    expect(access.reason).toBe('ACTIVE');
    expect(access.paidEntitlement).toBe(true);
    expect(access.paymentRequired).toBe(false);
  });

  it('does NOT grant API-only holders a paid workspace claim', async () => {
    setDemo(true);
    stubUser({ plan_id: 'api', entitlement_state: 'PRO_VERIFIED' });
    const access = await workspaceAccess('usr-api');
    expect(access.unlocked).toBe(true);
    expect(access.reason).toBe('TEMPORARY_DEMO_MODE');
    expect(access.paidEntitlement).toBe(false);
  });
});

// ===========================================================================
// B. TEMPORARY DEMO MODE = OFF — commercial enforcement returns
// ===========================================================================
describe('B. TEMPORARY DEMO MODE OFF — paywall returns unchanged', () => {
  it('locks out a FREE user with no entitlement', async () => {
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    const access = await workspaceAccess('usr-demo');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('NO_ENTITLEMENT');
    expect(access.paymentRequired).toBe(true);
    expect(access.paidEntitlement).toBe(false);
    expect(access.demoMode).toBe(false);
  });

  it('returns the existing 402 entitlement_required response', async () => {
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    const err = (await runWorkspaceMiddleware({ id: 'usr-demo', rbacRole: 'member' })) as {
      status: number;
      errorCode: string;
      message: string;
    };
    expect(err).toBeDefined();
    expect(err.status).toBe(402);
    expect(err.errorCode).toBe('entitlement_required');
    expect(err.message).toContain('₹999');
  });

  it('restores FREE_LIMITS verbatim', () => {
    expect(limitsFor('free')).toBe(FREE_LIMITS);
  });

  it('re-enables enforcement on the very next request after the flag flips off', async () => {
    setDemo(true);
    stubUser({ plan_id: 'free', entitlement_state: 'FREE' });
    expect((await workspaceAccess('usr-demo')).unlocked).toBe(true);

    setDemo(false); // operator flips the env var; no restart, no migration
    const after = await workspaceAccess('usr-demo');
    expect(after.unlocked).toBe(false);
    expect(after.reason).toBe('NO_ENTITLEMENT');
    expect(limitsFor('free')).toBe(FREE_LIMITS);
  });

  it('fails SAFE for unset, false, zero or malformed values', () => {
    for (const raw of ['', 'false', 'FALSE', '0', 'no', 'off', 'maybe', 'null', '   ']) {
      envMock.env.TEMPORARY_DEMO_MODE = raw;
      expect(temporaryDemoModeEnabled()).toBe(false);
    }
  });

  it('accepts only explicit truthy tokens', () => {
    for (const raw of ['true', 'TRUE', 'True', '1', 'on', 'yes', ' true ']) {
      envMock.env.TEMPORARY_DEMO_MODE = raw;
      expect(temporaryDemoModeEnabled()).toBe(true);
    }
  });

  it('defaults to OFF when the variable is absent entirely', () => {
    delete (envMock.env as Record<string, unknown>).TEMPORARY_DEMO_MODE;
    expect(temporaryDemoModeEnabled()).toBe(false);
  });
});

// ===========================================================================
// C. GOOGLE CUSTOMER OAUTH
// ===========================================================================
describe('C. GOOGLE — zero customer sign-in, plugin OAuth untouched', () => {
  const authRoutes = readFileSync(join(BACKEND_SRC, 'modules', 'auth', 'routes.ts'), 'utf8');

  it('registers no customer /google/authorize login route', () => {
    expect(authRoutes).not.toMatch(/router\.(get|post)\(\s*['"]\/google\/authorize/);
  });

  it('only accepts /google/callback for plugin OAuth state, else 404s', () => {
    expect(authRoutes).toContain("'/google/callback'");
    expect(authRoutes).toContain('isPluginOAuthState');
    expect(authRoutes).toContain('google.customer_login_removed');
  });

  it('keeps historical google_sub / google_connections data (no destructive path)', () => {
    // The type surface still carries google_sub, and no migration drops it.
    const types = readFileSync(join(BACKEND_SRC, 'modules', 'auth', 'service.ts'), 'utf8');
    expect(types).toContain('googleSub');
    expect(authRoutes).toMatch(/preserved untouched|preserved/i);
  });

  it('ships no Google sign-in button in the frontend', () => {
    const offenders = walk(FRONTEND_SRC).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /signInWithGoogle|Continue with Google|google\/callback/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('leaves the Google PLUGIN connector registered', () => {
    const pluginsIndex = readFileSync(join(BACKEND_SRC, 'modules', 'plugins', 'index.ts'), 'utf8');
    expect(pluginsIndex).toContain('googleAdapter');
  });
});

// ===========================================================================
// D. API ACCESS stays commercially protected
// ===========================================================================
describe('D. API ACCESS — never unlocked by demo mode', () => {
  async function runApiKey(bearer: string | null): Promise<unknown> {
    const next = vi.fn();
    const mw = apiKeyAuth();
    const req = { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} } as never;
    const res = { setHeader: vi.fn() } as never;
    await mw(req, res, next as never);
    return next.mock.calls[0]?.[0];
  }

  it('still returns 402 api_access_required without an API entitlement while demo is ON', async () => {
    setDemo(true);
    apikeyMock.resolveUserApiKey.mockResolvedValue({ ownerId: 'usr-demo', keyId: 'key-1' });
    apikeyMock.apiAccessEntitlementState.mockResolvedValue({ entitled: false });
    const err = (await runApiKey('cc_live_test')) as { status: number; errorCode: string; message: string };
    expect(err).toBeDefined();
    expect(err.status).toBe(402);
    expect(err.errorCode).toBe('api_access_required');
    expect(err.message).toContain('9,999');
  });

  it('the API-key gate contains no demo-mode logic at all', () => {
    const src = readFileSync(join(BACKEND_SRC, 'middleware', 'api-key-auth.ts'), 'utf8');
    expect(src).not.toContain('TEMPORARY_DEMO_MODE');
    expect(src).not.toContain('temporaryDemoModeEnabled');
  });

  it('a request with no Bearer key still passes through (session flow unchanged)', async () => {
    setDemo(true);
    expect(await runApiKey(null)).toBeUndefined();
  });
});

// ===========================================================================
// E. SECURITY + resource limits intact
// ===========================================================================
describe('E. SECURITY — no client bypass, protections retained', () => {
  it('every DEMO_LIMITS cap is finite and bounded below the paid plan', () => {
    for (const value of Object.values(DEMO_LIMITS)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    expect(DEMO_LIMITS.AGENT_MAX_BUDGET_USD).toBeLessThan(PRO_LIMITS.AGENT_MAX_BUDGET_USD);
    expect(DEMO_LIMITS.MAX_PROJECTS).toBeLessThan(PRO_LIMITS.MAX_PROJECTS);
    expect(DEMO_LIMITS.DAILY_MESSAGES).toBeLessThan(PRO_LIMITS.DAILY_MESSAGES);
    expect(DEMO_LIMITS.STORAGE_BYTES).toBeLessThan(PRO_LIMITS.STORAGE_BYTES);
    expect(DEMO_LIMITS.AGENT_MAX_TASKS_PER_RUN).toBeLessThanOrEqual(PRO_LIMITS.AGENT_MAX_TASKS_PER_RUN);
  });

  it('plan-independent rate limits stay positive and fail closed', () => {
    const rateLimit = readFileSync(join(BACKEND_SRC, 'middleware', 'rate-limit.ts'), 'utf8');
    expect(rateLimit).toContain('failClosed: true');
    for (const key of [
      'RATE_LIMIT_GLOBAL_PER_MIN',
      'RATE_LIMIT_AUTH_PER_MIN',
      'RATE_LIMIT_CHAT_PER_MIN',
    ] as const) {
      expect(envMock.env[key]).toBeGreaterThan(0);
    }
    expect(envMock.env.AI_PREMIUM_BUDGET_USD_PER_DAY).toBeGreaterThan(0);
  });

  it('the global limiter is mounted BEFORE the paid gate (applies to demo users too)', () => {
    const app = readFileSync(join(BACKEND_SRC, 'app.ts'), 'utf8');
    expect(app.indexOf('globalLimit()')).toBeGreaterThan(-1);
    expect(app.indexOf('globalLimit()')).toBeLessThan(app.indexOf('requireWorkspaceEntitlement()'));
  });

  it('no client-side switch exists: the frontend never reads the flag from the client env', () => {
    // The token may appear ONLY as a quoted wire value (the server's `reason`
    // code that /access returns). Any bare read — process.env.X, import.meta.env
    // — would be a client-controlled switch and is rejected.
    const token = 'TEMPORARY_DEMO_MODE';
    const offenders: string[] = [];
    for (const file of walk(FRONTEND_SRC)) {
      const src = readFileSync(file, 'utf8');
      const occurrences = src.split(token).length - 1;
      if (occurrences === 0) continue;
      const asWireValue = src.split(`'${token}'`).length - 1;
      if (asWireValue !== occurrences) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the frontend gate trusts only the server-supplied `unlocked` flag', () => {
    const app = readFileSync(join(FRONTEND_SRC, 'App.tsx'), 'utf8');
    expect(app).toContain('access && !access.unlocked');
  });

  it('the frontend banner is driven only by the server /access reply', () => {
    const app = readFileSync(join(FRONTEND_SRC, 'App.tsx'), 'utf8');
    expect(app).toContain('setMode(res?.mode');
    expect(app).toContain('mode?.temporaryDemoMode');
  });

  it('no demo mode value is read from storage, cookies or the URL', () => {
    const offenders = walk(FRONTEND_SRC).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /(localStorage|sessionStorage|URLSearchParams|location\.search)[^\n]*demo/i.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('REVOKED access is NOT undone by demo mode', async () => {
    setDemo(true);
    stubUser({ plan_id: 'free', entitlement_state: 'REVOKED' });
    const access = await workspaceAccess('usr-revoked');
    expect(access.unlocked).toBe(false);
    expect(access.reason).toBe('REVOKED');
  });

  it('still fails closed with 503 when the entitlement lookup breaks', async () => {
    setDemo(true);
    dbMock.queryOne.mockRejectedValue(new Error('db down'));
    const err = (await runWorkspaceMiddleware({ id: 'usr-demo', rbacRole: 'member' })) as {
      status: number;
      errorCode: string;
    };
    expect(err.status).toBe(503);
    expect(err.errorCode).toBe('entitlement_check_failed');
  });
});
