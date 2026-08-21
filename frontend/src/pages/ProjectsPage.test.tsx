/**
 * CodeConClave — ProjectsPage tests (PHASE 11).
 * ?new=1 opens the create form; ?focus scrolls to a card; details load
 * members, activity and stats; member add/remove use real endpoints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ProjectsPage } from './ProjectsPage';
import { jsonResponse, stubFetch } from '../testutils';

const PROJECT = {
  id: 'p1',
  owner_id: 'u1',
  team_id: null,
  name: 'Acme App',
  description: 'Main product',
  repo_url: null,
  workspace_root: null,
  status: 'ACTIVE',
  deadline: null,
  is_favorite: false,
  tags: ['web'],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
};

function projectsHandler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/api/v1/projects' && init?.method === 'POST') return jsonResponse({ data: { project: PROJECT } });
    if (url === '/api/v1/projects') return jsonResponse({ data: { projects: [PROJECT] } });
    if (url.includes('/api/v1/projects/p1/members')) {
      if (init?.method === 'POST') return jsonResponse({ data: { ok: true } });
      if (init?.method === 'DELETE') return jsonResponse({ data: { ok: true } });
      return jsonResponse({ data: { members: [{ userId: 'u1', email: 'alice@example.com', displayName: 'Alice', role: 'owner', addedAt: '2026-01-01T00:00:00.000Z' }] } });
    }
    if (url.includes('/api/v1/projects/p1/activity')) {
      return jsonResponse({ data: { activity: [{ id: 'a1', projectId: 'p1', action: 'project.created', actorUserId: null, metadata: null, createdAt: '2026-01-01T00:00:00.000Z' }] } });
    }
    if (url.includes('/api/v1/projects/p1/stats')) {
      return jsonResponse({ data: { stats: { files: 3, conversations: 2, tasks: 1, members: 1 } } });
    }
    if (extra) return extra(url, init);
    return jsonResponse({ data: {} });
  };
}

function renderProjects(initialEntry = '/projects') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <ProjectsPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('ProjectsPage', () => {
  it('opens the create form when ?new=1 is present', async () => {
    stubFetch(projectsHandler());
    renderProjects('/projects?new=1');
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
  });

  it('loads members, activity and stats into the details panel', async () => {
    stubFetch(projectsHandler());
    renderProjects();
    await waitFor(() => expect(screen.getByText('Acme App')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Details'));
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText(/files 3 · conversations 2 · tasks 1/)).toBeInTheDocument();
    expect(screen.getByText(/project\.created/)).toBeInTheDocument();
  });

  it('adds a member via the real endpoint', async () => {
    const fetchFn = stubFetch(projectsHandler());
    renderProjects();
    await userEvent.click(await screen.findByText('Details'));
    await userEvent.type(await screen.findByPlaceholderText('member email'), 'bob@example.com');
    await userEvent.click(screen.getByText('Add'));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/projects/p1/members' && i?.method === 'POST');
      expect(call).toBeDefined();
    });
  });

  it('creates a project through the API', async () => {
    const fetchFn = stubFetch(projectsHandler());
    renderProjects();
    await userEvent.click(screen.getByText('+ New project'));
    await userEvent.type(await screen.findByLabelText('Name'), 'New project');
    await userEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/projects' && i?.method === 'POST');
      expect(call).toBeDefined();
    });
  });

  it('shows a loading state before the list responds', async () => {
    stubFetch(projectsHandler());
    renderProjects();
    expect(screen.getByText('Loading projects…')).toBeInTheDocument();
  });
});