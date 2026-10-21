import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanLimitsCard, type PlanLimits } from './PlanLimitsCard';
import { forecastLine, sessionLabel, updatedAgo, weeklyLabel } from '../lib/usage';

const monday = '2026-10-26T00:00:00.000Z';
const limits = (over: Partial<PlanLimits> = {}): PlanLimits => ({
  plan: 'solo',
  planLabel: 'Solo',
  session: {
    used: 150_000,
    limit: 300_000,
    pct: 50,
    windowLabel: '5-hour session',
    resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    active: true,
    startedAt: new Date(Date.now() - 210 * 60_000).toISOString(),
  },
  weekly: { used: 600_000, limit: 3_000_000, pct: 20, windowLabel: 'weekly', resetsAt: monday },
  byProduct: { chats: 450_000, cowork: 120_000, code_review: 30_000, api_other: 0 },
  forecast: 'on_track',
  limited: false,
  ...over,
});

describe('PlanLimitsCard (Your usage)', () => {
  it('shows plan, pace, session + week meters and usage by product', async () => {
    const onRefresh = vi.fn();
    render(<PlanLimitsCard limits={limits()} checkedAt={Date.now()} onRefresh={onRefresh} />);
    expect(screen.getByRole('heading', { name: 'Your usage' })).toBeInTheDocument();
    expect(screen.getByText('Solo')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^On track\. You should reach \w+'s reset with room to spare\.$/);
    expect(screen.getByRole('progressbar', { name: 'Current session' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('progressbar', { name: 'This week' })).toHaveAttribute('aria-valuenow', '20');
    expect(screen.getByText(/Resets in 1 hr (29|30) min/)).toBeInTheDocument();
    const products = within(screen.getByRole('list', { name: "This week's usage by product" }));
    expect(products.getByText('Chats').parentElement).toHaveTextContent('75%');
    expect(products.getByText('Cowork').parentElement).toHaveTextContent('20%');
    expect(products.getByText('Code review').parentElement).toHaveTextContent('5%');
    expect(products.getByText('API & other').parentElement).toHaveTextContent('0%');
    expect(screen.getByText('Last updated: less than a minute ago')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check usage now' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('before the first message the session has not started', () => {
    const l = limits({ session: { used: 0, limit: 300_000, pct: 0, windowLabel: '5-hour session', resetsAt: null, active: false, startedAt: null } });
    render(<PlanLimitsCard limits={l} />);
    expect(screen.getByText('Starts with your first message')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Current session' })).toHaveAttribute('aria-valuenow', '0');
  });

  it('explains when a limit is reached', () => {
    render(<PlanLimitsCard limits={limits({ limited: true, forecast: 'limited' })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/reached a usage limit/);
  });

  it('formats labels', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    const s = limits().session;
    expect(sessionLabel({ ...s, resetsAt: '2026-10-20T10:20:00Z' }, now)).toBe('Resets in 20 min');
    expect(sessionLabel({ ...s, resetsAt: '2026-10-20T13:05:00Z' }, now)).toBe('Resets in 3 hr 5 min');
    expect(sessionLabel({ ...s, active: false, resetsAt: null }, now)).toBe('Starts with your first message');
    expect(weeklyLabel(monday)).toMatch(/^Resets (Sunday|Monday) /);
    expect(updatedAgo(now - 30_000, now)).toBe('less than a minute ago');
    expect(updatedAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(forecastLine(limits({ forecast: 'heavy' }))).toMatch(/^Heavy week\./);
  });
});
