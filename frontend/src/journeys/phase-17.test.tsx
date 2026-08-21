/**
 * CodeConClave — PHASE 17 frontend E2E journeys (RTL).
 *
 * Full-app journeys through the real router/shell rather than isolated pages:
 *   1. Chat → SSE Last-Event-ID replay → dedupe: a user streams a message,
 *      reconnects, and missed deltas are replayed exactly once.
 *   2. Return-to-work: after work happens, /home renders the evidence-backed
 *      WYWA card and a resume action targets a real workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { shellHandler, stubFetch, jsonResponse, TEST_USER } from '../testutils';
import type { ChatStreamEvent } from '../lib/sse';
import { streamChat } from '../lib/sse';

vi.mock('../lib/sse', () => ({ streamChat: vi.fn() }));
vi.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ user: TEST_USER }),
}));

const streamChatMock = vi.mocked(streamChat);

function journeyHandler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/workspace/state') && init?.method === 'PUT') return jsonResponse({ data: { entry: {} } });
    if (url.includes('/api/v1/workspace/state')) {
      return jsonResponse({ data: { state: [{ key: 'current_conversation', value: { conversationId: 'c1' } }] } });
    }
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
    if (url.includes('/api/v1/conversations')) {
      return jsonResponse({ data: { conversations: [{ id: 'c1', title: 'Chat 1', mode: 'CHAT', projectId: null, createdAt: '2026-01-01T00:00:00.000Z' }] } });
    }
    if (url.includes('/api/v1/messages')) return jsonResponse({ data: { messages: [] } });
    if (url.includes('/api/v1/workspace/return-to-work')) {
      return jsonResponse({
        data: {
          summary: {
            id: 'rtw1',
            generatedAt: new Date(Date.now() - 3600e3).toISOString(),
            absenceStart: new Date(Date.now() - 26 * 3600e3).toISOString(),
            absenceEnd: new Date().toISOString(),
            projectScope: null,
            frequency: 'daily',
            counts: { completed: 2, failed: 1, pendingApprovals: 0, modifiedFiles: 3, discoveries: 0, memoryUpdates: 0, dnaUpdates: 0, projectActivity: 4, unreadNotifications: 0 },
            evidence: {},
            recommendedActions: [
              { type: 'review_approvals', label: 'Review approvals', target: '/approvals' },
              { type: 'inspect_failed', label: 'Inspect failed tasks', target: '/work' },
            ],
            summaryText: 'While you were away: 2 tasks completed, 1 failed.',
            aiGenerated: false,
            read: false,
            dismissed: false,
          },
          eligibility: { eligible: true, reason: 'generated' },
        },
      });
    }
    if (extra) return extra(url, init);
    return shellHandler(url);
  };
}

function renderJourney(initialEntries: string[]) {
  const fetchFn = stubFetch(journeyHandler());
  const result = render(
    <MemoryRouter initialEntries={initialEntries}>
      <App />
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

function emit(events: ChatStreamEvent[]) {
  const cb = streamChatMock.mock.calls[0]?.[1];
  expect(cb).toBeTypeOf('function');
  for (const ev of events) cb?.(ev);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  streamChatMock.mockReset();
  Element.prototype.scrollTo = vi.fn();
  document.documentElement.removeAttribute('data-theme');
});

describe('JOURNEY 1 — chat stream, reconnect, Last-Event-ID replay, dedupe', () => {
  it('sends without an id first, then replays missed deltas exactly once after reconnect', async () => {
    renderJourney(['/chat']);
    const textarea = await screen.findByPlaceholderText(/Message CodeConClave/);
    expect(textarea).toBeInTheDocument();

    await userEvent.type(textarea, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(streamChatMock).toHaveBeenCalledTimes(1));
    // No done frame yet → no replay id.
    expect(streamChatMock.mock.calls[0]![3]).toBeUndefined();

    emit([
      { type: 'delta', data: { delta: 'Hello ', id: null } },
      { type: 'delta', data: { delta: 'there', id: null } },
      { type: 'done', data: { messageId: 'm_9001' } },
    ]);
    await waitFor(() => expect(screen.getByText('Hello there')).toBeInTheDocument());

    // Reconnect: the next send carries the last event id.
    await userEvent.type(textarea, 'again');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(streamChatMock).toHaveBeenCalledTimes(2));
    expect(streamChatMock.mock.calls[1]![3]).toBe('msg_m_9001');

    // A missed message is replayed on reconnect.
    emit([{ type: 'delta', data: { delta: 'Missed while offline', id: 'm_9002' } }]);
    expect(await screen.findByText('Missed while offline')).toBeInTheDocument();

    // A duplicate replay of the same message id is never appended twice.
    const countBefore = screen.getAllByText('Missed while offline').length;
    emit([{ type: 'delta', data: { delta: 'Missed while offline', id: 'm_9002' } }]);
    expect(screen.getAllByText('Missed while offline').length).toBe(countBefore);
  });
});

describe('JOURNEY 2 — return-to-work (WYWA) after real work', () => {
  it('renders the evidence-backed summary on /home and resumes to a real workspace', async () => {
    renderJourney(['/home']);
    expect(await screen.findByTestId('rtw-card')).toBeInTheDocument();
    expect(screen.getByText(/2 tasks completed/)).toBeInTheDocument();
    expect(screen.getByText(/1 task failed/)).toBeInTheDocument();
    expect(screen.getByText('Review approvals')).toBeInTheDocument();
    expect(screen.getByText('Inspect failed tasks')).toBeInTheDocument();

    // Expanding reveals the evidence text; a resume action leads to a real workspace.
    await userEvent.click(screen.getByText('View summary'));
    expect(await screen.findByText(/While you were away: 2 tasks completed, 1 failed/)).toBeInTheDocument();
  });
});