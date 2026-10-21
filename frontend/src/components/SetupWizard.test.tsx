import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SETUP_ROLES, SetupWizard, isSetupCommand } from './SetupWizard';

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const entry = (slug: string, name: string, installed = false) => ({
  manifest: { slug, name, description: `${name} skills` },
  source: 'catalog',
  installed,
  enabled: installed,
  installedVersion: installed ? '1.0.0' : null,
});

function stubApi() {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.includes('/skill-plugins') && method === 'GET') {
        return json({
          plugins: [entry('coder', 'Coder'), entry('debugger', 'Debugger', true), entry('tester', 'Tester'), entry('reviewer', 'Reviewer'), entry('git-pr', 'Git & PRs'), entry('security', 'Security')],
        });
      }
      if (url.includes('/workspace/preferences')) return json({ prefs: {} });
      return json({ ok: true });
    }),
  );
  return calls;
}

describe('/setup guided setup', () => {
  it('recognises /setup typed alone', () => {
    expect(isSetupCommand('/setup')).toBe(true);
    expect(isSetupCommand('  /SETUP ')).toBe(true);
    expect(isSetupCommand('/setup-codeconclave')).toBe(true);
    expect(isSetupCommand('/setup my repo')).toBe(false);
    expect(isSetupCommand('how do I /setup')).toBe(false);
  });

  it('every role recommends real catalog plugins and starts its try-prompt with a slash command', () => {
    const catalog = new Set(['architect', 'coder', 'security', 'tester', 'performance', 'research', 'docs', 'reviewer', 'planner', 'debugger', 'git-pr', 'release', 'team-handoff', 'safe-workflow']);
    for (const r of SETUP_ROLES) {
      expect(r.plugins.every((p) => catalog.has(p))).toBe(true);
      expect(r.tryPrompt).toMatch(/^\/[a-z-]+ /);
    }
  });

  it('role → installs only the picked plugins → connect → try a skill', async () => {
    const calls = stubApi();
    const onTry = vi.fn();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <SetupWizard onClose={onClose} onTry={onTry} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Developer/ }));
    expect(await screen.findByText('Coder')).toBeInTheDocument();
    // Already-installed plugins are shown as installed and not reinstalled.
    expect(screen.getByText('Installed')).toBeInTheDocument();
    // Untick Tester.
    await userEvent.click(screen.getByRole('checkbox', { name: /Tester/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Install and continue' }));

    expect(await screen.findByText(/Installed: Coder, Reviewer, Git & PRs/)).toBeInTheDocument();
    const installs = calls.filter((c) => c.method === 'POST' && c.url.includes('/install')).map((c) => c.url);
    expect(installs.some((u) => u.includes('/coder/install'))).toBe(true);
    expect(installs.some((u) => u.includes('/tester/install'))).toBe(false);
    expect(installs.some((u) => u.includes('/debugger/install'))).toBe(false);
    // Plugins that are not for this role are never offered.
    expect(installs.some((u) => u.includes('/security/install'))).toBe(false);

    expect(screen.getByRole('link', { name: /Gmail/ })).toHaveAttribute('href', '/plugins');
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await userEvent.click(screen.getByRole('button', { name: 'Try it' }));
    expect(onTry).toHaveBeenCalledWith(expect.stringMatching(/^\/debug /));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes from the header', async () => {
    stubApi();
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <SetupWizard onClose={onClose} onTry={() => undefined} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Close setup' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('/setup when plugins cannot load', () => {
  it('says so and still lets you continue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
    render(
      <MemoryRouter>
        <SetupWizard onClose={() => undefined} onTry={() => undefined} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Developer/ }));
    expect(await screen.findByText(/Couldn't load plugins/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Connect your tools')).toBeInTheDocument();
  });
});
