/**
 * Stage 25.5 contract suite — searchable plugin center.
 * Covers the server-authoritative integration classification
 * (LIVE / CONFIGURED / NOT_CONFIGURED / BLOCKED / UNSUPPORTED), catalogue
 * search + filters, and the derived health status. Never claims a connector
 * is implemented when it is not — classification is deterministic and derived
 * from the real adapter registry, server configuration and connection state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const state: { resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = { resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : [];
    return { rows, rowCount: rows.length };
  };
  return {
    state,
    pool: { query },
    queryOne: async (text: string, params: unknown[] = []) => {
      const rows = state.resolve ? state.resolve(text, params) : [];
      return rows[0] ?? null;
    },
    queryMany: async (text: string, params: unknown[] = []) => {
      const rows = state.resolve ? state.resolve(text, params) : [];
      return rows;
    },
  };
});

vi.mock('../shared/db.js', () => db);

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { env } from '../config/env.js';
import {
  searchCatalogue,
  classifyPluginIntegration,
  pluginServerConfigured,
  derivePluginHealthStatus,
  ADAPTER_IDS,
} from '../modules/plugins/health.js';
import type { PluginConnectionRow } from '../modules/plugins/health.js';

const CATALOGUE_ROWS = [
  { plugin_type: 'github', name: 'GitHub', description: 'Code hosting', capabilities: ['repositories'], enabled: true, category: 'development', popular: true, required_permissions: ['read', 'write'] },
  { plugin_type: 'google', name: 'Google', description: 'Gmail, Drive, Sheets', capabilities: ['gmail'], enabled: true, category: 'productivity', popular: true, required_permissions: ['read', 'write', 'send'] },
  { plugin_type: 'slack', name: 'Slack', description: 'Team chat', capabilities: ['messages'], enabled: true, category: 'communication', popular: true, required_permissions: ['read', 'send'] },
  { plugin_type: 'teams', name: 'Microsoft Teams', description: 'Team chat (adapter required)', capabilities: ['messages'], enabled: true, category: 'communication', popular: false, required_permissions: ['read', 'send'] },
  { plugin_type: 'notion', name: 'Notion', description: 'Docs (adapter required)', capabilities: ['documents'], enabled: true, category: 'productivity', popular: true, required_permissions: ['read', 'write'] },
  { plugin_type: 'jira', name: 'Jira', description: 'Issues (adapter required)', capabilities: ['issues'], enabled: true, category: 'project_management', popular: false, required_permissions: ['read', 'create', 'update'] },
  { plugin_type: 'figma', name: 'Figma', description: 'Design (adapter required)', capabilities: ['design'], enabled: true, category: 'design', popular: false, required_permissions: ['read'] },
  { plugin_type: 'supabase', name: 'Supabase', description: 'Database (adapter required)', capabilities: ['database'], enabled: true, category: 'data', popular: false, required_permissions: ['read', 'write'] },
  { plugin_type: 'render', name: 'Render', description: 'Deployments (adapter required)', capabilities: ['deployments'], enabled: true, category: 'cloud', popular: false, required_permissions: ['read', 'write'] },
  { plugin_type: 'sentry', name: 'Sentry', description: 'Monitoring', capabilities: ['monitoring'], enabled: true, category: 'monitoring', popular: false, required_permissions: ['read'] },
  { plugin_type: 'webhook', name: 'Webhook', description: 'Generic webhooks', capabilities: ['webhook'], enabled: true, category: 'development', popular: false, required_permissions: ['send', 'read'] },
] as Array<Record<string, unknown>>;

function connection(overrides: Partial<PluginConnectionRow>): PluginConnectionRow {
  return {
    id: 'plg_conn_1',
    owner_id: 'usr_alice',
    plugin_type: 'github',
    name: 'GitHub',
    state: 'CONNECTED',
    scopes: ['read'],
    credential_ref: 'enc:ref',
    last_health_check_at: new Date(),
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as PluginConnectionRow;
}

function seed(connections: PluginConnectionRow[]): void {
  db.state.resolve = (text: string) => {
    if (text.includes('FROM plugins')) return CATALOGUE_ROWS;
    if (text.includes('FROM plugin_connections')) return connections;
    return [];
  };
}

beforeEach(() => {
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
});

describe('plugin integration classification (server-authoritative)', () => {
  it('classifies connectors without an adapter as UNSUPPORTED', () => {
    for (const type of ['teams', 'notion', 'jira', 'figma', 'supabase', 'render']) {
      expect(classifyPluginIntegration(type, undefined)).toBe('UNSUPPORTED');
      expect(ADAPTER_IDS).not.toContain(type);
    }
  });

  it('classifies a usable connection as LIVE', () => {
    expect(classifyPluginIntegration('github', connection({ state: 'CONNECTED' }))).toBe('LIVE');
    expect(classifyPluginIntegration('github', connection({ state: 'DEGRADED' }))).toBe('LIVE');
  });

  it('classifies unusable connections as BLOCKED', () => {
    for (const state of ['FAILED', 'ERROR', 'REVOKED', 'REAUTH_REQUIRED']) {
      expect(classifyPluginIntegration('github', connection({ state }))).toBe('BLOCKED');
    }
  });

  it('classifies per-connection-token adapters as CONFIGURED without a connection', () => {
    expect(classifyPluginIntegration('slack', undefined)).toBe('CONFIGURED');
    expect(classifyPluginIntegration('linear', undefined)).toBe('CONFIGURED');
    expect(classifyPluginIntegration('discord', undefined)).toBe('CONFIGURED');
    expect(classifyPluginIntegration('sentry', undefined)).toBe('CONFIGURED');
    expect(classifyPluginIntegration('vercel', undefined)).toBe('CONFIGURED');
    expect(classifyPluginIntegration('cloudflare', undefined)).toBe('CONFIGURED');
  });

  it('classifies server-config adapters from the real deployment env', () => {
    expect(pluginServerConfigured('google')).toBe(Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET));
    expect(pluginServerConfigured('github')).toBe(Boolean(env.GITHUB_APP_ID || env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_SECRET));
    expect(pluginServerConfigured('resend')).toBe(Boolean(env.RESEND_API_KEY));
    expect(pluginServerConfigured('webhook')).toBe(Boolean(env.PLUGIN_WEBHOOK_ALLOWED_HOSTS));
    expect(classifyPluginIntegration('google', undefined)).toBe(pluginServerConfigured('google') ? 'CONFIGURED' : 'NOT_CONFIGURED');
    expect(classifyPluginIntegration('webhook', undefined)).toBe(pluginServerConfigured('webhook') ? 'CONFIGURED' : 'NOT_CONFIGURED');
  });

  it('never shows an unsupported connector as CONFIGURED or LIVE', () => {
    // Even with a phantom connection row, unsupported types stay UNSUPPORTED.
    for (const type of ['teams', 'notion', 'jira', 'figma', 'supabase', 'render']) {
      expect(classifyPluginIntegration(type, connection({ plugin_type: type, state: 'CONNECTED' }))).toBe('UNSUPPORTED');
    }
  });
});

describe('catalogue search and filters', () => {
  it('returns the server-derived status, integration and state for every plugin', async () => {
    seed([connection({ plugin_type: 'github', state: 'CONNECTED' })]);
    const rows = await searchCatalogue('usr_alice', {});
    const byType = new Map(rows.map((r) => [r.plugin_type, r]));
    expect(byType.get('github')?.integration).toBe('LIVE');
    expect(byType.get('github')?.status).toBe('HEALTHY');
    expect(byType.get('github')?.state).toBe('CONNECTED');
    expect(byType.get('teams')?.integration).toBe('UNSUPPORTED');
    expect(byType.get('teams')?.adapterAvailable).toBe(false);
    expect(byType.get('slack')?.adapterAvailable).toBe(true);
  });

  it('filters by query, category, capability, state and popular', async () => {
    seed([]);
    const all = await searchCatalogue('usr_alice', {});
    const q = await searchCatalogue('usr_alice', { q: 'team chat' });
    expect(q.map((r) => r.plugin_type).sort()).toEqual(['slack', 'teams']);
    const cat = await searchCatalogue('usr_alice', { category: 'productivity' });
    expect(cat.map((r) => r.plugin_type).sort()).toEqual(['google', 'notion']);
    const cap = await searchCatalogue('usr_alice', { capability: 'monitoring' });
    expect(cap.map((r) => r.plugin_type)).toEqual(['sentry']);
    const popular = await searchCatalogue('usr_alice', { popular: 'true' });
    expect(popular.map((r) => r.plugin_type).sort()).toEqual(['github', 'google', 'notion', 'slack']);
    expect(all.length).toBe(CATALOGUE_ROWS.length);
  });

  it('filters by connection state and derived status', async () => {
    seed([
      connection({ plugin_type: 'github', state: 'CONNECTED' }),
      connection({ plugin_type: 'slack', state: 'REVOKED', last_error: 'revoked' }),
    ]);
    const live = await searchCatalogue('usr_alice', { state: 'CONNECTED' });
    expect(live.map((r) => r.plugin_type)).toEqual(['github']);
    const blocked = await searchCatalogue('usr_alice', { status: 'UNAVAILABLE' });
    expect(blocked.map((r) => r.plugin_type)).toEqual(['slack']);
    expect(blocked[0]?.integration).toBe('BLOCKED');
  });

  it('derives an honest status for every state combination', () => {
    expect(derivePluginHealthStatus('github', 'CONNECTED', null)).toBe('HEALTHY');
    expect(derivePluginHealthStatus('github', 'DEGRADED', 'flaky')).toBe('DEGRADED');
    expect(derivePluginHealthStatus('github', 'REAUTH_REQUIRED', null)).toBe('REAUTH_REQUIRED');
    expect(derivePluginHealthStatus('github', 'FAILED', 'boom')).toBe('UNAVAILABLE');
    expect(derivePluginHealthStatus('github', 'DISCONNECTED', null)).toBe('NOT_CONNECTED');
    expect(derivePluginHealthStatus('teams', 'DISCONNECTED', null)).toBe('NOT_CONFIGURED');
  });
});