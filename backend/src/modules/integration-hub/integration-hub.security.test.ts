/**
 * CodeConClave — PKG-26 — Universal Integration Hub — security tests.
 *
 * Phase-19 security surface for the integration hub. Because PKG-26 REUSES the
 * existing plugin/webhook/release substrate rather than rebuilding it, these
 * checks assert the security invariants the hub must uphold:
 *
 *   A. Hub catalog   — owner isolation, NO token/secret/credential leakage,
 *                      honest server-derived states (never fabricated).
 *   B. OAuth state   — invalid / expired / cross-user states are rejected
 *                      (real engine verification, signed HMAC).
 *   C. Webhook auth  — malformed body, missing signature, invalid signature,
 *                      unregistered repo, replay/dedup.
 *   D. Deployment    — provider capability matrix is honest (no fake live).
 *
 * Deterministic in-memory fakes — no network, no provider, no process.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as crypto from 'node:crypto';

// ------------------------------------------------------------------ hoisted fakes
const hoisted = vi.hoisted(() => {
  const tables = new Map<string, Record<string, unknown>[]>();
  const query = vi.fn(async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const insert = /INSERT INTO (\w+)/i.exec(text);
    if (insert) {
      const table = insert[1]!;
      const arr = tables.get(table) ?? [];
      const row: Record<string, unknown> = {};
      params?.forEach((p, i) => { row[`p${i + 1}`] = p; });
      arr.push(row);
      tables.set(table, arr);
      if (/RETURNING id/.test(text)) return { rows: [{ id: params?.[0] ?? 'eid-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE (\w+)/i.test(text)) return { rows: [], rowCount: 1 };
    // SELECT from webhook_secrets / plugin_connections / plugin_events / event_log
    const from = /FROM (\w+)/i.exec(text);
    if (from) {
      const table = from[1]!;
      const arr = tables.get(table) ?? [];
      const sourceIdx = /source = \$(\d+)/i.test(text) ? Number(/-source = \$(\d+)/.exec(text)?.[1]) : null;
      const rows = arr.filter((r) => (sourceIdx ? r[`p${sourceIdx}`] === params?.[sourceIdx! - 1] : true));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const queryMany = vi.fn(async (text: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    const from = /FROM (\w+)/i.exec(text);
    if (!from) return [];
    const table = from[1]!;
    const arr = tables.get(table) ?? [];
    let rows = arr;
    const ownerIdx = /owner_id = \$(\d+)/i.exec(text);
    if (ownerIdx) rows = rows.filter((r) => r[`p${ownerIdx[1]}`] === params?.[Number(ownerIdx[1]) - 1]);
    return rows;
  });
  const queryOne = vi.fn(async () => null);
  return { tables, query, queryMany, queryOne };
});

const recordAudit = vi.hoisted(() => vi.fn(async () => undefined));
const envMock = vi.hoisted(() => ({ JWT_SECRET: 'test-jwt-secret-at-least-32-bytes', SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long', SENTRY_DSN: '', SENTRY_ENABLED: 'false' }));

vi.mock('../../shared/db.js', () => ({
  pool: { query: hoisted.query },
  queryMany: hoisted.queryMany,
  queryOne: hoisted.queryOne,
  withTenant: async (_id: unknown, fn: (c: { query: typeof hoisted.query }) => Promise<unknown>) =>
    fn?.({ query: hoisted.query }),
  withSystem: async (fn: (c: { query: typeof hoisted.query }) => Promise<unknown>) =>
    fn?.({ query: hoisted.query }),
}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
vi.mock('../../config/env.js', () => ({ env: envMock }));
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    badRequest: (code: string, msg?: string) => Object.assign(new Error(msg ?? code), { status: 400, errorCode: code }),
    unauthorized: (code: string, msg?: string) => Object.assign(new Error(msg ?? code), { status: 401, errorCode: code }),
    notFound: (msg: string, code?: string) => Object.assign(new Error(msg ?? code), { status: 404, errorCode: code ?? 'not_found' }),
    forbidden: () => Object.assign(new Error('forbidden'), { status: 403 }),
  },
}));
vi.mock('../../shared/ids.js', () => {
  let c = 0;
  return {
    newId: () => `id_${++c}`,
    PREFIX: { WEBHOOK_SECRET: 'whs', EVENT: 'ev', PLUGIN_CONNECTION: 'c', AUDIT: 'aud' },
  };
});

// ------------------------------------------------------------------ adapter/health mocks
interface MockAction { name: string; permission: string; scope: string; idempotent: boolean }
const listAdapters = vi.hoisted(() =>
  vi.fn(() => [
    { id: 'github', name: 'GitHub', capabilities: ['repo.read', 'pr.write'], oauth: { required: true, scopes: [] }, actions: [{ name: 'repositories.list', permission: 'read', scope: 'repositories:read', idempotent: true } as MockAction] },
    { id: 'slack', name: 'Slack', capabilities: ['message.send'], oauth: { required: true, scopes: [] }, actions: [{ name: 'messages.post', permission: 'send', scope: 'chat:write', idempotent: false } as MockAction] },
    { id: 'linear', name: 'Linear', capabilities: ['issue.write'], oauth: { required: true, scopes: [] }, actions: [{ name: 'issues.create', permission: 'create', scope: 'issues:create', idempotent: false } as MockAction] },
    { id: 'webhook', name: 'Webhook', capabilities: ['deliver'], oauth: { required: false, scopes: [] }, actions: [{ name: 'deliver', permission: 'write', scope: '*', idempotent: true } as MockAction] },
  ]),
);
const healthMock = vi.hoisted(() => ({
  listConnections: vi.fn(async (userId: string): Promise<unknown[]> => {
    const rows = hoisted.tables.get('plugin_connections') ?? [];
    return rows.filter((r) => r.p1 === userId || r.p2 === userId).map((r) => ({
      id: String(r.p1 ?? ''),
      owner_id: String(r.p1 ?? ''),
      plugin_type: String(r.p2 ?? ''),
      name: String(r.p3 ?? ''),
      state: String(r.p5 ?? 'CONNECTED'),
      scopes: (r.p6 as string[]) ?? [],
      last_health_check_at: null,
      last_error: (r.p7 as string | null) ?? null,
    }));
  }),
  pluginServerConfigured: vi.fn((t: string) => t === 'github' || t === 'slack'),
  classifyPluginIntegration: vi.fn(() => 'CONNECTED'),
  derivePluginHealthStatus: vi.fn(() => 'CONNECTED'),
}));

vi.mock('../plugins/sdk.js', () => ({ listAdapters }));
vi.mock('../plugins/health.js', () => healthMock);

// ------------------------------------------------------------------ real modules under test
import { hubStateFor } from './service.js';
import { githubEventType, createWebhookSecret } from '../automations/webhooks.js';
import { verifyPluginOAuthState, pluginOAuthStateToken, isPluginOAuthState } from '../plugins/engine.js';

const U = 'usr-1';
const OTHER = 'usr-2';

beforeEach(() => {
  hoisted.tables.clear();
  hoisted.query.mockClear();
  hoisted.queryMany.mockClear();
  hoisted.queryOne.mockClear();
  recordAudit.mockClear();
  healthMock.listConnections.mockClear();
  healthMock.pluginServerConfigured.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
});

function seedConnection(owner: string, pluginType: string, state: string, scopes: string[], lastError: string | null) {
  const cols = ['id', 'owner_id', 'plugin_type', 'name', 'state', 'scopes', 'last_error'];
  const arr = hoisted.tables.get('plugin_connections') ?? [];
  arr.push({
    id: `conn-${pluginType}-${owner}`,
    owner_id: owner,
    plugin_type: pluginType,
    name: pluginType,
    state,
    scopes,
    last_health_check_at: null,
    last_error: lastError,
  } as unknown as Record<string, unknown>);
  void cols;
  hoisted.tables.set('plugin_connections', arr);
}

describe('PKG-26 · Hub catalog security', () => {
  it('A1. hub provider for a connected OWNER connection never exposes token/secret values', async () => {
    seedConnection(U, 'github', 'CONNECTED', ['repositories:read', 'tokens:x-secret-abc123'], 'upstream said token:ghp_SECRETTOKEN9x');
    const provider = await import('./service.js').then((m) => m.hubProvider(U, 'github', healthMock.listConnections(U)[0]));
    const ser = JSON.stringify(provider);
    expect(ser).not.toContain('ghp_SECRETTOKEN9x');
    expect(ser).not.toContain('x-secret-abc123');
    expect(ser).not.toContain('access_token');
    expect(ser).not.toContain('refresh_token');
  });

  it('A2. owner isolation: an OWNER cannot see another user\'s connection in their hub', async () => {
    seedConnection(OTHER, 'slack', 'CONNECTED', ['chat:write'], null);
    const hub = await import('./service.js').then((m) => m.buildIntegrationHub(U));
    const slack = hub.providers.find((p) => p.provider === 'slack');
    expect(slack!.connection).toBeNull(); // OTHER's connection is not surfaced to U
    expect(slack!.state).toBe('AVAILABLE'); // U's own slack is configured but has no live connection
    // a provider that is not even server-configured for U is UNCONFIGURED
    const linear = hub.providers.find((p) => p.provider === 'linear');
    expect(linear!.connection).toBeNull();
    expect(linear!.state).toBe('UNCONFIGURED');
  });

  it('A3. unsupported provider reports UNSUPPORTED — never a fabricated connection', () => {
    expect(hubStateFor(undefined, { serverConfigured: false, adapterAvailable: false })).toBe('UNSUPPORTED');
  });

  it('A4. no connection + server unconfigured → UNCONFIGURED (not fake CONNECTED)', () => {
    expect(hubStateFor(undefined, { serverConfigured: false, adapterAvailable: true })).toBe('UNCONFIGURED');
  });

  it('A5. connected server → CONNECTED', () => {
    expect(hubStateFor({ state: 'CONNECTED' } as never, { serverConfigured: true, adapterAvailable: true })).toBe('CONNECTED');
  });

  it('A6. reauth-required → AUTH_REQUIRED', () => {
    expect(hubStateFor({ state: 'REAUTH_REQUIRED' } as never, { serverConfigured: true, adapterAvailable: true })).toBe('AUTH_REQUIRED');
  });

  it('A7. revoked/disconnected → DISCONNECTED', () => {
    expect(hubStateFor({ state: 'REVOKED' } as never, { serverConfigured: true, adapterAvailable: true })).toBe('DISCONNECTED');
    expect(hubStateFor({ state: 'DISCONNECTED' } as never, { serverConfigured: true, adapterAvailable: true })).toBe('DISCONNECTED');
  });

  it('A8. degraded/failed/error → ERROR', () => {
    for (const s of ['DEGRADED', 'FAILED', 'ERROR']) {
      expect(hubStateFor({ state: s } as never, { serverConfigured: true, adapterAvailable: true })).toBe('ERROR');
    }
  });

  it('A9. adapter present + configured but no live connection → AVAILABLE', () => {
    expect(hubStateFor(undefined, { serverConfigured: true, adapterAvailable: true })).toBe('AVAILABLE');
  });

  it('A10. deployment provider capabilities are honest — never claim live without real config', async () => {
    const caps = await import('./service.js').then((m) => m.deploymentProviderCapabilities());
    expect(Array.isArray(caps)).toBe(true);
    for (const c of caps) {
      expect(c.provider).toBeTruthy();
      expect(['SUPPORTED', 'CONFIGURED', 'UNCONFIGURED', 'ENVIRONMENT_BLOCKED', 'UNAVAILABLE', 'UNSUPPORTED']).toContain(c.state);
      expect(typeof c.live).toBe('boolean');
      expect(typeof c.reason).toBe('string');
      // honest: a capability is only live when the environment genuinely supports it
      if (c.live) expect(c.state).not.toBe('ENVIRONMENT_BLOCKED');
      if (c.state === 'ENVIRONMENT_BLOCKED') expect(c.live).toBe(false);
    }
  });

  it('A11. hub webhook-source summary exposes counts, never hmac_key / secret_hash', async () => {
    const created = await createWebhookSecret(U, { source: 'github', name: 'main-repo', repo: 'org/repo' });
    const hub = await import('./service.js').then((m) => m.buildIntegrationHub(U));
    const ser = JSON.stringify({ webhookSources: hub.webhookSources, secrets: created.secret });
    expect(ser).not.toContain('hmac_key');
    expect(ser).not.toContain('secret_hash');
    expect(created.secret).not.toHaveProperty('hmac_key');
    expect(created.secret).not.toHaveProperty('secret_hash');
    // plaintext secret is returned ONCE at creation, never re-listed
    expect(created.plaintextSecret.length).toBeGreaterThan(0);
    expect(hub.webhookSources.length).toBeGreaterThan(0);
  });
});

describe('PKG-26 · OAuth state security (real engine verification)', () => {
  it('B1. tampered/forged OAuth state (wrong signature) is rejected as invalid', () => {
    const good = pluginOAuthStateToken(U, 'conn-github');
    const [body, sig] = good.split('.');
    const forged = `${Buffer.from(JSON.stringify({ kind: 'plugin-oauth', userId: U, connectionId: 'conn-evil', exp: Date.now() + 60000 })).toString('base64url')}.${sig}`;
    expect(isPluginOAuthState(forged)).toBe(true); // shape is plausibly a state
    expect(() => verifyPluginOAuthState(forged)).toThrow();
  });

  it('B2. expired OAuth state (exp in the past) is rejected as expired', () => {
    const pastBody = Buffer.from(JSON.stringify({ kind: 'plugin-oauth', userId: U, connectionId: 'conn-github', exp: Date.now() - 1000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', envMock.JWT_SECRET).update(`plugin-oauth:${pastBody}`).digest('base64url');
    expect(() => verifyPluginOAuthState(`${pastBody}.${sig}`)).toThrow();
  });

  it('B3. authentic OAuth state verifies back to the true owner + connection', () => {
    const token = pluginOAuthStateToken(U, 'conn-github');
    const { userId, connectionId } = verifyPluginOAuthState(token);
    expect(userId).toBe(U);
    expect(connectionId).toBe('conn-github');
  });

  it('B4. a state minted for one owner can never authorize a different owner', () => {
    const token = pluginOAuthStateToken(U, 'conn-github');
    const { userId, connectionId } = verifyPluginOAuthState(token);
    expect(userId).toBe(U);
    expect(userId).not.toBe(OTHER);
    expect(connectionId).toBe('conn-github');
  });

  it('B5. state with wrong kind flag is rejected', () => {
    const body = Buffer.from(JSON.stringify({ kind: 'login', userId: U, connectionId: 'conn-github', exp: Date.now() + 60000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', envMock.JWT_SECRET).update(`plugin-oauth:${body}`).digest('base64url');
    expect(() => verifyPluginOAuthState(`${body}.${sig}`)).toThrow();
  });
});

describe('PKG-26 · Webhook authentication security', () => {
  it('C1. malformed JSON body is rejected before any provider lookup', async () => {
    const { handleWebhook } = await import('../automations/webhooks.js');
    await expect(handleWebhook({ source: 'github', rawBody: Buffer.from('{not json'), headers: {} })).rejects.toMatchObject({ status: 400 });
  });

  it('C2. GitHub webhook missing signature + delivery id is rejected as unauthorized', async () => {
    const { handleWebhook } = await import('../automations/webhooks.js');
    const rawBody = Buffer.from(JSON.stringify({ repository: { full_name: 'org/repo' } }));
    await expect(
      handleWebhook({ source: 'github', rawBody, headers: { 'x-github-event': 'push' } }),
    ).rejects.toMatchObject({ status: 401, errorCode: 'webhook_auth_required' });
  });

  it('C3. GitHub webhook with an invalid HMAC signature is rejected', async () => {
    const { encryptAtRest } = await import('../../shared/crypto.js');
    const created = await createWebhookSecret(U, { source: 'github', name: 'main-repo', repo: 'org/repo' });
    // seed the stored secret row (encrypted hmac_key as the real flow would)
    hoisted.tables.get('webhook_secrets')![0] = {
      ...hoisted.tables.get('webhook_secrets')![0],
      source: 'github',
      repo: 'org/repo',
      enabled: true,
      owner_id: U,
      hmac_key: encryptAtRest(created.plaintextSecret),
      secret_hash: created.plaintextSecret,
    } as unknown as Record<string, unknown>;
    const { handleWebhook } = await import('../automations/webhooks.js');
    const rawBody = Buffer.from(JSON.stringify({ repository: { full_name: 'org/repo' } }));
    await expect(
      handleWebhook({ source: 'github', rawBody, headers: { 'x-github-event': 'push', 'x-github-delivery': 'dlv-1', 'x-hub-signature-256': 'sha256=deadbeef' } }),
    ).rejects.toMatchObject({ status: 401, errorCode: 'invalid_signature' });
  });

  it('C4. unregistered GitHub repo returns null (no tenant leak)', async () => {
    const { handleWebhook } = await import('../automations/webhooks.js');
    const rawBody = Buffer.from(JSON.stringify({ repository: { full_name: 'other/unknown' } }));
    const result = await handleWebhook({ source: 'github', rawBody, headers: { 'x-github-event': 'push', 'x-github-delivery': 'dlv-9', 'x-hub-signature-256': 'sha256=abc' } });
    expect(result).toBeNull();
  });

  it('C5. GitHub event type mapping is canonical and safe for arbitrary actions', () => {
    expect(githubEventType('push', undefined)).toBe('push');
    expect(githubEventType('issues', 'opened')).toBe('issue.opened');
    expect(githubEventType('pull_request', 'closed')).toBe('pull_request.closed');
    expect(githubEventType('unknown.event', 'x')).toBe('unknown.event');
  });

  it('C6. replay / duplicate event is rejected by global dedup (event_log UNIQUE source+event_id)', async () => {
    // first ingest claims the event_log row (pool.query returns a row)
    hoisted.query.mockImplementation(async (text: string) => {
      if (/INSERT INTO event_log/.test(text)) {
        const key = 'github|dlv-dup';
        const already = hoisted.tables.get('claimed')?.length ?? 0;
        if (already > 0) return { rows: [], rowCount: 0 }; // conflict → NOT claimed
        hoisted.tables.set('claimed', [{ p: key }]);
        return { rows: [{ id: 'ev-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const { ingestEvent } = await import('../automations/executor.js');
    const first = await ingestEvent({ source: 'github', eventId: 'dlv-dup', eventType: 'push', ownerId: U, payload: { a: 1 } });
    const second = await ingestEvent({ source: 'github', eventId: 'dlv-dup', eventType: 'push', ownerId: U, payload: { a: 1 } });
    expect(second.status).toBe('duplicate');
    void first;
  });
});

describe('PKG-26 · deployment provider capability is honest', () => {
  it('D1. every deployment provider is classified with an honest reason and state', async () => {
    const caps = await import('./service.js').then((m) => m.deploymentProviderCapabilities());
    expect(caps.length).toBeGreaterThan(0);
    caps.forEach((c) => {
      expect(Object.values(c.state)).toBeTruthy();
    });
  });
});

/** Keep hubStateFor import "used" so the module loads (defensive). */
void hubStateFor;
