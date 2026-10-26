/**
 * CodeConClave — Sidebar tests. Navigation is SEPARATED BY PLAN:
 * Free = chat + Customize only; Solo = personal power tools; Team adds Teams.
 * Agent Sai is backend-only and never appears in the rail.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TEST_USER } from '../testutils';
import type { User } from '../lib/types';

const solo: User = { ...TEST_USER, planId: 'pro', entitlementState: 'PRO_VERIFIED' };
const team: User = { ...TEST_USER, planId: 'team', entitlementState: 'PRO_VERIFIED' };
const free: User = { ...TEST_USER, planId: 'free', entitlementState: 'FREE' };

const SOLO_PRIMARY = ['Projects', 'Agents', 'Beyond', 'Customize'];

describe('Sidebar', () => {
  it('shows Search, New chat and the Solo primary list (no Agent Sai)', () => {
    render(
      <MemoryRouter>
        <Sidebar user={solo} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New chat/ })).toBeInTheDocument();
    for (const label of SOLO_PRIMARY) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    // Agent Sai is a backend worker — users never see it in the rail.
    expect(screen.queryByRole('link', { name: 'Agent Sai' })).not.toBeInTheDocument();
  });

  it('keeps secondary surfaces under a collapsed "More"; Team sees Teams there', () => {
    render(
      <MemoryRouter>
        <Sidebar user={team} />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: /^More/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['Tasks', 'Code review', 'Teams', 'Terminal', 'Trash']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('separates by plan: Free sees chat + Customize only, not Projects or Teams', () => {
    render(
      <MemoryRouter>
        <Sidebar user={free} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /New chat/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Customize' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Projects' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Teams' })).not.toBeInTheDocument();
  });

  it('Solo does not see Teams (a Team-only feature)', () => {
    render(
      <MemoryRouter>
        <Sidebar user={solo} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    expect(screen.queryByRole('link', { name: 'Teams' })).not.toBeInTheDocument();
  });

  it('does not list past chats on the rail (Home is the one chat)', () => {
    render(
      <MemoryRouter>
        <Sidebar user={solo} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Recents')).not.toBeInTheDocument();
  });

  it('marks the navigation landmark for assistive tech', () => {
    render(
      <MemoryRouter>
        <Sidebar user={solo} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Workspace navigation')).toBeInTheDocument();
  });
});
