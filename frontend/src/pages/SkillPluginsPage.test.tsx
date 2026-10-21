/**
 * CodeConClave — Plugin directory tests.
 * Catalog cards with icons, install / enable toggle, detail drawer with
 * skills + slash commands, Installed tab, and custom-manifest validation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { SkillPluginsPage, type SkillPluginEntry } from './SkillPluginsPage';
import { jsonResponse, stubFetch } from '../testutils';

const reviewer: SkillPluginEntry = {
  manifest: {
    slug: 'reviewer',
    name: 'Reviewer',
    version: '1.0.0',
    description: 'Quality-gate code review.',
    author: 'CodeConClave',
    category: 'quality',
    icon: 'eye',
    skills: [{ name: 'Review for correctness first', description: 'Bugs before style.', instructions: 'Report bugs first.' }],
    commands: [{ name: 'review', description: 'Review a diff.', prompt: 'Review: $ARGUMENTS' }],
    connectors: ['github'],
  },
  source: 'builtin',
  installed: false,
  enabled: false,
  installedVersion: null,
};

const docs: SkillPluginEntry = {
  ...reviewer,
  manifest: { ...reviewer.manifest, slug: 'docs', name: 'Docs', category: 'docs', icon: 'book', commands: [{ name: 'readme', description: 'Draft a README.', prompt: 'README for $ARGUMENTS' }] },
  installed: true,
  enabled: true,
  installedVersion: '1.0.0',
};

function renderPage() {
  return render(
    <ToastProvider>
      <SkillPluginsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('SkillPluginsPage', () => {
  it('lists plugins with their commands and installs one', async () => {
    let installed = false;
    const fetchFn = stubFetch(async (url, init) => {
      if (url.endsWith('/api/v1/skill-plugins/reviewer/install') && init?.method === 'POST') {
        installed = true;
        return jsonResponse({ data: { plugin: { ...reviewer, installed: true, enabled: true } } }, 201);
      }
      if (url.endsWith('/api/v1/skill-plugins')) {
        return jsonResponse({ data: { plugins: [installed ? { ...reviewer, installed: true, enabled: true } : reviewer, docs] } });
      }
      return jsonResponse({ data: {} });
    });
    renderPage();

    expect(await screen.findByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText(/1 skill · \/review/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(installed).toBe(true));
    expect(fetchFn.mock.calls.some(([u, i]) => String(u).endsWith('/reviewer/install') && i?.method === 'POST')).toBe(true);
    expect(await screen.findByRole('checkbox', { name: 'Disable Reviewer' })).toBeChecked();
  });

  it('toggles an installed plugin off with PATCH', async () => {
    const fetchFn = stubFetch(async (url) => {
      if (url.endsWith('/api/v1/skill-plugins')) return jsonResponse({ data: { plugins: [docs] } });
      return jsonResponse({ data: { ok: true } });
    });
    renderPage();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Disable Docs' }));
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some(
          ([u, i]) => String(u).endsWith('/api/v1/skill-plugins/docs') && i?.method === 'PATCH' && String(i.body).includes('"enabled":false'),
        ),
      ).toBe(true),
    );
  });

  it('opens a detail drawer showing skills, commands and connectors', async () => {
    stubFetch(async () => jsonResponse({ data: { plugins: [reviewer] } }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Open Reviewer' }));
    const dialog = screen.getByRole('dialog', { name: 'Reviewer' });
    expect(within(dialog).getByText('Review for correctness first')).toBeInTheDocument();
    expect(within(dialog).getByText('/review')).toBeInTheDocument();
    expect(within(dialog).getByText('github')).toBeInTheDocument();
  });

  it('Installed tab shows only installed plugins', async () => {
    stubFetch(async () => jsonResponse({ data: { plugins: [reviewer, docs] } }));
    renderPage();
    await screen.findByText('Reviewer');
    await userEvent.click(screen.getByRole('tab', { name: /Installed/ }));
    expect(screen.queryByRole('button', { name: 'Open Reviewer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Docs' })).toBeInTheDocument();
  });

  it('shows team plugins as team-managed; members cannot unpublish', async () => {
    const teamPlugin: SkillPluginEntry = {
      ...docs,
      manifest: { ...docs.manifest, slug: 'ship', name: 'Ship Flow' },
      source: 'team',
      team: { id: 'tm_1', name: 'Platform', canManage: false },
    };
    stubFetch(async () => jsonResponse({ data: { plugins: [teamPlugin] } }));
    renderPage();
    expect(await screen.findByText('Team · Platform')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Ship Flow' }));
    const dialog = screen.getByRole('dialog', { name: 'Ship Flow' });
    expect(within(dialog).getByText(/Only team owners and admins can change it/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Unpublish' })).not.toBeInTheDocument();
  });

  it('admins publish a plugin to a team they manage', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.endsWith('/api/v1/skill-plugins/teams')) return jsonResponse({ data: { teams: [{ id: 'tm_1', name: 'Platform' }] } });
      if (url.endsWith('/api/v1/skill-plugins/teams/tm_1') && init?.method === 'POST') {
        return jsonResponse({ data: { manifest: { ...docs.manifest, slug: 'my-plugin', name: 'My Plugin' } } }, 201);
      }
      return jsonResponse({ data: { plugins: [] } });
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Create plugin/ }));
    await userEvent.selectOptions(await screen.findByLabelText('Publish to'), 'tm_1');
    await userEvent.click(screen.getByRole('button', { name: 'Publish to team' }));
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([u, i]) => String(u).endsWith('/skill-plugins/teams/tm_1') && i?.method === 'POST')).toBe(true),
    );
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/custom'))).toBe(false);
  });

  it('rejects an invalid manifest before calling the server', async () => {
    const fetchFn = stubFetch(async () => jsonResponse({ data: { plugins: [] } }));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Create plugin/ }));
    const editor = screen.getByLabelText('Plugin manifest JSON');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'not json');
    await userEvent.click(screen.getByRole('button', { name: 'Save and install' }));
    expect(screen.getByText('Manifest is not valid JSON.')).toBeInTheDocument();
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/custom'))).toBe(false);
  });
});
