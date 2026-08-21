/**
 * CodeConClave — Approval Center (Phase 4C).
 * Server-authoritative human gate: risk level, action type, affected
 * resources, proposed action, justification, coworker, model, timestamp and a
 * live expiry countdown. States are honest — approved/rejected/expired/executed
 * and execution failures are only ever shown from the server record, never
 * from a button click. Executing an approved action waits for the server
 * execution result and renders it (SUCCEEDED/FAILED) on the approval.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { mapApproval, type Approval } from '../lib/types';
import { useToast } from '../components/Toast';
import { isOnline, enqueueOfflineOp } from '../lib/offline';

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
  const [reason, setReason] = useState('');
  const [now, setNow] = useState(() => Date.now());
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

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const decide = async (id: string, decision: 'APPROVE' | 'REJECT') => {
    try {
      if (!isOnline()) {
        // Offline: queue the decision — it syncs (idempotently) on reconnect.
        enqueueOfflineOp('approval.decide', { approvalId: id, decision, reason: reason.trim() || null });
        setReason('');
        toast(`${decision === 'APPROVE' ? 'Approval' : 'Rejection'} queued — will sync when you reconnect`, 'info');
        return;
      }
      await api(`/api/v1/execution/approvals/${id}/decide`, {
        method: 'POST',
        body: { decision, reason: reason.trim() || undefined },
      });
      setReason('');
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

  const pendingNow = useMemo(
    () =>
      approvals
        .filter((a) => a.status === 'PENDING')
        .map((a) => ({ id: a.id, remaining: formatRemaining(a.expiresAt) })),
    [approvals, now], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const expiresSoon = (expiresAt: string) => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    return ms > 0 && ms < 5 * 60 * 1000;
  };

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h1>Approval Center</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="cc-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="EXPIRED">Expired</option>
            <option value="EXECUTED">Executed</option>
          </select>
          {pendingCount > 0 && <span className="cc-pill cc-pill--accent">{pendingCount} pending</span>}
        </div>
      </div>
      {approvals.length === 0 && <div className="cc-card cc-empty">No approvals {filter !== 'PENDING' ? `(${filter})` : ''}.</div>}
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
                  <span className="cc-pill" style={{ borderColor: '#b3261e', color: '#b3261e' }}>
                    expires soon
                  </span>
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
              <div className="cc-hint" style={{ marginTop: 4 }}>
                {a.coworker && <span>coworker: {a.coworker}</span>}
                {a.coworker && a.model && <span> · </span>}
                {a.model && <span>model: {a.model}</span>}
                <div>
                  created {new Date(a.createdAt).toLocaleString()} · expires{' '}
                  {new Date(a.expiresAt).toLocaleString()}
                  {a.status === 'PENDING' && (
                    <span data-testid={`countdown-${a.id}`}> · {pendingNow.find((p) => p.id === a.id)?.remaining}</span>
                  )}
                </div>
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
              {a.executionStatus && (
                <div
                  className="cc-card"
                  style={{ marginTop: 8, borderColor: a.executionStatus === 'FAILED' ? '#b3261e' : '#2e7d32' }}
                  data-testid={`execution-${a.id}`}
                >
                  execution: {a.executionStatus === 'SUCCEEDED' ? 'executed' : 'execution failed'}
                  {a.executionStatus === 'FAILED' && a.executionResult && (
                    <div className="cc-hint">{(a.executionResult as { error?: string }).error ?? 'unknown error'}</div>
                  )}
                  {a.executionCompletedAt && (
                    <div className="cc-hint">completed {new Date(a.executionCompletedAt).toLocaleString()}</div>
                  )}
                  {a.auditReference && <div className="cc-hint">audit: {a.auditReference}</div>}
                </div>
              )}
              <button className="cc-btn cc-btn--sm cc-btn--ghost" onClick={() => setDetailsId(detailsId === a.id ? null : a.id)}>
                {detailsId === a.id ? 'Hide details' : 'Review details'}
              </button>
              {detailsId === a.id && a.proposedAction && (
                <pre className="cc-code" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(a.proposedAction, null, 2)}
                </pre>
              )}
            </div>
            {a.status === 'PENDING' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input
                  className="cc-input"
                  placeholder="reason (optional)"
                  style={{ width: 180 }}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button className="cc-btn cc-btn--sm" onClick={() => void decide(a.id, 'APPROVE')}>
                  Approve
                </button>
                <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void decide(a.id, 'REJECT')}>
                  Reject
                </button>
              </div>
            )}
            {a.status === 'APPROVED' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 300 }}>
                <input
                  className="cc-input"
                  placeholder="tool (e.g. file_write)"
                  value={String(execTool[a.id] ?? ((a.proposedAction as Record<string, unknown>)?.tool ?? ''))}
                  onChange={(e) => setExecTool((p) => ({ ...p, [a.id]: e.target.value }))}
                  data-testid={`tool-${a.id}`}
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
                  data-testid={`device-${a.id}`}
                />
                <button
                  className="cc-btn cc-btn--sm"
                  onClick={() => void execute(a)}
                  disabled={executingId === a.id}
                  data-testid={`execute-${a.id}`}
                >
                  {executingId === a.id ? 'Executing…' : 'Execute approved action'}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}