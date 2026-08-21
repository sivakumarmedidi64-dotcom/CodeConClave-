/**
 * CodeConClave — AgentsPage tests (Stage 25.5).
 * Role catalog rendering, agent creation with role-routed eligible models,
 * run start (objective + bounded budget/deadline), run status badges, task
 * list and cancel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { AgentsPage } from './AgentsPage';
import { jsonResponse, stubFetch } from '../testutils';

const ROLES = [
  { role: 'ARCHITECT', label: 'Architect', description: 'System design', computeClass: 'C', coding: false },
  { role: 'CODER', label: 'Coder', description: 'Implements changes', computeClass: 'B', coding: true },
  { role: 'RESEARCHER', label: 'Researcher', description: 'Gathers facts', computeClass: 'A', coding: false },
];

const MODELS = [
  { id: 'gemini-3.7-flash', providerId: 'google', label: 'Gemini Flash', available: true, locked: false, computeClass: 'A' },
  { id: 'claude-sonnet-4', providerId: 'anthropic', label: 'Claude Sonnet', available: true, locked: false, computeClass: 'B' },
  { id: 'claude-opus-4', providerId: 'anthropic', label: 'Claude Opus', available: false, locked: true, computeClass: 'C' },
];

const AGENT = {
  id: 'agt_1',
  owner_id: 'u1',
  name: 'Ship It',
  role: 'CODER',
  objective: 'Build the feature',
  capabilities: [],
  model_provider: 'anthropic',
  model_id: 'claude-sonnet-4',
  max_tasks_per_run: 3,
  max_retries: 1,
  status: 'IDLE',
  current_run_id: null,
  created_at: '2026-08-18T00:00:00.000Z',
  updated_at: '2026-08-18T00:00:00.000Z',
};

function handler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/agents/roles')) return jsonResponse({ data: { roles: ROLES } });
    if (url.includes('/api/v1/ai/models')) return jsonResponse({ data: { models: MODELS } });
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [{ id: 'prj_1', name: 'Main app' }] } });
    if (url.includes('/api/v1/agents/runs/') && init?.method === 'POST') {
      return jsonResponse({ data: { run: { id: 'arn_1' } } });
    }
    if (url.includes('/api/v1/agents/runs/')) {
      return jsonResponse({
        data: {
          run: {
            id: 'arn_1', agent_id: 'agt_1', owner_id: 'u1', project_id: 'prj_1', status: 'RUNNING',
            objective: 'Build the feature', current_task_id: null, total_tasks: 2, completed_tasks: 0,
            failed_tasks: 0, retries_used: 0, budget_usd: 2, spent_usd: 0, deadline_at: null, error: null,
            started_at: '2026-08-18T00:00:00.000Z', completed_at: null, created_at: '2026-08-18T00:00:00.000Z',
          },
          tasks: [{ id: 'tsk_1', status: 'PLANNED', title: 'Design', attempted: false }],
        },
      });
    }
    if (url.includes('/api/v1/agents/') && init?.method === 'POST') {
      return jsonResponse({ data: { run: { id: 'arn_1' } } });
    }
    if (url.includes('/api/v1/agents/') && init?.method === 'DELETE') {
      return jsonResponse({ data: { deleted: true } });
    }
    if (url.includes('/api/v1/agents/')) {
      return jsonResponse({
        data: {
          agent: AGENT,
          runs: [
            {
              id: 'arn_1', agent_id: 'agt_1', owner_id: 'u1', project_id: 'prj_1', status: 'RUNNING',
              objective: 'Build the feature', current_task_id: null, total_tasks: 2, completed_tasks: 1,
              failed_tasks: 0, retries_used: 0, budget_usd: 2, spent_usd: 0.01, deadline_at: null, error: null,
              started_at: '2026-08-18T00:00:00.000Z', completed_at: null, created_at: '2026-08-18T00:00:00.000Z',
            },
          ],
        },
      });
    }
    if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: [AGENT] } });
    if (extra) return extra(url, init);
    return jsonResponse({ data: {} });
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AgentsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentsPage — workspace', () => {
  it('lists agents with role, model and status', async () => {
    stubFetch(handler());
    renderPage();
    expect(await screen.findByText('Ship It')).toBeInTheDocument();
    expect(screen.getByText(/CODER · model claude-sonnet-4/)).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('creates an agent with a role-routed eligible model', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '+ New agent' }));
    await userEvent.type(await screen.findByLabelText('Name'), 'Debugger One');
    const roleSelect = screen.getByLabelText('Role');
    await userEvent.selectOptions(roleSelect, 'CODER');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => {
      const post = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/agents' && i?.method === 'POST');
      expect(post).toBeDefined();
    });
    const body = JSON.parse(String(fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/agents' && i?.method === 'POST')?.[1]?.body));
    expect(body.name).toBe('Debugger One');
    expect(body.role).toBe('CODER');
    expect(body.modelId).toBe('claude-sonnet-4');
    expect(screen.getByText('Agent created')).toBeInTheDocument();
  });

  it('does not offer unavailable/locked models for assignment', async () => {
    stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '+ New agent' }));
    const modelSelect = screen.getByLabelText(/Model/);
    const options = within(modelSelect).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Gemini Flash (google)');
    expect(options).toContain('Claude Sonnet (anthropic)');
    expect(options).not.toContain('Claude Opus (anthropic)');
  });

  it('deletes an idle agent', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/agents/agt_1' && i?.method === 'DELETE')).toBe(true);
    });
    expect(screen.getByText('Agent deleted')).toBeInTheDocument();
  });
});

describe('AgentsPage — runs', () => {
  it('starts a run with objective, project, budget and deadline', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await userEvent.type(await screen.findByLabelText('Objective'), 'Build the feature');
    await userEvent.type(screen.getByLabelText('Subtasks (one per line, optional)'), 'Design\nImplement');
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'prj_1');
    await userEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => {
      const post = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/agents/agt_1/run' && i?.method === 'POST');
      expect(post).toBeDefined();
    });
    const body = JSON.parse(String(fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/agents/agt_1/run' && i?.method === 'POST')?.[1]?.body));
    expect(body.objective).toBe('Build the feature');
    expect(body.subtasks).toEqual([{ title: 'Design' }, { title: 'Implement' }]);
    expect(body.projectId).toBe('prj_1');
    expect(body.budgetUsd).toBe(2);
    expect(body.deadlineMinutes).toBe(120);
    expect(screen.getByText('Agent run started — tasks created through the execution pipeline')).toBeInTheDocument();
  });

  it('shows run tasks and cancels a non-terminal run', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Runs' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Tasks' }));
    expect(await screen.findByText('Design')).toBeInTheDocument();
    expect(screen.getByText('PLANNED')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/agents/runs/arn_1/cancel' && i?.method === 'POST')).toBe(true);
    });
    expect(screen.getByText('Run cancelled')).toBeInTheDocument();
  });
});