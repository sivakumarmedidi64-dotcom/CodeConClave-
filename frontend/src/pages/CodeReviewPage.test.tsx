import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { CodeReviewPage } from './CodeReviewPage';
import { jsonResponse, stubFetch } from '../testutils';

const swarm = (status: string) => ({
  id: 'swm_1',
  title: 'Fix auth',
  pr_ref: 'Fix auth',
  status,
  roles: ['ARCHITECT', 'REVIEWER', 'SECURITY', 'TESTER'],
  verdict: null,
  created_at: '2026-10-20T00:00:00.000Z',
});

const finding = {
  id: 'fnd_1',
  role: 'SECURITY',
  severity: 'HIGH',
  category: 'auth',
  title: 'Empty token bypasses the check',
  description: 'check() returns true when token is falsy.',
  file_path: 'changes.diff',
  line_start: 5,
  line_end: 5,
  confidence: 0.9,
  recommendation: 'Return false for a missing token.',
  status: 'OPEN',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <CodeReviewPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('CodeReviewPage', () => {
  it('starts a review, shows findings live, and records a decision', async () => {
    let polls = 0;
    const fetchFn = stubFetch(async (url, init) => {
      if (url === '/api/v1/projects') return jsonResponse({ data: { projects: [{ id: 'prj_1', name: 'App', deleted_at: null, status: 'ACTIVE' }] } });
      if (url === '/api/v1/engineering/pr-reviews' && init?.method === 'POST') return jsonResponse({ data: { swarm: swarm('PENDING') } }, 201);
      if (url === '/api/v1/engineering/pr-reviews') return jsonResponse({ data: { swarms: [] } });
      if (url.endsWith('/run')) return new Promise<Response>(() => undefined); // holds, like the real run
      if (url === '/api/v1/engineering/pr-reviews/swm_1') {
        polls += 1;
        return jsonResponse({ data: { swarm: swarm(polls > 1 ? 'COMPLETED' : 'RUNNING') } });
      }
      if (url.endsWith('/findings')) return jsonResponse({ data: { findings: [finding] } });
      if (url.endsWith('/decide')) return jsonResponse({ data: { finding: { ...finding, status: 'ACCEPTED' } } });
      return jsonResponse({ data: {} });
    });
    renderPage();
    await screen.findByRole('option', { name: 'App' });
    await userEvent.type(screen.getByLabelText('Diff or code to review'), '+ if (!token) return true;');
    await userEvent.click(screen.getByRole('button', { name: 'Start review' }));

    expect(await screen.findByText('Empty token bypasses the check')).toBeInTheDocument();
    expect(screen.getByText('changes.diff:5')).toBeInTheDocument();
    const post = fetchFn.mock.calls.find(([u, i]) => u === '/api/v1/engineering/pr-reviews' && i?.method === 'POST');
    expect(String(post?.[1]?.body)).toContain('"path":"changes.diff"');
    await waitFor(() => expect(screen.getAllByText('COMPLETED').length).toBeGreaterThan(0), { timeout: 4000 });

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
  });

  it('asks for a diff or files before starting', async () => {
    stubFetch(async (url) =>
      url === '/api/v1/projects'
        ? jsonResponse({ data: { projects: [{ id: 'prj_1', name: 'App', deleted_at: null, status: 'ACTIVE' }] } })
        : jsonResponse({ data: { swarms: [] } }),
    );
    renderPage();
    await screen.findByRole('option', { name: 'App' });
    await userEvent.click(screen.getByRole('button', { name: 'Start review' }));
    expect(screen.getByText(/Paste a diff or add at least one file/)).toBeInTheDocument();
  });
});
