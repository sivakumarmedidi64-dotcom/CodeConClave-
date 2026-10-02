/**
 * CodeConClave — Cowork Review Loop (B1): review inbox.
 * Server-authoritative list of safety reviews for a project. Every status and
 * hunk count comes from the server record, never from a client guess. Clicking
 * a review opens the detail page where hunks are decided and the loop proceeds.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { mapReview, type Project, type ReviewListEntry } from '../lib/types';
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

function progressLabel(entry: ReviewListEntry): string {
  if (entry.totalHunks === 0) return 'no hunks';
  return `${entry.acceptedHunks}/${entry.totalHunks} accepted · ${entry.rejectedHunks} rejected`;
}

export function ReviewListPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [reviews, setReviews] = useState<ReviewListEntry[]>([]);

  useEffect(() => {
    void api<{ projects: Project[] }>('/api/v1/projects')
      .then((res) => {
        setProjects(res.projects ?? []);
        if (res.projects.length > 0) setProjectId((prev) => prev || res.projects[0]!.id);
      })
      .catch((err) => toast(err instanceof Error ? err.message : 'projects load failed', 'error'));
  }, [toast]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api<{ reviews: Array<Record<string, unknown>> }>(`/api/v1/reviews?projectId=${encodeURIComponent(projectId)}`);
      setReviews(
        (res.reviews ?? []).map((r) => {
          const item = r as Record<string, unknown>;
          const inner = (item.review ?? item) as Record<string, unknown>;
          const toNum = (v: unknown): number => {
            if (v === null || v === undefined) return 0;
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
          };
          // Hunk counts live on the LIST WRAPPER, not inside the review
          // payload. The server returns camelCase (totalHunks/...); older and
          // test fixtures use snake_case (total_hunks/...). Read the wrapper
          // first so a real inbox never renders "no hunks", then fall back to
          // the inner payload for shape-tolerant legacy records.
          return {
            review: mapReview(inner),
            totalHunks: toNum(item.total_hunks ?? item.totalHunks ?? inner.total_hunks ?? inner.totalHunks ?? 0),
            acceptedHunks: toNum(item.accepted_hunks ?? item.acceptedHunks ?? inner.accepted_hunks ?? inner.acceptedHunks ?? 0),
            rejectedHunks: toNum(item.rejected_hunks ?? item.rejectedHunks ?? inner.rejected_hunks ?? inner.rejectedHunks ?? 0),
          };
        }),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'reviews load failed', 'error');
    }
  }, [projectId, toast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openReviews = useMemo(() => reviews.filter((r) => !['COMMITTED', 'CANCELLED'].includes(r.review.status)), [reviews]);

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h1>Review Loop</h1>
        <select className="cc-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project" data-testid="project-select">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.id}
            </option>
          ))}
        </select>
      </div>
      {reviews.length === 0 && projectId && (
        <div className="cc-card cc-empty" data-testid="reviews-empty">
          No reviews for this project yet.
        </div>
      )}
      {reviews.map((entry) => (
        <div className="cc-card" key={entry.review.id} data-testid={`review-${entry.review.id}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="cc-pill" data-testid={`status-${entry.review.id}`}>
                  {STATUS_LABEL[entry.review.status] ?? entry.review.status}
                </span>
                <span className="cc-pill" data-testid={`progress-${entry.review.id}`}>
                  {progressLabel(entry)}
                </span>
              </div>
              <p style={{ margin: '8px 0 0', fontWeight: 600 }}>{entry.review.title ?? `Review ${entry.review.id}`}</p>
              <div className="cc-hint" style={{ marginTop: 4 }}>
                {entry.review.filesChanged} file(s) · +{entry.review.additions}/-{entry.review.deletions} · created{' '}
                {new Date(entry.review.createdAt).toLocaleString()}
              </div>
            </div>
            <button className="cc-btn cc-btn--sm" onClick={() => navigate(`/reviews/${entry.review.id}`)}>
              {openReviews.some((r) => r.review.id === entry.review.id) ? 'Review' : 'View'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}