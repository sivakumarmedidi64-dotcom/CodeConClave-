/**
 * CodeConClave — IdeasPage tests (PHASE 13).
 * Ideas tab: create/vote/comments/trash confirm; Brainstorm tab: session
 * creation, capture, AI generation, and an honest `ai_unavailable` path.
 * Loading / error / empty states are explicit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { IdeasPage } from './IdeasPage';
import { jsonResponse, stubFetch } from '../testutils';

const IDEA = {
  id: 'ide_1',
  ownerId: 'u1',
  teamId: null,
  projectId: null,
  title: 'Ship dark mode',
  description: 'Reduce eye strain',
  tags: ['ux'],
  category: null,
  priority: 'HIGH',
  status: 'PROPOSED',
  assigneeId: null,
  archived: false,
  deletedAt: null,
  voteCount: 2,
  commentCount: 1,
  aiGenerated: false,
  provenance: null,
  references: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SESSION = {
  id: 'bsh_1',
  ownerId: 'u1',
  title: 'Q3 roadmap',
  description: null,
  status: 'ACTIVE',
  grouping: 'NONE',
  endedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DETAIL = {
  session: SESSION,
  participants: [{ id: 'bsp_1', sessionId: 'bsh_1', userId: 'u1', role: 'HOST', joinedAt: '2026-01-01T00:00:00.000Z' }],
  ideas: [],
};

function renderIdeas() {
  return render(
    <ToastProvider>
      <IdeasPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('IdeasPage — ideas tab', () => {
  it('lists ideas with status, priority and AI badges', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/ideas')) return jsonResponse({ data: { ideas: [IDEA], total: 1 } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await waitFor(() => expect(screen.getByText('Ship dark mode')).toBeInTheDocument());
    expect(screen.getAllByText('proposed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('HIGH').length).toBeGreaterThan(0);
    expect(screen.getByText('votes 2')).toBeInTheDocument();
    expect(screen.getByText('comments 1')).toBeInTheDocument();
    expect(screen.getByText('#ux')).toBeInTheDocument();
  });

  it('creates an idea and refreshes the list', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url === '/api/v1/ideas' && init?.method === 'POST') {
        return jsonResponse({ data: { idea: { ...IDEA, title: 'Combine the services' } } }, 201);
      }
      if (url.includes('/api/v1/ideas')) return jsonResponse({ data: { ideas: [IDEA], total: 1 } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await userEvent.type(screen.getByPlaceholderText('Title'), 'Combine the services');
    await userEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      const post = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/ideas' && i?.method === 'POST');
      expect(post).toBeDefined();
    });
    const post = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/ideas' && i?.method === 'POST');
    expect(JSON.parse(String(post![1]?.body))).toMatchObject({ title: 'Combine the services', priority: 'MEDIUM', status: 'PROPOSED' });
  });

  it('votes on an idea and shows the updated count', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/ideas/ide_1/vote') && init?.method === 'POST') {
        return jsonResponse({ data: { idea: { ...IDEA, voteCount: 3 }, voted: true } });
      }
      if (url.includes('/api/v1/ideas')) return jsonResponse({ data: { ideas: [IDEA], total: 1 } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await waitFor(() => expect(screen.getByText('▲ 2')).toBeInTheDocument());
    await userEvent.click(screen.getByText('▲ 2'));
    await waitFor(() => expect(screen.getByText('▲ 3')).toBeInTheDocument());
    expect(fetchFn.mock.calls.some(([u, i]) => u.includes('/vote') && i?.method === 'POST')).toBe(true);
  });

  it('loads and shows comments, then adds one', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/ideas/ide_1/comments') && init?.method === 'POST') {
        return jsonResponse({ data: { comment: { id: 'icm_2', ideaId: 'ide_1', authorId: 'u1', content: 'Love it', editedAt: null, createdAt: '2026-01-02T00:00:00.000Z' } } }, 201);
      }
      if (url.includes('/api/v1/ideas/ide_1/comments')) {
        return jsonResponse({
          data: {
            comments: [{ id: 'icm_1', ideaId: 'ide_1', authorId: 'u1', content: 'First!', editedAt: null, createdAt: '2026-01-01T00:00:00.000Z' }],
          },
        });
      }
      if (url.includes('/api/v1/ideas')) return jsonResponse({ data: { ideas: [IDEA], total: 1 } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await userEvent.click(await screen.findByText('💬 1'));
    await waitFor(() => expect(screen.getByText('First!')).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText('Add a comment…'), 'Love it');
    await userEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(screen.getByText('Love it')).toBeInTheDocument());
    expect(fetchFn.mock.calls.some(([u, i]) => u.includes('/comments') && i?.method === 'POST')).toBe(true);
  });

  it('asks for confirmation before trashing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchFn = stubFetch(async (url, init) => {
      if (url.includes('/api/v1/ideas/ide_1/trash') && init?.method === 'POST') return jsonResponse({ data: { trashed: true } });
      if (url.includes('/api/v1/ideas')) return jsonResponse({ data: { ideas: [IDEA], total: 1 } });
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await userEvent.click(await screen.findByText('Trash'));
    expect(confirmSpy).toHaveBeenCalledWith('Move "Ship dark mode" to trash?');
    await waitFor(() => expect(fetchFn.mock.calls.some(([u, i]) => u.includes('/trash') && i?.method === 'POST')).toBe(true));
    confirmSpy.mockRestore();
  });

  it('shows an error state with retry', async () => {
    let calls = 0;
    stubFetch(async (url) => {
      if (url.includes('/api/v1/ideas')) {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: { code: 'http_error', message: 'down' } }, 500);
        return jsonResponse({ data: { ideas: [IDEA], total: 1 } });
      }
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await waitFor(() => expect(screen.getByText('Could not load your ideas.')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByText('Ship dark mode')).toBeInTheDocument());
  });
});

describe('IdeasPage — brainstorm tab', () => {
  it('creates a session and opens its detail', async () => {
    const fetchFn = stubFetch(async (url, init) => {
      if (url === '/api/v1/brainstorming' && init?.method === 'POST') {
        return jsonResponse({ data: { session: SESSION } }, 201);
      }
      if (url.includes('/api/v1/brainstorming/bsh_1')) {
        return jsonResponse({ data: DETAIL });
      }
      if (url.includes('/api/v1/brainstorming')) return jsonResponse({ data: { sessions: [SESSION] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await userEvent.click(screen.getByText('Brainstorm'));
    await userEvent.type(screen.getByPlaceholderText('Title'), 'Q3 roadmap');
    await userEvent.click(screen.getByText('Start session'));
    await waitFor(() => expect(screen.getByTestId('brainstorm-detail')).toBeInTheDocument());
    expect(fetchFn.mock.calls.some(([u, i]) => u === '/api/v1/brainstorming' && i?.method === 'POST')).toBe(true);
    expect(within(screen.getByTestId('brainstorm-detail')).getByText('Capture an idea')).toBeInTheDocument();
  });

  it('captures a participant proposal into the session', async () => {
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/brainstorming/bsh_1/capture') && init?.method === 'POST') {
        return jsonResponse({ data: { brainstormIdea: { id: 'bsi_2', sessionId: 'bsh_1', ideaId: 'ide_9', createdBy: 'u1', proposal: 'AI-first onboarding', grouping: null, aiGenerated: false, createdAt: '2026-01-02T00:00:00.000Z' }, idea: { ...IDEA, title: 'AI-first onboarding' } } }, 201);
      }
      if (url.includes('/api/v1/brainstorming/bsh_1')) {
        return jsonResponse({
          data: {
            session: SESSION,
            participants: [{ id: 'bsp_1', sessionId: 'bsh_1', userId: 'u1', role: 'HOST', joinedAt: '2026-01-01T00:00:00.000Z' }],
            ideas: [{ id: 'bsi_2', sessionId: 'bsh_1', ideaId: 'ide_9', createdBy: 'u1', proposal: 'AI-first onboarding', grouping: null, aiGenerated: false, createdAt: '2026-01-02T00:00:00.000Z' }],
          },
        });
      }
      if (url.includes('/api/v1/brainstorming')) return jsonResponse({ data: { sessions: [SESSION] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await userEvent.click(screen.getByText('Brainstorm'));
    await userEvent.click(await screen.findByText('Open'));
    await userEvent.type(await screen.findByPlaceholderText('Your proposal…'), 'AI-first onboarding');
    await userEvent.click(screen.getByText('Capture'));
    await waitFor(() => expect(screen.getByText('AI-first onboarding')).toBeInTheDocument());
  });

  it('reports AI generation failure honestly when no provider is configured', async () => {
    stubFetch(async (url, init) => {
      if (url.includes('/api/v1/brainstorming/bsh_1/generate') && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'ai_unavailable', message: 'No AI provider is configured' } }, 503);
      }
      if (url.includes('/api/v1/brainstorming/bsh_1')) return jsonResponse({ data: DETAIL });
      if (url.includes('/api/v1/brainstorming')) return jsonResponse({ data: { sessions: [SESSION] } });
      return jsonResponse({ data: {} });
    });
    renderIdeas();
    await userEvent.click(screen.getByText('Brainstorm'));
    await userEvent.click(await screen.findByText('Open'));
    await userEvent.type(await screen.findByPlaceholderText('Topic'), 'onboarding');
    await userEvent.click(screen.getByText('Generate'));
    await waitFor(() => expect(screen.getByText(/No AI provider is configured/)).toBeInTheDocument());
  });
});