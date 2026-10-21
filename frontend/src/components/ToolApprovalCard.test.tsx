import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolApprovalCard } from './ToolApprovalCard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const call = { approvalId: 'app_t1', server: 'notes', tool: 'create_note', arguments: { title: 'Launch' }, risk: 'MEDIUM', destructive: false };

function stub() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/mcp/approvals/')) return json({ result: { server: 'notes', tool: 'create_note', text: 'created note "Launch"', isError: false } });
      return json({ ok: true });
    }),
  );
  return calls;
}

describe('MCP tool approval card (Article 8)', () => {
  it('shows exactly what will run and that nothing ran yet', () => {
    stub();
    render(<ToolApprovalCard call={call} />);
    expect(screen.getByText('notes.create_note')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has run yet/)).toBeInTheDocument();
    expect(screen.getByText(/"title": "Launch"/)).toBeInTheDocument();
  });

  it('Allow once: approve, then run that exact approval, and show the result', async () => {
    const calls = stub();
    const onResult = vi.fn();
    render(<ToolApprovalCard call={call} onResult={onResult} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByText(/Ran once/)).toBeInTheDocument();
    expect(screen.getByText('created note "Launch"')).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api\/v1/, '')}`)).toEqual([
      'POST /execution/approvals/app_t1/decide',
      'POST /mcp/approvals/app_t1/run',
    ]);
    expect(onResult).toHaveBeenCalledWith('created note "Launch"');
  });

  it('Always allow saves a server/tool allow rule first', async () => {
    const calls = stub();
    render(<ToolApprovalCard call={call} />);
    await userEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    await screen.findByText(/Ran once/);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { effect: 'allow', tool: 'mcp_call', pattern: 'notes/create_note' } });
  });

  it('never offers Always allow for a tool that changes or deletes data; Deny runs nothing', async () => {
    const calls = stub();
    render(<ToolApprovalCard call={{ ...call, tool: 'delete_all', destructive: true, risk: 'HIGH' }} />);
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
    expect(screen.getByText('changes or deletes data')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByText(/the tool did not run/)).toBeInTheDocument());
    expect(calls.some((c) => c.url.includes('/mcp/approvals/'))).toBe(false);
    expect(calls[0]!.body).toEqual({ decision: 'REJECT' });
  });
});
