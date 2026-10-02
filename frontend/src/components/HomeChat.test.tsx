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
    expect(screen.getByText('Open full chat')).toBeInTheDocument();
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

  it('surfaces an interrupted stream as a system row', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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
});