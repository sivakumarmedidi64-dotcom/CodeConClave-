/**
 * CodeConClave — WorkbenchPage tests (integration).
 * Wires real fetchers against a stub backend, loads the project/task scope,
 * renders the tree + task timeline, and opens a file into the code viewer.
 * The SSE stream is the never-connecting test double, so the surface must
 * degrade to the polling transport without crashing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkbenchPage } from './WorkbenchPage';

const TASK = {
  id: 't1',
  projectId: 'p1',
  title: 'Fix the pipeline',
  description: 'Repair the build',
  status: 'RUNNING',
  executionMode: 'CLOUD',
  riskLevel: 'MEDIUM',
  coworkerPipeline: ['ARCHITECT', 'CODER'],
  conversationId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const TREE = [
  {
    path: 'src',
    name: 'src',
    type: 'folder',
    children: [{ path: 'src/app.ts', name: 'app.ts', type: 'file', file: { id: 'f1', path: 'src/app.ts' } }],
  },
  { path: 'README.md', name: 'README.md', type: 'file', file: { id: 'f2', path: 'README.md' } },
];

const TIMELINE = {
  task: TASK,
  attempts: [],
  steps: [{ id: 's1', taskId: 't1', attemptId: 'a1', kind: 'plan', title: 'Plan', status: 'COMPLETED', detail: null, output: null, errorCode: null, startedAt: null, completedAt: null }],
  toolCalls: [],
  coworkerRuns: [],
  artifacts: [],
  plan: null,
  dependencies: [],
  failureInfo: null,
  dlq: null,
};

function json(data: unknown): Response {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ data }), text: async () => JSON.stringify({ data }) } as unknown as Response;
}

function text(body: string): Response {
  return { ok: true, status: 200, headers: { get: () => 'text/plain' }, json: async () => ({}), text: async () => body } as unknown as Response;
}

function handler(url: string): Response {
  if (url === '/api/v1/projects') return json({ projects: [{ id: 'p1', name: 'Acme' }] });
  if (url.startsWith('/api/v1/files/tree')) return json({ tree: TREE });
  if (url.includes('/api/v1/files/f2/content')) return text('line one\nline two');
  if (url.includes('/api/v1/execution/tasks/t1/artifacts')) return json({ artifacts: [] });
  if (url.endsWith('/api/v1/execution/tasks/t1')) return json(TIMELINE);
  if (url.includes('/api/v1/execution/tasks')) return json({ tasks: [TASK] });
  if (url.includes('/api/v1/memory/handoffs')) return json({ handoffs: [] });
  if (url.includes('/api/v1/memory')) return json({ memories: [] });
  if (url.includes('/api/v1/reviews')) return json({ reviews: [] });
  if (url.includes('/api/v1/activity')) return json({ events: [] });
  if (url.includes('/api/v1/audit')) return json({ events: [] });
  if (url.includes('/api/v1/environment/status')) return json({ environment: 'development', status: 'VERIFIED', requiredVars: [], declaredEnv: null, blockEnvironmentSensitive: false, checkedAt: '2026-01-01T00:00:00.000Z' });
  if (url.includes('/api/v1/runtime/executions')) return json([]);
  return json({});
}

function renderWorkbench() {
  return render(
    <MemoryRouter initialEntries={['/workbench/p1']}>
      <Routes>
        <Route path="/workbench/:projectId" element={<WorkbenchPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
});

describe('WorkbenchPage', () => {
  it('loads the project scope into the explorer and toolbar', async () => {
    renderWorkbench();
    await waitFor(() => expect(screen.getByTestId('workbench-page')).toBeInTheDocument());
    expect(await screen.findByText('app.ts')).toBeInTheDocument();
    expect(screen.getByLabelText('Project')).toHaveValue('p1');
  });

  it('renders the selected task timeline status', async () => {
    renderWorkbench();
    await waitFor(() => expect(screen.getByTestId('task-panel')).toBeInTheDocument());
    expect(screen.getByTestId('workbench-task-status')).toHaveTextContent('Running');
  });

  it('opens a real file into the code viewer', async () => {
    renderWorkbench();
    const file = await screen.findByText('README.md');
    fireEvent.click(file);
    await waitFor(() => expect(screen.getByTestId('code-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('code-body').textContent).toContain('line one');
  });

  it('shows the honest connecting transport when the stream never opens', async () => {
    renderWorkbench();
    await waitFor(() => expect(screen.getByTestId('workbench-transport')).toBeInTheDocument());
    expect(screen.getByTestId('workbench-transport')).toHaveTextContent('connecting');
  });
});