/**
 * Phase 10 contract suite — plugins + external integrations + isolation.
 * Covers: plugin core (registration/connect/disconnect/reauthorize/states),
 * permissions (allowed/denied/revoked/tenant isolation), security (secrets
 * never exposed, arbitrary URLs rejected, policy + approval cannot bypass
 * scope), health (healthy/degraded/failed/recovery + notifications), retry
 * (timeout/backoff/circuit open/half-open/recovery), GitHub, Google
 * (OAuth reuse, scope enforcement, token protection), Resend, webhook/API,
 * approval integration, and coworker typed tool requests.
 * Providers are mocked at the fetch boundary only — adapters are the real
 * implementation.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

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
    queryOne: async (text: string, params: unknown[] = []) => {
      state.calls.push({ text, params });
      const rows = state.resolve ? state.resolve(text, params) : null;
      return (rows ?? state.rows)[0] ?? null;
    },
    queryMany: async (text: string, params: unknown[] = []) => {
      state.calls.push({ text, params });
      const rows = state.resolve ? state.resolve(text, params) : null;
      return rows ?? state.rows;
    },
    withTenant: async (_userId: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { encryptAtRest } from '../shared/crypto.js';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import {
  connectPlugin,
  disconnectPlugin,
  reauthorizePlugin,
  updateConnectionScopes,
  listPluginScopes,
  sweepPluginHealth,
  revokePlugin,
  getConnection,
  transitionConnectionState,
} from '../modules/plugins/health.js';
import {
  executePluginAction,
  healthCheckPlugin,
  beginPluginOAuth,
  completePluginOAuth,
  pluginOAuthStateToken,
  verifyPluginOAuthState,
  isPluginOAuthState,
  consecutivePluginFailures,
  resetHealthTrackers,
} from '../modules/plugins/engine.js';
import {
  storePluginCredential,
  readPluginCredentials,
  credentialKinds,
  revokePluginCredentials,
} from '../modules/plugins/credentials.js';
import { getAction, listAdapters, registerAdapter, type PluginAdapter } from '../modules/plugins/sdk.js';
import { registerPlugins } from '../modules/plugins/index.js';
import { registerWebhookHosts, resetWebhookAllowlist, webhookHostAllowed } from '../modules/plugins/adapters/webhook.js';
import { webhookAdapter } from '../modules/plugins/adapters/webhook.js';
import { githubAdapter } from '../modules/plugins/adapters/github.js';
import { googleAdapter } from '../modules/plugins/adapters/google.js';
import { resendAdapter } from '../modules/plugins/adapters/resend.js';
import {
  withRetry,
  ProviderTimeoutError,
  checkCircuit,
  circuitState,
  recordCircuitFailure,
  recordCircuitSuccess,
  resetCircuits,
  checkRateLimit,
  resetRateLimiters,
} from '../modules/plugins/circuit.js';
import { runRegisteredTool, registerTool, listRegisteredTools } from '../modules/execution/toolcalls.js';
import { proposeApproval, executeApprovedAction } from '../modules/execution/approvals.js';
import { proposeToolCall } from '../modules/execution/toolcalls.js';
import { evaluateToolCall } from '../modules/execution/policy.js';
import { AuditAction as ExecutionAuditAction } from '../modules/execution/policy-shared.js';
import { ApprovalActionType, AuditAction, NotificationType } from '@codeconclave/shared';

const OWNER = 'usr_alice';
const OTHER = 'usr_bob';

interface TestConnection {
  id: string;
  owner_id: string;
  plugin_type: string;
  name: string;
  state: string;
  scopes: string[];
  credential_ref: string | null;
  last_health_check_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

let conn: TestConnection;
let insertedConn: Record<string, unknown> | null;
let scopeRows: { id: string; connection_id: string; scope: string; granted_at: Date; expires_at: Date | null; revoked_at: Date | null }[];
let credRows: { id: string; connection_id: string; kind: string; value_encrypted: string; created_at: Date; updated_at: Date; revoked_at: Date | null }[];
let approvalRow: Record<string, unknown> | null;
let toolCallRow: Record<string, unknown> | null;
let globalFetch: ReturnType<typeof vi.fn>;

const nowIso = () => new Date().toISOString();

function makeConn(overrides: Partial<TestConnection> = {}): TestConnection {
  return {
    id: 'plg_1',
    owner_id: OWNER,
    plugin_type: 'github',
    name: 'GitHub',
    state: 'CONNECTED',
    scopes: [],
    credential_ref: null,
    last_health_check_at: new Date(),
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function cred(kind: string, value: string) {
  return {
    id: `plg_cred_${kind}`,
    connection_id: conn.id,
    kind,
    value_encrypted: encryptAtRest(value),
    created_at: new Date(),
    updated_at: new Date(),
    revoked_at: null,
  };
}

function approveRow(status = 'APPROVED') {
  return {
    id: 'app_1',
    task_id: null,
    owner_id: OWNER,
    detail: {},
    risk_level: 'MEDIUM',
    status,
    decision: status === 'APPROVED' ? 'APPROVE' : null,
    decided_by: OWNER,
    decided_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    action_type: ApprovalActionType.PLUGIN_ACTION,
    coworker: null,
    model: null,
    justification: 'test',
    affected_resources: [{ type: 'plugin', ref: conn.id, detail: null }],
    proposed_action: { connectionId: conn.id, action: 'repositories.list', input: {} },
    execution_status: null,
    execution_started_at: null,
    execution_completed_at: null,
    execution_result: null,
    audit_reference: null,
    batch_group: null,
  };
}

function installResolver() {
  db.state.resolve = (text: string, params: unknown[]) => {
    if (text.includes('INSERT INTO plugin_connections')) {
      insertedConn = {
        id: String(params[0]),
        owner_id: String(params[1]),
        plugin_type: String(params[2]),
        name: String(params[3]),
        state: String(params[4]),
        credential_ref: (params[5] as string | null) ?? null,
        scopes: [],
        last_health_check_at: new Date(),
        last_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      return [];
    }
    if (text.includes('UPDATE plugin_connections')) {
      const stateMatch = /SET state\s*=\s*'([A-Z_]+)'/.exec(text);
      const to = params[1] != null ? String(params[1]) : (stateMatch ? stateMatch[1] : '');
      if (conn) {
        conn.state = to;
        if (text.includes('credential_ref')) conn.credential_ref = null;
        if (text.includes('scopes = $2') && params[1]) {
          try {
            conn.scopes = JSON.parse(String(params[1]));
          } catch {
            /* keep */
          }
        }
      }
      return [];
    }
    if (text.includes('INSERT INTO plugin_scopes')) {
      scopeRows.push({
        id: String(params[0]),
        connection_id: String(params[1]),
        scope: String(params[2]),
        granted_at: new Date(),
        expires_at: null,
        revoked_at: null,
      });
      return [];
    }
    if (text.includes('INSERT INTO plugin_credentials')) {
      credRows.push({
        id: String(params[0]),
        connection_id: String(params[1]),
        kind: String(params[2]),
        value_encrypted: String(params[3]),
        created_at: new Date(),
        updated_at: new Date(),
        revoked_at: null,
      });
      return [];
    }
    if (text.includes('INSERT INTO approvals')) {
      approvalRow = {
        id: String(params[0]),
        task_id: params[1] == null ? null : String(params[1]),
        owner_id: String(params[2]),
        detail: safeJson(String(params[3])),
        risk_level: params[4] as string,
        status: 'PENDING',
        decision: null,
        decided_by: null,
        decided_at: null,
        expires_at: new Date(Date.now() + Number(params[5])),
        created_at: new Date(),
        action_type: params[6] as string,
        coworker: params[7] ?? null,
        model: params[8] ?? null,
        justification: params[9] ?? null,
        affected_resources: safeJson(String(params[10])),
        proposed_action: safeJson(String(params[11])),
        execution_status: null,
        execution_started_at: null,
        execution_completed_at: null,
        execution_result: null,
        audit_reference: null,
        batch_group: params[12] ?? null,
      };
      return [];
    }
    if (text.includes('UPDATE approvals')) {
      const statusMatch = /SET status = '(\w+)'/.exec(text);
      const execMatch = /execution_status = '(\w+)'/.exec(text);
      if (approvalRow) {
        if (statusMatch) approvalRow.status = statusMatch[1];
        if (execMatch) approvalRow.execution_status = execMatch[1];
      }
      return [];
    }
    if (text.includes('FROM plugin_connections')) {
      if (text.includes('AND plugin_type')) return conn ? [conn] : [];
      if (params.length === 2 && params[1] !== OWNER) return [];
      if (params.length === 1) return insertedConn ? [insertedConn] : conn ? [conn] : [];
      return conn ? [conn] : [];
    }
    if (text.includes('FROM plugin_scopes')) return scopeRows;
    if (text.includes('FROM plugin_credentials')) return credRows;
    if (text.includes('FROM approvals')) return approvalRow ? [approvalRow] : [];
    if (text.includes('FROM tool_calls')) return toolCallRow ? [toolCallRow] : [];
    return null;
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 1;
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
  conn = makeConn();
  insertedConn = null;
  scopeRows = [];
  credRows = [];
  approvalRow = null;
  toolCallRow = null;
  resetHealthTrackers();
  resetWebhookAllowlist();
  installResolver();
  globalFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('plugin core', () => {
  it('registers the Phase 10 + Stage 25.5 adapters through the SDK', () => {
    registerPlugins();
    const ids = listAdapters().map((a) => a.id).sort();
    expect(ids).toEqual(['cloudflare', 'discord', 'github', 'google', 'linear', 'resend', 'sentry', 'slack', 'vercel', 'webhook']);
    expect(getAction('github', 'repositories.list')).not.toBeNull();
    expect(getAction('github', 'not.real')).toBeNull();
    expect(getAction('nope', 'x')).toBeNull();
  });

  it('connects a plugin without credentials → CONNECTING (no fake CONNECTED)', async () => {
    conn = null as unknown as TestConnection;
    const row = await connectPlugin(OWNER, 'github' as never, 'GitHub');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO plugin_connections'))!;
    expect(insert.params).toEqual([row.id, OWNER, 'github', 'GitHub', 'CONNECTING', null]);
    expect(row.state).toBe('CONNECTING');
  });

  it('duplicate connection conflicts', async () => {
    conn = makeConn();
    await expect(connectPlugin(OWNER, 'github' as never, 'GitHub')).rejects.toMatchObject({ errorCode: 'plugin_connected' });
  });

  it('disconnect → DISCONNECTED (soft; credentials kept); revoke → REVOKED + scopes revoked', async () => {
    conn = makeConn({ state: 'CONNECTED' });
    credRows = [cred('token', 'tok')];
    await disconnectPlugin(OWNER, conn.id);
    expect(conn.state).toBe('DISCONNECTED');
    await revokePlugin(OWNER, conn.id);
    expect(conn.state).toBe('REVOKED');
    expect(conn.credential_ref).toBeNull();
    const revokeCalls = db.state.calls.filter((c) => c.text.includes('UPDATE plugin_scopes'));
    expect(revokeCalls.length).toBeGreaterThan(0);
  });

  it('reauthorize: OAuth adapters return an authUrl and enter REAUTH_REQUIRED', async () => {
    conn = makeConn({ plugin_type: 'google', state: 'FAILED' });
    const result = await reauthorizePlugin(OWNER, conn.id, () => 'https://accounts.google.com/o/oauth2/v2/auth?state=x');
    expect(result.authUrl).toBeTruthy();
    expect(conn.state).toBe('REAUTH_REQUIRED');
  });

  it('reauthorize: token adapters verify stored credentials and return to CONNECTING', async () => {
    conn = makeConn({ state: 'FAILED' });
    credRows = [cred('token', 'tok')];
    const result = await reauthorizePlugin(OWNER, conn.id);
    expect(result.authUrl).toBeUndefined();
    expect(conn.state).toBe('CONNECTING');
  });

  it('sweep marks stale CONNECTED/DEGRADED/REAUTH_REQUIRED connections ERROR (honest)', async () => {
    const n = await sweepPluginHealth();
    expect(n).toBe(1);
    const update = db.state.calls.find((c) => c.text.includes('health_check_timeout'))!;
    expect(update.text).toContain("state IN ('CONNECTING','CONNECTED','DEGRADED','REAUTH_REQUIRED')");
  });
});

