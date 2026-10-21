import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import { EmergencyStopButton, HoldBanner, STOP_EVERYTHING, summarizeStop } from './EmergencyStop';

let held = false;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/api/v1/control/emergency-stop')) {
    if (init?.method === 'POST') {
      held = true;
      return json({ stopped: { assignmentsCancelled: 1, assignmentsFailed: 0, tasksCancelled: 2, tasksSkipped: 0 }, hold: { held: true, heldSince: new Date().toISOString(), reason: 'Stop everything' } });
    }
    if (init?.method === 'DELETE') {
      held = false;
      return json({ hold: { held: false, heldSince: null, reason: null } });
    }
    return json({ hold: held ? { held: true, heldSince: new Date().toISOString(), reason: 'x' } : { held: false, heldSince: null, reason: null } });
  }
  return json({});
});
function json(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  held = false;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ui = () =>
  render(
    <ToastProvider>
      <EmergencyStopButton />
      <HoldBanner />
    </ToastProvider>,
  );

describe('Stop everything', () => {
  it('asks once, stops, shows the hold banner, and Resume clears it', async () => {
    ui();
    await userEvent.click(screen.getByRole('button', { name: 'Stop everything' }));
    expect(screen.getByRole('dialog', { name: 'Stop everything' })).toHaveTextContent(/Nothing is deleted/);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Stop everything' })).getByRole('button', { name: 'Stop everything' }));
    await waitFor(() => expect(screen.getByTestId('hold-banner')).toHaveTextContent('Everything is stopped.'));
    expect(screen.getByText(/Stopped 2 tasks and 1 laptop action\./)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.queryByTestId('hold-banner')).not.toBeInTheDocument());
  });

  it('the keyboard shortcut stops immediately (no confirm)', async () => {
    ui();
    window.dispatchEvent(new Event(STOP_EVERYTHING));
    await waitFor(() => expect(screen.getByTestId('hold-banner')).toBeInTheDocument());
  });

  it('summarizes honestly, including work that could not be cancelled', () => {
    expect(summarizeStop({ assignmentsCancelled: 0, assignmentsFailed: 1, tasksCancelled: 1, tasksSkipped: 2 })).toBe(
      'Stopped 1 task and 0 laptop actions (3 already finishing or unreachable). Scheduled and automated work is on hold until you resume.',
    );
  });
});
