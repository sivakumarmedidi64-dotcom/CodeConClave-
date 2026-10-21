import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PipelineTrace, ReceiptChip, asReceipt, type PipelineReceipt } from './PipelineReceipt';

afterEach(() => vi.unstubAllGlobals());

const receipt = (over: Partial<PipelineReceipt> = {}): PipelineReceipt => ({
  runId: 'run_1',
  status: 'VERIFIED',
  role: 'Computational Math',
  contractVersion: 'computational-math@abc123def456',
  engine: 'CodeConClave AI · fastqa',
  cached: false,
  attempts: 1,
  tokens: { used: 900, budget: 12588 },
  proofs: [{ kind: 'identity', verifier: 'cas', verdict: 'PASS', method: 'symbolic+numeric', detail: 'symbolic residual = 0; 5 seeded points agree', proofHash: 'f'.repeat(64) }],
  verdict: { passed: 1, failed: 0, errors: 0 },
  proofHash: 'a'.repeat(64),
  gate: [{ check: 'schema', ok: true }, { check: 'domain', ok: true }],
  notes: [],
  ...over,
});

describe('pipeline trace + receipt', () => {
  it('shows each stage live', () => {
    render(<PipelineTrace stages={[{ stage: 'intake', status: 'done', label: 'Intake · budget locked' }, { stage: 'specialist', status: 'start', label: 'Coder · working' }]} />);
    expect(screen.getByText('Intake · budget locked')).toBeInTheDocument();
    expect(screen.getByText('Coder · working').closest('li')).toHaveClass('is-live');
  });

  it('summarises a verified answer and expands to proofs, gate and proof hash', async () => {
    render(<ReceiptChip receipt={receipt()} />);
    expect(screen.getByText('Verified · 1/1 proof pass')).toBeInTheDocument();
    expect(screen.getByText('Computational Math')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/symbolic residual = 0/)).toBeInTheDocument();
    expect(screen.getByText('✓ schema · ✓ domain')).toBeInTheDocument();
    expect(screen.getByText(/aaaaaaaaaaaaaaaa…/)).toBeInTheDocument();
    expect(screen.getByText('CodeConClave AI · fastqa')).toBeInTheDocument();
  });

  it('checks the run ledger on demand', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { chain: { ok: true, checked: 8, brokenAt: null } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(<ReceiptChip receipt={receipt()} />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    await userEvent.click(screen.getByRole('button', { name: /Check the run ledger/ }));
    expect(await screen.findByText('✓ 8 hash-linked events, unbroken')).toBeInTheDocument();
  });

  it('labels escalated and unverified answers honestly', () => {
    const { rerender } = render(<ReceiptChip receipt={receipt({ status: 'ESCALATED', verdict: { passed: 0, failed: 1, errors: 0 } })} />);
    expect(screen.getByText('Escalated · verification failed 3 times')).toBeInTheDocument();
    rerender(<ReceiptChip receipt={receipt({ status: 'UNVERIFIED', proofs: [] })} />);
    expect(screen.getByText('Not machine-checked · no checkable claims')).toBeInTheDocument();
  });

  it('only accepts real receipts from the stream', () => {
    expect(asReceipt(undefined)).toBeUndefined();
    expect(asReceipt({ status: 'VERIFIED' })).toBeUndefined();
    expect(asReceipt(receipt())).toBeDefined();
  });
});
