/**
 * CodeConClave — public product entry tests.
 *
 * Covers the approved public-entry contract: no Google/OAuth customer login,
 * no payment pressure during early access, professional product positioning,
 * the web/desktop choice, the expanded About section, and the honest feature
 * showcase (nothing unverified advertised as live).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from './LandingPage';

function jsonResponse(data: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => data } as unknown as Response;
}

function renderLanding() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

describe('LandingPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, available: true, version: '0.1.0', sizeMB: 110 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('product positioning', () => {
    it('leads with the product as an AI developer and founder operating system', () => {
      renderLanding();
      const h1 = screen.getByRole('heading', { level: 1 });
      expect(h1.textContent).toMatch(/CodeConClave/);
      expect(h1.textContent).toMatch(/AI Developer & Founder Operating System/i);
      expect(screen.getByText(/understands your project, executes work, verifies results/i)).toBeDefined();
    });

    it('states the core concepts', () => {
      renderLanding();
      const pillars = screen.getByRole('list', { name: /core concepts/i });
      for (const p of ['Memory', 'Execution', 'Continuity', 'Team', 'Control']) {
        expect(within(pillars).getByText(p)).toBeDefined();
      }
    });

    it('offers the primary entry actions', () => {
      renderLanding();
      const enter = screen.getAllByRole('link', { name: 'Enter CodeConClave' });
      expect(enter.length).toBeGreaterThan(0);
      for (const link of enter) expect(link.getAttribute('href')).toBe('/register');
      expect(screen.getAllByRole('link', { name: 'Explore CodeConClave' })[0]!.getAttribute('href')).toBe('/login');
    });
  });

  describe('early access messaging', () => {
    it('says the product is in early access', () => {
      renderLanding();
      expect(screen.getAllByText(/available in Early Access/i).length).toBeGreaterThan(0);
    });

    it('never exposes internal demo or entitlement terminology', () => {
      const { container } = renderLanding();
      const text = (container.textContent ?? '').replace(/\s+/g, ' ');
      for (const leaked of [
        'TEMPORARY_DEMO_MODE',
        'temporaryDemoMode',
        'testBypass',
        'PAYMENT_TEST_USER_IDS',
        'entitlementState',
        'PRO_VERIFIED',
      ]) {
        expect(text).not.toContain(leaked);
      }
    });

    it('carries no purchase pressure', () => {
      renderLanding();
      for (const cta of [/buy now/i, /subscribe now/i, /^upgrade/i]) {
        expect(screen.queryByRole('link', { name: cta })).toBeNull();
        expect(screen.queryByRole('button', { name: cta })).toBeNull();
      }
      expect(document.body.textContent).not.toMatch(/₹/);
    });
  });

  describe('web / desktop choice', () => {
    it('is presented prominently, directly after the product introduction', () => {
      const { container } = renderLanding();
      expect(screen.getByRole('heading', { name: /Choose how you want to use CodeConClave/i })).toBeDefined();

      const choose = container.querySelector('#lp-choose')!;
      const hero = container.querySelector('.lp-hero')!;
      // Choice sits after the hero, before About — not buried deeper in the page.
      expect(hero.compareDocumentPosition(choose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        choose.compareDocumentPosition(container.querySelector('#lp-about')!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('offers the web app with its documented benefits', () => {
      renderLanding();
      const card = screen.getByRole('article', { name: /Web App/i });
      expect(within(card).getByText('Run CodeConClave in your browser.')).toBeDefined();
      for (const point of ['No installation', 'Instant access', 'Works across devices', 'Best for quick access']) {
        expect(within(card).getByText(point)).toBeDefined();
      }
      expect(within(card).getByRole('link', { name: 'Open Web App' }).getAttribute('href')).toBe('/register');
    });

    it('offers the desktop app with its documented benefits', () => {
      renderLanding();
      const card = screen.getByRole('article', { name: /Desktop App/i });
      expect(within(card).getByText('Use the full CodeConClave desktop environment.')).toBeDefined();
      for (const point of [
        'Local project access',
        'Desktop workflow',
        'Local-agent capabilities where supported',
        'Best for development workflows',
      ]) {
        expect(within(card).getByText(point)).toBeDefined();
      }
      // No installer is published, so the CTA must be truthful Early Access wording
      // and must NOT link the 404ing download endpoint.
      const cta = within(card).getByRole('link', { name: 'Request Access' });
      expect(cta.getAttribute('href')).toBe('/register');
      expect(card.textContent).not.toContain('Get Desktop App');
      expect(card.textContent).not.toContain('/api/v1/downloads/desktop');
    });

    it('renders both cards so the choice stays visually balanced', () => {
      renderLanding();
      const cards = screen.getAllByRole('article');
      const names = cards.map((c) => c.textContent ?? '');
      expect(names.filter((n) => n.includes('Web App')).length).toBe(1);
      expect(names.filter((n) => n.includes('Desktop App')).length).toBe(1);
    });

    it('shows the fetched installer version on the desktop card', async () => {
      renderLanding();
      expect(await screen.findByText(/Windows installer · v0\.1\.0 · 110 MB/i)).toBeDefined();
    });
  });

  describe('workflow explanation', () => {
    it('contrasts a fragmented traditional workflow with one CodeConClave workflow', () => {
      renderLanding();
      const flow = screen.getByRole('region', { name: /One workflow instead of six disconnected tools/i });

      expect(within(flow).getByText('Fragmented workflow')).toBeDefined();
      expect(within(flow).getByText('One AI development workflow')).toBeDefined();

      const traditional = within(flow).getByText('Traditional workflow').closest('.lp-flow__col')!;
      for (const part of ['IDE', 'Chatbot', 'Task tracker', 'Terminal', 'Memory', 'Deployment']) {
        expect(within(traditional as HTMLElement).getByText(part)).toBeDefined();
      }

      const conclave = within(flow).getByText('CodeConClave', { selector: '.lp-flow__title' }).closest('.lp-flow__col')!;
      for (const part of ['Project context', 'AI agents', 'Execution', 'Verification', 'Continuity', 'Control']) {
        expect(within(conclave as HTMLElement).getByText(part)).toBeDefined();
      }
    });
  });

  describe('about section', () => {
    it('explains what CodeConClave is', () => {
      renderLanding();
      expect(screen.getByRole('heading', { name: 'What is CodeConClave?' })).toBeDefined();
      expect(screen.getByText(/AI-native developer and founder operating system/i)).toBeDefined();
    });

    it('covers every required product area', () => {
      const { container } = renderLanding();
      const about = container.querySelector('#lp-about') as HTMLElement;
      expect(screen.getByRole('heading', { name: 'What is CodeConClave?' })).toBeDefined();
      expect(within(about).getByText(/AI-native developer and founder operating system/i)).toBeDefined();

      for (const heading of [
        'Project memory',
        'AI agents',
        'Execution',
        'Verification',
        'Continuity',
        'Control',
        'Team',
        'Desktop and web',
        'Developer workflow',
        'Deployment',
      ]) {
        expect(within(about).getByRole('heading', { name: heading })).toBeDefined();
      }
    });

    it('shows the developer workflow chain in order', () => {
      const { container } = renderLanding();
      const chain = within(container.querySelector('#lp-about') as HTMLElement).getByText('Goal').closest('.lp-chain') as HTMLElement;
      const stages = ['Goal', 'Plan', 'Agent execution', 'Verification', 'Artifact', 'Memory', 'Continue'];
      const nodes = stages.map((s) => within(chain).getByText(s));

      for (let i = 1; i < nodes.length; i++) {
        expect(nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it('states Kuberns deployment is proposed and not live', () => {
      const { container } = renderLanding();
      const about = container.querySelector('#lp-about') as HTMLElement;
      expect(within(about).getByText(/Kuberns deployment is a proposed integration/i)).toBeDefined();
    });
  });

  describe('feature showcase', () => {
    function features(): HTMLElement {
      return document.querySelector('#lp-features') as HTMLElement;
    }

    it('lists the implemented capability areas', () => {
      renderLanding();
      const grid = features();
      for (const title of [
        'AI agent orchestration',
        'Project memory',
        'Persistent context',
        'Task execution',
        'Verification',
        'Artifact tracking',
        'Continuity',
        'Background work',
        'Terminal and tools',
        'Git and development workflows',
        'Security',
        'Auditability',
        'Team workflows',
        'API access',
        'Desktop environment',
        'Web environment',
      ]) {
        expect(within(grid).getByRole('heading', { name: title })).toBeDefined();
      }
    });

    it('labels availability as text, so status is never colour-only', () => {
      renderLanding();
      const grid = features();
      const statusOf = (title: string) => {
        const card = within(grid).getByRole('heading', { name: title }).closest('.lp-feature') as HTMLElement;
        return within(card).getByText(/^(Available now|Plan dependent|Proposed|Early access)$/).textContent;
      };

      expect(statusOf('Project memory')).toBe('Available now');
      expect(statusOf('API access')).toBe('Plan dependent');
      expect(statusOf('Deployment integrations')).toBe('Proposed');
    });
  });

  describe('removed personal / amateur content', () => {
    it('drops the age and personal-founder story', () => {
      renderLanding();
      const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
      for (const removed of [
        /16 years? old/i,
        /16-year-old/i,
        /teenager/i,
        /founder behind it/i,
        /₹0/,
        /zero budget/i,
        /my story/i,
      ]) {
        expect(text).not.toMatch(removed);
      }
    });

    it('drops the founder photo request that produced a 404', () => {
      const { container } = renderLanding();
      expect(container.querySelector('img[src*="founder"]')).toBeNull();
      expect(container.textContent).not.toMatch(/founder-photo/);
    });
  });

  describe('customer authentication entry', () => {
    it('offers no Google or OAuth customer sign-in', () => {
      renderLanding();
      for (const label of [/sign in with google/i, /continue with google/i, /google/i]) {
        expect(screen.queryByRole('link', { name: label })).toBeNull();
        expect(screen.queryByRole('button', { name: label })).toBeNull();
      }
    });

    it('routes entry into authentication, not through extra pages', () => {
      renderLanding();
      const authLinks = screen.getAllByRole('link').filter((l) => {
        const href = l.getAttribute('href') ?? '';
        return href === '/login' || href === '/register';
      });
      expect(authLinks.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('accessibility', () => {
    it('exposes exactly one h1 and a skip link', () => {
      const { container } = renderLanding();
      expect(container.querySelectorAll('h1').length).toBe(1);
      expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#lp-main');
      expect(container.querySelector('#lp-main')).not.toBeNull();
    });

    it('labels both navigation landmarks', () => {
      renderLanding();
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeDefined();
      expect(screen.getByRole('navigation', { name: 'Footer' })).toBeDefined();
    });

    it('names each choice card through its heading', () => {
      renderLanding();
      expect(screen.getByRole('article', { name: /Web App/i })).toBeDefined();
      expect(screen.getByRole('article', { name: /Desktop App/i })).toBeDefined();
    });
  });
});
