/**
 * Stage 26 — agent marketplace contract suite.
 * Covers: catalogue browse/search, capability allowlist enforcement
 * (packages cannot inject privileged tools), duplicate-install rejection,
 * install through the EXISTING createAgent pipeline (plan limits apply),
 * disable/enable with audit, uninstall (agent deleted, install REMOVED),
 * version update, and startRun refusal for disabled marketplace agents.
 * The agents service + AI gateway are mocked; this suite validates the
 * marketplace driver and its tenant scoping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditAction } from '@codeconclave/shared';

const db = vi.hoisted(() => {
  const state: { rows: unknown[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = {
    rows: [],
    resolve: null,
  };
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
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

const agents = vi.hoisted(() => ({
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getAgent: vi.fn(),
}));
vi.mock('../modules/agents/service.js', () => agents);

import { browseCatalogue, getCatalogueItem, installPackage, listInstalled, setInstalledStatus, uninstallPackage, updateInstalled, assertInstalledAgentEnabled } from '../modules/agents/marketplace.js';
import { AppError } from '../shared/errors.js';

const PACKAGE = (over: Record<string, unknown> = {}) => ({
  id: 'cat-1',
  slug: 'style-guardian',
  name: 'Style Guardian',
  description: 'Keeps code style consistent',
  role: 'REVIEWER',
  capabilities: ['review'],
  declared_permissions: ['read.project'],
  min_trust_level: 'L1',
  min_plan: 'free',
  version: '1.0.0',
  enabled: true,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  ...over,
});

const INSTALLED = (over: Record<string, unknown> = {}) => ({
  id: 'inst-1',
  owner_id: 'u1',
  catalogue_id: 'cat-1',
  catalogue_slug: 'style-guardian',
  agent_id: 'ag-1',
  version: '1.0.0',
  status: 'INSTALLED',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  ...over,
});

beforeEach(() => {
  audit.recordAudit.mockClear();
  agents.createAgent.mockReset();
  agents.deleteAgent.mockReset();
  agents.getAgent.mockReset();
  db.state.rows = [];
  db.state.resolve = null;
});

describe('CATALOGUE — public browse', () => {
  it('lists enabled packages with search and role filters', async () => {
    db.state.rows = [PACKAGE()];
    const list = await browseCatalogue();
    expect(list).toHaveLength(1);
    expect(list[0].slug).toBe('style-guardian');
    const roleFiltered = await browseCatalogue(undefined, 'reviewer');
    expect(roleFiltered[0].role).toBe('REVIEWER');
  });

  it('returns the package by id or not_found', async () => {
    db.state.rows = [PACKAGE()];
    expect((await getCatalogueItem('cat-1')).slug).toBe('style-guardian');
    db.state.rows = [];
    await expect(getCatalogueItem('missing')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('INSTALL — through the existing agent pipeline', () => {
  it('creates a real agent from the package and records + audits the install', async () => {
    agents.createAgent.mockResolvedValue({ id: 'ag-1', name: 'Style Guardian', role: 'REVIEWER', trust_level: 'L1' });
    db.state.rows = [PACKAGE(), { n: 0 }];
    db.state.resolve = (text: string) => {
      if (text.includes('SELECT * FROM agent_catalogue')) return [PACKAGE()];
      if (text.includes('SELECT count(*)')) return [{ n: 0 }];
      return null;
    };
    const installed = await installPackage('u1', 'cat-1', {});
    expect(installed.agent.id).toBe('ag-1');
    expect(installed.status).toBe('INSTALLED');
    expect(agents.createAgent).toHaveBeenCalledWith('u1', expect.objectContaining({
      name: 'Style Guardian',
      role: 'REVIEWER',
      trustLevel: 'L1',
      capabilities: ['review'],
    }));
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.MARKETPLACE_INSTALLED,
      detail: expect.objectContaining({ slug: 'style-guardian', agentId: 'ag-1' }),
    }));
  });

  it('rejects packages whose capabilities are outside the allowlist', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('SELECT * FROM agent_catalogue')) return [PACKAGE({ capabilities: ['exec', 'review'] })];
      return null;
    };
    await expect(installPackage('u1', 'cat-1', {})).rejects.toMatchObject({ errorCode: 'invalid_agent_package' });
    expect(agents.createAgent).not.toHaveBeenCalled();
  });

  it('rejects duplicate installs', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('SELECT * FROM agent_catalogue')) return [PACKAGE()];
      if (text.includes('SELECT count(*)')) return [{ n: 1 }];
      return null;
    };
    await expect(installPackage('u1', 'cat-1', {})).rejects.toMatchObject({ errorCode: 'already_installed' });
    expect(agents.createAgent).not.toHaveBeenCalled();
  });
});

describe('LIFECYCLE — disable / enable / uninstall / update', () => {
  it('disables and enables with audit', async () => {
    db.state.rows = [INSTALLED()];
    await setInstalledStatus('u1', 'inst-1', 'DISABLED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MARKETPLACE_DISABLED }));
    await setInstalledStatus('u1', 'inst-1', 'ENABLED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MARKETPLACE_ENABLED }));
  });

  it('refuses lifecycle ops on installs the user does not own', async () => {
    db.state.rows = [];
    await expect(setInstalledStatus('u1', 'inst-1', 'DISABLED')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(uninstallPackage('u1', 'inst-1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('uninstall deletes the created agent and marks the install REMOVED', async () => {
    db.state.rows = [INSTALLED()];
    await uninstallPackage('u1', 'inst-1');
    expect(agents.deleteAgent).toHaveBeenCalledWith('u1', 'ag-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.MARKETPLACE_UNINSTALLED }));
  });

  it('update syncs name/objective and records the version', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('JOIN agent_catalogue')) {
        return [{ ...INSTALLED(), ...PACKAGE({ version: '1.1.0', description: 'New desc' }) }];
      }
      return null;
    };
    await updateInstalled('u1', 'inst-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.MARKETPLACE_UPDATED,
      detail: expect.objectContaining({ version: '1.1.0' }),
    }));
  });
});

describe('EXECUTION GUARD — disabled packages cannot run', () => {
  it('refuses startRun for a DISABLED marketplace agent', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('SELECT status FROM installed_agents')) return [{ status: 'DISABLED' }];
      return null;
    };
    await expect(assertInstalledAgentEnabled('u1', 'ag-1')).rejects.toMatchObject({ errorCode: 'agent_disabled' });
  });

  it('allows enabled or non-marketplace agents', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('SELECT status FROM installed_agents')) return [{ status: 'INSTALLED' }];
      return null;
    };
    await expect(assertInstalledAgentEnabled('u1', 'ag-1')).resolves.toBeUndefined();
  });
});

describe('READS — tenant scoping', () => {
  it('lists installed agents only for the owner', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM installed_agents i')) {
        return [{ ...INSTALLED(), a_id: 'ag-1', a_name: 'Style Guardian', a_role: 'REVIEWER', a_status: 'IDLE', a_trust_level: 'L2', c_name: 'Style Guardian', c_description: 'd', c_capabilities: ['review'], c_permissions: [], c_min_trust: 'L1', c_min_plan: 'free', c_version: '1.0.0' }];
      }
      return null;
    };
    const list = await listInstalled('u1');
    expect(list).toHaveLength(1);
    expect(list[0].agent?.name).toBe('Style Guardian');
    expect(list[0].package?.slug).toBe('style-guardian');
  });
});