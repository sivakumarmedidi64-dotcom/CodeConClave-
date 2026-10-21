import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PipelinePage } from './PipelinePage';

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

function stub() {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/api/v1/pipeline/registry')) {
        return json({ roles: [{ role: 'Statistics', lane: 'science', science: true, contractVersion: 'statistics@0123456789ab', driver: 'codeconclave-fastqa', residentReady: false, residentNote: 'not configured', claimKinds: ['stats'] }] });
      }
      if (url.includes('/api/v1/pipeline/runs/run_1')) {
        return json({
          run: { id: 'run_1', status: 'VERIFIED', role: 'Statistics', receipt: null },
          events: [
            { seq: 1, stage: 'intake', payload: {}, event_hash: 'a'.repeat(64), created_at: new Date().toISOString() },
            { seq: 2, stage: 'seal', payload: { status: 'VERIFIED', proofHash: 'b'.repeat(64) }, event_hash: 'c'.repeat(64), created_at: new Date().toISOString() },
          ],
          chain: { ok: true, checked: 2, brokenAt: null },
        });
      }
      if (url.includes('/api/v1/pipeline/runs')) {
        return json({ runs: [{ id: 'run_1', status: 'VERIFIED', role: 'Statistics', risk: 'low', attempts: 1, tokensUsed: 800, budgetTokens: 12588, proofHash: 'b'.repeat(64), createdAt: new Date().toISOString() }] });
      }
      if (url.endsWith('/api/v1/pipeline/verify')) {
        return json({ kernel: { proofs: [{ index: 0, kind: 'identity', verifier: 'cas', verdict: 'PASS', method: 'symbolic+numeric', detail: 'symbolic residual = 0', proofHash: 'd'.repeat(64) }] } });
      }
      return json({});
    }),
  );
  return calls;
}

describe('PipelinePage', () => {
  it('shows the registry, runs, a run ledger, and verifies claims', async () => {
    const calls = stub();
    render(<PipelinePage />);
    expect(await screen.findByText('Statistics', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/own model offline \(cloud fallback\)/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Ledger' }));
    const run = await screen.findByTestId('run-detail');
    expect(within(run).getByText('✓ Ledger verified · 2 hash-linked events')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Verify/ }));
    expect(await screen.findByText('symbolic residual = 0')).toBeInTheDocument();
    const verifyCall = calls.find((c) => c.url.endsWith('/api/v1/pipeline/verify'))!;
    expect((verifyCall.body as { claims: unknown[] }).claims).toHaveLength(3); // the example claims
  });

  it('reports invalid claims JSON without calling the server', async () => {
    const calls = stub();
    render(<PipelinePage />);
    const box = screen.getByLabelText('Claims JSON');
    await userEvent.clear(box);
    await userEvent.type(box, 'not json');
    await userEvent.click(screen.getByRole('button', { name: /Verify/ }));
    expect(await screen.findByText(/Not valid JSON/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/verify'))).toBe(false);
  });
});
