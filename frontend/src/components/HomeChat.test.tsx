/**
 * CodeConClave — HomeChat tests. The all-in-one Cursor-style composer on Home:
 * streams a reply through the real SSE chat endpoint against a stub fetch and
 * renders user/assistant/system rows without leaving dead state behind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HomeChat } from './HomeChat';

const SSE_BODY =
  'event: thinking_start\ndata: {}\n\n' +
  'event: delta\ndata: {"delta":"Hello from the home chat."}\n\n' +
  'event: done\ndata: {}\n\n';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/ai/models')) {
      return jsonResponse({ models: [], defaultModel: null });
    }
    if (url.includes('/api/v1/conversations/chat')) {
      return sseResponse(SSE_BODY);
    }
    return jsonResponse({ data: {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HomeChat', () => {
  it('shows the composer with a model picker and full-chat link', () => {
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    // The home composer stands alone: no "open full chat" escape hatch.
    expect(screen.queryByText('Open full chat')).not.toBeInTheDocument();
  });

  it('streams a reply and renders the assistant bubble', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'hi');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    const chatCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/conversations/chat'));
    expect(chatCalls).toHaveLength(1);
    const init = chatCalls[0]?.[1];
    const body = JSON.parse(String(init?.body ?? '')) as { content: string; mode: string };
    expect(body.content).toBe('hi');
    expect(body.mode).toBe('CHAT');
  });

  it('surfaces an interrupted stream as a system row', async () => {    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
      if (url.includes('/api/v1/conversations/chat')) return sseResponse('event: thinking_start\ndata: {}\n\n');
      return jsonResponse({ data: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'ping');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/interrupted/i)).toBeInTheDocument();
  });

  it('starts centered and empty, then flows upward in chronological order', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    expect(container.querySelector('.cc-homechat--empty')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'hi');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    // Centered hero is gone once the conversation exists...
    expect(container.querySelector('.cc-homechat--empty')).not.toBeInTheDocument();
    // ...and the user message precedes the assistant reply in DOM order
    // (oldest at top, newest appended at the bottom, auto-scrolled into view).
    const userRow = screen.getByText('hi');
    const asstRow = screen.getByText('Hello from the home chat.');
    expect(userRow.compareDocumentPosition(asstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the 3D thinking indicator only while a real generation runs', async () => {    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
      if (url.includes('/api/v1/conversations/chat')) return gate;
      return jsonResponse({ data: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'think hard');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByTestId('homechat-thinking-moon')).toBeInTheDocument();
    release(sseResponse(SSE_BODY));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('homechat-thinking-moon')).not.toBeInTheDocument());
  });

  it('disables Agent mode with a pairing hint when no device is online', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/local-workspace/devices')) return jsonResponse({ devices: [] });
        if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
        return jsonResponse({ data: {} });
      }),
    );
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    const agentTab = await screen.findByRole('button', { name: 'Agent' });
    expect(agentTab).toBeDisabled();
    expect(await screen.findByTestId('homechat-pair-hint')).toHaveTextContent('pair it on the Remote page');
  });

  it('sends mode AGENT once a device is online and Agent is selected', async () => {
    let posted: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/local-workspace/devices')) {
          return jsonResponse({ devices: [{ id: 'd1', name: 'laptop', presence: 'ONLINE' }] });
        }
        if (url.includes('/api/v1/ai/models')) return jsonResponse({ models: [], defaultModel: null });
        if (url.includes('/api/v1/conversations/chat') && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return sseResponse(SSE_BODY);
        }
        return jsonResponse({ data: {} });
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HomeChat />
      </MemoryRouter>,
    );
    const agentTab = await screen.findByRole('button', { name: 'Agent' });
    await waitFor(() => expect(agentTab).not.toBeDisabled());
    await user.click(agentTab);
    await user.type(screen.getByPlaceholderText('Ask anything…'), 'list my project files');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('Hello from the home chat.')).toBeInTheDocument());
    expect(posted.mode).toBe('AGENT');
  });
});