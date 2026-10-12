/**
 * CodeConClave — pre-work briefing: before work starts, the report.
 *
 * Reads the already-loaded task queue (no extra task fetch) plus the pending
 * approval count, and states plainly what the work is and what the balance
 * looks like: open, running, waiting on you, done, failed. Failed sources
 * hide their own clause — the briefing never breaks on a missing number.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Task } from '../lib/types';

const DONE = new Set(['COMPLETED', 'VERIFIED']);
const FAILED = new Set(['FAILED', 'TIMED_OUT']);

export function WorkBriefing({ tasks }: { tasks: Task[] }) {
  const [pendingApprovals, setPendingApprovals] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api<{ pendingCount: number }>('/api/v1/execution/approvals');
        if (active && typeof res.pendingCount === 'number') setPendingApprovals(res.pendingCount);
      } catch {
        /* approvals clause hides itself */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (tasks.length === 0 && (pendingApprovals === null || pendingApprovals === 0)) return null;

  let open = 0;
  let running = 0;
  let waiting = 0;
  let done = 0;
  let failed = 0;
  for (const t of tasks) {
    const s = t.status ?? '';
    if (DONE.has(s)) done += 1;
    else if (FAILED.has(s)) failed += 1;
    else if (s === 'CANCELLED') failed += 1;
    else if (s === 'RUNNING') running += 1;
    else if (s.startsWith('WAITING')) waiting += 1;
    else open += 1;
  }
  const remaining = open + running + waiting;

  return (
    <div data-testid="work-briefing" className="cc-card cc-briefing">
      <p className="cc-card__eyebrow">Before you start</p>
      <p data-testid="work-briefing-line">
        {remaining === 0 && done + failed === 0 ? (
          'No work queued yet.'
        ) : (
          <>
            {done > 0 && <span>{done} done</span>}
            {done > 0 && remaining > 0 && <span> · </span>}
            {remaining > 0 && (
              <span>
                {remaining} still open ({open} to do{running > 0 ? `, ${running} running` : ''}
                {waiting > 0 ? `, ${waiting} waiting` : ''})
              </span>
            )}
            {remaining === 0 && (done > 0 || failed > 0) && <span>All clear — nothing open.</span>}
            {failed > 0 && <span> · {failed} failed</span>}
          </>
        )}
      </p>
      {pendingApprovals !== null && pendingApprovals > 0 && (
        <p data-testid="work-briefing-approvals">
          <Link to="/approvals">
            {pendingApprovals} decision{pendingApprovals === 1 ? '' : 's'} waiting on you
          </Link>
        </p>
      )}
    </div>
  );
}
