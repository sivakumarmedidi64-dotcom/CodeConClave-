import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import { AccountDataPanel } from './AccountDataPanel';
import { jsonResponse, stubFetch } from '../testutils';

const pending = {
  id: 'adr_1',
  state: 'PENDING',
  requestedAt: '2026-10-20T00:00:00.000Z',
  dueAt: '2026-11-19T00:00:00.000Z',
  cancelledAt: null,
  completedAt: null,
};

function renderPanel() {
  return render(
    <ToastProvider>
      <AccountDataPanel email="me@example.test" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountDataPanel', () => {
  it('only enables scheduling once the exact email is typed, then shows the pending date', async () => {
    const fetchFn = stubFetch(async (_url, init) => {
      if (init?.method === 'POST') return jsonResponse({ data: { request: pending } }, 201);
      return jsonResponse({ data: { request: null } });
    });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    const schedule = screen.getByRole('button', { name: 'Schedule deletion' });
    expect(schedule).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Confirm account email'), 'ME@example.test');
    expect(schedule).toBeEnabled();
    await userEvent.click(schedule);
    expect(await screen.findByRole('status')).toHaveTextContent(/Deletion is scheduled for/);
    const post = fetchFn.mock.calls.find(([, i]) => i?.method === 'POST');
    expect(String(post?.[1]?.body)).toContain('"confirmEmail":"ME@example.test"');
  });

  it('cancels a pending deletion', async () => {
    const fetchFn = stubFetch(async (_url, init) => {
      if (init?.method === 'DELETE') return jsonResponse({ data: { request: { ...pending, state: 'CANCELLED', cancelledAt: '2026-10-21T00:00:00.000Z' } } });
      return jsonResponse({ data: { request: pending } });
    });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel deletion' }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(true));
    expect(await screen.findByText(/previous request was cancelled/)).toBeInTheDocument();
  });
});
