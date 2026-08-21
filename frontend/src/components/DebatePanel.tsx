/**
 * CodeConClave — Agent debate panel (Stage 26I).
 * Creates and runs debates between agents with a judge; renders server
 * state only (status, rounds, spend, proposals, judge rationale). Approvals
 * (WAITING_FOR_APPROVAL) are decided here; nothing is fabricated.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Agent, DebateProposalRow, DebateRow } from '../lib/types';
import { useToast } from './Toast';

const STATUS_COLORS: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: '#64748b' },
  IN_DEBATE: { label: 'In debate', color: '#2563eb' },
  JUDGING: { label: 'Judging', color: '#7c3aed' },
  COMPLETED: { label: 'Completed', color: '#1e7d46' },
  FAILED: { label: 'Failed', color: '#dc2626' },
  CANCELLED: { label: 'Cancelled', color: '#64748b' },
  BLOCKED: { label: 'Blocked', color: '#dc2626' },
  WAITING_FOR_APPROVAL: { label: 'Waiting for your approval', color: '#b45309' },
  APPROVED: { label: 'Approved', color: '#1e7d46' },
  REJECTED: { label: 'Rejected', color: '#dc2626' },
};

const LIVE = new Set(['PENDING', 'IN_DEBATE', 'JUDGING', 'WAITING_FOR_APPROVAL']);

export function DebatePanel() {
  const { toast } = useToast();
  const [debates, setDebates] = useState<DebateRow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [showNew, setShowNew] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [proposerIds, setProposerIds] = useState<string[]>([]);
  const [judgeId, setJudgeId] = useState('');
  const [budget, setBudget] = useState('1');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ debate: DebateRow; proposals: DebateProposalRow[] } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [d, a] = await Promise.all([
        api<{ debates: DebateRow[] }>('/api/v1/agents/debates'),
        api<{ agents: Agent[] }>('/api/v1/agents'),
      ]);
      setDebates(d.debates);
      setAgents(a.agents);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Bounded live refresh: only while any debate is live.
  const [liveRef, setLiveRef] = useState(false);
  useEffect(() => {
    if (state !== 'ready') return;
    const live = debates.some((d) => LIVE.has(d.status));
    if (live === liveRef) return;
    setLiveRef(live);
    if (!live) return;
    const timer = window.setInterval(() => {
      void load();
      if (detail) void openDetail(detail.debate.id);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [debates, state, liveRef, detail]);

  const openDetail = async (id: string) => {
    try {
      const res = await api<{ debate: DebateRow; proposals: DebateProposalRow[] }>(`/api/v1/agents/debates/${id}`);
      setDetail(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  };

  const toggleProposer = (id: string) => {
    setProposerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 5 ? prev : [...prev, id]));
  };

  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ debate: DebateRow }>('/api/v1/agents/debates', {
        method: 'POST',
        body: { agentIds: proposerIds, judgeAgentId: judgeId, prompt, budgetUsd: Number(budget) || undefined },
      });
      setPrompt('');
      setProposerIds([]);
      setJudgeId('');
      setShowNew(false);
      await load();
      await openDetail(res.debate.id);
      toast('Debate started');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'start failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      const res = await api<{ debate: DebateRow }>(`/api/v1/agents/debates/${id}/cancel`, { method: 'POST' });
      setDetail((prev) => (prev ? { ...prev, debate: res.debate } : prev));
      await load();
      toast('Debate cancelled');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'cancel failed', 'error');
    }
  };

  const decide = async (id: string, decision: 'APPROVED' | 'REJECTED') => {
    try {
      const res = await api<{ debate: DebateRow }>(`/api/v1/agents/debates/${id}/decide`, {
        method: 'POST',
        body: { decision },
      });
      setDetail((prev) => (prev ? { ...prev, debate: res.debate } : prev));
      await load();
      toast(decision === 'APPROVED' ? 'Debate approved' : 'Debate rejected');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'decision failed', 'error');
    }
  };

  const badge = (status: string) => {
    const s = STATUS_COLORS[status] ?? { label: status, color: '#334155' };
    return (
      <span className="cc-pill" style={{ background: s.color, color: '#fff' }}>
        {s.label}
      </span>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p className="cc-hint" style={{ margin: 0 }}>
          Agents argue for and against a decision; a judge agent evaluates. Server-side only — proposals, rounds,
          spend and the judge's rationale are rendered as recorded.
        </p>
        <button className="cc-btn" onClick={() => setShowNew((s) => !s)}>
          + New debate
        </button>
      </div>

      {showNew && (
        <div className="cc-card">
          <div className="cc-field">
            <label htmlFor="debate-prompt">Question / decision to debate</label>
            <textarea
              id="debate-prompt"
              className="cc-textarea"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Should we switch the checkout to a server-side render?"
            />
          </div>
          <div className="cc-field">
            <label>Proposing agents (2–5)</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {agents
                .filter((a) => a.status === 'IDLE')
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="cc-pill"
                    style={{ cursor: 'pointer', background: proposerIds.includes(a.id) ? '#0f766e' : '#1e293b', color: '#fff' }}
                    onClick={() => toggleProposer(a.id)}
                    aria-pressed={proposerIds.includes(a.id)}
                  >
                    {a.name}
                  </button>
                ))}
              {agents.filter((a) => a.status === 'IDLE').length === 0 && (
                <p className="cc-hint">No idle agents available — create agents in the Agents tab first.</p>
              )}
            </div>
          </div>
          <div className="cc-field">
            <label htmlFor="debate-judge">Judge agent</label>
            <select id="debate-judge" className="cc-select" value={judgeId} onChange={(e) => setJudgeId(e.target.value)}>
              <option value="">Select judge…</option>
              {agents
                .filter((a) => !proposerIds.includes(a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role})
                  </option>
                ))}
            </select>
          </div>
          <div className="cc-field" style={{ width: 140 }}>
            <label htmlFor="debate-budget">Budget USD</label>
            <input id="debate-budget" className="cc-input" type="number" min={0.1} step={0.1} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <button className="cc-btn" disabled={busy || !prompt.trim() || proposerIds.length < 2 || !judgeId} onClick={() => void create()}>
            Start debate
          </button>
        </div>
      )}

      {state === 'loading' && <div className="cc-card cc-empty">Loading debates…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load debates.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {state === 'ready' && debates.length === 0 && <div className="cc-card cc-empty">No debates yet — start one to compare agent proposals.</div>}

      {debates.map((d) => (
        <div className="cc-card" key={d.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h4 style={{ margin: 0 }}>
                {d.prompt} {badge(d.status)}
              </h4>
              <p className="cc-hint cc-mono" style={{ margin: '4px 0' }}>
                round {d.round_count}/{d.max_rounds} · spent ${Number(d.spent_usd).toFixed(4)} / ${Number(d.budget_usd).toFixed(2)} ·
                deadline {new Date(d.deadline_at).toLocaleString()}
              </p>
              {d.require_approval && d.user_decision === null && (
                <p className="cc-hint" style={{ margin: '4px 0', color: '#b45309' }}>
                  Requires your approval before the winning proposal applies.
                </p>
              )}
              {d.rationale && <p className="cc-hint" style={{ margin: '4px 0' }}>Judge: {d.rationale}</p>}
              {d.error && <p className="cc-hint" style={{ margin: '4px 0', color: '#dc2626' }}>{d.error}</p>}
            </div>
            <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-start' }}>
              {LIVE.has(d.status) && (
                <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void cancel(d.id)}>Cancel</button>
              )}
              {d.status === 'WAITING_FOR_APPROVAL' && (
                <>
                  <button className="cc-btn cc-btn--sm" onClick={() => void decide(d.id, 'APPROVED')}>Approve</button>
                  <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void decide(d.id, 'REJECTED')}>Reject</button>
                </>
              )}
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void openDetail(d.id)}>
                {detail?.debate.id === d.id ? 'Close' : 'Proposals'}
              </button>
            </div>
          </div>
          {detail?.debate.id === d.id && (
            <div style={{ marginTop: 12 }}>
              {detail.proposals.length === 0 && <p className="cc-hint">No proposals recorded yet.</p>}
              {detail.proposals.map((p) => (
                <div key={p.id} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '8px 0' }}>
                  <strong style={{ fontSize: 13 }}>
                    {p.agent_name} ({p.role}) — round {p.round}
                  </strong>{' '}
                  <span className="cc-pill" style={{ fontSize: 11 }}>{p.status}</span>
                  {p.status === 'FAILED' ? (
                    <p style={{ margin: '4px 0', color: '#dc2626' }}>{p.error ?? 'Proposal failed'}</p>
                  ) : (
                    <>
                      {p.proposal && <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{p.proposal}</p>}
                      {p.evidence && <p style={{ margin: '2px 0' }}><strong>Evidence:</strong> {p.evidence}</p>}
                      {p.risks && <p style={{ margin: '2px 0' }}><strong>Risks:</strong> {p.risks}</p>}
                      {p.tradeoffs && <p style={{ margin: '2px 0' }}><strong>Tradeoffs:</strong> {p.tradeoffs}</p>}
                      <p className="cc-mono" style={{ margin: '2px 0', fontSize: 11 }}>
                        ${Number(p.cost_usd).toFixed(4)} · {(p.duration_ms / 1000).toFixed(1)}s
                      </p>
                    </>
                  )}
                </div>
              ))}
              {d.winner_agent_id && (
                <p className="cc-hint" style={{ marginTop: 8 }}>
                  Winner: {detail.proposals.find((p) => p.agent_id === d.winner_agent_id)?.agent_name ?? d.winner_agent_id}
                </p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}