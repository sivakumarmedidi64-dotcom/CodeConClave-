import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionRulesCard } from './PermissionRulesCard';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('permission rules card (Article 1)', () => {
  it('adds a rule through the API and shows it, then removes it', async () => {
    let rules: unknown[] = [];
    const calls: { method: string; body?: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'POST') {
          const b = JSON.parse(String(init!.body));
          rules = [{ id: 'prl_1', ...b, note: b.note ?? null, createdAt: new Date().toISOString() }];
          return json({ rule: rules[0] }, 201);
        }
        if (method === 'DELETE') {
          rules = [];
          return json({ deleted: true });
        }
        return json({ rules, tools: ['*', 'file_write', 'terminal_exec'] });
      }),
    );
    render(<PermissionRulesCard />);
    expect(await screen.findByTestId('permission-rules-empty')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Rule effect'), 'deny');
    await userEvent.selectOptions(screen.getByLabelText('Rule action'), 'terminal_exec');
    await userEvent.type(screen.getByLabelText('Rule pattern'), 'npm publish*');
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByText('npm publish*')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ effect: 'deny', tool: 'terminal_exec', pattern: 'npm publish*' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove rule npm publish*' }));
    await waitFor(() => expect(screen.queryByText('npm publish*')).not.toBeInTheDocument());
  });

  it('shows the server refusal (e.g. a rule that is too broad)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? 'GET').toUpperCase() === 'POST'
          ? json({ code: 'rule_too_broad', message: 'An allow rule for every tool and every target is too broad.' }, 400)
          : json({ rules: [] }),
      ),
    );
    render(<PermissionRulesCard />);
    await screen.findByTestId('permission-rules-empty');
    await userEvent.selectOptions(screen.getByLabelText('Rule effect'), 'allow');
    await userEvent.selectOptions(screen.getByLabelText('Rule action'), '*');
    await userEvent.type(screen.getByLabelText('Rule pattern'), '*');
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too broad/);
  });
});
