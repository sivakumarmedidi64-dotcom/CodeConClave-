/**
 * CodeConClave — Sidebar tests (AI-OS IA).
 * The primary navigation is a compact eight-item set (Home, Chat, Projects,
 * Agents, Tasks, Activity, Connectors, Settings); Approval Center navigation is
 * intentionally absent (approvals still arrive via notifications). Secondary
 * surfaces live under the collapsible "More" group and only render once expanded.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TEST_USER } from '../testutils';

const PRIMARY = [
  'Home',
  'Chat',
  'Projects',
  'Agents',
  'Tasks',
  'Activity',
  'Connectors',
  'Settings',
];

const SECONDARY = [
  'Memory',
  'DNA',
  'Files',
  'Terminal',
  'Automation',
  'Repo Workspace',
  'Coworkers',
  'Teams',
  'Control',
  'Remote',
  'Ideas',
  'Data',
  'Recovery',
  'Trash',
];

function visibleLabels(): string[] {
  return screen
    .getAllByRole('link')
    .map((l) => l.textContent?.replace(/[^\p{L}\p{N} /-]/gu, '').trim())
    .filter(Boolean) as string[];
}

describe('Sidebar', () => {
  it('renders the eight primary destinations in order', () => {
    render(
      <MemoryRouter>
        <Sidebar user={TEST_USER} />
      </MemoryRouter>,
    );
    const filtered = visibleLabels().filter((l) => PRIMARY.includes(l));
    expect(filtered).toEqual(PRIMARY);
  });

  it('keeps secondary surfaces tucked under the collapsed More group', () => {
    render(
      <MemoryRouter>
        <Sidebar user={TEST_USER} />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: /^More/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(visibleLabels().filter((l) => SECONDARY.includes(l))).toEqual([]);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const all = visibleLabels().filter((l) => [...PRIMARY, ...SECONDARY].includes(l));
    expect(all).toEqual([...PRIMARY, ...SECONDARY]);
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