/**
 * CodeConClave — WorkPage tests (PHASE 11).
 * Task states render honestly (incl. WAITING_FOR_LOCAL_AGENT); retry posts
 * to the real endpoint; the detail timeline loads steps/attempts/tool calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { WorkPage } from './WorkPage';
import { jsonResponse, stubFetch } from '../testutils';

const TASK = {
  id: 't1',
  projectId: 'p1',
  title: 'Fix the pipeline',
  description: null,
  status: 'WAITING_FOR_LOCAL_AGENT',
  executionMode: 'LOCAL',
  riskLevel: 'MEDIUM',
  coworkerPipeline: ['ARCHITECT', 'CODER'],
  conversationId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const FAILED_TASK = { ...TASK, id: 't2', title: 'Failed task', status: 'FAILED', executionMode: 'CLOUD' };

function workHandler(tasks: Array<Record<string, unknown>> = [TASK]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/api/v1/projects') return jsonResponse({ data: { projects: [{ id: 'p1', name: 'Acme' }] } });
    if (url.includes('/api/v1/execution/tasks')) {
      if (init?.method === 'POST') return jsonResponse({ data: { task: {} } });
      if (url.endsWith('/t1')) {
        return jsonResponse({
          data: {
            task: TASK,
            attempts: [{ id: 'a1', task_id: 't1', attempt_number: 1, started_at: '2026-01-01T00:00:00.000Z', finished_at: null, result: null, error_code: null, output_summary: null }],
            steps: [{ id: 's1', task_id: 't1', attempt_id: 'a1', kind: 'plan', title: 'Plan', status: 'RUNNING', detail: null, output: 'Planning…', error_code: null, started_at: '2026-01-01T00:00:00.000Z', completed_at: null }],
            toolCalls: [{ id: 'tc1', task_id: 't1', step_id: 's1', tool: 'read_file', input: null, decision: 'ALLOWED', started_at: null, completed_at: null, error_code: null }],
            coworkerRuns: [],
            artifacts: [],
            plan: null,
            dependencies: [],
            failureInfo: null,
            dlq: null,
          },
        });
      }
      if (url.includes('/api/v1/execution/tasks/t1/retry') || url.includes('/api/v1/execution/tasks/t2/retry')) {
        return jsonResponse({ data: { task: {} } });
      }
      return jsonResponse({ data: { tasks } });
    }
    if (url.includes('/api/v1/artifacts')) return jsonResponse({ data: { artifacts: [] } });
    return jsonResponse({ data: {} });
  };
}

function renderWork() {
  return render(
    <ToastProvider>
      <WorkPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkPage', () => {
  it('renders the honest WAITING_FOR_LOCAL_AGENT state for LOCAL tasks', async () => {
    stubFetch(workHandler());
    renderWork();
    await waitFor(() => expect(screen.getByText('Fix the pipeline')).toBeInTheDocument());
    expect(screen.getByText('WAITING_FOR_LOCAL_AGENT')).toBeInTheDocument();
    expect(screen.getByText(/waiting for a paired Local Agent/)).toBeInTheDocument();
  });

  it('skips background poll ticks while the tab is hidden', async () => {
    vi.useFakeTimers();
    const stateSpy = vi.spyOn(document, 'visibilityState', 'get');
    try {
      const fetchFn = stubFetch(workHandler());
      stateSpy.mockReturnValue('visible');
      renderWork();
      const taskListCalls = () => fetchFn.mock.calls.filter(([u]) => String(u).includes('/api/v1/execution/tasks?')).length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const baseline = taskListCalls();
      expect(baseline).toBeGreaterThan(0);
      stateSpy.mockReturnValue('hidden');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(24000);
      });
      expect(taskListCalls()).toBe(baseline);
      stateSpy.mockReturnValue('visible');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(taskListCalls()).toBeGreaterThan(baseline);
    } finally {
      stateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('offers retry for failed tasks', async () => {
    stubFetch(workHandler([FAILED_TASK]));
    renderWork();
    await waitFor(() => expect(screen.getByText('Failed task')).toBeInTheDocument());
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('re-queues a failed task through the retry endpoint', async () => {
    const fetchFn = stubFetch(workHandler([FAILED_TASK]));
    renderWork();
    await userEvent.click(await screen.findByText('Retry'));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/execution/tasks/t2/retry' && i?.method === 'POST');
      expect(call).toBeDefined();
    });
    expect(screen.getByText('Task re-queued')).toBeInTheDocument();
  });

  it('loads the detail timeline with steps, attempts and tool calls', async () => {
    stubFetch(workHandler());
    renderWork();
    await userEvent.click(await screen.findByText('Details'));
    await waitFor(() => expect(screen.getByText('Plan')).toBeInTheDocument());
    expect(screen.getByText(/attempt 1/)).toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText(/ALLOWED/)).toBeInTheDocument();
  });

  it('is honest for backend raw rows where coworker_pipeline is null', async () => {
    stubFetch(workHandler([{ ...TASK, id: 't3', title: 'No pipeline task', coworkerPipeline: null }]));
    renderWork();
    await waitFor(() => expect(screen.getByText('No pipeline task')).toBeInTheDocument());
    expect(screen.getByText(/pipeline: default/)).toBeInTheDocument();
    expect(screen.getByText('No pipeline task')).toBeInTheDocument();
  });

  it('shows the empty queue while no project is selected', async () => {
    stubFetch(workHandler());
    renderWork();
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument();
  });
});