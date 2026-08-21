/**
 * Stage 25.5 - plugin marketplace / connector-center contract suite.
 * Covers: server-derived health classification (adapter types vs UNSUPPORTED),
 * catalogue search filters, honest integration classification
 * (LIVE/CONFIGURED/NOT_CONFIGURED/BLOCKED/UNSUPPORTED), connect/revoke audit
 * emissions, and adapter registration for the expanded connector set
 * (slack/linear/discord/sentry/vercel/cloudflare). No provider is contacted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: { rows: unknown[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = { rows: [], resolve: null };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : state.rows;
    return { rows: rows ?? [], rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));

import { derivePluginHealthStatus, searchCatalogue, connectPlugin, revokePlugin, listConnections, classifyPluginIntegration } from '../modules/plugins/health.js';
import { getAdapter, listAdapters } from '../modules/plugins/sdk.js';
import { registerPlugins } from '../modules/plugins/index.js';
import { env } from '../config/env.js';
import type { PluginCatalogueRow, PluginConnectionRow } from '../modules/plugins/health.js';

registerPlugins();

const CATALOGUE: PluginCatalogueRow[] = [
  { id: 'plg-c1', plugin_type: 'discord', name: 'Discord', description: 'Send notifications to Discord', category: 'messaging', capabilities: ['notify'], popular: true, enabled: true, required_permissions: ['notify:send'] },
  { id: 'plg-c2', plugin_type: 'sentry', name: 'Sentry', description: 'Error tracking', category: 'observability', capabilities: ['report_error'], popular: false, enabled: true, required_permissions: ['errors:read'] },
  { id: 'plg-c3', plugin_type: 'vercel', name: 'Vercel', description: 'Deployments', category: 'deployment', capabilities: ['deploy'], popular: true, enabled: true, required_permissions: ['deployments:write'] },
  { id: 'plg-c4', plugin_type: 'cloudflare', name: 'Cloudflare', description: 'Edge + Workers', category: 'infrastructure', capabilities: ['manage_workers'], popular: false, enabled: true, required_permissions: ['workers:write'] },
  { id: 'plg-c5', plugin_type: 'notion', name: 'Notion', description: 'Docs', category: 'productivity', capabilities: ['read_docs'], popular: false, enabled: true, required_permissions: [] },
] as PluginCatalogueRow[];

const CONNECTION: PluginConnectionRow = {
  id: 'plg-1',
  owner_id: 'u1',
  plugin_type: 'discord',
  name: 'My Discord',
  state: 'CONNECTED',
  credential_ref: 'cred:1',
  last_error: null,
  last_health_check_at: null,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  db.state.resolve = null;
  db.state.rows = [];
});

describe('HEALTH CLASSIFICATION (server-derived, never client-inferred)', () => {
  it('marks unknown types NOT_CONFIGURED regardless of state', () => {
    expect(derivePluginHealthStatus('notion', 'CONNECTED', null)).toBe('NOT_CONFIGURED');
    expect(derivePluginHealthStatus('vscode', 'CONNECTED', null)).toBe('NOT_CONFIGURED');
  });

  it('maps adapter states to health statuses', () => {
    expect(derivePluginHealthStatus('discord', 'DISCONNECTED', null)).toBe('NOT_CONNECTED');
    expect(derivePluginHealthStatus('sentry', 'CONNECTED', null)).toBe('HEALTHY');
    expect(derivePluginHealthStatus('vercel', 'ERROR', 'boom')).toBe('UNAVAILABLE');
    expect(derivePluginHealthStatus('cloudflare', 'REAUTH_REQUIRED', null)).toBe('REAUTH_REQUIRED');
    expect(derivePluginHealthStatus('slack', 'DEGRADED', null)).toBe('DEGRADED');
  });
});

describe('CATALOGUE SEARCH', () => {
  it('fuzzy search matches name, description, category and capability', async () => {
    db.state.rows = [...CATALOGUE];
    const res = await searchCatalogue('u1', { q: 'error track' });
    expect(res.map((r) => r.plugin_type)).toEqual(['sentry']);
    const byCap = await searchCatalogue('u1', { q: 'deploy' });
    expect(byCap.map((r) => r.plugin_type)).toContain('vercel');
  });

  it('applies category / state / status / popular filters', async () => {
    db.state.rows = [...CATALOGUE];
    const cat = await searchCatalogue('u1', { category: 'deployment' });
    expect(cat.map((r) => r.plugin_type)).toEqual(['vercel']);
    const pop = await searchCatalogue('u1', { popular: 'true' });
    expect(pop.map((r) => r.plugin_type)).toContain('discord');
    expect(pop.map((r) => r.plugin_type)).not.toContain('sentry');
    db.state.rows = [CONNECTION];
    const stateFilter = await searchCatalogue('u1', { state: 'CONNECTED' });
    expect(stateFilter.map((r) => r.plugin_type)).toEqual(['discord']);
  });

  it('adapterAvailable is true for the expanded connector set', async () => {
    db.state.rows = [...CATALOGUE];
    const res = await searchCatalogue('u1', {});
    const discord = res.find((r) => r.plugin_type === 'discord')!;
    expect(discord.adapterAvailable).toBe(true);
    const notion = res.find((r) => r.plugin_type === 'notion')!;
    expect(notion.adapterAvailable).toBe(false);
    expect(notion.integration).toBe('UNSUPPORTED');
  });
});

describe('INTEGRATION CLASSIFICATION (honest LIVE/CONFIGURED/BLOCKED)', () => {
  it('classifies token-path adapters as CONFIGURED when disconnected', () => {
    expect(classifyPluginIntegration('discord', undefined)).toBe('CONFIGURED');
    expect(classifyPluginIntegration('sentry', undefined)).toBe('CONFIGURED');
  });

  it('classifies a healthy connection as LIVE and a broken one as BLOCKED', () => {
    expect(classifyPluginIntegration('vercel', CONNECTION)).toBe('LIVE');
    expect(classifyPluginIntegration('discord', { ...CONNECTION, state: 'FAILED' })).toBe('BLOCKED');
    expect(classifyPluginIntegration('discord', { ...CONNECTION, state: 'REVOKED' })).toBe('BLOCKED');
  });

  it('classifies server-type plugins by actual server configuration (honest)', () => {
    const configured = Boolean(env.GITHUB_APP_ID || env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_SECRET);
    expect(classifyPluginIntegration('github', undefined)).toBe(configured ? 'CONFIGURED' : 'NOT_CONFIGURED');
  });
});

describe('CONNECTION LIFECYCLE + AUDIT', () => {
  it('connectPlugin inserts a CONNECTED row and audits PLUGIN_CONNECTED', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('SELECT * FROM plugin_connections WHERE owner_id')) return [];
      if (text.includes('FROM plugin_connections WHERE id')) return [CONNECTION];
      return null;
    };
    const row = await connectPlugin('u1', 'discord', 'My Discord', 'cred:1');
    expect(row.state).toBe('CONNECTED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.connected', resourceType: 'plugin_connection' }));
  });

  it('connectPlugin rejects a duplicate connection (one per type)', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM plugin_connections WHERE owner_id') ? [CONNECTION] : null);
    await expect(connectPlugin('u1', 'discord', 'Again', 'cred:2')).rejects.toMatchObject({ errorCode: 'plugin_connected' });
  });

  it('connectPlugin rejects unknown plugin types', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM plugin_connections WHERE owner_id') ? [] : null);
    await expect(connectPlugin('u1', 'minecraft' as never, 'x', undefined)).rejects.toMatchObject({ errorCode: 'invalid_plugin_type' });
  });

  it('revokePlugin clears credentials and scopes and audits PLUGIN_REVOKED', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM plugin_connections WHERE id') ? [CONNECTION] : null);
    await revokePlugin('u1', 'plg-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.revoked' }));
  });
});

describe('EXPANDED ADAPTER REGISTRATION (no network)', () => {
  it('registers the 10-connector adapter set', () => {
    const ids = listAdapters().map((a) => a.id).sort();
    expect(ids).toEqual(['cloudflare', 'discord', 'github', 'google', 'linear', 'resend', 'sentry', 'slack', 'vercel', 'webhook']);
  });

  it('the expanded adapters declare real capabilities and typed actions', () => {
    for (const id of ['slack', 'linear', 'discord', 'sentry', 'vercel', 'cloudflare'] as const) {
      const adapter = getAdapter(id);
      expect(adapter).not.toBeNull();
      expect(adapter!.capabilities.length).toBeGreaterThan(0);
      expect(adapter!.actions.length).toBeGreaterThan(0);
      expect(adapter!.id).toBe(id);
    }
  });

  it('getAdapter returns null for unknown types', () => {
    expect(getAdapter('minecraft')).toBeNull();
  });
});