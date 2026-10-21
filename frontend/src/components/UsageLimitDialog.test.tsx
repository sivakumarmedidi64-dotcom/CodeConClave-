import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { reportLimitError, untilText, UsageLimitHost, UsageNearLimit } from './UsageLimitDialog';

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Limit Guard', () => {
  it('formats the time until reset', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    expect(untilText('2026-10-21T10:25:00Z', now)).toBe('in 25 min');
    expect(untilText('2026-10-21T12:10:00Z', now)).toBe('in 2 hr 10 min');
    expect(untilText('2026-10-26T10:00:00Z', now)).toBe('in 5 days');
    expect(untilText('2026-10-21T09:00:00Z', now)).toBe('now');
    expect(untilText(null, now)).toBe('soon');
  });

  it('ignores errors that are not limits', () => {
    const seen = vi.fn();
    window.addEventListener('cc:usage-limit-hit', seen);
    expect(reportLimitError('rate_limited', 'slow down')).toBe(false);
    expect(reportLimitError(undefined, 'x')).toBe(false);
    window.removeEventListener('cc:usage-limit-hit', seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('pops up with the window, reset time and meter when a limit is hit, and closes on Esc', async () => {
    render(
      <MemoryRouter>
        <UsageLimitHost />
      </MemoryRouter>,
    );
    const resetsAt = new Date(Date.now() + 90 * 60_000).toISOString();
    act(() => {
      expect(reportLimitError('usage_limit_reached', 'Weekly limit reached', { window: 'weekly', resetsAt, used: 50, limit: 50, plan: 'pro' })).toBe(true);
    });
    const dialog = await screen.findByRole('dialog', { name: "You've reached your weekly limit" });
    expect(dialog).toHaveTextContent(/resets at/);
    expect(dialog).toHaveTextContent(/in 1 hr 30 min|in 1 hr 29 min/);
    expect(screen.getByLabelText('100% used')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View usage' })).toHaveAttribute('href', '/settings?tab=usage');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends people without a plan to plans', async () => {
    render(
      <MemoryRouter>
        <UsageLimitHost />
      </MemoryRouter>,
    );
    act(() => {
      reportLimitError('plan_required', 'CodeConClave AI needs an active plan.');
    });
    expect(await screen.findByRole('dialog', { name: 'Choose a plan to use CodeConClave AI' })).toHaveTextContent('CodeConClave AI needs an active plan.');
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings?tab=billing');
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  const limits = (sessionPct: number, weeklyPct: number) => ({
    limits: {
      plan: 'pro',
      planLabel: 'Solo',
      session: { used: sessionPct, limit: 100, pct: sessionPct, windowLabel: '5 hours', resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      weekly: { used: weeklyPct, limit: 100, pct: weeklyPct, windowLabel: 'week', resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
      limited: false,
    },
  });

  it('warns quietly before the wall and can be dismissed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(limits(85, 20))));
    render(
      <MemoryRouter>
        <UsageNearLimit />
      </MemoryRouter>,
    );
    const banner = await screen.findByTestId('near-limit');
    expect(banner).toHaveTextContent("You've used 85% of this session");
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('near-limit')).toBeNull();
  });

  it('stays hidden when usage is comfortable', async () => {
    const fetchMock = vi.fn(async () => json(limits(30, 40)));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <UsageNearLimit />
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('near-limit')).toBeNull();
  });
});
