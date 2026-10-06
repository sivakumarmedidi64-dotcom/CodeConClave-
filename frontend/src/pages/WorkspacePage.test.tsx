/**
 * CodeConClave — Workspace page tests (Stage 26G).
 * CHAT composes a real task through the execution engine; CODE shows the real
 * file tree, change heatmap and proof-of-work; PREVIEW reuses the live
 * PreviewPanel with comments (each creating a real task) and the honest
 * visual diff. Everything asserted here is server-shaped, nothing fabricated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { WorkspacePage } from './WorkspacePage';
import { ToastProvider } from '../components/Toast';
import { jsonResponse, stubFetch } from '../testutils';

const PROJECT = { id: 'prj-1', name: 'Core App' };

const TASK = {
  id: 'tsk-9',
  projectId: 'prj-1',
  title: 'Fix the login flow',
  description: null,
  status: 'PENDING',
  executionMode: 'CLOUD',
  riskLevel: 'MEDIUM',
  coworkerPipeline: [],
  conversationId: null,
  createdAt: '2026-08-19T00:00:00Z',
};

const PROOF = {
  id: 'pow-1',
  owner_id: 'u1',
  task_id: 'tsk-9',
  project_id: 'prj-1',
  report: {
    taskId: 'tsk-9',
    projectId: 'prj-1',
    request: { title: 'Fix the login flow', description: null },
    plan: { status: 'COMPLETED', entries: [] },
    files: [{ path: 'src/app.tsx', sizeBytes: 1200 }],
    tests: [],
    evidence: { attempts: 2, errors: [], artifacts: [] },
    preview: null,
    approvals: [],
    time: { created_at: '2026-08-19T00:00:00Z', completed_at: null, durationMs: null },
    ai: { calls: 3, inputTokens: 300, outputTokens: 150, costUsd: 0.002 },
    cost: { totalUsd: 0.003, aiUsd: 0.002 },
    generatedAt: '2026-08-19T00:00:00Z',
  },
  created_at: '2026-08-19T00:00:00Z',
  updated_at: '2026-08-19T00:00:00Z',
};

const calls: string[] = [];
let commentRows: Array<Record<string, unknown>> = [];

function handler(url: string, init?: RequestInit): Promise<Response> {
  if (url.includes('/api/v1/projects')) return Promise.resolve(jsonResponse({ data: { projects: [PROJECT] } }));
  if (url.includes('/api/v1/execution/tasks')) {
    if (init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ data: { task: TASK } }, 201));
    }
    return Promise.resolve(jsonResponse({ data: { tasks: [TASK] } }));
  }
  if (url.includes('/api/v1/files/tree')) {
    return Promise.resolve(jsonResponse({ data: { tree: [{ name: 'src', path: 'src', type: 'folder', children: [{ name: 'app.tsx', path: 'src/app.tsx', type: 'file' }] }] } }));
  }
  if (url.includes('/api/v1/control/activity/heatmap')) {
    return Promise.resolve(jsonResponse({ data: { heatmap: [{ date: '2026-08-19', changes: 4 }] } }));
  }
  if (url.includes('/api/v1/control/pow')) {
    if (init?.method === 'POST') return Promise.resolve(jsonResponse({ data: { proof: PROOF } }, 201));
    return Promise.resolve(jsonResponse({ data: { proof: PROOF } }));
  }
  if (url.includes('/api/v1/preview/') && url.endsWith('/comments')) {
    if (init?.method === 'POST') {
      commentRows.push({
        id: 'cmt-1',
        owner_id: 'u1',
        project_id: 'prj-1',
        preview_version: 1,
        selector: '.submit-btn',
        comment: 'Make it green',
        task_id: 'tsk-9',
        status: 'OPEN',
        created_at: '2026-08-19T00:00:00Z',
        updated_at: '2026-08-19T00:00:00Z',
      });
      return Promise.resolve(jsonResponse({ data: { comment: commentRows[0]! } }));
    }
    return Promise.resolve(jsonResponse({ data: { comments: commentRows } }));
  }
  if (url.includes('/api/v1/preview/') && url.endsWith('/diff')) {
    return Promise.resolve(jsonResponse({ data: { diff: { projectId: 'prj-1', before: null, after: null, available: false } } }));
  }
  if (url.includes('/api/v1/preview/')) {
    return Promise.resolve(
      jsonResponse({
        data: {
          session: {
            id: 'ps-1',
            owner_id: 'u1',
            project_id: 'prj-1',
            state: 'NOT_CONFIGURED',
            build_log: [],
            error: null,
            task_id: null,
            version: 1,
            updated_at: '2026-08-19T00:00:00Z',
            created_at: '2026-08-19T00:00:00Z',
          },
          configured: false,
        },
      }),
    );
  }
  return Promise.resolve(jsonResponse({ data: {} }));
}

describe('WorkspacePage', () => {
  beforeEach(() => {
    commentRows = [];
    stubFetch(handler);
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <ToastProvider>
          <WorkspacePage />
        </ToastProvider>
      </MemoryRouter>,
    );

  it('renders CHAT/CODE/PREVIEW tabs and queues a task', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Core App')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'CHAT' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.type(screen.getByLabelText('Task title'), 'Fix the login flow');
    await userEvent.click(screen.getByRole('button', { name: 'Queue task' }));

    await waitFor(() => expect(screen.getByText(/Task queued: Fix the login flow/)).toBeInTheDocument());
    expect(screen.getByText('Fix the login flow')).toBeInTheDocument();
  });

  it('CODE tab shows the file tree, heatmap and proof of work', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Core App')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: 'CODE' }));

    await waitFor(() => expect(screen.getByText(/app\.tsx/)).toBeInTheDocument());
    expect(screen.getByTestId('heatmap')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/ai: 3 call\(s\)/)).toBeInTheDocument());
    expect(screen.getByTestId('proof-report')).toBeInTheDocument();
  });

  it('PREVIEW tab shows the live panel, adds a comment and surfaces the honest diff', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Core App')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('tab', { name: 'PREVIEW' }));

    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();
    expect(screen.getByText(/Fewer than two snapshots exist/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Element selector'), '.submit-btn');
    await userEvent.type(screen.getByLabelText('Comment'), 'Make it green');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText(/Comment queued as task tsk-9/)).toBeInTheDocument());
    expect(await screen.findByText('Make it green')).toBeInTheDocument();
  });
});