describe('permissions', () => {
  it('allowed scope executes the action', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 'ghp_test')];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ id: 1, full_name: 'a/b' }) }));
    const outcome = await executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.get', input: { owner: 'a', repo: 'b' } });
    expect(outcome.ok).toBe(true);
    expect(outcome.data).toMatchObject({ full_name: 'a/b' });
    const audit = recordAudit.mock.calls.map((c) => c[0]).find((a) => a.action === AuditAction.PLUGIN_ACTION_PERFORMED);
    expect(audit.detail).toMatchObject({ pluginType: 'github', action: 'repositories.get', ok: true });
    expect(JSON.stringify(audit.detail)).not.toContain('ghp_test');
  });

  it('denied scope → plugin_scope_denied', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'send', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'plugin_scope_denied', status: 403 });
  });

  it('revoked scope → denied (no active grant remains)', async () => {
    conn = makeConn();
    scopeRows = [];
    credRows = [cred('token', 't')];
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'plugin_scope_denied' });
  });

  it('admin scope covers any action', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'admin', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => [] }));
    const outcome = await executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} });
    expect(outcome.ok).toBe(true);
  });

  it('tenant isolation: another user cannot touch the connection', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    await expect(getConnection(OTHER, conn.id)).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(
      executePluginAction({ userId: OTHER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('scope update replaces grants and is audited', async () => {
    conn = makeConn();
    const scopes = await updateConnectionScopes(OWNER, conn.id, ['read', 'write']);
    expect(scopes).toEqual(['read', 'write']);
    expect(conn.scopes).toEqual(['read', 'write']);
    const rows = await listPluginScopes(conn.id);
    expect(rows.map((r) => r.scope)).toEqual(['read', 'write']);
    expect(recordAudit.mock.calls.map((c) => c[0]).some((a) => a.action === AuditAction.PLUGIN_SCOPE_CHANGED)).toBe(true);
  });

  it('invalid scope rejected', async () => {
    conn = makeConn();
    await expect(updateConnectionScopes(OWNER, conn.id, ['sudo'])).rejects.toMatchObject({ errorCode: 'invalid_plugin_scope' });
  });
});

describe('security', () => {
  it('credential values are never returned through normal API surfaces', async () => {
    conn = makeConn();
    credRows = [cred('token', 'SUPERSECRET'), cred('refresh_token', 'REFRESHSECRET')];
    const kinds = await credentialKinds(conn.id);
    expect(kinds).toEqual(expect.arrayContaining(['token', 'refresh_token']));
    expect(kinds.join(',')).not.toContain('SUPERSECRET');
    const creds = await readPluginCredentials(conn.id);
    expect(creds.kinds['token']).toBe('SUPERSECRET');
    const connRow = await getConnection(OWNER, conn.id);
    expect(JSON.stringify(connRow)).not.toContain('SUPERSECRET');
  });

  it('revoking credentials makes them unreadable', async () => {
    conn = makeConn();
    credRows = [cred('token', 't')];
    await revokePluginCredentials(conn.id);
    credRows = [];
    const creds = await readPluginCredentials(conn.id);
    expect(creds.kinds).toEqual({});
  });

  it('arbitrary webhook URLs are rejected (allowlist)', () => {
    registerWebhookHosts(['api.example.com']);
    expect(webhookHostAllowed('https://api.example.com/v1/x')).toBe(true);
    expect(webhookHostAllowed('https://evil.example.net/x')).toBe(false);
    expect(webhookHostAllowed('ftp://api.example.com/x')).toBe(false);
    expect(webhookHostAllowed('https://localhost/x')).toBe(false);
    expect(webhookHostAllowed('not a url')).toBe(false);
  });

  it('webhook action to a non-allowlisted host → plugin_url_not_allowed', async () => {
    conn = makeConn({ plugin_type: 'webhook' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'write', granted_at: new Date(), expires_at: null, revoked_at: null }];
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'http.request', input: { url: 'https://evil.com/x', method: 'POST', body: {} } }),
    ).rejects.toMatchObject({ errorCode: 'plugin_url_not_allowed', status: 403 });
  });

  it('non-CONNECTED states never execute', async () => {
    for (const state of ['FAILED', 'REAUTH_REQUIRED', 'DISCONNECTED', 'ERROR', 'REVOKED', 'CONNECTING']) {
      conn = makeConn({ state });
      scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
      credRows = [cred('token', 't')];
      await expect(
        executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
      ).rejects.toMatchObject({ errorCode: state === 'REAUTH_REQUIRED' ? 'plugin_reauth_required' : 'plugin_not_connected' });
    }
  });

  it('typed action schemas reject malformed input', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.get', input: { owner: '' } }),
    ).rejects.toMatchObject({ errorCode: 'plugin_input_invalid' });
  });

  it('unknown actions are rejected before any provider call', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.deleteAll', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'plugin_action_unknown' });
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('health', () => {
  it('healthy connection reports ok and stays CONNECTED', async () => {
    conn = makeConn();
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ login: 'x' }) }));
    const result = await healthCheckPlugin(OWNER, conn.id);
    expect(result.ok).toBe(true);
    expect(result.state).toBe('CONNECTED');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO plugin_health'))).toBe(true);
  });

  it('repeated action failures → DEGRADED with notification', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    for (let i = 0; i < 3; i += 1) {
      await expect(
        executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
      ).rejects.toBeInstanceOf(AppError);
    }
    expect(conn.state).toBe('DEGRADED');
    expect(notify.mock.calls.map((c) => c[1])).toContain(NotificationType.PLUGIN_DEGRADED);
  });

  it('continued failures → FAILED with notification', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    for (let i = 0; i < 5; i += 1) {
      await expect(
        executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
      ).rejects.toBeInstanceOf(AppError);
    }
    expect(conn.state).toBe('FAILED');
    expect(notify.mock.calls.map((c) => c[1])).toContain(NotificationType.PLUGIN_FAILED);
  });

  it('recovery: health check passes after FAILED → CONNECTED with recovery notification', async () => {
    conn = makeConn({ state: 'FAILED', last_error: 'x' });
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ login: 'x' }) }));
    const result = await healthCheckPlugin(OWNER, conn.id);
    expect(result.ok).toBe(true);
    expect(conn.state).toBe('CONNECTED');
    expect(notify.mock.calls.map((c) => c[1])).toContain(NotificationType.PLUGIN_RECOVERED);
  });

  it('a clean action after DEGRADED recovers to CONNECTED', async () => {
    conn = makeConn({ state: 'DEGRADED' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => [] }));
    await executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} });
    expect(conn.state).toBe('CONNECTED');
  });

  it('failure counter is tracked and resettable', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toBeInstanceOf(AppError);
    expect(consecutivePluginFailures(conn.id)).toBe(1);
    resetHealthTrackers();
    expect(consecutivePluginFailures(conn.id)).toBe(0);
  });
});

