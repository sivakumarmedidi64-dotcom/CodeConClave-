import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './Toast';
import { PermissionModeCard, timeLeft } from './PermissionModeControl';

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('Power Mode', () => {
  it('grants Auto for a chosen time and shows the countdown', async () => {
    const puts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)));
          return json({ mode: 'full_access', expiresAt: new Date(Date.now() + 120 * 60_000).toISOString(), revertTo: 'ask' });
        }
        return json({ mode: 'ask', expiresAt: null, revertTo: null });
      }),
    );
    render(
      <ToastProvider>
        <PermissionModeCard />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByRole('radio', { name: /Manual/ })).toHaveAttribute('aria-checked', 'true'));
    await userEvent.selectOptions(screen.getByLabelText(/Power Mode/), 'For 2 hours');
    await userEvent.click(screen.getAllByRole('radio')[2]!); // Auto
    expect(puts).toEqual([{ mode: 'full_access', minutes: 120 }]);
    expect(await screen.findByTestId('power-countdown')).toHaveTextContent(/Auto · 2 hr 0 min left, then back to Manual\./);
    expect(screen.getByRole('button', { name: 'End now' })).toBeInTheDocument();
  });

  it('formats time left', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    expect(timeLeft('2026-10-21T10:04:10Z', now)).toBe('4 min left');
    expect(timeLeft('2026-10-21T10:00:20Z', now)).toBe('1 min left');
    expect(timeLeft('2026-10-21T11:12:00Z', now)).toBe('1 hr 12 min left');
  });
});
