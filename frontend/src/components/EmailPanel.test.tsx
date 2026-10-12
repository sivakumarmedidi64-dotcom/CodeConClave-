/**
 * CodeConclave — EmailPanel tests.
 *
 * Pins: type-address + Connect starts OAuth with the address as hint; a
 * connected account shows the real inbox; opening uses format=full; replies
 * surface the approval gate (never silent sends); direct execution shows sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EmailPanel } from './EmailPanel';

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
      <EmailPanel />
    </MemoryRouter>,
  );
  return vi.mocked(fetch);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

const META = {
  payload: {
    headers: [
      { name: 'Subject', value: 'Deploy Friday?' },
      { name: 'From', value: 'Boss <boss@x.com>' },
      { name: 'Date', value: 'Fri, 10 Oct 2026' },
    ],
  },
  snippet: 'are we shipping',
};

describe('EmailPanel', () => {
  it('connects by typing an address (hint passed to Google)', async () => {
    const user = userEvent.setup();
    const fetchFn = setup((url, init) => {
      if (url.includes('/plugins/connections') && (!init.method || init.method === 'GET')) {
        return json({ data: { connections: [] } });
      }
      if (url.includes('/plugins/connections') && init.method === 'POST') {
        return json({ data: { connection: { id: 'conn-1', plugin_type: 'google', state: 'PENDING' } } });
      }
      if (url.includes('/plugins/oauth/conn-1/authorize')) return json({ data: { authUrl: 'https://accounts.google.com/o/x' } });
      return json({ data: {} });
    });
    await user.type(await screen.findByTestId('email-connect-input'), 'saharsh@example.com');
    await user.click(screen.getByTestId('email-connect-submit'));
    await waitFor(() => {
      const post = fetchFn.mock.calls.find(([u, i]) => String(u).includes('/plugins/connections') && (i as RequestInit)?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ pluginType: 'google', name: 'saharsh@example.com' });
    });
    const auth = fetchFn.mock.calls.find(([u]) => String(u).includes('/plugins/oauth/conn-1/authorize'));
    expect(String(auth![0])).toContain(`hint=${encodeURIComponent('saharsh@example.com')}`);
  });

  it('reads the inbox and sends replies through the approval gate', async () => {
    const user = userEvent.setup();
    setup((url, init) => {
      if (url.includes('/plugins/connections')) {
        return json({ data: { connections: [{ id: 'c1', plugin_type: 'google', state: 'CONNECTED', name: 'me@x.com' }] } });
      }
      if (url.includes('/plugins/actions') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.action === 'gmail.messages.list') return json({ data: { messages: [{ id: 'm1' }] } });
        if (body.action === 'gmail.messages.get' && body.input?.format === 'metadata') return json({ data: META });
        if (body.action === 'gmail.messages.get' && body.input?.format === 'full') {
          return json({ data: { ...META, threadId: 't1', bodyText: 'full body here', bodyTruncated: false } });
        }
        if (body.action === 'gmail.send') {
          expect(body.input.to).toEqual(['boss@x.com']);
          expect(body.input.subject).toBe('Re: Deploy Friday?');
          expect(body.input.inReplyTo).toBeUndefined();
          return json({ data: { requiresApproval: true, approval: { id: 'ap1', status: 'PENDING' } } });
        }
      }
      return json({ data: {} });
    });
    expect(await screen.findByTestId('email-inbox')).toBeInTheDocument();
    expect(await screen.findByText('Deploy Friday?')).toBeInTheDocument();
    await user.click(screen.getByTestId('email-open-m1'));
    expect(await screen.findByTestId('email-reader')).toBeInTheDocument();
    expect(screen.getByText('full body here')).toBeInTheDocument();
    await user.type(screen.getByTestId('email-reply-body'), 'Shipping Monday.');
    await user.click(screen.getByTestId('email-reply-send'));
    const notice = await screen.findByTestId('email-approval-notice');
    expect(notice).toHaveTextContent('waiting on your approval');
    expect(notice.querySelector('a')?.getAttribute('href')).toBe('/approvals');
  });

  it('shows sent when the server executes directly', async () => {
    const user = userEvent.setup();
    setup((url, init) => {
      if (url.includes('/plugins/connections')) {
        return json({ data: { connections: [{ id: 'c1', plugin_type: 'google', state: 'CONNECTED' }] } });
      }
      if (url.includes('/plugins/actions') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.action === 'gmail.messages.list') return json({ data: { messages: [{ id: 'm1' }] } });
        if (body.action === 'gmail.messages.get') return json({ data: { ...META, threadId: '', bodyText: 'b', bodyTruncated: false } });
        if (body.action === 'gmail.send') return json({ data: { executed: true, approvalId: null, result: { id: 'gm-1' } } });
      }
      return json({ data: {} });
    });
    await user.click(await screen.findByTestId('email-open-m1'));
    await user.type(await screen.findByTestId('email-reply-body'), 'ok');
    await user.click(screen.getByTestId('email-reply-send'));
    expect(await screen.findByTestId('email-sent')).toHaveTextContent('gm-1');
  });
});
