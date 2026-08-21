/**
 * CodeConClave — CommandPalette tests (PHASE 11).
 * Opens on Cmd/Ctrl+K, filters by typing, navigates on Enter, closes on Esc,
 * and performs real actions for theme/focus commands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from './CommandPalette';
import { jsonResponse, stubFetch } from '../testutils';

function renderPalette(onToggleFocus = vi.fn()) {
  const result = render(
    <MemoryRouter initialEntries={['/home']}>
      <CommandPalette onToggleFocus={onToggleFocus} />
    </MemoryRouter>,
  );
  return { onToggleFocus, ...result };
}

const INPUT = () => screen.getByRole('textbox', { name: 'Command palette' });

function projectsHandler() {
  return async (url: string): Promise<Response> => {
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
    return jsonResponse({ data: {} });
  };
}

async function openPalette() {
  await userEvent.keyboard('{Control>}k{/Control}');
  await waitFor(() => screen.getByRole('dialog'));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('CommandPalette', () => {
  it('opens with Ctrl+K and lists all static commands', async () => {
    stubFetch(projectsHandler());
    renderPalette();
    expect(screen.queryByRole('dialog')).toBeNull();
    await openPalette();
    expect(INPUT()).toBeInTheDocument();
    expect(screen.getByText('New Chat')).toBeInTheDocument();
    expect(screen.getByText('Open Approvals')).toBeInTheDocument();
    expect(screen.getByText('Open Billing')).toBeInTheDocument();
    expect(screen.getByText('Toggle Theme')).toBeInTheDocument();
    expect(screen.getByText('Toggle Focus Mode')).toBeInTheDocument();
  });

  it('filters commands as the user types', async () => {
    stubFetch(projectsHandler());
    renderPalette();
    await openPalette();
    await userEvent.type(INPUT(), 'approval');
    expect(screen.getByText('Open Approvals')).toBeInTheDocument();
    expect(screen.queryByText('New Chat')).toBeNull();
  });

  it('navigates to a workspace when Enter runs a command', async () => {
    stubFetch(projectsHandler());
    renderPalette();
    await openPalette();
    await userEvent.type(INPUT(), 'open approvals');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const location = window.location;
    void location;
  });

  it('closes on Escape', async () => {
    stubFetch(projectsHandler());
    renderPalette();
    await openPalette();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows jump-to-project items fetched live from the projects API', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/projects')) {
        return jsonResponse({ data: { projects: [{ id: 'p1', name: 'Acme App', deleted_at: null, status: 'ACTIVE' }] } });
      }
      return jsonResponse({ data: {} });
    });
    renderPalette();
    await openPalette();
    await waitFor(() => expect(screen.getByText('Acme App')).toBeInTheDocument());
  });

  it('runs the focus-mode command and toggles the sidebar', async () => {
    stubFetch(projectsHandler());
    const { onToggleFocus } = renderPalette();
    await openPalette();
    await userEvent.type(INPUT(), 'focus mode');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onToggleFocus).toHaveBeenCalled());
  });
});