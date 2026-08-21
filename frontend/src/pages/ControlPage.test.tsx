/**
 * CodeConClave — Control Plane page tests (Stage 26G).
 * Kill switch toggles, risk policies, undo log, secret guard scanning and
 * usage analytics. All values are server-derived; the ROI is shown as an
 * estimate and secret findings never render stored secret values.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlPage } from './ControlPage';
import { ToastProvider } from '../components/Toast';
import { jsonResponse, stubFetch } from '../testutils';

const KILL_SWITCHES = [
  { id: 'ks-1', owner_id: 'u1', scope: 'GLOBAL', active: false, reason: null, created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T00:00:00Z', suspended: false },
  { id: 'ks-2', owner_id: 'u1', scope: 'TASKS', active: true, reason: 'release freeze', created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T00:00:00Z', suspended: true },
];

const POLICY = {
  id: 'pol-1',
  owner_id: 'u1',
  scope: 'task',
  action: 'create',
  risk_level: 'HIGH',
  requirement: 'require_approval',
  enabled: true,
  created_at: '2026-08-19T00:00:00Z',
  updated_at: '2026-08-19T00:00:00Z',
};

const SCAN = {
  id: 'scan-1',
  owner_id: 'u1',
  target_type: 'agent_output',
  target_ref: 'run-1',
  matched: true,
  findings: [{ kind: 'openai_api_key', location: 'run-1:12', confidence: 0.95, preview: 'sk-…' }],
  created_at: '2026-08-19T00:00:00Z',
};

const calls: string[] = [];
let scanRows: Array<Record<string, unknown>> = [];

function handler(url: string, init?: RequestInit): Promise<Response> {
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.includes('/api/v1/control/kill-switch')) {
    if (init?.method === 'PUT') {
      return Promise.resolve(jsonResponse({ data: { killSwitch: { ...KILL_SWITCHES[0], scope: 'AGENTS', active: true, suspended: true } } }));
    }
    return Promise.resolve(jsonResponse({ data: { scopes: KILL_SWITCHES } }));
  }
  if (url.includes('/api/v1/control/policies')) {
    if (init?.method === 'POST') return Promise.resolve(jsonResponse({ data: { policy: POLICY } }, 201));
    if (init?.method === 'DELETE') return Promise.resolve(jsonResponse({ data: { deleted: true } }));
    return Promise.resolve(jsonResponse({ data: { policies: [POLICY] } }));
  }
  if (url.includes('/api/v1/control/undo')) {
    if (init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ data: { entry: { id: 'u-1', owner_id: 'u1', action_type: 'kill_switch_toggle', description: 'AGENTS suspended', payload: {}, status: 'APPLIED', result: 'AGENTS autonomy resumed', created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T00:00:00Z' } } }));
    }
    return Promise.resolve(jsonResponse({ data: { entries: [{ id: 'u-1', owner_id: 'u1', action_type: 'kill_switch_toggle', description: 'AGENTS suspended', payload: {}, status: 'PENDING', result: null, created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-19T00:00:00Z' }] } }));
  }
  if (url.includes('/api/v1/control/secret-guard/scans')) return Promise.resolve(jsonResponse({ data: { scans: scanRows } }));
  if (url.includes('/api/v1/control/secret-guard/scan')) {
    scanRows.unshift(SCAN);
    return Promise.resolve(jsonResponse({ data: { scan: SCAN } }, 201));
  }
  if (url.includes('/api/v1/control/usage/cost-per-task')) {
    return Promise.resolve(jsonResponse({ data: { cost: { costUsd: 0.05, aiUsd: 0.04, calls: 2 } } }));
  }
  if (url.includes('/api/v1/control/usage/cost-per-feature')) {
    return Promise.resolve(jsonResponse({ data: { features: [{ feature: 'tasks', cost_usd: 0.01, calls: 2 }] } }));
  }
  if (url.includes('/api/v1/control/usage/roi')) {
    return Promise.resolve(jsonResponse({ data: { estimateUsd: 25, tasks: 5, aiCostUsd: 0.2, days: 30, labelled: true } }));
  }
  if (url.includes('/api/v1/control/usage/transparency')) {
    return Promise.resolve(jsonResponse({ data: { calls: [] } }));
  }
  if (url.includes('/api/v1/control/usage/rollups')) {
    if (init?.method === 'POST') return Promise.resolve(jsonResponse({ data: { rolledUp: 1, rollups: [] } }));
    return Promise.resolve(jsonResponse({ data: { rollups: [] } }));
  }
  return Promise.resolve(jsonResponse({ data: {} }));
}

describe('ControlPage', () => {
  beforeEach(() => {
    calls.length = 0;
    scanRows = [];
    stubFetch(handler);
  });

  const renderPage = () =>
    render(
      <ToastProvider>
        <ControlPage />
      </ToastProvider>,
    );

  it('shows the kill switch state and suspends a scope', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('TASKS kill switch')).toBeChecked());
    await userEvent.type(screen.getByLabelText('Kill switch reason'), 'freeze');

    const agents = screen.getByLabelText('AGENTS kill switch');
    expect(agents).not.toBeChecked();
    await userEvent.click(agents);

    await waitFor(() => expect(calls.some((c) => c.startsWith('PUT /api/v1/control/kill-switch'))).toBe(true));
  });

  it('lists policies and saves a new one', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('task:create')).toBeInTheDocument());
    expect(screen.getAllByText('require_approval').length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByLabelText('Policy requirement'), 'block');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() => expect(calls.some((c) => c.startsWith('POST /api/v1/control/policies'))).toBe(true));
  });

  it('scans content and reports findings without rendering the secret value', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/No reversible actions/)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Content to scan'), 'sk-test1234567890abcdef');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => expect(screen.getByText(/1 secret\(s\) detected/)).toBeInTheDocument());
    const findings = await screen.findByText(/openai_api_key/);
    expect(findings).toBeInTheDocument();
    expect(findings.textContent).not.toContain('sk-test1234567890abcdef');
  });

  it('runs an undo and refreshes rollups', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('AGENTS suspended')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(screen.getByText(/Undo APPLIED: AGENTS autonomy resumed/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Refresh rollups' }));
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST /api/v1/control/usage/rollup'))).toBe(true));
  });

  it('labels the ROI as an estimate', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/\$25\.00 estimated value/)).toBeInTheDocument());
    expect(screen.getByText(/estimate only, using a fixed \$5\/task value model/)).toBeInTheDocument();
  });
});