describe('retry + circuit breaker', () => {
  it('withRetry times out and surfaces ProviderTimeoutError', async () => {
    await expect(
      withRetry(
        () => new Promise<never>(() => undefined),
        { attempts: 1, baseDelayMs: 1, timeoutMs: 20, idempotent: true },
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('idempotent actions retry with exponential backoff until success', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('boom');
        return { ok: true };
      },
      { attempts: 3, baseDelayMs: 5, timeoutMs: 500, idempotent: true },
    );
    expect(calls).toBe(2);
    expect(result).toEqual({ ok: true });
  });

  it('non-idempotent actions are never retried', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { attempts: 4, baseDelayMs: 1, timeoutMs: 500, idempotent: false },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('engine only retries idempotent actions (2 attempts, not 3+)', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'plugin_provider_error' });
    const fetches = globalFetch.mock.calls.length;
    expect(fetches).toBe(2);
  });

  it('circuit opens after repeated failures and rejects with plugin_circuit_open', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    for (let i = 0; i < 3; i += 1) {
      await expect(
        executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
      ).rejects.toBeInstanceOf(AppError);
    }
    expect(circuitState(conn.id)).toBe('OPEN');
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'plugin_circuit_open', status: 503 });
  });

  it('half-open allows a trial; success closes the circuit', () => {
    vi.useFakeTimers();
    resetCircuits();
    recordCircuitFailure('c1');
    recordCircuitFailure('c1');
    recordCircuitFailure('c1');
    expect(circuitState('c1')).toBe('OPEN');
    vi.setSystemTime(Date.now() + 31_000);
    expect(circuitState('c1')).toBe('HALF_OPEN');
    recordCircuitSuccess('c1');
    expect(circuitState('c1')).toBe('CLOSED');
    vi.useRealTimers();
  });

  it('rate limiter rejects bursts per connection', () => {
    resetRateLimiters();
    for (let i = 0; i < 60; i += 1) {
      checkRateLimit('c1');
    }
    expect(() => checkRateLimit('c1')).toThrow();
    try {
      checkRateLimit('c1');
    } catch (err) {
      expect((err as AppError).errorCode).toBe('plugin_rate_limited');
    }
  });
});

