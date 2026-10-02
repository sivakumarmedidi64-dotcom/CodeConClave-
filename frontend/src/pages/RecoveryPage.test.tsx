/**
 * CodeConClave — RecoveryPage tests (Stage 26I).
 * Task picker, autopsy generate/render, checkpoints list, branch and rewind
 * through the recovery API. Rewind blockers and empty states come from the
 * server; the page reports them honestly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { RecoveryPage } from './RecoveryPage';
import { jsonResponse, stubFetch } from '../testutils';

const PROJECTS = [{ id: 'prj_1', name: 'Main app' }];
const TASKS = [
  { id: 'tsk_1', title: 'Fix login', status: 'FAILED' },
  { id: 'tsk_2', title: 'Ship checkout', status: 'RUNNING' },
];

const AUTOPSY = {
  id: 'aut_1', task_id: 'tsk_1', attempt_id: null, owner_id: 'u1', status: 'FAILED',
  root_cause_code: 'APPROVAL_REJECTED', root_cause: 'The approval for this task was rejected.',
  confidence: 0.87, timeline: [], attempts: [], errors: [], dependency_state: {},
  recovery_attempts: [], successful_fix: null,
  prevention: { action: 'request_approval', description: 'Review approvals before retrying.' },
  evidence: {}, memory_id: 'mem_1', created_at: '2026-08-20T00:00:00.000Z',
};

const CHECKPOINT = {
  id: 'chk_1', task_id: 'tsk_2', attempt_id: null, owner_id: 'u1', label: 'before auth change',
  reason: 'milestone', stage_index: 2, task_state: {}, plan_state: null, execution_metadata: {},
  approval_state: null, created_at: '2026-08-20T00:00:00.000Z',
};

function handler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/recovery/tasks/') && init?.method === 'POST' && url.endsWith('/autopsy')) {
      return jsonResponse({ data: { autopsy: AUTOPSY } }, 201);
    }
    if (url.includes('/api/v1/recovery/tasks/') && init?.method === 'POST' && url.includes('/branch')) {
      return jsonResponse({ data: { branchTask: { id: 'tsk_3', title: 'Fix login (before auth change)', status: 'PLANNED' }, branchId: 'br_1' } }, 201);
    }
    if (url.includes('/api/v1/recovery/tasks/') && init?.method === 'POST' && url.includes('/rewind')) {
      return jsonResponse({ data: { branchTask: { id: 'tsk_4', title: 'Fix login (rewound)', status: 'PLANNED' }, branchId: 'br_2' } }, 201);
    }
    if (url.includes('/api/v1/recovery/tasks/') && init?.method === 'POST') {
      return jsonResponse({ data: { checkpoint: CHECKPOINT } }, 201);
    }
    if (url.includes('/api/v1/recovery/tasks/') && url.includes('/checkpoints')) {
      return jsonResponse({ data: { checkpoints: [CHECKPOINT] } });
    }
    if (url.includes('/api/v1/recovery/tasks/') && url.includes('/history')) {
      return jsonResponse({ data: { history: [{ id: 'rh_1', task_id: 'tsk_1', owner_id: 'u1', event: 'AUTOPSY_RECORDED', detail: { code: 'APPROVAL_REJECTED' }, actor: null, created_at: '2026-08-20T00:00:00.000Z' }] } });
    }
    if (url.includes('/api/v1/recovery/tasks/') && url.includes('/autopsy')) {
      return jsonResponse({ data: { autopsy: AUTOPSY, autopsies: [AUTOPSY] } });
    }
    if (url.includes('/api/v1/execution/tasks')) return jsonResponse({ data: { tasks: TASKS } });
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: PROJECTS } });
    if (extra) return extra(url, init);
    return jsonResponse({ data: {} });
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <RecoveryPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('RecoveryPage — task picker', () => {
  it('loads projects and tasks', async () => {
    stubFetch(handler());
    renderPage();
    expect(await screen.findByText('Fix login (FAILED)')).toBeInTheDocument();
    expect(screen.getByText('Ship checkout (RUNNING)')).toBeInTheDocument();
  });
});

describe('RecoveryPage — autopsy', () => {
  it('renders an existing autopsy with root cause and prevention', async () => {
    stubFetch(handler());
    renderPage();
    await screen.findByText('Fix login (FAILED)');
    const taskSelect = screen.getByLabelText('Task');
    await userEvent.selectOptions(taskSelect, 'tsk_1');
    expect(await screen.findByText('APPROVAL_REJECTED')).toBeInTheDocument();
    expect(screen.getByText(/The approval for this task was rejected/)).toBeInTheDocument();
    expect(screen.getByText(/Prevention:/)).toBeInTheDocument();
    expect(screen.getByText('AUTOPSY_RECORDED')).toBeInTheDocument();
  });

  it('generates an autopsy on demand', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await screen.findByText('Fix login (FAILED)');
    const taskSelect = screen.getByLabelText('Task');
    await userEvent.selectOptions(taskSelect, 'tsk_1');
    await userEvent.click(await screen.findByRole('button', { name: '+ Generate autopsy' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/recovery/tasks/tsk_1/autopsy'), expect.objectContaining({ method: 'POST' })));
  });
});

describe('RecoveryPage — time travel', () => {
  it('lists checkpoints and branches from one', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await screen.findByText('Ship checkout (RUNNING)');
    const taskSelect = screen.getByLabelText('Task');
    await userEvent.selectOptions(taskSelect, 'tsk_2');
    await userEvent.click(await screen.findByRole('tab', { name: 'Time travel' }));
    expect(await screen.findByText('before auth change')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Branch' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/recovery/tasks/tsk_2/branch'), expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText(/Created task/)).toBeInTheDocument();
  });

  it('creates a checkpoint snapshot', async () => {
    const fetchFn = stubFetch(handler());
    renderPage();
    await screen.findByText('Ship checkout (RUNNING)');
    const taskSelect = screen.getByLabelText('Task');
    await userEvent.selectOptions(taskSelect, 'tsk_2');
    await userEvent.click(await screen.findByRole('tab', { name: 'Time travel' }));
    await userEvent.type(await screen.findByLabelText('Checkpoint label'), 'pre-release');
    await userEvent.click(screen.getByRole('button', { name: 'Create checkpoint' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/recovery/tasks/tsk_2/checkpoints'), expect.objectContaining({ method: 'POST' })));
  });

  it('shows the idle state before a task is picked', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/execution/tasks')) return jsonResponse({ data: { tasks: [] } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      return jsonResponse({ data: {} });
    });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Time travel' }));
    expect(await screen.findByText(/Select a task to snapshot, branch or rewind it/)).toBeInTheDocument();
  });
});