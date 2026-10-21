import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuditIntegrityCard } from './AuditIntegrityCard';

const respond = (chain: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { chain } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
afterEach(() => vi.unstubAllGlobals());

describe('AuditIntegrityCard', () => {
  it('shows a verified chain with its latest fingerprint', async () => {
    respond({ ok: true, checked: 42, brokenAt: null, lastHash: 'ab'.repeat(32), legacyRows: 3, checkedAt: new Date().toISOString() });
    render(<AuditIntegrityCard />);
    expect(await screen.findByText(/Verified — 42 records, no tampering found/)).toBeInTheDocument();
    expect(screen.getByText(/abababababababab…/)).toBeInTheDocument();
    expect(screen.getByText(/3 older records/)).toBeInTheDocument();
  });

  it('says exactly where and how the chain broke', async () => {
    respond({ ok: false, checked: 6, brokenAt: { seq: 7, id: 'aud_7', reason: 'truncated' }, lastHash: null, legacyRows: 0, checkedAt: new Date().toISOString() });
    render(<AuditIntegrityCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tampering detected at record #7: the newest records were removed.');
  });
});