describe('github adapter', () => {
  it('authorized repository access with Bearer token + App version headers', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 'ghp_secret')];
    globalFetch.mockImplementation(async (url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 7, full_name: 'owner/repo' }),
    }));
    const outcome = await executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.get', input: { owner: 'owner', repo: 'repo' } });
    expect(outcome.data).toMatchObject({ full_name: 'owner/repo' });
    const [url, init] = globalFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/repos/owner/repo');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_secret');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('unauthorized repository (401) is rejected and never faked', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 'bad')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) }));
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'github_unauthorized' });
  });

  it('missing repository (404) → not_found (honest)', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }));
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.get', input: { owner: 'a', repo: 'b' } }),
    ).rejects.toMatchObject({ errorCode: 'github_not_found' });
  });

  it('without credentials or App config → credentials_missing (no invented permissions)', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    const savedId = env.GITHUB_APP_ID;
    const savedKey = env.GITHUB_PRIVATE_KEY;
    env.GITHUB_APP_ID = undefined;
    env.GITHUB_PRIVATE_KEY = undefined;
    try {
      await expect(
        executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
      ).rejects.toMatchObject({ errorCode: 'credentials_missing' });
    } finally {
      env.GITHUB_APP_ID = savedId;
      env.GITHUB_PRIVATE_KEY = savedKey;
    }
  });

  it('declares only genuinely implemented capabilities (no webhooks)', () => {
    expect(githubAdapter.capabilities).toEqual(['repositories', 'contents', 'branches', 'issues', 'pull_requests', 'checks']);
    expect(githubAdapter.capabilities).not.toContain('webhooks');
  });
});

