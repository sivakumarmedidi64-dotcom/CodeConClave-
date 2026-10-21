import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanApprovalCard, PlanSteps, asPlanSummary, botName } from './PlanApproval';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const plan = {
  goal: 'Add a health check',
  source: 'planner',
  steps: [
    { order: 1, coworker: 'ARCHITECT', acceptanceCriteria: 'route designed' },
    { order: 2, coworker: 'CODER' },
    { order: 3, coworker: 'TESTER', risk: 'MEDIUM' },
  ],
};

describe('plan first (Article 5)', () => {
  it('reads the approval/done-event plan shape and rejects anything else', () => {
    expect(asPlanSummary({ kind: 'plan', ...plan })?.steps).toHaveLength(3);
    expect(asPlanSummary({ steps: [] })).toBeNull();
    expect(asPlanSummary('nope')).toBeNull();
    expect(botName('CODER')).toBe('Cody · Coder');
  });

  it('lists the bots in order with their done-when criteria', () => {
    render(<PlanSteps plan={plan} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Archie · Architect — done when: route designed');
    expect(items[2]).toHaveTextContent('medium risk');
  });

  it('approving goes through the real approvals endpoint and starts the team', async () => {
    const fetchMock = vi.fn(async () => json({ approval: { id: 'app_1', status: 'APPROVED' } }));
    vi.stubGlobal('fetch', fetchMock);
    const onApproved = vi.fn();
    render(<PlanApprovalCard approvalId="app_1" plan={plan} onApproved={onApproved} />);
    expect(screen.getByText(/nothing runs until you approve/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve and start' }));
    expect(await screen.findByText(/Approved — the team is starting/)).toBeInTheDocument();
    expect(onApproved).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/execution/approvals/app_1/decide');
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'APPROVE' });
  });

  it('rejecting says plainly that nothing ran', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ approval: { id: 'app_2', status: 'REJECTED' } })));
    render(<PlanApprovalCard approvalId="app_2" plan={plan} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText(/nothing ran/)).toBeInTheDocument();
  });

  it('shows the server error when the approval expired, and the fallback-plan note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'approval_not_pending', message: 'Approval is already expired' }, 409)));
    render(<PlanApprovalCard approvalId="app_3" plan={{ ...plan, source: 'default_fallback' }} />);
    expect(screen.getByText(/standard team plan/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve and start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/);
  });
});
