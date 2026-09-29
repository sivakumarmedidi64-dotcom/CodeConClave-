/**
 * CodeConClave — Cowork Review Loop (B1): review detail.
 * Server-authoritative hunk decisions and lifecycle. Each accept/reject posts
 * to the server and re-fetches the review; apply rewrites files only from the
 * accepted hunks; tests run in the sandboxed worktree; commit requires an
 * explicit message and never pushes. State is always the server record.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { mapReview, type ReviewView } from '../lib/types';
import { useToast } from '../components/Toast';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'draft',
  READY_FOR_REVIEW: 'ready for review',
  PARTIALLY_REVIEWED: 'partially reviewed',
  APPLIED: 'applied',
  TESTING: 'testing',
  TEST_PASSED: 'tests passed',
  TEST_FAILED: 'tests failed',
  COMMITTED: 'committed',
  UNDONE: 'undone',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const HUNK_LABEL: Record<string, string> = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  APPLIED: 'applied',
  FAILED: 'failed',
  INVALIDATED: 'invalidated',
};

const ACTIONABLE = ['DRAFT', 'READY_FOR_REVIEW', 'PARTIALLY_REVIEWED'];
const APPLIED_STATES = ['APPLIED', 'TESTING', 'TEST_PASSED', 'TEST_FAILED'];

export function ReviewDetailPage() {
  const { id = '' } = useParams();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [review, setReview] = useState<ReviewView | null>(null);
  const [busy, setBusy] = useState('');
  const [commitInput, setCommitInput] = useState('');
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ review: Record<string, unknown> }>(`/api/v1/reviews/${id}`);
      setReview(mapReview(res.review));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'review load failed', 'error');
    }
  }, [id, toast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (action: string, run: () => Promise<unknown>) => {
      setBusy(action);
      try {
        await run();
        await load();
      } catch (err) {
        toast(err instanceof Error ? err.message : `${action} failed`, 'error');
      } finally {
        setBusy('');
      }
    },
    [load, toast],
  );

  const decideHunk = (hunkId: string, decision: 'ACCEPTED' | 'REJECTED') =>
    act(`decide ${hunkId}`, () =>
      api(`/api/v1/reviews/${id}/hunks/${hunkId}/${decision === 'ACCEPTED' ? 'accept' : 'reject'}`, { method: 'POST' }),
    );

  const acceptAll = () =>
    act('accept all', () => api(`/api/v1/reviews/${id}/hunks/accept-all`, { method: 'POST' }));

  const rejectAll = () =>
    act('reject all', () => api(`/api/v1/reviews/${id}/hunks/reject-all`, { method: 'POST' }));

  const apply = () => act('apply', () => api(`/api/v1/reviews/${id}/apply`, { method: 'POST' }));
  const runTests = () => act('run tests', () => api(`/api/v1/reviews/${id}/run-tests`, { method: 'POST' }));
  const undo = () => {
    if (!confirm) {
      setConfirm(true);
      toast('Click undo again to confirm reverting the applied changes', 'info');
      return;
    }
    setConfirm(false);
    void act('undo', () => api(`/api/v1/reviews/${id}/undo`, { method: 'POST' }));
  };
  const cancel = () =>
    act('cancel', () => api(`/api/v1/reviews/${id}/cancel`, { method: 'POST' }));

  const commit = () => {
    const message = commitInput.trim();
    if (!message) {
      toast('A commit message is required', 'error');
      return;
    }
    void act('commit', () => api(`/api/v1/reviews/${id}/commit`, { method: 'POST', body: { message } }));
  };

  if (!review) {
    return (
      <div className="cc-page">
        <div className="cc-card cc-empty" data-testid="review-loading">
          Loading review…
        </div>
      </div>
    );
  }

  const canDecide = ACTIONABLE.includes(review.status);
  const pendingHunks = review.hunks.filter((h) => h.status === 'PENDING').length;

  return (
    <div className="cc-page">
      <button className="cc-btn cc-btn--sm cc-btn--ghost" onClick={() => navigate('/reviews')} style={{ marginBottom: 12 }}>
        Back to reviews
      </button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1>{review.title ?? `Review ${review.id}`}</h1>
        <span className="cc-pill" data-testid="review-status">
          {STATUS_LABEL[review.status] ?? review.status}
        </span>
      </div>
      <div className="cc-hint" style={{ marginTop: 4 }}>
        {review.filesChanged} file(s) · +{review.additions}/-{review.deletions} · created{' '}
        {new Date(review.createdAt).toLocaleString()} · {pendingHunks} hunk(s) pending
      </div>

      {review.applyError && (
        <div className="cc-card" data-testid="apply-error" style={{ borderColor: '#dc2626' }}>
          apply failed: {review.applyError}
        </div>
      )}
      {review.diffText && <pre className="cc-code" style={{ whiteSpace: 'pre-wrap' }}>{review.diffText}</pre>}

      {canDecide && pendingHunks > 0 && (
        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
          <button className="cc-btn cc-btn--sm" onClick={() => void acceptAll()} disabled={busy === 'accept all'} data-testid="accept-all">
            {busy === 'accept all' ? 'Accepting…' : 'Accept all'}
          </button>
          <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void rejectAll()} disabled={busy === 'reject all'} data-testid="reject-all">
            {busy === 'reject all' ? 'Rejecting…' : 'Reject all'}
          </button>
        </div>
      )}

      {review.hunks.map((h) => (
        <div className="cc-card" key={h.id} data-testid={`hunk-${h.id}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="cc-pill" data-testid={`hunk-status-${h.id}`}>
                {HUNK_LABEL[h.status] ?? h.status}
              </span>
              <span className="cc-pill">{h.path}</span>
              <span className="cc-hint">
                +{h.additions}/-{h.deletions} @ {h.newStart}
              </span>
            </div>
            {canDecide && h.status === 'PENDING' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="cc-btn cc-btn--sm" onClick={() => void decideHunk(h.id, 'ACCEPTED')} disabled={busy === `decide ${h.id}`} data-testid={`accept-${h.id}`}>
                  Accept
                </button>
                <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void decideHunk(h.id, 'REJECTED')} disabled={busy === `decide ${h.id}`} data-testid={`reject-${h.id}`}>
                  Reject
                </button>
              </div>
            )}
          </div>
          <pre className="cc-code" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }} data-testid={`diff-${h.id}`}>
            {h.diffText}
          </pre>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
        {review.status === 'READY_FOR_REVIEW' && !canDecide && pendingHunks > 0 && <span className="cc-hint">Decide hunks to continue.</span>}
        {ACTIONABLE.includes(review.status) && (
          <button className="cc-btn cc-btn--sm" onClick={() => void apply()} disabled={busy === 'apply'} data-testid="apply">
            {busy === 'apply' ? 'Applying…' : 'Apply accepted changes'}
          </button>
        )}
        {APPLIED_STATES.includes(review.status) && (
          <button className="cc-btn cc-btn--sm" onClick={() => void runTests()} disabled={busy === 'run tests'} data-testid="run-tests">
            {busy === 'run tests' ? 'Testing…' : 'Run tests in sandbox'}
          </button>
        )}
        {review.status === 'TEST_PASSED' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="cc-input"
              placeholder="commit message"
              value={commitInput}
              onChange={(e) => setCommitInput(e.target.value)}
              data-testid="commit-message"
              style={{ width: 260 }}
            />
            <button className="cc-btn cc-btn--sm" onClick={commit} disabled={busy === 'commit'} data-testid="commit">
              {busy === 'commit' ? 'Committing…' : 'Commit (no push)'}
            </button>
          </div>
        )}
        {APPLIED_STATES.includes(review.status) && (
          <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={undo} disabled={busy === 'undo'} data-testid="undo">
            {busy === 'undo' ? 'Undoing…' : confirm ? 'Confirm undo' : 'Undo'}
          </button>
        )}
        {canDecide && (
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void cancel()} disabled={busy === 'cancel'} data-testid="cancel">
            Cancel review
          </button>
        )}
      </div>

      {review.testStatus !== 'NOT_RUN' && (
        <div className="cc-card" style={{ marginTop: 16 }} data-testid="test-result">
          <div>
            tests: {review.testStatus.toLowerCase().replaceAll('_', ' ')}
            {review.testExitCode !== null && <> · exit code {review.testExitCode}</>}
            {review.testDurationMs !== null && <> · {review.testDurationMs}ms</>}
          </div>
          {review.testOutput && <pre className="cc-code" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{review.testOutput}</pre>}
        </div>
      )}

      {review.commitStatus !== 'NOT_COMMITTED' && (
        <div className="cc-card" style={{ marginTop: 16 }} data-testid="commit-result">
          <div>
            commit: {review.commitStatus.toLowerCase().replaceAll('_', ' ')}
            {review.commitHash && <> · {review.commitHash}</>}
            {review.branch && <> · branch {review.branch}</>}
          </div>
          {review.commitMessage && <div className="cc-hint">{review.commitMessage}</div>}
        </div>
      )}
    </div>
  );
}