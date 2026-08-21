/**
 * CodeConClave — responsive shell journey tests (Stage 26I).
 * The same shell is exercised at desktop (collapse), tablet (hamburger) and
 * mobile (drawer) widths: drawer opens/closes from the backdrop, closes on
 * navigation, and the hamburger is always wired to real shell behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { shellHandler, stubFetch } from './testutils';

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}

function renderApp(initialEntries: string[]) {
  const fetchFn = stubFetch(shellHandler);
  const result = render(
    <MemoryRouter initialEntries={initialEntries}>
      <App />
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

async function waitAuthed() {
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument(), { timeout: 8000 });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  delete (window as unknown as { innerWidth?: number }).innerWidth;
});

describe('responsive shell journey', () => {
  it('desktop: the hamburger collapses the sidebar', async () => {
    setWidth(1280);
    const { container } = renderApp(['/home']);
    await waitAuthed();
    const shell = container.querySelector('.cc-shell') as HTMLElement;
    expect(shell.className).not.toContain('cc-shell--collapsed');
    await userEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(shell.className).toContain('cc-shell--collapsed');
  });

  it('tablet: the hamburger is present and collapses the sidebar', async () => {
    setWidth(900);
    const { container } = renderApp(['/home']);
    await waitAuthed();
    expect(screen.getByRole('button', { name: 'Toggle navigation' })).toBeInTheDocument();
    const shell = container.querySelector('.cc-shell') as HTMLElement;
    await userEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(shell.className).toContain('cc-shell--collapsed');
  });

  it('mobile: the hamburger opens the drawer, the backdrop closes it', async () => {
    setWidth(375);
    const { container } = renderApp(['/home']);
    await waitAuthed();
    const shell = container.querySelector('.cc-shell') as HTMLElement;
    await userEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(shell.className).toContain('cc-shell--drawer-open');
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(shell.className).not.toContain('cc-shell--drawer-open');
  });

  it('mobile: navigating from the drawer closes it', async () => {
    setWidth(375);
    const { container } = renderApp(['/home']);
    await waitAuthed();
    const shell = container.querySelector('.cc-shell') as HTMLElement;
    await userEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    expect(shell.className).toContain('cc-shell--drawer-open');
    await userEvent.click(screen.getByRole('link', { name: /Projects/ }));
    await waitFor(() => expect(shell.className).not.toContain('cc-shell--drawer-open'));
  });
});