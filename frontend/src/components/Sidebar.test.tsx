/**
 * CodeConClave — Sidebar tests (PHASE 11 + Stage 25.5).
 * The canonical navigation in the frozen spec order (Stage 25.5 adds the
 * multi-agent workspace between Projects and Memory), including Settings
 * between History and Approvals.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TEST_USER } from '../testutils';

const EXPECTED_ORDER = [
  'Home',
  'Chat',
  'Projects',
  'Agents',
  'Memory',
  'DNA Load',
  'Files',
  'Local Terminal',
  '24/7 Work',
  'Automation',
  'Workspace',
  'Coworkers',
  'Teams',
  'Plugins',
  'Control Plane',
  'Remote Control',
  'Ideas',
  'Data Centre',
  'Recovery',
  'Gain Trash',
  'History',
  'Settings',
  'Approvals',
];

describe('Sidebar', () => {
  it('renders all 23 workspaces in the frozen order', () => {
    render(
      <MemoryRouter>
        <Sidebar user={TEST_USER} />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link');
    const labels = links.map((l) => l.textContent?.replace(/[^\p{L}\p{N} /-]/gu, '').trim()).filter(Boolean);
    const filtered = labels.filter((l) => EXPECTED_ORDER.includes(l));
    expect(filtered).toEqual(EXPECTED_ORDER);
    expect(filtered).toHaveLength(23);
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