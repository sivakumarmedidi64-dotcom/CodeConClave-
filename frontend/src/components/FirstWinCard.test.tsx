/**
 * CodeConClave — FirstWinCard tests (Stage 26I).
 * Honest progress: the card hides once real projects + agents exist, checks
 * steps only from server state, and the demo button seeds through real APIs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { FirstWinCard } from '../components/FirstWinCard';
import { jsonResponse, stubFetch } from '../testutils';

function handler(overrides: { projects?: unknown[]; agents?: unknown[] } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/projects') && init?.method === 'POST') {
      return jsonResponse({ data: { project: { id: 'prj_1', name: 'Demo Project' } } }, 201);
    }
    if (url.includes('/api/v1/agents') && init?.method === 'POST') {
      return jsonResponse({ data: { agent: { id: 'agt_1' } } }, 201);
    }
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: overrides.projects ?? [] } });
    if (url.includes('/api/v1/agents')) return jsonResponse({ data: { agents: overrides.agents ?? [] } });
    return jsonResponse({ data: {} });
  };
}

function renderCard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <FirstWinCard />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('FirstWinCard', () => {
  it('shows unchecked steps for an empty workspace', async () => {
    stubFetch(handler());
    renderCard();
    expect(await screen.findByTestId('first-win')).toBeInTheDocument();
    expect(screen.getByText('Create your first project')).toBeInTheDocument();
    expect(screen.getByText('Create your first agent')).toBeInTheDocument();
    expect(screen.getByText('Run your first task')).toBeInTheDocument();
  });

  it('checks steps only when the server reports real state', async () => {
    stubFetch(handler({ projects: [{ id: 'prj_1', name: 'Main' }], agents: [{ id: 'agt_1', total_tasks: 3 }] }));
    renderCard();
    await waitFor(() => expect(screen.queryByTestId('first-win')).toBeNull());
  });

  it('marks project+agent steps done but not the run step', async () => {
    stubFetch(handler({ projects: [{ id: 'prj_1', name: 'Main' }] }));
    renderCard();
    expect(await screen.findByTestId('first-win')).toBeInTheDocument();
    const projectStep = screen.getByText('Create your first project');
    expect(projectStep.style.textDecoration).toContain('line-through');
    const runStep = screen.getByText('Run your first task');
    expect(runStep.style.textDecoration).not.toContain('line-through');
  });

  it('seeds a demo project + agent through the real APIs', async () => {
    const fetchFn = stubFetch(handler());
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up a demo project' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/projects'), expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/v1/agents'), expect.objectContaining({ method: 'POST' })));
  });
});