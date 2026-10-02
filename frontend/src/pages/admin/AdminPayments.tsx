import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';

interface AdminClaim {
  id: string;
  planId: string;
  purchaseType: string;
  amountInr: number;
  currency: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  razorpayPaymentId: string;
  source: string;
  rejectionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  intentId: string;
  reference: string | null;
  email: string;
}

interface AdminClaimsResponse {
  claims: AdminClaim[];
  total: number;
  limit: number;
  offset: number;
}

const FILTERS = ['Pending', 'Approved', 'Rejected', ''];
const FILTER_LABEL: Record<string, string> = { Pending: 'PENDING', Approved: 'APPROVED', Rejected: 'REJECTED', '': '' };

function statusPillClass(status: string): string {
  if (status === 'APPROVED') return 'cc-pill cc-pill--ok';
  if (status === 'REJECTED') return 'cc-pill cc-pill--danger';
  return 'cc-pill cc-pill--warn';
}

export function AdminPayments() {
  const { user } = useAuth();
  const [claims, setClaims] = useState<AdminClaim[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('Pending');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100', offset: '0' });
      if (FILTER_LABEL[status]) params.set('status', FILTER_LABEL[status]);
      const res = await fetch(`/api/v1/admin/payments/claims?${params}`, { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? `Failed to load claims (${res.status})`);
        return;
      }
      const data = (await res.json()) as AdminClaimsResponse;
      setClaims(data.claims ?? []);
      setTotal(data.total ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load claims');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void fetchClaims();
  }, [fetchClaims]);

  const act = async (path: string, body?: Record<string, unknown>) => {
    setBusyId(path);
    try {
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error?.message ?? json?.message ?? `Request failed (${res.status})`);
        return false;
      }
      setError(null);
      await fetchClaims();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (id: string) => {
    const reason = window.confirm('Approve this payment claim? This activates the entitlement immediately (exactly-once).');
    if (!reason) return;
    await act(`/api/v1/admin/payments/claims/${id}/approve`);
  };

  const confirmReject = async (id: string) => {
    await act(`/api/v1/admin/payments/claims/${id}/reject`, { reason: rejectReason.trim() });
    setRejectingId(null);
    setRejectReason('');
  };

  if (!user || !['admin', 'owner'].includes(user.rbacRole)) {
    return null;
  }

  return (
    <div className="cc-admin">
      {/* Filter */}
      <div className="cc-admin-panel">
        <div className="cc-admin-panel__body">
          <div className="cc-admin__header">
            <div className="cc-admin-tabs" role="tablist" aria-label="Claim status">
              {FILTERS.map((f) => (
                <button
                  key={f || 'All'}
                  role="tab"
                  aria-selected={status === f}
                  className={`cc-btn cc-btn--sm ${status === f ? 'cc-btn--primary' : 'cc-btn--ghost'}`}
                  onClick={() => setStatus(f)}
                >
                  {f === '' ? 'All' : f}
                </button>
              ))}
            </div>
            <div className="cc-admin-hint">{total} claims</div>
          </div>
        </div>
      </div>

      {/* Claims */}
      <div className="cc-admin-panel">
        {error && (
          <div className="cc-admin-panel__body">
            <p className="cc-hint" style={{ color: 'var(--cc-danger, #b3261e)' }}>{error}</p>
          </div>
        )}
        {loading ? (
          <div className="cc-admin-loading">
            <div className="cc-spinner" />
          </div>
        ) : claims.length === 0 ? (
          <div className="cc-empty">No claims{status ? ` with status ${FILTER_LABEL[status]}` : ''}</div>
        ) : (
          <div className="cc-table-wrap">
            <table className="cc-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>Payment ID</th>
                  <th>Reference</th>
                  <th>Submitted</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className={statusPillClass(c.status)}>{c.status}</span>
                    </td>
                    <td>
                      <div className="cc-admin-user">{c.email}</div>
                      <div className="cc-admin-hint">{c.purchaseType}</div>
                    </td>
                    <td>{c.planId.toUpperCase()}</td>
                    <td>₹{c.amountInr} {c.currency}</td>
                    <td>
                      <span className="cc-hint" style={{ fontFamily: 'monospace' }}>{c.razorpayPaymentId}</span>
                    </td>
                    <td className="cc-admin-hint">{c.reference ?? '—'}</td>
                    <td className="cc-admin-hint">{new Date(c.createdAt).toLocaleString()}</td>
                    <td>
                      {c.status === 'PENDING' ? (
                        rejectingId === c.id ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                            <textarea
                              className="cc-input"
                              rows={2}
                              placeholder="Reason (shown to the user)"
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                            />
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                className="cc-btn cc-btn--sm"
                                disabled={busyId !== null || rejectReason.trim().length === 0}
                                onClick={() => void confirmReject(c.id)}
                              >
                                {busyId !== null ? '…' : 'Reject'}
                              </button>
                              <button className="cc-btn cc-btn--sm cc-btn--ghost" onClick={() => { setRejectingId(null); setRejectReason(''); }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="cc-btn cc-btn--sm cc-btn--primary" disabled={busyId !== null} onClick={() => void approve(c.id)}>
                              Approve
                            </button>
                            <button
                              className="cc-btn cc-btn--sm cc-btn--ghost"
                              disabled={busyId !== null}
                              onClick={() => { setRejectingId(c.id); setRejectReason(''); }}
                            >
                              Reject
                            </button>
                          </div>
                        )
                      ) : (
                        <span className="cc-admin-hint">
                          {c.decidedAt ? new Date(c.decidedAt).toLocaleString() : '—'}
                          {c.status === 'REJECTED' && c.rejectionReason ? ` — ${c.rejectionReason}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}