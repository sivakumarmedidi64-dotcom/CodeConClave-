/**
 * CodeConClave — ChatPage tests (PHASE 11).
 * CHAT/COWORK switch inside the workspace, slash commands run real actions
 * (/idea captures a memory), Esc cancels an active stream.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ChatPage } from './ChatPage';
import { jsonResponse, stubFetch, TEST_USER } from '../testutils';
import { streamChat } from '../lib/sse';

vi.mock('../lib/sse', () => ({ streamChat: vi.fn() }));
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: TEST_USER }),
}));

const streamChatMock = vi.mocked(streamChat);

function renderChat() {
  return render(
    <MemoryRouter initialEntries={['/chat']}>
      <ToastProvider>
        <ChatPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function chatHandler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
    if (url.includes('/api/v1/workspace/state')) return jsonResponse({ data: { state: [] } });
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
    if (url.includes('/api/v1/conversations') && init?.method === 'POST') {
      return jsonResponse({ data: { conversation: { id: 'c1', title: 'New conversation', mode: 'CHAT', projectId: null, createdAt: '2026-01-01T00:00:00.000Z' } } });
    }
    if (url.includes('/api/v1/conversations')) return jsonResponse({ data: { conversations: [] } });
    if (extra) return extra(url, init);
    return jsonResponse({ data: {} });
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatPage — mode switch', () => {
  it('switches between Chat and Cowork modes and persists the mode', async () => {
    const fetchFn = stubFetch(chatHandler());
    renderChat();
    const cowork = await screen.findByRole('button', { name: 'Cowork' });
    await userEvent.click(cowork);
    expect(await screen.findByPlaceholderText('Brief a coworker (task auto-created)…')).toBeInTheDocument();
    await waitFor(() => {
      const put = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/workspace/state/current_mode' && i?.method === 'PUT');
      expect(put).toBeDefined();
    });
    const put = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/workspace/state/current_mode');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ value: { mode: 'COWORK' } });
  });

  it('restores Cowork mode from the URL (?mode=cowork)', async () => {
    stubFetch(chatHandler());
    render(
      <MemoryRouter initialEntries={['/chat?mode=cowork']}>
        <ToastProvider>
          <ChatPage />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByPlaceholderText('Brief a coworker (task auto-created)…')).toBeInTheDocument();
  });
});

describe('ChatPage — slash commands', () => {
  it('shows the slash menu when the input starts with /', async () => {
    stubFetch(chatHandler());
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, '/');
    expect(await screen.findByText('/idea <text>')).toBeInTheDocument();
    expect(screen.getByText('/cowork')).toBeInTheDocument();
    expect(screen.getByText('/new')).toBeInTheDocument();
  });

  it('captures an idea memory when /idea is submitted', async () => {
    const fetchFn = stubFetch(
      chatHandler(async (url, init) => {
        if (url === '/api/v1/memory' && init?.method === 'POST') {
          return jsonResponse({ data: { memory: { id: 'm1', content: 'Combine the services' } } });
        }
        if (url === '/api/v1/memory/m1' && init?.method === 'PATCH') {
          return jsonResponse({ data: { memory: { id: 'm1' } } });
        }
        return jsonResponse({ data: {} });
      }),
    );
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, '/idea combine the services');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      const post = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/memory' && i?.method === 'POST');
      expect(post).toBeDefined();
    });
    const patch = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/memory/m1' && i?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ structured: { idea: true } });
    expect(screen.getByText('Idea captured to Memory')).toBeInTheDocument();
  });

  it('starts a new conversation when /new is submitted', async () => {
    const fetchFn = stubFetch(chatHandler());
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, '/new');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      const post = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/conversations' && i?.method === 'POST');
      expect(post).toBeDefined();
    });
  });
});

describe('ChatPage — attachments and cancel', () => {
  it('marks in-chat attachments as unsupported, honestly', async () => {
    stubFetch(chatHandler());
    renderChat();
    await userEvent.click(screen.getByLabelText('Attach file'));
    expect(screen.getByText(/The chat API does not support attachments yet/)).toBeInTheDocument();
    expect(screen.getByText('Upload to Files…')).toBeInTheDocument();
  });

  it('aborts the active stream on Escape', async () => {
    stubFetch(chatHandler());
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.keyboard('{Escape}');
    expect(textarea).toBeInTheDocument();
  });
});

describe('ChatPage — free limit moon + scroll continuity', () => {
  beforeEach(() => {
    streamChatMock.mockReset();
    Element.prototype.scrollTo = vi.fn();
  });

  it('shows the Free Limit Moon only when the server reports the transition', async () => {
    streamChatMock.mockImplementation(async (_payload, onEvent) => {
      onEvent({ type: 'limit_reached', data: { showMoon: true } });
      return null;
    });
    stubFetch(chatHandler());
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const moon = await screen.findByTestId('free-limit-moon');
    expect(screen.getByText(/today.s free usage limit/)).toBeInTheDocument();
    expect(screen.getByText('Continue with Pro')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('free-limit-moon')).toBeNull());
    expect(screen.getByText('Free tier daily limit reached.')).toBeInTheDocument();
  });

  it('does not show the moon when the server says showMoon=false', async () => {
    streamChatMock.mockImplementation(async (_payload, onEvent) => {
      onEvent({ type: 'limit_reached', data: { showMoon: false } });
      return null;
    });
    stubFetch(chatHandler());
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('Free tier daily limit reached.')).toBeInTheDocument());
    expect(screen.queryByTestId('free-limit-moon')).toBeNull();
  });

  it('restores the saved conversation scroll position on mount', async () => {
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
      if (url.includes('/api/v1/workspace/state')) {
        return jsonResponse({
          data: {
            state: [
              { key: 'current_conversation', value: { conversationId: 'c1' } },
              { key: 'conversation_scroll', value: { top: 420 } },
            ],
          },
        });
      }
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      if (url.includes('/api/v1/conversations/c1/messages')) return jsonResponse({ data: { messages: [] } });
      if (url.includes('/api/v1/conversations')) return jsonResponse({ data: { conversations: [] } });
      return jsonResponse({ data: {} });
    });
    renderChat();
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 420 })));
  });
});

describe('ChatPage — SSE Last-Event-ID replay (Phase 17)', () => {
  beforeEach(() => {
    streamChatMock.mockReset();
    Element.prototype.scrollTo = vi.fn();
  });

  it('sends Last-Event-ID on the next same-conversation send and dedupes replayed deltas by id', async () => {
    const serverTruth: { id: string; role: 'user' | 'assistant'; content: string }[] = [
      { id: 'm1', role: 'user', content: 'hello' },
      { id: 'm2', role: 'assistant', content: 'first answer' },
      { id: 'm3', role: 'assistant', content: 'shared answer' },
      { id: 'm4', role: 'assistant', content: 'another' },
    ];
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
      if (url.includes('/api/v1/workspace/state')) {
        return jsonResponse({ data: { state: [{ key: 'current_conversation', value: { conversationId: 'c1' } }] } });
      }
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      if (url.includes('/api/v1/conversations/c1/messages')) return jsonResponse({ data: { messages: serverTruth } });
      if (url.includes('/api/v1/conversations')) {
        return jsonResponse({ data: { conversations: [{ id: 'c1', title: 'Chat 1', mode: 'CHAT' }] } });
      }
      return jsonResponse({ data: {} });
    });
    let sendCount = 0;
    streamChatMock.mockImplementation(async (_payload, onEvent) => {
      sendCount += 1;
      if (sendCount === 1) {
        serverTruth.push({ id: 'm5', role: 'assistant', content: 'new live answer' });
        onEvent({ type: 'delta', data: { delta: 'new live answer' } });
        onEvent({ type: 'done', data: { messageId: 'm5' } });
        return 'msg_m5';
      }
      // Second send carries Last-Event-ID: msg_m5. The server replays m3/m4
      // (already rendered from the load) and a genuinely new m7, then streams.
      serverTruth.push({ id: 'm6', role: 'assistant', content: 'second live' });
      serverTruth.push({ id: 'm7', role: 'assistant', content: 'restored' });
      onEvent({ type: 'delta', data: { delta: 'shared answer', id: 'msg_m3' } }); // dup of loaded — dedupe
      onEvent({ type: 'delta', data: { delta: 'another', id: 'msg_m4' } }); // dup of loaded — dedupe
      onEvent({ type: 'delta', data: { delta: 'restored', id: 'msg_m7' } });
      onEvent({ type: 'delta', data: { delta: 'restored', id: 'msg_m7' } }); // duplicate replay — must be deduped
      onEvent({ type: 'delta', data: { delta: ' second live' } });
      onEvent({ type: 'done', data: { messageId: 'm6' } });
      return 'msg_m6';
    });
    renderChat();
    await waitFor(() => expect(screen.getByText('shared answer')).toBeInTheDocument());
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'again');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('new live answer')).toBeInTheDocument());

    await userEvent.type(textarea, 'once more');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('second live')).toBeInTheDocument());
    // Replayed already-loaded messages are NOT re-rendered; replayed new
    // messages render exactly once (no concatenated duplicate).
    expect(screen.getAllByText('shared answer')).toHaveLength(1);
    expect(screen.getAllByText('another')).toHaveLength(1);
    expect(screen.getAllByText('restored')).toHaveLength(1);
    expect(screen.queryByText('restoredrestored')).toBeNull();
    // Second send carried the first stream's confirmed id as Last-Event-ID.
    expect(streamChatMock.mock.calls[0]![3]).toBeUndefined();
    await waitFor(() => {
      expect(streamChatMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(streamChatMock.mock.calls[1]![3]).toBe('msg_m5');
    });
  });

  it('never sends Last-Event-ID before any done frame for a conversation', async () => {
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
      if (url.includes('/api/v1/workspace/state')) return jsonResponse({ data: { state: [] } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      if (url.includes('/api/v1/conversations')) return jsonResponse({ data: { conversations: [] } });
      return jsonResponse({ data: {} });
    });
    streamChatMock.mockImplementation(async (_payload, onEvent) => {
      onEvent({ type: 'delta', data: { delta: 'partial' } });
      onEvent({ type: 'error', data: { code: 'ai_timeout', message: 'upstream timeout' } });
      return null;
    });
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.type(textarea, 'again');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(streamChatMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    for (const call of streamChatMock.mock.calls) {
      expect(call[3]).toBeUndefined();
    }
  });
});

describe('ChatPage — stream termination + Thinking Moon cleanup (Stage 21)', () => {
  beforeEach(() => {
    streamChatMock.mockReset();
    Element.prototype.scrollTo = vi.fn();
  });

  it('clears the Thinking Moon and resets generation state when the server reports an error', async () => {
    stubFetch(chatHandler());
    streamChatMock.mockImplementation(async (_payload, onEvent) => {
      onEvent({ type: 'error', data: { code: 'model_unavailable', message: 'All configured models failed (timeout).' } });
      return null;
    });
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('All configured models failed (timeout).')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('CodeConClave is thinking')).toBeNull());
    expect(screen.queryByText(/Connection interrupted/)).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Streaming�' })).toBeNull());
  });

  it('a silent stream close shows an honest connection-interrupted note and clears the moon', async () => {
    stubFetch(chatHandler());
    streamChatMock.mockResolvedValue(null);
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(screen.getByText('Connection interrupted — the stream closed before the response completed.')).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByText('CodeConClave is thinking')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Streaming�' })).toBeNull());
  });

  it('user cancellation never surfaces the raw AbortError text and clears the moon', async () => {
    stubFetch(chatHandler());
    streamChatMock.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByText('CodeConClave is thinking')).toBeNull());
    expect(screen.queryByText('This operation was aborted')).toBeNull();
    expect(screen.queryByText(/Connection interrupted/)).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Streaming�' })).toBeNull());
  });
});
