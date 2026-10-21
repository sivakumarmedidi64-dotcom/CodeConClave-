/**
 * Settings → Privacy (spec Solo #36): download a full JSON export and
 * request / cancel account deletion. The server is authoritative: the status
 * shown here is the stored request, and a completed deletion shows its
 * receipt (what was erased, what was retained de-identified).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, apiBlob } from '../lib/api';
import { useToast } from './Toast';
import { Icon } from './Icon';

interface DeletionRequest {
  id: string;
  state: 'PENDING' | 'CANCELLED' | 'COMPLETED';
  requestedAt: string;
  dueAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export function AccountDataPanel({ email }: { email: string }) {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [request, setRequest] = useState<DeletionRequest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ request: DeletionRequest | null }>('/api/v1/account/deletion');
      setRequest(res.request);
    } catch {
      setRequest(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async () => {
    setExporting(true);
    try {
      const blob = await apiBlob('/api/v1/account/export');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `codeconclave-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Export downloaded');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ request: DeletionRequest }>('/api/v1/account/deletion', { method: 'POST', body: { confirmEmail } });
      setRequest(res.request);
      setConfirming(false);
      setConfirmEmail('');
      toast('Deletion scheduled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request deletion');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await api<{ request: DeletionRequest }>('/api/v1/account/deletion', { method: 'DELETE' });
      setRequest(res.request);
      toast('Deletion cancelled');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not cancel', 'error');
    } finally {
      setBusy(false);
    }
  };

  const pending = request?.state === 'PENDING';

  return (
    <>
      <div className="cc-card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="download" size={18} className="sp-btn-icon" /> Export your data
        </h3>
        <p className="cc-hint">
          A JSON file with your profile, projects, conversations and messages, memories, DNA, ideas, notifications, teams, sessions,
          devices, API key metadata and plugins. Secrets (password and token hashes, MFA secrets, key values) are never included.
        </p>
        <button type="button" className="cc-btn" disabled={exporting} onClick={() => void download()}>
          {exporting ? 'Preparing…' : 'Download export'}
        </button>
      </div>

      <div className="cc-card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="trash" size={18} className="sp-btn-icon" /> Delete account
        </h3>
        {pending && request && (
          <div role="status" className="cc-error-state" style={{ marginBottom: 12 }}>
            Deletion is scheduled for <strong>{fmt(request.dueAt)}</strong>. Until then you can sign in and cancel.
            <div style={{ marginTop: 8 }}>
              <button type="button" className="cc-btn" disabled={busy} onClick={() => void cancel()}>
                Cancel deletion
              </button>
            </div>
          </div>
        )}
        {!pending && (
          <>
            <p className="cc-hint">
              Deletion runs 30 days after you request it, and you can cancel any time before then. It signs out every session,
              revokes your devices and API keys, erases your personal conversations, memories, DNA, ideas and plugins, and
              de-identifies your account. Work shared with a team stays with that team. If you own a team with other members,
              transfer ownership first. Download an export before deleting if you want a copy.
            </p>
            {request?.state === 'CANCELLED' && request.cancelledAt && (
              <p className="cc-muted">Your previous request was cancelled on {fmt(request.cancelledAt)}.</p>
            )}
            {!confirming ? (
              <button type="button" className="cc-btn cc-btn--danger" onClick={() => setConfirming(true)}>
                Delete my account…
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
                <label className="cc-field">
                  <span>
                    Type <strong>{email}</strong> to confirm
                  </span>
                  <input
                    className="cc-input"
                    value={confirmEmail}
                    onChange={(e) => setConfirmEmail(e.target.value)}
                    aria-label="Confirm account email"
                    autoComplete="off"
                  />
                </label>
                {error && <div className="cc-error">{error}</div>}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="cc-btn cc-btn--danger"
                    disabled={busy || confirmEmail.trim().toLowerCase() !== email.trim().toLowerCase()}
                    onClick={() => void submit()}
                  >
                    Schedule deletion
                  </button>
                  <button type="button" className="cc-btn cc-btn--ghost" onClick={() => setConfirming(false)}>
                    Keep my account
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
