/**
 * CodeConClave — MorningBrief tests.
 *
 * Pins: greeting uses the real display name, each source feeds exactly one
 * honest line, failed sources hide their own line (never break the greeting),
 * mail-off explains how to connect, empty day says all-clear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MorningBrief } from './MorningBrief';

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { displayName: 'Ada Lovelace', email: 'ada@x.com' } }),
}));

function json(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function setup(route: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init ?? {})),
  );
  render(
    <MemoryRouter>
      <MorningBrief />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

const QUIET = () => json({ data: { count: 0 } });

describe('MorningBrief', () => {
  it('greets by display name and reports an all-clear empty day', async () => {
    setup((url) => {
      if (url.includes('/notifications/unread-count')) return json({ data: { count: 0 } });
      if (url.includes('/execution/approvals')) return json({ data: { approvals: [], pendingCount: 0 } });
      if (url.includes('/workspace/return-to-work')) return json({ data: { summary: null } });
      if (url.includes('/plugins/connections')) return json({ data: { connections: [] } });
      return QUIET();
    });
    expect(await screen.findByTestId('morning-brief-hi')).toHaveTextContent('Hi Ada.');
    await waitFor(() => expect(screen.getByText('All clear — nothing needs you right now.')).toBeInTheDocument());
    expect(screen.getByText(/Mail isn.t connected/)).toBeInTheDocument();
  });

  it('lists unread mail subjects when Gmail is connected', async () => {
    setup((url, init) => {
      if (url.includes('/notifications/unread-count')) return json({ data: { count: 2 } });
      if (url.includes('/execution/approvals')) return json({ data: { approvals: [], pendingCount: 1 } });
      if (url.includes('/workspace/return-to-work'))
        return json({ data: { summary: { summaryText: 'Stopped mid-deploy on Friday.', counts: {} } } });
      if (url.includes('/plugins/connections'))
        return json({ data: { connections: [{ id: 'c1', plugin_type: 'google', state: 'CONNECTED' }] } });
      if (url.includes('/plugins/actions') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.action === 'gmail.messages.list') return json({ data: { messages: [{ id: 'm1' }] } });
        return json({
          data: { payload: { headers: [{ name: 'From', value: 'b@c.com' }, { name: 'Subject', value: 'Invoice due' }] }, snippet: '' },
        });
      }
      return QUIET();
    });
    await waitFor(() => expect(screen.getByText(/Invoice due/)).toBeInTheDocument());
    expect(screen.getByText(/2 unread notification/)).toBeInTheDocument();
    expect(screen.getByText(/1 decision waiting on you/)).toBeInTheDocument();
    expect(screen.getByText(/Stopped mid-deploy on Friday/)).toBeInTheDocument();
  });

  it('a failed source hides its own line without breaking the greeting', async () => {
    setup((url) => {
      if (url.includes('/notifications/unread-count')) return json({ data: { count: 0 } });
      if (url.includes('/execution/approvals') || url.includes('/workspace/return-to-work')) {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      if (url.includes('/plugins/connections')) return json({ data: { connections: [] } });
      return QUIET();
    });
    expect(await screen.findByTestId('morning-brief-hi')).toHaveTextContent('Hi Ada.');
    await waitFor(() => expect(screen.queryByText('Checking overnight state…')).not.toBeInTheDocument());
  });
});
