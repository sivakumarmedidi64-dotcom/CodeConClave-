/**
 * CodeConClave — ReviewListPage tests (B1).
 * Server-authoritative review inbox: project picker, status + progress pills,
 * empty state, navigation into the detail page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ReviewListPage } from './ReviewListPage';
import { jsonResponse, stubFetch } from '../testutils';

const REVIEW = {
  review: {
    id: 'rvw_1',
    task_id: 'tsk_1',
    project_id: 'prj_1',
    title: 'Apply the pipeline fix',
    status: 'READY_FOR_REVIEW',
    files_changed: 1,
    additions: 2,
    deletions: 1,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
  },
  total_hunks: 2,
  accepted_hunks: 1,
  rejected_hunks: 0,
};

function handler(extra?: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [{ id: 'prj_1', name: 'Main app' }] } });
    if (url.includes('/api/v1/reviews')) return jsonResponse({ data: { reviews: [REVIEW] } });
    return extra ? extra(url, init) : jsonResponse({ data: {} });
  };
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/reviews']}>
      <ToastProvider>
        <Routes>
          <Route path="/reviews" element={<ReviewListPage />} />
          <Route path="/reviews/:id" element={<div data-testid="detail-page" />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('ReviewListPage', () => {
  it('renders a project-scoped review inbox with honest status and progress', async () => {
    stubFetch(handler());
    renderList();
    expect(await screen.findByText('Review Loop')).toBeInTheDocument();
    expect(await screen.findByText('Apply the pipeline fix')).toBeInTheDocument();
    expect(screen.getByTestId('status-rvw_1')).toHaveTextContent('ready for review');
    expect(screen.getByTestId('progress-rvw_1')).toHaveTextContent('1/2 accepted');
  });

  it('renders the honest empty state', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/projects')) return jsonResponse({ data: { projects: [{ id: 'prj_1', name: 'Main app' }] } });
      if (url.includes('/api/v1/reviews')) return jsonResponse({ data: { reviews: [] } });
      return jsonResponse({ data: {} });
    });
    renderList();
    expect(await screen.findByTestId('reviews-empty')).toHaveTextContent('No reviews');
  });

  it('navigates to the detail page from the Review button', async () => {
    stubFetch(handler());
    renderList();
    const btn = await screen.findByRole('button', { name: 'Review' });
    await userEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId('detail-page')).toBeInTheDocument());
  });
});