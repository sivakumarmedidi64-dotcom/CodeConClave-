/**
 * Team skill plugins: only owners/admins publish or unpublish, every publish
 * and unpublish writes an attributable version row, and members see team
 * plugins as active (attributed to the team in the skill block).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: { text: string; params: unknown[] }[] = [];
let rowsFor: (text: string) => unknown[] = () => [];

vi.mock('../../shared/db.js', () => ({
  withTenant: async (_userId: string, fn: (q: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        const rows = rowsFor(text);
        return { rows, rowCount: rows.length };
      },
    }),
}));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../teams/service.js', () => ({
  requireTeamRole: vi.fn(),
  teamRoleFor: vi.fn(),
}));

import { AppError } from '../../shared/errors.js';
import { requireTeamRole, teamRoleFor } from '../teams/service.js';
import { activePlugins, listCatalog, publishTeamPlugin, teamPluginVersions, unpublishTeamPlugin } from './service.js';

const manifest = {
  slug: 'release-flow',
  name: 'Release Flow',
  version: '1.2.0',
  description: 'Our approved release workflow',
  author: 'Platform team',
  category: 'team',
  icon: 'rocket',
  commands: [{ name: 'ship', description: 'Run the release checklist', prompt: 'Run our release checklist for $ARGUMENTS' }],
};

beforeEach(() => {
  queries.length = 0;
  rowsFor = () => [];
  vi.mocked(requireTeamRole).mockReset();
  vi.mocked(teamRoleFor).mockReset();
});

describe('publishTeamPlugin', () => {
  it('refuses non-admins before touching the database', async () => {
    vi.mocked(requireTeamRole).mockRejectedValue(AppError.forbidden('insufficient_permission'));
    await expect(publishTeamPlugin('usr_member', 'tm_1', manifest)).rejects.toMatchObject({ status: 403 });
    expect(queries).toHaveLength(0);
  });

  it('upserts the plugin and records a PUBLISHED version for admins', async () => {
    vi.mocked(requireTeamRole).mockResolvedValue('admin' as never);
    rowsFor = (t) => (t.includes('count(*)') ? [{ n: 0 }] : []);
    const saved = await publishTeamPlugin('usr_admin', 'tm_1', manifest);
    expect(saved.slug).toBe('release-flow');
    expect(requireTeamRole).toHaveBeenCalledWith('usr_admin', 'tm_1', ['owner', 'admin']);
    expect(queries.some((q) => q.text.includes('INSERT INTO team_skill_plugins'))).toBe(true);
    const version = queries.find((q) => q.text.includes('INSERT INTO team_skill_plugin_versions'));
    expect(version?.text).toContain("'PUBLISHED'");
    expect(version?.params).toContain('usr_admin');
  });

  it('rejects built-in slugs and invalid manifests', async () => {
    vi.mocked(requireTeamRole).mockResolvedValue('owner' as never);
    await expect(publishTeamPlugin('usr_admin', 'tm_1', { ...manifest, slug: 'reviewer' })).rejects.toMatchObject({ status: 409 });
    await expect(publishTeamPlugin('usr_admin', 'tm_1', { ...manifest, version: 'latest' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('unpublishTeamPlugin', () => {
  it('records an UNPUBLISHED version', async () => {
    vi.mocked(requireTeamRole).mockResolvedValue('admin' as never);
    rowsFor = (t) => (t.startsWith('DELETE FROM team_skill_plugins') ? [{ version: '1.2.0', manifest }] : []);
    await unpublishTeamPlugin('usr_admin', 'tm_1', 'release-flow');
    expect(queries.some((q) => q.text.includes("'UNPUBLISHED'"))).toBe(true);
  });

  it('404s when the plugin is not published', async () => {
    vi.mocked(requireTeamRole).mockResolvedValue('admin' as never);
    await expect(unpublishTeamPlugin('usr_admin', 'tm_1', 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('member view', () => {
  beforeEach(() => {
    rowsFor = (t) =>
      t.includes('FROM team_skill_plugins tsp')
        ? [{ team_id: 'tm_1', team_name: 'Platform', role: 'editor', manifest }]
        : [];
  });

  it('lists team plugins as active, managed by admins', async () => {
    const team = (await listCatalog('usr_member')).find((e) => e.source === 'team');
    expect(team).toMatchObject({ installed: true, enabled: true, team: { id: 'tm_1', name: 'Platform', canManage: false } });
  });

  it('includes team plugins in the active set, attributed to the team', async () => {
    const active = await activePlugins('usr_member');
    expect(active.map((p) => p.name)).toContain('Release Flow (team: Platform)');
  });

  it('version history requires membership', async () => {
    vi.mocked(teamRoleFor).mockResolvedValue(null);
    await expect(teamPluginVersions('usr_outsider', 'tm_1', 'release-flow')).rejects.toMatchObject({ status: 403 });
  });
});
