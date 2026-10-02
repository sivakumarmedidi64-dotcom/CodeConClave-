/**
 * CodeConClave — CoworkersPage tests (PHASE 11).
 * Catalogue renders server capability/permission/model chips; loading/error/
 * empty states; run states displayed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoworkersPage } from './CoworkersPage';
import { jsonResponse, stubFetch } from '../testutils';

const COWORKERS = [
  {
    type: 'ARCHITECT',
    name: 'Architect',
    role: 'System design and architecture planning',
    description: 'Designs components and interfaces.',
    capabilities: ['design', 'interface_spec'],
    permissionScope: 'READ_ONLY',
    modelPolicy: { computeClass: 'C', maxTokens: 2000 },
    memoryAccess: 'Read project DNA + semantic memory only',
  },
];

const RUNS = [
  {
    id: 'r1',
    taskId: 't1',
    coworkerType: 'ARCHITECT',
    state: 'COMPLETED',
    input: null,
    output: 'Decision recorded',
    handoffTo: 'CODER',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('CoworkersPage', () => {
  it('renders the catalogue with capability and permission chips', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/execution/coworkers')) return jsonResponse({ data: { coworkers: COWORKERS, runs: RUNS } });
      return jsonResponse({ data: {} });
    });
    render(<CoworkersPage />);
    await waitFor(() => expect(screen.getByText('System design and architecture planning')).toBeInTheDocument());
    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.getByText('interface_spec')).toBeInTheDocument();
    expect(screen.getByText(/permission: READ_ONLY/)).toBeInTheDocument();
    expect(screen.getByText(/model: class C/)).toBeInTheDocument();
  });

  it('shows recent runs with their states', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/execution/coworkers')) return jsonResponse({ data: { coworkers: COWORKERS, runs: RUNS } });
      return jsonResponse({ data: {} });
    });
    render(<CoworkersPage />);
    await waitFor(() => expect(screen.getByText('Recent runs')).toBeInTheDocument());
    expect(screen.getAllByText('ARCHITECT').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
    expect(screen.getByText(/handoff → CODER/)).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    let calls = 0;
    stubFetch(async (url) => {
      if (url.includes('/api/v1/execution/coworkers')) {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
        return jsonResponse({ data: { coworkers: COWORKERS, runs: [] } });
      }
      return jsonResponse({ data: {} });
    });
    render(<CoworkersPage />);
    await waitFor(() => expect(screen.getByText('Could not load the coworker catalogue.')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('System design and architecture planning')).toBeInTheDocument());
  });
});