describe('google adapter', () => {
  it('OAuth state tokens round-trip and are namespaced (not login states)', () => {
    const token = pluginOAuthStateToken(OWNER, 'plg_9');
    expect(isPluginOAuthState(token)).toBe(true);
    const parsed = verifyPluginOAuthState(token);
    expect(parsed).toEqual({ userId: OWNER, connectionId: 'plg_9' });
    expect(isPluginOAuthState('garbage')).toBe(false);
  });

  it('beginPluginOAuth refuses when the Google client is not configured (honest)', async () => {
    conn = makeConn({ plugin_type: 'google' });
    const savedId = env.GOOGLE_CLIENT_ID;
    const savedSecret = env.GOOGLE_CLIENT_SECRET;
    env.GOOGLE_CLIENT_ID = undefined;
    env.GOOGLE_CLIENT_SECRET = undefined;
    try {
      await expect(beginPluginOAuth(OWNER, conn.id)).rejects.toMatchObject({ errorCode: 'google_not_configured' });
    } finally {
      env.GOOGLE_CLIENT_ID = savedId;
      env.GOOGLE_CLIENT_SECRET = savedSecret;
    }
  });

  it('token-based plugins cannot use the OAuth flow', async () => {
    conn = makeConn();
    await expect(beginPluginOAuth(OWNER, conn.id)).rejects.toMatchObject({ errorCode: 'oauth_not_required' });
  });

  it('completePluginOAuth stores encrypted tokens + scopes and connects', async () => {
    conn = makeConn({ plugin_type: 'google', state: 'CONNECTING' });
    globalFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at_1', refresh_token: 'rt_1', scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive.file' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const token = pluginOAuthStateToken(OWNER, conn.id);
    const result = await completePluginOAuth('code123', token);
    expect(result).toEqual({ userId: OWNER, connectionId: conn.id });
    expect(conn.state).toBe('CONNECTED');
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO plugin_credentials'));
    expect(inserts.length).toBe(3);
    const refresh = inserts.find((c) => c.params[2] === 'refresh_token')!;
    expect(String(refresh.params[3])).not.toContain('rt_1'); // encrypted, never plain
    const creds = await readPluginCredentials(conn.id);
    expect(creds.kinds['refresh_token']).toBe('rt_1');
    const granted = JSON.parse(creds.kinds['oauth_scopes']!);
    expect(granted).toContain('https://www.googleapis.com/auth/drive.file');
  });

  it('scope enforcement: action needs an OAuth scope the token lacks → oauth_scope_denied', async () => {
    conn = makeConn({ plugin_type: 'google' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'write', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [
      cred('refresh_token', 'rt'),
      cred('oauth_scopes', JSON.stringify(['https://www.googleapis.com/auth/gmail.send'])),
    ];
    globalFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at' }),
    }));
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'drive.files.create', input: { name: 'x', content: 'hi' } }),
    ).rejects.toMatchObject({ errorCode: 'oauth_scope_denied' });
  });

  it('refresh-token protection: token values never appear in audits or events', async () => {
    conn = makeConn({ plugin_type: 'google' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [
      cred('refresh_token', 'SUPER_REFRESH_TOKEN'),
      cred('oauth_scopes', JSON.stringify(['https://www.googleapis.com/auth/gmail.send'])),
    ];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', messages: [] }) }));
    const outcome = await executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'gmail.messages.list', input: { maxResults: 5 } });
    expect(outcome.ok).toBe(true);
    const allSerialized = JSON.stringify({ audits: recordAudit.mock.calls, events: db.state.calls });
    expect(allSerialized).not.toContain('SUPER_REFRESH_TOKEN');
  });

  it('adapter declares the four enabled APIs only', () => {
    expect(googleAdapter.capabilities.sort()).toEqual(['calendar', 'drive', 'gmail', 'sheets']);
  });
});

