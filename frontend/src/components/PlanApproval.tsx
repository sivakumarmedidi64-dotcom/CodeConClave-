/**
 * Plan first, then act (constitution Article 5). The Cowork team's plan is
 * shown before any work runs; Approve releases the task to the team, Reject
 * cancels it. The decision goes through the real approvals endpoint — the
 * same one the Approvals page uses — so nothing here is local-only state.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';

export interface PlanStep {
  order: number;
  coworker: string;
  acceptanceCriteria?: string;
  risk?: string;
}

export interface PlanSummary {
  goal?: string;
  source?: string;
  steps: PlanStep[];
}

const BOT_NAMES: Record<string, string> = {
  PLANNER: 'Plato · Planner',
  ARCHITECT: 'Archie · Architect',
  CODER: 'Cody · Coder',
  SECURITY: 'Sentry · Security',
  TESTER: 'Tess · Tester',
  PERFORMANCE: 'Turbo · Performance',
  RESEARCH: 'Scout · Research',
  DOCS: 'Doc · Docs',
  REVIEWER: 'Rhea · Reviewer',
  NOVA: 'Nova · Generalist',
};

export function botName(coworker: string): string {
  return BOT_NAMES[coworker.toUpperCase()] ?? coworker.charAt(0) + coworker.slice(1).toLowerCase();
}

/** Accepts the approval detail / done-event plan shape; null when it isn't a plan. */
export function asPlanSummary(value: unknown): PlanSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { kind?: unknown; goal?: unknown; source?: unknown; steps?: unknown };
  if (!Array.isArray(v.steps) || v.steps.length === 0) return null;
  const steps = v.steps
    .map((s, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return typeof o.coworker === 'string'
        ? {
            order: typeof o.order === 'number' ? o.order : i + 1,
            coworker: o.coworker,
            ...(typeof o.acceptanceCriteria === 'string' ? { acceptanceCriteria: o.acceptanceCriteria } : {}),
            ...(typeof o.risk === 'string' ? { risk: o.risk } : {}),
          }
        : null;
    })
    .filter((s): s is PlanStep => s !== null);
  if (steps.length === 0) return null;
  return { goal: typeof v.goal === 'string' ? v.goal : undefined, source: typeof v.source === 'string' ? v.source : undefined, steps };
}

export function PlanSteps({ plan }: { plan: PlanSummary }) {
  return (
    <ol className="cc-plan__steps">
      {plan.steps.map((s) => (
        <li key={`${s.order}-${s.coworker}`}>
          <strong>{botName(s.coworker)}</strong>
          {s.acceptanceCriteria && <span className="cc-plan__done-when"> — done when: {s.acceptanceCriteria}</span>}
          {s.risk && s.risk !== 'LOW' && <span className="cc-pill">{s.risk.toLowerCase()} risk</span>}
        </li>
      ))}
    </ol>
  );
}

type Decision = 'idle' | 'sending' | 'approved' | 'rejected' | 'error';

export function PlanApprovalCard({
  approvalId,
  plan,
  onApproved,
}: {
  approvalId: string;
  plan: PlanSummary;
  onApproved?: () => void;
}) {
  const [state, setState] = useState<Decision>('idle');
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'APPROVE' | 'REJECT') => {
    setState('sending');
    setError(null);
    try {
      await api(`/api/v1/execution/approvals/${encodeURIComponent(approvalId)}/decide`, { method: 'POST', body: { decision } });
      setState(decision === 'APPROVE' ? 'approved' : 'rejected');
      if (decision === 'APPROVE') onApproved?.();
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Could not record your decision.');
    }
  };

  return (
    <section className="cc-plan" data-testid="plan-approval" aria-label="Plan waiting for approval">
      <header className="cc-plan__head">
        <Icon name="map" size={15} />
        <strong>Plan — nothing runs until you approve</strong>
      </header>
      {plan.goal && <p className="cc-plan__goal">{plan.goal}</p>}
      <PlanSteps plan={plan} />
      {plan.source === 'default_fallback' && (
        <p className="cc-hint">The planner was unavailable, so this is the standard team plan.</p>
      )}
      {state === 'approved' ? (
        <p className="pv3-ok" role="status">
          ✓ Approved — the team is starting this plan.
        </p>
      ) : state === 'rejected' ? (
        <p className="cc-hint" role="status">
          Rejected — the task was cancelled and nothing ran.
        </p>
      ) : (
        <div className="cc-plan__actions">
          <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={state === 'sending'} onClick={() => void decide('APPROVE')}>
            Approve and start
          </button>
          <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" disabled={state === 'sending'} onClick={() => void decide('REJECT')}>
            Reject
          </button>
        </div>
      )}
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
