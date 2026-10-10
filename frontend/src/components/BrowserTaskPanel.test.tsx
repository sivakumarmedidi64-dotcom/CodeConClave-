/**
 * CodeConClave — BrowserTaskPanel tests (P1).
 * Device picker only offers online browser-capable devices; dispatch posts a
 * real instruction to the real endpoint; risk is derived honestly; the active
 * task monitor renders the assignment / progress / artifact refs from /local.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import { BrowserTaskPanel } from './BrowserTaskPanel';
import { jsonResponse, stubFetch } from '../testutils';
import type { Task } from '../lib/types';

const DEVICES = [
  {
    id: 'd1',
    name: 'Alice-PC',
    state: 'PAIRED',
    presence: 'ONLINE',
    capabilities: ['terminal_exec', 'browser.open', 'browser.read', 'browser.click', 'browser.inspect'],
    remoteCapable: true,
    lastSeenAt: null,
  },
  {
    id: 'd2',
    name: 'Idle-Tab',
    state: 'PAIRED',
    presence: 'OFFLINE',
    capabilities: ['terminal_exec', 'browser.open'],
    remoteCapable: true,
    lastSeenAt: null,
  },
];

const RUNNING_TASK: Task = {
  id: 'tb1',
  projectId: 'p1',
  title: 'Download the report',
  description: null,
  status: 'RUNNING',
  executionMode: 'LOCAL',
  riskLevel: 'MEDIUM',
  coworkerPipeline: [],
  conversationId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function panelHandler({ devices = DEVICES, local }: { devices?: unknown[]; local?: unknown } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/api/v1/agent/status') return jsonResponse({ data: { devices } });
    if (url === '/api/v1/execution/tasks' && init?.method === 'POST') return jsonResponse({ data: { task: RUNNING_TASK } }, 201);
    if (url.includes('/api/v1/execution/tasks/tb1/local')) return jsonResponse({ data: { local } });
    return jsonResponse({ data: {} });
  };
}

function renderPanel(tasks: Task[] = []) {
  return render(
    <ToastProvider>
      <BrowserTaskPanel projectId="p1" tasks={tasks} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('BrowserTaskPanel — device picker', () => {
  it('offers only online browser-capable devices and honestly counts the rest', async () => {
    stubFetch(panelHandler());
    renderPanel();
    await waitFor(() => expect(screen.getByText(/1 online browser-capable of 2 paired/)).toBeInTheDocument());
    const combo = screen.getByRole('combobox', { name: /device/i }) as HTMLSelectElement;
    expect([...combo.options].map((o) => o.value)).toEqual(['', 'd1']);
    expect(combo.innerHTML).not.toContain('Idle-Tab');
  });

  it('shows the honest no-browser message when nothing qualifies', async () => {
    stubFetch(panelHandler({ devices: [{ ...DEVICES[0]!, presence: 'OFFLINE' }] }));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/No paired device currently online advertises/)).toBeInTheDocument());
  });
});

describe('BrowserTaskPanel — authoring + dispatch', () => {
  it('posts a read-only instruction at MEDIUM without touching the device grant gate', async () => {
    const fetchFn = stubFetch(
      panelHandler({
        local: {
          assignment: {
            id: 'a1',
            task_id: 'tb1',
            device_id: 'd1',
            status: 'RUNNING',
            result: null,
            progress: { step: 'running' },
            artifact_refs: [],
            lease_expires_at: '2026-01-02T00:00:00.000Z',
            error_code: null,
            error_detail: null,
          },
          instruction: {
            type: 'browser',
            grants: { capabilities: ['browser.open', 'browser.read'], allowedOrigins: ['https://example.com'], lifetimeMs: 3600000 },
            actions: [
              { op: 'open', url: 'https://example.com/' },
              { op: 'search', query: 'hi' },
            ],
          },
        },
      }),
    );
    renderPanel();
    await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /device/i }), 'd1');
    await userEvent.type(screen.getByPlaceholderText('https://…'), 'https://example.com/');
    await userEvent.click(screen.getByRole('button', { name: /Dispatch browser task/ }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/execution/tasks' && i?.method === 'POST')).toBe(true));
    const [, init] = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/execution/tasks' && i?.method === 'POST')!;
    const body = JSON.parse(String(init!.body)) as {
      executionMode: string;
      deviceId: string;
      riskLevel: string;
      localInstruction: { type: string; grants: { capabilities: string[]; allowedOrigins: string[] }; actions: { op: string }[] };
    };
    expect(body.executionMode).toBe('LOCAL');
    expect(body.deviceId).toBe('d1');
    expect(body.riskLevel).toBe('MEDIUM');
    expect(body.localInstruction.type).toBe('browser');
    expect(body.localInstruction.grants.capabilities.sort()).toEqual(['browser.open']);
    expect(body.localInstruction.grants.allowedOrigins).toContain('https://example.com');
    expect(body.localInstruction.actions[0]!.op).toBe('open');
  });

  it('ranks descriptions with consequential actions HIGH (approval-gated) and sends the click/type actions', async () => {
    const fetchFn = stubFetch(panelHandler());
    renderPanel();
    await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /device/i }), 'd1');
    await userEvent.type(screen.getByPlaceholderText('https://…'), 'https://example.com/');
    await userEvent.click(screen.getByRole('button', { name: /Add action/ }));
    const opSelects = screen.getAllByRole('combobox').filter((el) => [...el.querySelectorAll('option')].some((o) => o.textContent === 'Click'));
    await userEvent.selectOptions(opSelects[1]!, 'click');
    await userEvent.type(screen.getByPlaceholderText('CSS selector'), '#go');
    expect(screen.getByText(/HIGH — approval required/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Dispatch browser task/ }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/execution/tasks' && i?.method === 'POST')).toBe(true));
    const [, init] = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/execution/tasks' && i?.method === 'POST')!;
    const body = JSON.parse(String(init!.body)) as { riskLevel: string; localInstruction: { actions: { op: string }[] } };
    expect(body.riskLevel).toBe('HIGH');
    expect(body.localInstruction.actions.map((a) => a.op)).toEqual(['open', 'click']);
  });

  it('blocks dispatch with an author-time error when an action is incomplete', async () => {
    stubFetch(panelHandler());
    renderPanel();
    await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /device/i }), 'd1');
    await userEvent.type(screen.getByPlaceholderText('https://…'), 'https://example.com/');
    await userEvent.click(screen.getByRole('button', { name: /Add action/ }));
    const opSelects = screen.getAllByRole('combobox').filter((el) => [...el.querySelectorAll('option')].some((o) => o.textContent === 'Click'));
    await userEvent.selectOptions(opSelects[1]!, 'click');
    await userEvent.click(screen.getByRole('button', { name: /Dispatch browser task/ }));
    await waitFor(() => expect(screen.getByText(/action 2: click requires a selector/)).toBeInTheDocument());
  });

  it('surfaces a server-side feature-gate denial honestly', async () => {
    const fetchFn = stubFetch(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/agent/status') return jsonResponse({ data: { devices: DEVICES } });
      if (url === '/api/v1/execution/tasks' && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'browser_control_disabled', message: 'BROWSER_CONTROL_ENABLED is false' } }, 403);
      }
      return jsonResponse({ data: {} });
    });
    renderPanel();
    await waitFor(() => expect(screen.queryByText(/Loading devices/)).not.toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /device/i }), 'd1');
    await userEvent.type(screen.getByPlaceholderText('https://…'), 'https://example.com/');
    await userEvent.click(screen.getByRole('button', { name: /Dispatch browser task/ }));
    await waitFor(() => expect(screen.getByText(/Browser control is DISABLED on this deployment/)).toBeInTheDocument());
    expect(fetchFn.mock.calls.filter(([u, i]) => u === '/api/v1/execution/tasks' && i?.method === 'POST').length).toBe(1);
  });
});

describe('BrowserTaskPanel — active task monitor', () => {
  it('renders assignment, live progress and artifact refs from /tasks/:id/local', async () => {
    stubFetch(
      panelHandler({
        local: {
          assignment: {
            id: 'a1',
            task_id: 'tb1',
            device_id: 'd1',
            status: 'RUNNING',
            result: null,
            progress: { step: 'action', index: 0, op: 'open', done: 1, actionsTotal: 2 },
            artifact_refs: [
              { kind: 'browser_download', path: 'downloads/tb1/file.pdf', absPath: '/x/downloads/tb1/file.pdf', bytes: 1234, sha256: 'abcdef1234567890' },
            ],
            lease_expires_at: '2026-01-02T00:00:00.000Z',
            error_code: null,
            error_detail: null,
          },
          instruction: {
            type: 'browser',
            grants: { capabilities: ['browser.open', 'browser.search'], allowedOrigins: ['https://example.com'], lifetimeMs: 3600000 },
            actions: [
              { op: 'open', url: 'https://example.com/' },
              { op: 'search', query: 'hi' },
            ],
          },
        },
      }),
    );
    renderPanel([RUNNING_TASK]);
    await waitFor(() => expect(screen.getByText('Download the report')).toBeInTheDocument());
    expect(screen.getByText(/device: Alice-PC · 2 actions · open → search/)).toBeInTheDocument();
    expect(screen.getByText(/action 1\/2 — open/)).toBeInTheDocument();
    expect(screen.getByText(/browser_download/)).toBeInTheDocument();
    expect(screen.getByText(/abcdef123456/)).toBeInTheDocument();
  });

  it('shows the honest wait state when there is no assignment yet', async () => {
    stubFetch(panelHandler({ local: null }));
    renderPanel([RUNNING_TASK]);
    await waitFor(() => expect(screen.getByText(/No local assignment yet/)).toBeInTheDocument());
  });
});