describe('resend adapter', () => {
  it('send path returns the provider id', async () => {
    conn = makeConn({ plugin_type: 'resend' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'send', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('api_key', 're_key')];
    globalFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain('api.resend.com/emails');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer re_key');
      return { ok: true, status: 200, json: async () => ({ id: 're_123' }) };
    });
    const outcome = await executePluginAction({
      userId: OWNER,
      connectionId: conn.id,
      action: 'email.send',
      input: { to: ['a@b.c'], subject: 'Hi', html: '<p>hi</p>' },
    });
    expect(outcome.data).toEqual({ id: 're_123' });
  });

  it('failure path → resend_send_failed (never faked as delivered)', async () => {
    conn = makeConn({ plugin_type: 'resend' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'send', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('api_key', 're_key')];
    globalFetch.mockImplementation(async () => ({ ok: false, status: 422, json: async () => ({}) }));
    await expect(
      executePluginAction({
        userId: OWNER,
        connectionId: conn.id,
        action: 'email.send',
        input: { to: ['a@b.c'], subject: 'Hi', html: '<p>hi</p>' },
      }),
    ).rejects.toMatchObject({ errorCode: 'resend_send_failed' });
  });

  it('missing API key → credentials_missing', async () => {
    conn = makeConn({ plugin_type: 'resend' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'send', granted_at: new Date(), expires_at: null, revoked_at: null }];
    const savedKey = env.RESEND_API_KEY;
    env.RESEND_API_KEY = undefined;
    try {
      await expect(
        executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'email.send', input: { to: ['a@b.c'], subject: 'x', html: 'x' } }),
      ).rejects.toMatchObject({ errorCode: 'credentials_missing' });
    } finally {
      env.RESEND_API_KEY = savedKey;
    }
  });
});

