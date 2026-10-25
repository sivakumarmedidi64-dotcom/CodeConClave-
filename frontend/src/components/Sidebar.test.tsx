/**
 * CodeConClave — Sidebar tests. Minimal, Claude-like navigation: a Search, a
 * "New chat", a short primary list (Projects, Agents, Beyond, Customize), and
 * everything else under the collapsible "More". No chat list on the rail.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TEST_USER } from '../testutils';

const PRIMARY = ['Projects', 'Agents', 'Beyond', 'Agent Sai', 'Customize'];
const SECONDARY_SAMPLE = ['Tasks', 'Code review', 'Teams', 'Terminal', 'Trash'];

describe('Sidebar', () => {
  it('shows Search, New chat and the short primary list', () => {
    render(
      <MemoryRouter>
        <Sidebar user={TEST_USER} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New chat/ })).toBeInTheDocument();
    for (const label of PRIMARY) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('keeps secondary surfaces under a collapsed "More" until it is expanded', () => {
    render(
      <MemoryRouter>
        <Sidebar user={TEST_USER} />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: /^More/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const label of SECONDARY_SAMPLE) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('does not list past chats on the rail (Home is the one chat)', () => {
    render(
      <MemoryRouter>
        <Sidebar user={TEST_USER} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Recents')).not.toBeInTheDocument();
  });

  it('marks the navigation landmark for assistive tech', () => {
    render(
      <MemoryRouter>
        <Sidebar user={TEST_USER} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Workspace navigation')).toBeInTheDocument();
  });
});
