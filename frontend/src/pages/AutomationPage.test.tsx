/**
 * CodeConClave — AutomationPage tests (Stage 26I).
 * Schedules list/create/pause/run-now/delete, goals list/create/plan/approve,
 * escalations raise/decide. All responses are server-shaped; the page renders
 * them honestly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { AutomationPage } from './AutomationPage';
import { jsonResponse, stubFetch } from '../testutils';

const SCHEDULE = {
  id: 'sch_1', owner_id: 'u1', project_id: null, agent_id: 'agt_1', title: 'Nightly build',
  description: 'Every day at 09:00 (UTC)', recurrence: 'DAILY', cron_expression: null,
  timezone: 'UTC', run_at: '09:00', run_on_days: [], enabled: true,
  execution_mode: 'CLOUD', missed_run_policy: 'RUN_ON_RECOVERY',
  next_run_at: '2026-08-21T09:00:00.000Z', last_run_at: null, last_run_status: null,
  run_count: 0, require_approval: false, timeout_ms: 900000, max_attempts: 3,
  notify_on_completion: false, error: null, created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z',
};

const GOAL = {
  id: 'gl_1', owner_id: 'u1', project_id: null, title: 'Launch v2', objective: 'Ship the checkout redesign',
  success_criteria: ['Checkout passes'], constraints: [], status: 'PLAN_READY', plan: [],
  progress: {}, evidence: [], blockers: [], budget_usd: 5, spent_usd: 0, deadline_at: null,
  estimated_cost_usd: null, require_approval: true, approval_id: null, approved_at: null,
  error: null, completed_at: null, created_at: '2026-08-20T00:00:00.000Z', updated_at: '2026-08-20T00:00:00.000Z',
};

const ESCALATION = {
  id: 'esc_1', owner_id: 'u1', goal_id: 'gl_1', schedule_id: null, issue: 'API key rotation blocked',
  evidence: [], attempted_actions: ['retry'], options: ['APPROVE', 'RETRY'], recommendation: 'Rotate now',
  risk: 'HIGH', status: 'OPEN', user_decision: null, decision_note: null, resolved_at: null,
  created_at: '2026-08-20T00:00:00.000Z',
};

const AGENTS = [{ id: 'agt_1', name: 'Ship It', role: 'CODER', status: 'IDLE' }];
const PROJECTS = [{ id: 'prj_1', name: 'Main app' }];

function handler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/scheduling/schedules') && init?.method === 'POST') {
      return jsonResponse({ data: { schedule: SCHEDULE } }, 201);
    }
    if (url.includes('/api/v1/scheduling/schedules/')) {
      return jsonResponse({ data: { runs: [] } });
    }
    if (url.includes('/api/v1/scheduling/schedules')) {
      return jsonResponse({ data: { schedules: [SCHEDULE] } });
    }
    if (url.endsWith('/api/v1/scheduling/goals') && init?.method === 'POST') {
      return jsonResponse({ data: { goal: { ...GOAL, status: 'PLANNING' } } }, 201);
    }
    if (url.includes('/api/v1/scheduling/goals/') && init?.method === 'POST') {
      return jsonResponse({ data: { goal: { ...GOAL, status: 'PLAN_READY' } } });
    }
    if (url.includes('/api/v1/scheduling/goals')) {
      return jsonResponse({ data: { goals: [GOAL] } });
    }
    if (url.includes('/api/v1/scheduling/escalations/')) {
      return jsonResponse({ data: { escalation: { ...ESCALATION, status: 'RESOLVED', user_decision: 'APPROVE' } } });
    }
    if (url.includes('/api/v1/scheduling/escalations')) {
      return jsonResponse({ data: { escalations: [ESCALATION] } });
    }
    if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: AGENTS } });
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: PROJECTS } });
    if (extra) return extra(url, init);
    return jsonResponse({ data: {} });
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AutomationPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('AutomationPage — schedules', () => {
  it('lists schedules with cadence and next run', async () => {
    stubFetch(handler());
    renderPage();
    expect(await screen.findByText('Nightly build')).toBeInTheDocument();
    expect(screen.getByText(/Every day at 09:00/)).toBeInTheDocument();
    expect(screen.getByText(/CLOUD · missed: RUN_ON_RECOVERY/)).toBeInTheDocument();
  });

  it('creates a schedule through the scheduling API', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '+ New schedule' }));
    await userEvent.type(await screen.findByLabelText('Title'), 'Weekly backup');
    await userEvent.type(await screen.findByLabelText('Task prompt'), 'Run backups');
    await userEvent.selectOptions(await screen.findByLabelText('Agent'), 'agt_1');
    await userEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/schedules'), expect.objectContaining({ method: 'POST' })));
  });

  it('pauses and deletes a schedule', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/schedules/sch_1/pause'), expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/schedules/sch_1'), expect.objectContaining({ method: 'DELETE' })));
  });
});

describe('AutomationPage — goals', () => {
  it('shows goal status and plan steps', async () => {
    const withPlan = { ...GOAL, plan: [{ id: 'p1', title: 'Design checkout', description: null, role: null, agentId: null, dependsOn: [], risk: 'MEDIUM', status: 'COMPLETED', runId: null, taskIds: [], attempts: 1, error: null }] };
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/scheduling/goals')) return jsonResponse({ data: { goals: [withPlan] } });
      if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: AGENTS } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: PROJECTS } });
      return jsonResponse({ data: {} });
    });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Goals' }));
    expect(await screen.findByText('Launch v2')).toBeInTheDocument();
    expect(screen.getByText('PLAN_READY')).toBeInTheDocument();
    expect(screen.getByText('Design checkout')).toBeInTheDocument();
  });

  it('creates a goal with criteria and triggers plan generation', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Goals' }));
    await userEvent.click(await screen.findByRole('button', { name: '+ New goal' }));
    await userEvent.type(await screen.findByLabelText('Title'), 'Fix onboarding');
    await userEvent.type(await screen.findByLabelText('Objective'), 'Reduce drop-off');
    await userEvent.type(await screen.findByLabelText('Success criteria (one per line)'), 'Drop-off < 20%');
    await userEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/goals'), expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/goals/gl_1/plan'), expect.objectContaining({ method: 'POST' })));
  });

  it('approves a goal waiting for approval', async () => {
    const pending = { ...GOAL, status: 'WAITING_FOR_APPROVAL' };
    const fetchFn = stubFetch(async (url, init) => {
      if (url.endsWith('/api/v1/scheduling/goals') && init?.method === 'POST') return jsonResponse({ data: { goal: pending } }, 201);
      if (url.includes('/api/v1/scheduling/goals/') && init?.method === 'POST') return jsonResponse({ data: { goal: { ...pending, status: 'RUNNING' } } });
      if (url.includes('/api/v1/scheduling/goals')) return jsonResponse({ data: { goals: [pending] } });
      if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: AGENTS } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: PROJECTS } });
      return jsonResponse({ data: {} });
    });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Goals' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/goals/gl_1/approve'), expect.objectContaining({ method: 'POST' })));
  });
});

describe('AutomationPage — escalations', () => {
  it('lists escalations and records a decision', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Escalations' }));
    expect(await screen.findByText('API key rotation blocked')).toBeInTheDocument();
    expect(screen.getByText('HIGH')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'APPROVE' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/escalations/esc_1/decide'), expect.objectContaining({ method: 'POST' })));
  });

  it('raises a manual escalation', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Escalations' }));
    await userEvent.type(await screen.findByLabelText('Issue'), 'Provider outage');
    await userEvent.click(screen.getByRole('button', { name: 'Raise' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/scheduling/escalations'), expect.objectContaining({ method: 'POST' })));
  });
});