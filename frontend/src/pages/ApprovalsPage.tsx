/**
 * CodeConClave — Approval Center (Phase 4C).
 * Server-authoritative human gate: risk level, action type, affected
 * resources, proposed action, justification, coworker, model, timestamp and a
 * live expiry countdown. States are honest — approved/rejected/expired/executed
 * and execution failures are only ever shown from the server record, never
 * from a button click. Executing an approved action waits for the server
 * execution result and renders it (SUCCEEDED/FAILED) on the approval.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { mapApproval, type Approval } from '../lib/types';
import { useToast } from '../components/Toast';
import { isOnline, enqueueOfflineOp } from '../lib/offline';
import { Icon } from '../components/Icon';
import { AICompanion } from '../components/AICompanion';

const RISK_CLASS: Record<string, string> = {
  LOW: 'cc-pill--success',
  MEDIUM: 'cc-pill--accent',
  HIGH: 'cc-pill--warn',
  CRITICAL: 'cc-pill--danger',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  EXECUTED: 'executed',
  REVOKED: 'revoked',
  CANCELLED: 'cancelled',
};

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function commandPreview(action: Approval): string {
  const proposed = action.proposedAction ?? {};
  const input = (proposed.input as Record<string, unknown>) ?? {};
  if (typeof input.command === 'string') return input.command;
  if (typeof input.path === 'string') return input.path;
  return '';
}

export function ApprovalsPage() {
  const { toast } = useToast();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [filter, setFilter] = useState('PENDING');
  /* Reason draft per approval row. A single shared field would mirror one
     row's text into every other pending row — confusing and error-prone
     when several approvals are on screen. */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [execTool, setExecTool] = useState<Record<string, string>>({});
  const [execInput, setExecInput] = useState<Record<string, string>>({});
  const [execDevice, setExecDevice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await api<{ approvals: Record<string, unknown>[]; pendingCount: number }>(
        `/api/v1/execution/approvals${filter ? `?status=${filter}` : ''}`,
      );
      setApprovals(res.approvals.map(mapApproval));
      setPendingCount(res.pendingCount);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  }, [filter, toast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const decide = async (id: string, decision: 'APPROVE' | 'REJECT') => {
    const draft = (reasons[id] ?? '').trim();
    const clearDraft = () =>
      setReasons((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    try {
      if (!isOnline()) {
        enqueueOfflineOp('approval.decide', { approvalId: id, decision, reason: draft || null });
        clearDraft();
        toast(`${decision === 'APPROVE' ? 'Approval' : 'Rejection'} queued — will sync when you reconnect`, 'info');
        return;
      }
      await api(`/api/v1/execution/approvals/${id}/decide`, {
        method: 'POST',
        body: { decision, reason: draft || undefined },
      });
      clearDraft();
      await load();
      toast(decision === 'APPROVE' ? 'Approved — ready to execute' : 'Rejected', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : `${decision.toLowerCase()} failed`, 'error');
    }
  };

  const execute = async (a: Approval) => {
    const proposed = (a.proposedAction as Record<string, unknown>) ?? {};
    const tool = String(execTool[a.id] ?? proposed.tool ?? '').trim();
    if (!tool) {
      toast('A tool is required to execute the approved action', 'error');
      return;
    }
    let input: Record<string, unknown> = {};
    const rawInput = execInput[a.id]?.trim();
    if (rawInput) {
      try {
        input = JSON.parse(rawInput) as Record<string, unknown>;
      } catch {
        toast('Execution input must be valid JSON', 'error');
        return;
      }
    }
    const deviceId = execDevice[a.id]?.trim() || undefined;
    setExecutingId(a.id);
    try {
      const res = await api<{ approval: Record<string, unknown> }>(
        `/api/v1/execution/approvals/${a.id}/execute`,
        { method: 'POST', body: { tool, input, deviceId } },
      );
      const updated = mapApproval(res.approval);
      setApprovals((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      if (updated.executionStatus === 'SUCCEEDED') {
        toast(`Executed — ${updated.actionType ?? 'action'} completed`, 'info');
      } else if (updated.executionStatus === 'FAILED') {
        toast('Execution failed — see the approval record', 'error');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'execution failed', 'error');
    } finally {
      setExecutingId(null);
    }
  };

  /* Each pending row owns its 1s countdown tick (see ExpiryCountdown below)
     so the whole page no longer rerenders every second. */
  const expiresSoon = (expiresAt: string) => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    return ms > 0 && ms < 5 * 60 * 1000;
  };

  const renderApprovalActions = (a: Approval) => {
    if (a.status === 'PENDING') {
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--cc-border)' }}>
          <input
            className="cc-input"
            placeholder="reason (optional)"
            aria-label={`Reason for approval ${a.id}`}
            style={{ width: 200 }}
            value={reasons[a.id] ?? ''}
            onChange={(e) => setReasons((prev) => ({ ...prev, [a.id]: e.target.value }))}
          />
          <button className="cc-btn cc-btn--primary cc-btn--sm" onClick={() => void decide(a.id, 'APPROVE')}>
            <Icon name="check" size={12} />
            Approve
          </button>
          <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void decide(a.id, 'REJECT')}>
            <Icon name="close" size={12} />
            Reject
          </button>
        </div>
      );
    }
    if (a.status === 'APPROVED') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 320, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--cc-border)' }}>
          <input
            className="cc-input"
            placeholder="tool (e.g. file_write)"
            value={String(execTool[a.id] ?? ((a.proposedAction as Record<string, unknown>)?.tool ?? ''))}
            onChange={(e) => setExecTool((p) => ({ ...p, [a.id]: e.target.value }))}
          />
          <input
            className="cc-input"
            placeholder='input JSON ({"path":"src/app.ts"})'
            value={execInput[a.id] ?? ''}
            onChange={(e) => setExecInput((p) => ({ ...p, [a.id]: e.target.value }))}
            data-testid={`input-${a.id}`}
          />
          <input
            className="cc-input"
            placeholder="device id (terminal/remote only)"
            value={execDevice[a.id] ?? ''}
            onChange={(e) => setExecDevice((p) => ({ ...p, [a.id]: e.target.value }))}
          />
          <button
            className="cc-btn cc-btn--primary cc-btn--sm"
            onClick={() => void execute(a)}
            disabled={executingId === a.id}
            data-testid={`execute-${a.id}`}
          >
            <Icon name={executingId === a.id ? 'refresh' : 'arrowRight'} size={12} />
            {executingId === a.id ? 'Executing…' : 'Execute approved action'}
          </button>
        </div>
      );
    }
    return null;
  };

  const renderApprovalDetails = (a: Approval) => {
    if (detailsId !== a.id) return null;
    return (
      <div style={{ marginTop: 8 }}>
        <div className="cc-hint" style={{ marginBottom: 4 }}>Proposed action</div>
        <pre className="cc-code" style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(a.proposedAction, null, 2)}
        </pre>
      </div>
    );
  };

  const renderExecutionResult = (a: Approval) => {
    if (!a.executionStatus) return null;
    return (
      <div
        className="cc-card"
        style={{
          marginTop: 8,
          borderColor: a.executionStatus === 'FAILED' ? '#dc2626' : '#16a34a',
        }}
        data-testid={`execution-${a.id}`}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
          <Icon name={a.executionStatus === 'SUCCEEDED' ? 'check' : 'close'} size={14} className={a.executionStatus === 'SUCCEEDED' ? 'cc-icon-success' : 'cc-icon-danger'} />
          execution: {a.executionStatus === 'SUCCEEDED' ? 'executed' : 'execution failed'}
        </div>
        {a.executionStatus === 'FAILED' && a.executionResult && (
          <div className="cc-hint" style={{ marginTop: 4 }}>{(a.executionResult as { error?: string }).error ?? 'unknown error'}</div>
        )}
        {a.executionCompletedAt && (
          <div className="cc-hint" style={{ marginTop: 4 }}>completed {new Date(a.executionCompletedAt).toLocaleString()}</div>
        )}
        {a.auditReference && <div className="cc-hint" style={{ marginTop: 4 }}>audit: {a.auditReference}</div>}
      </div>
    );
  };

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1>Approvals</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="cc-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="EXPIRED">Expired</option>
            <option value="EXECUTED">Executed</option>
          </select>
          {pendingCount > 0 && <span className="cc-pill cc-pill--accent">{pendingCount} pending</span>}
          {/* Companion presence for the one state Chat never shows: real,
              server-reported pending approvals awaiting a human. */}
          <AICompanion state={pendingCount > 0 ? 'approval' : 'idle'} />
        </div>
      </div>

      {approvals.length === 0 && (
        <div className="cc-card cc-empty">No approvals {filter !== 'PENDING' ? `(${filter})` : ''}.</div>
      )}

      {approvals.map((a) => (
        <div className="cc-card" key={a.id} data-testid={`approval-${a.id}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className={`cc-pill ${RISK_CLASS[a.riskLevel] ?? ''}`}>{a.riskLevel}</span>
                <span className="cc-pill" data-testid={`status-${a.id}`}>
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
                {a.actionType && <span className="cc-pill">{a.actionType}</span>}
                {a.status === 'PENDING' && expiresSoon(a.expiresAt) && (
                  <span className="cc-pill cc-pill--danger">expires soon</span>
                )}
              </div>

              <p style={{ margin: '8px 0 0', fontWeight: 600 }}>
                {a.justification ?? (a.taskId ? `Task ${a.taskId}` : 'Approval')}
              </p>

              {commandPreview(a) && (
                <div className="cc-code" style={{ marginTop: 6 }}>
                  {commandPreview(a)}
                </div>
              )}

              <div className="cc-hint" style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>
                  {a.coworker && <span>coworker: {a.coworker}</span>}
                  {a.coworker && a.model && <span> · </span>}
                  {a.model && <span>model: {a.model}</span>}
                </span>
                <span>
                  created {new Date(a.createdAt).toLocaleString()} · expires{' '}
                  {new Date(a.expiresAt).toLocaleString()}
                  {a.status === 'PENDING' && <ExpiryCountdown id={a.id} expiresAt={a.expiresAt} />}
                </span>
              </div>

              {a.affectedResources && a.affectedResources.length > 0 && (
                <div className="cc-hint" style={{ marginTop: 4 }}>
                  affects:{' '}
                  {a.affectedResources.map((r) => (
                    <span key={r.ref} className="cc-pill">
                      {r.type}:{r.ref}
                    </span>
                  ))}
                </div>
              )}

              {renderExecutionResult(a)}

              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setDetailsId(detailsId === a.id ? null : a.id)}>
                {detailsId === a.id ? 'Hide details' : 'Review details'}
              </button>

              {renderApprovalDetails(a)}

              {renderApprovalActions(a)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Live expiry countdown for one pending approval. Owns a single 1s timer
 * that stops itself once the approval expires — the page no longer
 * rerenders every second for every row.
 */
function ExpiryCountdown({ id, expiresAt }: { id: string; expiresAt: string }) {
  const [remaining, setRemaining] = useState(() => formatRemaining(expiresAt));
  useEffect(() => {
    if (new Date(expiresAt).getTime() - Date.now() <= 0) {
      setRemaining('expired');
      return;
    }
    const tick = window.setInterval(() => {
      const label = formatRemaining(expiresAt);
      setRemaining(label);
      if (label === 'expired') window.clearInterval(tick);
    }, 1000);
    return () => window.clearInterval(tick);
  }, [expiresAt]);
  return (
    <span data-testid={`countdown-${id}`} aria-label={`Expires in ${remaining}`}>
      {' '}· {remaining}
    </span>
  );
}