describe('webhook/API adapter', () => {
  it('allowlisted destination executes and validates the response', async () => {
    conn = makeConn({ plugin_type: 'webhook' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'write', granted_at: new Date(), expires_at: null, revoked_at: null }];
    registerWebhookHosts(['api.example.com']);
    globalFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.example.com/v1/hook');
      expect(JSON.parse(String(init?.body))).toEqual({ event: 'x' });
      return { ok: true, status: 200, text: async () => JSON.stringify({ received: true }), json: async () => ({ received: true }) };
    });
    const outcome = await executePluginAction({
      userId: OWNER,
      connectionId: conn.id,
      action: 'http.request',
      input: { url: 'https://api.example.com/v1/hook', method: 'POST', body: { event: 'x' } },
    });
    expect(outcome.data).toMatchObject({ status: 200, body: { received: true } });
  });

  it('headers come from secure credentials (never from arbitrary input only)', async () => {
    conn = makeConn({ plugin_type: 'webhook' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'write', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 'hook_secret')];
    registerWebhookHosts(['api.example.com']);
    globalFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer hook_secret');
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    });
    await executePluginAction({
      userId: OWNER,
      connectionId: conn.id,
      action: 'http.request',
      input: { url: 'https://api.example.com/v1/hook', method: 'GET' },
    });
  });

  it('non-2xx response → webhook_response_rejected', async () => {
    conn = makeConn({ plugin_type: 'webhook' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'write', granted_at: new Date(), expires_at: null, revoked_at: null }];
    registerWebhookHosts(['api.example.com']);
    globalFetch.mockImplementation(async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }));
    await expect(
      executePluginAction({
        userId: OWNER,
        connectionId: conn.id,
        action: 'http.request',
        input: { url: 'https://api.example.com/v1/hook', method: 'POST', body: {} },
      }),
    ).rejects.toMatchObject({ errorCode: 'webhook_response_rejected' });
  });

  it('timeout is enforced for webhook calls', async () => {
    conn = makeConn({ plugin_type: 'webhook' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'write', granted_at: new Date(), expires_at: null, revoked_at: null }];
    registerWebhookHosts(['api.example.com']);
    globalFetch.mockImplementation(() => new Promise<never>(() => undefined));
    await expect(
      executePluginAction({
        userId: OWNER,
        connectionId: conn.id,
        action: 'http.request',
        input: { url: 'https://api.example.com/v1/slow', method: 'GET', timeoutMs: 100 },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('result validation rejects non-object payloads', () => {
    expect(webhookAdapter.validateResponse({ status: 200 })).toBe(true);
    expect(webhookAdapter.validateResponse(null)).toBe(false);
  });
});

describe('approval integration', () => {
  it('HIGH-risk plugin actions propose an approval (never auto-execute)', async () => {
    conn = makeConn({ plugin_type: 'resend' });
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'send', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('api_key', 'k')];
    const decision = evaluateToolCall({ tool: 'plugin_action', input: { pluginType: 'resend', action: 'email.send' }, userId: OWNER });
    expect(decision).toMatchObject({ allowed: true, requiresApproval: true });
    approvalRow = null;
    const proposed = await proposeApproval(OWNER, {
      actionType: ApprovalActionType.PLUGIN_ACTION,
      justification: 'send email',
      affectedResources: [{ type: 'plugin', ref: conn.id, detail: 'email.send' }],
      proposedAction: { connectionId: conn.id, action: 'email.send', input: { to: ['a@b.c'], subject: 'x', html: 'x' } },
    });
    expect(proposed.approval?.status).toBe('PENDING');
    expect(proposed.autoApproved).toBe(false);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[6]).toBe(ApprovalActionType.PLUGIN_ACTION);
  });

  it('approved execution runs the plugin tool and records SUCCEEDED', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    approvalRow = approveRow('APPROVED');
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ id: 1 }) }));
    const result = await executeApprovedAction(OWNER, 'app_1', {
      tool: 'plugin_action',
      input: { connectionId: conn.id, action: 'repositories.get', input: { owner: 'a', repo: 'b' }, path: conn.id },
    });
    expect(result.execution_status).toBe('SUCCEEDED');
    expect(recordAudit.mock.calls.map((c) => c[0]).some((a) => a.action === AuditAction.APPROVAL_EXECUTION_SUCCEEDED)).toBe(true);
  });

  it('rejected approval cannot execute', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    approvalRow = approveRow('REJECTED');
    await expect(
      executeApprovedAction(OWNER, 'app_1', { tool: 'plugin_action', input: { connectionId: conn.id, action: 'repositories.list', input: {}, path: conn.id } }),
    ).rejects.toMatchObject({ errorCode: 'approval_not_approved' });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('expired approval cannot execute', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    approvalRow = { ...approveRow('APPROVED'), expires_at: new Date(Date.now() - 1000) };
    await expect(
      executeApprovedAction(OWNER, 'app_1', { tool: 'plugin_action', input: { connectionId: conn.id, action: 'repositories.list', input: {}, path: conn.id } }),
    ).rejects.toMatchObject({ errorCode: 'approval_expired' });
  });

  it('approval cannot bypass plugin scope: revoked scope → FAILED execution', async () => {
    conn = makeConn();
    scopeRows = [];
    credRows = [cred('token', 't')];
    approvalRow = approveRow('APPROVED');
    const result = await executeApprovedAction(OWNER, 'app_1', {
      tool: 'plugin_action',
      input: { connectionId: conn.id, action: 'repositories.list', input: {}, path: conn.id },
    });
    expect(result.execution_status).toBe('FAILED');
    expect(recordAudit.mock.calls.map((c) => c[0]).some((a) => a.action === AuditAction.APPROVAL_EXECUTION_FAILED)).toBe(true);
  });

  it('approval for a different connection cannot execute (resource mismatch)', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    approvalRow = { ...approveRow('APPROVED'), affected_resources: [{ type: 'plugin', ref: 'plg_other', detail: null }] };
    await expect(
      executeApprovedAction(OWNER, 'app_1', { tool: 'plugin_action', input: { connectionId: conn.id, action: 'repositories.list', input: {}, path: conn.id } }),
    ).rejects.toMatchObject({ errorCode: 'approval_resource_mismatch' });
  });
});

