/**
 * CodeConClave — Approval Center page tests (PHASE 4C).
 * Honest states: pending/approved/rejected/expired/executed/execution failed
 * are only rendered from the server record — never from a button click.
 * Execution waits for the server result (SUCCEEDED/FAILED) and renders it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ApprovalsPage } from './ApprovalsPage';
import { mapApproval } from '../lib/types';

function snakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'app_1',
    task_id: 'tsk_1',
    owner_id: 'usr_1',
    detail: {},
    risk_level: 'HIGH',
    status: 'PENDING',
    decision: null,
    decided_by: null,
    decided_at: null,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    action_type: 'file_delete',
    coworker: 'tester',
    model: 'deepseek-v4',
    justification: 'remove dead code',
    affected_resources: [{ type: 'file', ref: 'src/old.ts' }],
    proposed_action: { tool: 'file_delete', input: { path: 'src/old.ts' } },
    execution_status: null,
    execution_started_at: null,
    execution_completed_at: null,
    execution_result: null,
    audit_reference: null,
    batch_group: null,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    blob: async () => new Blob(['png'], { type: 'image/png' }),
  } as unknown as Response;
}

function renderPage(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = vi.fn(handler);
  vi.stubGlobal('fetch', fetchFn);
  const result = render(
    <MemoryRouter>
      <ToastProvider>
        <ApprovalsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('mapApproval — snake_case row to camelCase', () => {
  it('maps the full phase 4c record', () => {
    const a = mapApproval(snakeRow());
    expect(a.riskLevel).toBe('HIGH');
    expect(a.taskId).toBe('tsk_1');
    expect(a.actionType).toBe('file_delete');
    expect(a.coworker).toBe('tester');
    expect(a.model).toBe('deepseek-v4');
    expect(a.justification).toBe('remove dead code');
    expect(a.affectedResources![0]!.ref).toBe('src/old.ts');
    expect(a.executionStatus).toBeNull();
  });

  it('maps execution results honestly', () => {
    const failed = mapApproval(
      snakeRow({
        status: 'EXECUTED',
        execution_status: 'FAILED',
        execution_result: { error: 'disk full' },
        execution_completed_at: new Date().toISOString(),
        audit_reference: 'tool:file_delete',
      }),
    );
    expect(failed.status).toBe('EXECUTED');
    expect(failed.executionStatus).toBe('FAILED');
    expect((failed.executionResult as { error: string }).error).toBe('disk full');
  });
});

describe('ApprovalsPage — pending approvals', () => {
  it('renders risk, action type, justification, resources, metadata and countdown', async () => {
    renderPage(async (url) => {
      if (url.includes('/approvals?')) return jsonResponse({ data: { approvals: [snakeRow()], pendingCount: 1 } });
      return jsonResponse({ data: {} });
    });
    await waitFor(() => expect(screen.getByText('HIGH')).toBeInTheDocument());
    expect(screen.getByText('file_delete')).toBeInTheDocument();
    expect(screen.getByText('remove dead code')).toBeInTheDocument();
    expect(screen.getByText('src/old.ts')).toBeInTheDocument();
    expect(screen.getByText(/coworker: tester/)).toBeInTheDocument();
    expect(screen.getByText(/model: deepseek-v4/)).toBeInTheDocument();
    expect(screen.getByText(/1 pending/)).toBeInTheDocument();
    expect(screen.getByTestId('countdown-app_1')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('approves and refreshes the list', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/decide')) {
        return jsonResponse({ data: { approval: snakeRow({ status: 'APPROVED', decision: 'APPROVE' }) } });
      }
      return jsonResponse({ data: { approvals: [snakeRow()], pendingCount: 1 } });
    });
    renderPage(fetchFn);
    await waitFor(() => expect(screen.getByText('Approve')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Approve'));
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([u, init]) => String(u).includes('/decide') && init?.method === 'POST')).toBe(true),
    );
  });

  it('rejects with a reason', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/decide')) {
        const body = JSON.parse(String(init.body)) as { decision: string; reason?: string };
        expect(body.decision).toBe('REJECT');
        expect(body.reason).toBe('not now');
        return jsonResponse({ data: { approval: snakeRow({ status: 'REJECTED', decision: 'REJECT' }) } });
      }
      return jsonResponse({ data: { approvals: [snakeRow()], pendingCount: 1 } });
    });
    renderPage(fetchFn);
    await waitFor(() => expect(screen.getByText('Reject')).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText('reason (optional)'), 'not now');
    await userEvent.click(screen.getByText('Reject'));
    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('ApprovalsPage — human-gate execution is honest', () => {
  it('approved approval renders an execute form and shows the server SUCCEEDED result', async () => {
    renderPage(async (url, init) => {
      if (init?.method === 'POST' && String(url).includes('/execute')) {
        return jsonResponse({
          data: {
            approval: snakeRow({
              status: 'EXECUTED',
              execution_status: 'SUCCEEDED',
              execution_result: { ok: true },
              execution_completed_at: new Date().toISOString(),
              audit_reference: 'tool:file_delete',
            }),
          },
        });
      }
      return jsonResponse({ data: { approvals: [snakeRow({ status: 'APPROVED' })], pendingCount: 0 } });
    });
    await waitFor(() => expect(screen.getByTestId('execute-app_1')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('execute-app_1'));
    await waitFor(() => expect(screen.getByTestId('execution-app_1')).toHaveTextContent('executed'));
  });

  it('renders execution failure with the server error — never a fake success', async () => {
    renderPage(async (url, init) => {
      if (init?.method === 'POST' && String(url).includes('/execute')) {
        return jsonResponse({
          data: {
            approval: snakeRow({
              status: 'EXECUTED',
              execution_status: 'FAILED',
              execution_result: { error: 'disk full' },
              execution_completed_at: new Date().toISOString(),
            }),
          },
        });
      }
      return jsonResponse({ data: { approvals: [snakeRow({ status: 'APPROVED' })], pendingCount: 0 } });
    });
    await waitFor(() => expect(screen.getByTestId('execute-app_1')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('execute-app_1'));
    await waitFor(() => expect(screen.getByTestId('execution-app_1')).toHaveTextContent('execution failed'));
    expect(screen.getByText('disk full')).toBeInTheDocument();
  });

  it('refuses malformed execution input JSON without calling the server', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (String(url).includes('/approvals?')) return jsonResponse({ data: { approvals: [snakeRow({ status: 'APPROVED' })], pendingCount: 0 } });
      return jsonResponse({ data: {} });
    });
    renderPage(fetchFn);
    await waitFor(() => expect(screen.getByTestId('execute-app_1')).toBeInTheDocument());
    await userEvent.type(screen.getByTestId('input-app_1'), 'not-json');
    await userEvent.click(screen.getByTestId('execute-app_1'));
    await waitFor(() => expect(screen.getByText('Execution input must be valid JSON')).toBeInTheDocument());
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes('/execute'))).toBe(false);
  });

  it('approval never claims execution from a mere approve click — status stays approved until the server says executed', async () => {
    const fetchFn = vi.fn(async (url, init) => {
      if (init?.method === 'POST' && String(url).includes('/decide')) {
        return jsonResponse({ data: { approval: snakeRow({ status: 'APPROVED', decision: 'APPROVE' }) } });
      }
      return jsonResponse({ data: { approvals: [snakeRow({ status: 'APPROVED', decision: 'APPROVE' })], pendingCount: 0 } });
    });
    renderPage(fetchFn);
    await waitFor(() => expect(screen.getByTestId('status-app_1')).toHaveTextContent('approved'));
    expect(screen.queryByText('executed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('execution-app_1')).not.toBeInTheDocument();
  });
});

describe('ApprovalsPage — honest state rendering', () => {
  it('renders rejected, expired and executed rows with their true labels', async () => {
    renderPage(async (url) => {
      if (url.includes('?status=')) {
        return jsonResponse({
          data: {
            approvals: [
              snakeRow({ id: 'app_r', status: 'REJECTED', decision: 'REJECT' }),
              snakeRow({ id: 'app_e', status: 'EXPIRED' }),
              snakeRow({ id: 'app_x', status: 'EXECUTED', execution_status: 'SUCCEEDED' }),
            ],
            pendingCount: 0,
          },
        });
      }
      return jsonResponse({ data: { approvals: [], pendingCount: 0 } });
    });
    await waitFor(() => expect(screen.getByTestId('status-app_r')).toHaveTextContent('rejected'));
    expect(screen.getByTestId('status-app_e')).toHaveTextContent('expired');
    expect(screen.getByTestId('status-app_x')).toHaveTextContent('executed');
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Reject')).not.toBeInTheDocument();
  });
});