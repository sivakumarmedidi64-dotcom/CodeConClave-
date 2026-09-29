/**
 * CodeConClave — ReviewDetailPage tests (B1).
 * Server-authoritative hunk decisions + lifecycle: per-hunk accept/reject,
 * accept-all, apply, run tests, undo (with confirmation), commit requires a
 * message. Every button posts to the real endpoint and re-reads the record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { ReviewDetailPage } from './ReviewDetailPage';
import { jsonResponse, stubFetch } from '../testutils';

type Row = Record<string, unknown>;

const HUNK = (id: string, status: string): Row => ({
  id,
  review_id: 'rvw_1',
  file_id: 'rvf_1',
  path: 'src/app.ts',
  hunk_order: 1,
  status,
  old_start: 3,
  old_lines: 1,
  new_start: 3,
  new_lines: 1,
  original_sha: 'a',
  proposed_sha: 'b',
  additions: 1,
  deletions: 1,
  context_lines: { before: ['line2'], after: ['line4'] },
  diff_text: '@@ -3,1 +3,1 @@\n line2\n-OLD\n+NEW\n line4',
  decided_at: status === 'PENDING' ? null : '2026-08-18T00:00:00.000Z',
});

function baseReview(): Row {
  return {
    id: 'rvw_1',
    task_id: 'tsk_1',
    project_id: 'prj_1',
    title: 'Apply the pipeline fix',
    status: 'READY_FOR_REVIEW',
    test_status: 'NOT_RUN',
    commit_status: 'NOT_COMMITTED',
    diff_text: 'diff --git a/src/app.ts b/src/app.ts',
    files_changed: 1,
    additions: 1,
    deletions: 1,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    files: [],
    hunks: [HUNK('rvh_1', 'PENDING'), HUNK('rvh_2', 'PENDING')],
  };
}

const POSTS: string[] = [];

/** Mutable server-ish store so POSTs mutate what the subsequent GET returns. */
function makeHandler(initial: Row) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/reviews/rvw_1/hunks/accept-all') && init?.method === 'POST') {
      POSTS.push('/api/v1/reviews/rvw_1/hunks/accept-all');
      initial.hunks = (initial.hunks as Row[]).map((h) => HUNK(String(h.id), 'ACCEPTED'));
      return jsonResponse({ data: { review: initial } });
    }
    if (url.includes('/api/v1/reviews/rvw_1/hunks/') && init?.method === 'POST') {
      POSTS.push(url.split('?')[0]!);
      const m = /hunks\/(rvh_\d+)\/(accept|reject)$/.exec(url);
      if (m) {
        const hunkId = m[1]!;
        const action = m[2]!;
        initial.hunks = (initial.hunks as Row[]).map((h) =>
          h.id === hunkId ? HUNK(hunkId, action === 'accept' ? 'ACCEPTED' : 'REJECTED') : h,
        );
      }
      return jsonResponse({ data: { review: initial } });
    }
    if (url.includes('/api/v1/reviews/rvw_1/apply') && init?.method === 'POST') {
      POSTS.push('/api/v1/reviews/rvw_1/apply');
      initial.status = 'APPLIED';
      initial.hunks = (initial.hunks as Row[]).map((h) => HUNK(String(h.id), 'APPLIED'));
      return jsonResponse({ data: { review: initial } });
    }
    if (url.includes('/api/v1/reviews/rvw_1/run-tests') && init?.method === 'POST') {
      POSTS.push('/api/v1/reviews/rvw_1/run-tests');
      initial.status = 'TESTING';
      initial.test_status = 'RUNNING';
      initial.hunks = [];
      return jsonResponse({ data: { review: initial } });
    }
    if (url.includes('/api/v1/reviews/rvw_1/undo') && init?.method === 'POST') {
      POSTS.push('/api/v1/reviews/rvw_1/undo');
      initial.status = 'UNDONE';
      initial.hunks = [];
      return jsonResponse({ data: { review: initial } });
    }
    if (url.includes('/api/v1/reviews/rvw_1/commit') && init?.method === 'POST') {
      POSTS.push('/api/v1/reviews/rvw_1/commit');
      initial.status = 'COMMITTED';
      initial.commit_status = 'COMMITTED';
      initial.commit_hash = 'abc1234';
      initial.hunks = [];
      return jsonResponse({ data: { review: initial } });
    }
    if (url.includes('/api/v1/reviews/rvw_1')) return jsonResponse({ data: { review: initial } });
    return jsonResponse({ data: {} });
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/reviews/rvw_1']}>
      <ToastProvider>
        <Routes>
          <Route path="/reviews/:id" element={<ReviewDetailPage />} />
          <Route path="/reviews" element={<div data-testid="list-page" />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  POSTS.length = 0;
});