describe('coworker / tool-call integration', () => {
  it('typed plugin tool request: policy gate + approval linkage + audit', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    approvalRow = { ...approveRow('PENDING'), id: 'app_cow' };
    toolCallRow = {
      id: 'tlc_1',
      task_id: 'tsk_1',
      step_id: null,
      tool_name: 'plugin_action',
      input: { connectionId: conn.id, action: 'repositories.list', input: {} },
      output: null,
      risk_level: 'MEDIUM',
      status: 'PROPOSED',
      approval_id: 'app_cow',
      started_at: null,
      completed_at: null,
    };
    const result = await proposeToolCall({
      taskId: 'tsk_1',
      stepId: null,
      ownerId: OWNER,
      toolName: 'plugin_action',
      toolInput: { connectionId: conn.id, action: 'repositories.list', input: {} },
    });
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.requiresApproval).toBe(true);
    expect(result.call.approval_id).toBe('app_cow');
    const audit = recordAudit.mock.calls.map((c) => c[0]).find((a) => a.action === ExecutionAuditAction.EXECUTION_TOOL_CALL);
    expect(audit.detail).toMatchObject({ tool: 'plugin_action' });
  });

  it('plugin_action tool requires an authenticated caller context', async () => {
    registerPlugins();
    expect(listRegisteredTools()).toContain('plugin_action');
    await expect(
      runRegisteredTool('plugin_action', { connectionId: 'plg_1', action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'plugin_caller_unknown' });
  });

  it('plugin_action tool executes through the engine with a caller context', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => [] }));
    const output = await runRegisteredTool(
      'plugin_action',
      { connectionId: conn.id, action: 'repositories.list', input: {} },
      { userId: OWNER },
    );
    expect(output.ok).toBe(true);
    expect(output.action).toBe('repositories.list');
    const audit = recordAudit.mock.calls.map((c) => c[0]).find((a) => a.action === AuditAction.PLUGIN_ACTION_PERFORMED);
    expect(audit).toBeTruthy();
  });

  it('failed provider calls never crash the process — they surface as AppErrors', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => {
      throw new Error('network down');
    });
    await expect(
      executePluginAction({ userId: OWNER, connectionId: conn.id, action: 'repositories.list', input: {} }),
    ).rejects.toMatchObject({ errorCode: 'plugin_provider_error', status: 503 });
  });

  it('state transitions are audited and recorded as events', async () => {
    conn = makeConn();
    await transitionConnectionState(conn.id, 'DEGRADED', { actorUserId: OWNER, lastError: 'x' });
    expect(conn.state).toBe('DEGRADED');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO plugin_events'))).toBe(true);
    expect(recordAudit.mock.calls.map((c) => c[0]).some((a) => a.action === AuditAction.PLUGIN_HEALTH_CHANGED)).toBe(true);
  });
});

describe('provenance', () => {
  it('task/run plugin actions record provenance artifacts (best-effort, never breaking)', async () => {
    conn = makeConn();
    scopeRows = [{ id: 's1', connection_id: conn.id, scope: 'read', granted_at: new Date(), expires_at: null, revoked_at: null }];
    credRows = [cred('token', 't')];
    globalFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => [] }));
    const outcome = await executePluginAction({
      userId: OWNER,
      connectionId: conn.id,
      action: 'repositories.get',
      input: { owner: 'owner', repo: 'repo' },
      taskId: 'tsk_1',
      runId: 'crw_1',
    });
    expect(outcome.ok).toBe(true);
    const event = db.state.calls.find((c) => c.text.includes('INSERT INTO plugin_events'))!;
    const payload = JSON.parse(String(event.params[3]));
    expect(payload).toMatchObject({ action: 'repositories.get', ok: true, resource: 'owner/repo' });
    expect(payload.provider === undefined).toBe(true); // provenance travels via events/artifacts, never as verified facts
  });
});