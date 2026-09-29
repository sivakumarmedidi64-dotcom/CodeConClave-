/**
 * CodeConClave — ChatPage tests (PHASE 11).
 * CHAT/COWORK switch inside the workspace, slash commands run real actions
 * (/idea captures a memory), Esc cancels an active stream.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ChatPage } from './ChatPage';
import { jsonResponse, stubFetch, TEST_USER } from '../testutils';
import { streamChat, type ChatStreamEvent } from '../lib/sse';
import { uploadFileWithProgress } from '../lib/upload';
import { resetDefaultContinuityCache } from '../lib/continuity';

vi.mock('../lib/sse', () => ({ streamChat: vi.fn() }));
vi.mock('../lib/upload', () => ({ uploadFileWithProgress: vi.fn() }));
vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: TEST_USER }),
}));

const streamChatMock = vi.mocked(streamChat);
const uploadMock = vi.mocked(uploadFileWithProgress);

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

  it('anchors the slash menu to the composer wrapper, not the chat card', async () => {
    stubFetch(chatHandler());
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, '/');
    const item = await screen.findByText('/idea <text>');
    const popover = item.closest('.cc-popover') as HTMLElement | null;
    expect(popover).not.toBeNull();
    // jsdom has no layout, so assert the DOM contract directly: the first
    // inline-positioned ancestor of the absolute menu must be the composer
    // textarea wrapper. Otherwise bottom:100% anchors to .cc-card and the
    // menu renders above the whole chat card — invisible to the user.
    let el: HTMLElement | null = popover!.parentElement;
    let anchor: HTMLElement | null = null;
    while (el) {
      if (el.style.position && el.style.position !== 'static') {
        anchor = el;
        break;
      }
      el = el.parentElement;
    }
    expect(anchor).not.toBeNull();
    expect(anchor!.classList.contains('cc-card')).toBe(false);
    expect(anchor!.contains(textarea)).toBe(true);
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
  beforeEach(() => {
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ id: 'f0', name: 'x.txt', size: 1 });
    Element.prototype.scrollTo = vi.fn();
  });

  it('requires a project before attachments can be uploaded', async () => {
    stubFetch(chatHandler());
    renderChat();
    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [new File(['hello'], 'a.txt')] } });
    expect(await screen.findByText(/Select a project first/)).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('uploads in-chat attachments with progress and sends them on the message', async () => {
    uploadMock.mockResolvedValue({ id: 'f1', name: 'note.txt', size: 4 });
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
      if (url.includes('/api/v1/workspace/state')) return jsonResponse({ data: { state: [] } });
      if (url.includes('/api/v1/projects')) {
        return jsonResponse({ data: { projects: [{ id: 'p1', name: 'Project One', status: 'ACTIVE', deleted_at: null }] } });
      }
      if (url.includes('/api/v1/conversations')) return jsonResponse({ data: { conversations: [] } });
      return jsonResponse({ data: {} });
    });
    renderChat();
    const project = await screen.findByLabelText('Project');
    await userEvent.selectOptions(project, 'p1');
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input!, { target: { files: [new File(['hello'], 'note.txt')] } });
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ projectId: 'p1' }),
      expect.any(Function),
    );
    expect(await screen.findByText('note.txt')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/failed/)).toBeNull());
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'summarize the note');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(streamChatMock).toHaveBeenCalled();
      const payload = streamChatMock.mock.calls[0]![0] as { attachments?: { fileId: string; name: string }[] };
      expect(payload.attachments).toEqual([{ fileId: 'f1', name: 'note.txt' }]);
    });
  });

  it('enforces the 16-attachment total across a batch', async () => {
    const batch = Array.from({ length: 17 }, (_, i) => new File([String(i)], `f${i}.txt`));
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
      if (url.includes('/api/v1/workspace/state')) return jsonResponse({ data: { state: [] } });
      if (url.includes('/api/v1/projects')) {
        return jsonResponse({ data: { projects: [{ id: 'p1', name: 'Project One', status: 'ACTIVE', deleted_at: null }] } });
      }
      if (url.includes('/api/v1/conversations')) return jsonResponse({ data: { conversations: [] } });
      return jsonResponse({ data: {} });
    });
    renderChat();
    const project = await screen.findByLabelText('Project');
    await userEvent.selectOptions(project, 'p1');
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input!, { target: { files: batch } });
    expect(await screen.findByText(/You can attach up to 16 files total/)).toBeInTheDocument();
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
    expect(screen.getByText(/reached your usage limit/)).toBeInTheDocument();
    expect(screen.getByText('Continue with Pro')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('free-limit-moon')).toBeNull());
    expect(screen.getByText('Usage limit reached for this rolling window.')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByText('Usage limit reached for this rolling window.')).toBeInTheDocument());
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

describe('ChatPage — continuity (clientId, decision chip, offline outbox)', () => {
  beforeEach(() => {
    streamChatMock.mockReset();
    Element.prototype.scrollTo = vi.fn();
    resetDefaultContinuityCache();
  });

  function conversationHandler() {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
      if (url.includes('/api/v1/workspace/state')) return jsonResponse({ data: { state: [] } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      if (url.includes('/api/v1/conversations/c1/messages')) return jsonResponse({ data: { messages: [] } });
      if (url.includes('/api/v1/conversations')) {
        return jsonResponse({ data: { conversations: [{ id: 'c1', title: 'Chat 1', mode: 'CHAT', createdAt: '2026-01-01T00:00:00.000Z' }] } });
      }
      return jsonResponse({ data: {} });
    };
  }

  it('sends a per-turn clientId (exactly-once key) on the stream request', async () => {
    stubFetch(conversationHandler());
    streamChatMock.mockResolvedValue(null);
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'use postgres');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(streamChatMock).toHaveBeenCalled());
    const payload = streamChatMock.mock.calls[0]![0] as { clientId?: string };
    expect(payload.clientId).toMatch(/^cc_v1_/);
  });

  it('renders a decision chip when done carries decisionRecorded and clears the pending flag', async () => {
    stubFetch(conversationHandler());
    streamChatMock.mockImplementation(async (_payload, onEvent) => {
      onEvent({ type: 'delta', data: { delta: "we'll go with Postgres for billing" } });
      onEvent({ type: 'done', data: { messageId: 'm9', decisionRecorded: { id: 'dec9', title: 'Postgres for billing', status: 'TENTATIVE' } } });
      return 'msg_m9';
    });
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'use postgres');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText(/Decision recorded:/)).toBeInTheDocument());
    expect(screen.getByText(/Postgres for billing \(TENTATIVE\)/)).toBeInTheDocument();
    expect(screen.queryByText(/queued locally/)).toBeNull();
  });

  it('parks a failed send in the outbox and surfaces the pending indicator + sync action', async () => {
    stubFetch(conversationHandler());
    streamChatMock.mockRejectedValue(new Error('offline'));
    renderChat();
    await waitFor(() => expect(screen.getByText('Chat 1')).toBeInTheDocument());
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'capture this offline');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('offline')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/queued locally — will sync on reconnect/)).toBeInTheDocument());
    expect(await screen.findByRole('button', { name: /Sync 1 pending/ })).toBeInTheDocument();
  });

  it('never parks an aborted (user-stopped) stream in the outbox', async () => {
    stubFetch(conversationHandler());
    streamChatMock.mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
    renderChat();
    await waitFor(() => expect(screen.getByText('Chat 1')).toBeInTheDocument());
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'cancel me');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByText('CodeConClave is thinking')).toBeNull());
    expect(screen.queryByText(/queued locally/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Sync \d+ pending/ })).toBeNull();
  });
});

describe('ChatPage — companion presence mirrors the real stream lifecycle', () => {
  beforeEach(() => {
    streamChatMock.mockReset();
    Element.prototype.scrollTo = vi.fn();
    resetDefaultContinuityCache();
  });

  function handler() {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
      if (url.includes('/api/v1/workspace/state')) return jsonResponse({ data: { state: [] } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      if (url.includes('/api/v1/conversations/c1/messages')) return jsonResponse({ data: { messages: [] } });
      if (url.includes('/api/v1/conversations')) {
        return jsonResponse({ data: { conversations: [{ id: 'c1', title: 'Chat 1', mode: 'CHAT', createdAt: '2026-01-01T00:00:00.000Z' }] } });
      }
      return jsonResponse({ data: {} });
    };
  }

  it('is idle before work, thinking on send, working on deltas, done at completion', async () => {
    stubFetch(handler());
    let emit: ((ev: ChatStreamEvent) => void) | null = null;
    let resolveStream!: (value: string | null) => void;
    streamChatMock.mockImplementation((_payload, onEvent) => {
      emit = onEvent;
      return new Promise((res) => {
        resolveStream = res;
      });
    });
    renderChat();
    expect(await screen.findByRole('status', { name: 'AI companion idle' })).toBeInTheDocument();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'create a project called Corder');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'AI is thinking' })).toBeInTheDocument());
    emit!({ type: 'delta', data: { delta: 'Creating project' } });
    await waitFor(() => expect(screen.getByRole('status', { name: 'AI is working' })).toBeInTheDocument());
    emit!({ type: 'done', data: { messageId: 'm1' } });
    resolveStream('msg_m1');
    await waitFor(() => expect(screen.getByRole('status', { name: 'AI completed the task' })).toBeInTheDocument());
  });

  it('shows the error state when the stream fails', async () => {
    stubFetch(handler());
    streamChatMock.mockImplementation(async (_payload, onEvent) => {
      onEvent({ type: 'error', data: { code: 'provider_error', message: 'provider unavailable' } });
      return 'msg_x';
    });
    renderChat();
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'AI encountered an error' })).toBeInTheDocument());
  });
});