describe('ReviewDetailPage', () => {
  it('renders hunks with accept/reject and posts a single decision', async () => {
    stubFetch(makeHandler(baseReview()));
    renderDetail();
    expect(await screen.findByText('Apply the pipeline fix')).toBeInTheDocument();
    expect(screen.getByTestId('review-status')).toHaveTextContent('ready for review');

    const hunk = screen.getByTestId('hunk-rvh_1');
    expect(within(hunk).getByText(/\+1\/-1/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('accept-rvh_1'));
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/hunks/rvh_1/accept'));
    expect(await screen.findByTestId('hunk-status-rvh_1')).toHaveTextContent('accepted');
  });

  it('accept-all posts the bulk endpoint and shows applied acceptances', async () => {
    stubFetch(makeHandler(baseReview()));
    renderDetail();
    await userEvent.click(await screen.findByTestId('accept-all'));
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/hunks/accept-all'));
    expect(await screen.findAllByText('accepted')).toHaveLength(2);
  });

  it('apply posts and reflects the applied status', async () => {
    stubFetch(makeHandler(baseReview()));
    renderDetail();
    await userEvent.click(await screen.findByTestId('apply'));
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/apply'));
    expect(await screen.findByTestId('review-status')).toHaveTextContent('applied');
  });

  it('run-tests only appears after apply and posts the endpoint', async () => {
    stubFetch(makeHandler(baseReview()));
    renderDetail();
    expect(await screen.findByTestId('apply')).toBeInTheDocument();
    expect(screen.queryByTestId('run-tests')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/apply'));
    const runTests = await screen.findByTestId('run-tests');
    await userEvent.click(runTests);
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/run-tests'));
  });

  it('undo requires an explicit confirmation click', async () => {
    stubFetch(makeHandler(baseReview()));
    renderDetail();
    await userEvent.click(await screen.findByTestId('apply'));
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/apply'));

    await userEvent.click(await screen.findByTestId('undo'));
    expect(await screen.findByText('Click undo again to confirm reverting the applied changes')).toBeInTheDocument();
    expect(POSTS).not.toContain('/api/v1/reviews/rvw_1/undo');
    await userEvent.click(screen.getByTestId('undo'));
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/undo'));
  });

  it('commit requires a message before posting and shows the hash after', async () => {
    const store = baseReview();
    store.status = 'TEST_PASSED';
    store.test_status = 'PASSED';
    const handler = makeHandler(store);
    stubFetch(handler);
    renderDetail();
    const cm = await screen.findByTestId('commit-message');
    await userEvent.click(screen.getByTestId('commit'));
    expect(POSTS).not.toContain('/api/v1/reviews/rvw_1/commit');
    expect(await screen.findByText('A commit message is required')).toBeInTheDocument();
    await userEvent.type(cm, 'Apply pipeline fix');
    await userEvent.click(screen.getByTestId('commit'));
    await waitFor(() => expect(POSTS).toContain('/api/v1/reviews/rvw_1/commit'));
    expect(await screen.findByTestId('commit-result')).toHaveTextContent('abc1234');
  });
});