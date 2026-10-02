/**
 * CodeConClave — public landing page tests.
 * Verifies the marketing page renders the brand, sections and the desktop
 * download CTA, and adapts the version badge to the /info endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('shows the brand, section headings and founder signature', () => {
    renderLanding();
    expect(screen.getByText('CodeConClave')).toBeDefined();
    expect(screen.getByText('What is CodeConClave?')).toBeDefined();
    expect(screen.getByText('How it works')).toBeDefined();
    expect(screen.getByText(/MEDIDI SAHARSH \(Founder of CodeConClave\)/i)).toBeDefined();
  });

  it('links the desktop download button to the download endpoint', () => {
    renderLanding();
    const download = screen.getByRole('link', { name: /download the desktop app/i });
    expect(download.getAttribute('href')).toBe('/api/v1/downloads/desktop');
  });

  it('links to the web app (register) and sign-in', () => {
    renderLanding();
    const web = screen.getByRole('link', { name: /open web app|use in browser/i });
    expect(web.getAttribute('href')).toBe('/register');
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/login');
  });

  it('shows the fetched installer version for the download line', async () => {
    renderLanding();
    expect(await screen.findByText(/Windows installer • v0\.1\.0 • 110 MB/i)).toBeDefined();
  });

  it('links every Contact-the-founder action to the founder email', () => {
    renderLanding();
    const links = screen.getAllByRole('link', { name: /contact the founder|contact founder/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('mailto:medidisaharsh@gmail.com');
    }
  });

  it('offers contact alongside the browser and desktop choices', () => {
    renderLanding();
    const rows = screen.getAllByRole('link', { name: /contact (the )?founder/i });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.getAttribute('href')).toBe('mailto:medidisaharsh@gmail.com');
    expect(screen.getByRole('link', { name: /use .* browser/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /download the desktop app/i })).toBeDefined();
  });
});