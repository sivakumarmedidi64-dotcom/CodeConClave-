import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiCreditsCard } from './ApiCreditsCard';
import { ApiUsageChip, inr } from './ApiUsageChip';

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const credits = (balance: number, granted = 5_000_000) => ({
  credits: { balancePaise: balance, grantedPaise: granted, spentPaise: granted - balance, calls: 1204, exhausted: balance <= 0, topupInr: 50000, lastTopupAt: null, rate: { paisePer1kTokens: 100, minPaisePerCall: 10 } },
  entries: [
    { kind: 'GRANT', amountPaise: 5_000_000, tokens: null, note: 'API Access purchase (₹50,000)', createdAt: new Date().toISOString() },
    { kind: 'DEBIT', amountPaise: -250, tokens: 2500, note: 'API call', createdAt: new Date().toISOString() },
  ],
});

describe('API credits', () => {
  it('formats rupees', () => {
    expect(inr(5_000_000)).toBe('₹50,000');
    expect(inr(250)).toBe('₹2.50');
    expect(inr(-30)).toBe('₹0');
  });

  it('shows the balance, usage, rate and recent activity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(credits(4_823_000))));
    render(
      <MemoryRouter>
        <ApiCreditsCard />
      </MemoryRouter>,
    );
    expect(await screen.findByText('₹48,230')).toBeInTheDocument();
    expect(screen.getByText(/left of ₹50,000 bought/)).toBeInTheDocument();
    expect(screen.getByText(/1,204 API calls/)).toBeInTheDocument();
    expect(screen.getByText(/API call · 2,500 tokens/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Top up ₹50,000' })).toBeInTheDocument();
  });

  it('says plainly when credits are used up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(credits(0))));
    render(
      <MemoryRouter>
        <ApiCreditsCard />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/refusing new calls/)).toBeInTheDocument();
  });

  it('the top-right meter shows credits left and calls today, and "Top up" at ₹0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/credits') ? json(credits(0)) : json({ today: 37, dailyLimitPerKey: 500, windowLimit: 60, windowSeconds: 60, keys: [{ id: 'k', name: 'prod', today: 37 }] }),
      ),
    );
    render(
      <MemoryRouter>
        <ApiUsageChip />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/API · Top up ₹50,000/)).toBeInTheDocument();
  });
});
