/**
 * CodeConClave — offline sync banner (Phase 16).
 * Shows queued work while offline, sync progress on reconnect, and conflict
 * resolution when the server rejected a queued change (the server is
 * authoritative; the user chooses: discard or keep for another attempt).
 * Success is only shown when the server confirmed it — never after a failure.
 */
import { useEffect, useState } from 'react';
import {
  type OfflineOp,
  listOfflineOps,
  subscribeOffline,
  flushOfflineQueue,
  retryOfflineOp,
  resolveOfflineConflict,
  isOnline,
} from '../lib/offline';

const OP_LABELS: Record<OfflineOp['op'], string> = {
  'approval.decide': 'Approval decision',
  'notifications.markRead': 'Mark notifications read',
};

export function OfflineBanner() {
  const [ops, setOps] = useState<OfflineOp[]>(() => listOfflineOps());
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState<boolean>(() => isOnline());

  useEffect(() => {
    const off = subscribeOffline(setOps);
    const update = () => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      off();
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const pending = ops.filter((o) => o.status === 'PENDING');
  const failed = ops.filter((o) => o.status === 'FAILED');
  const conflicts = ops.filter((o) => o.status === 'CONFLICT');
  const visible = online ? [...failed, ...conflicts] : ops;

  if (visible.length === 0) return null;

  const retryAll = async () => {
    setSyncing(true);
    await flushOfflineQueue();
    setSyncing(false);
  };

  return (
    <div className="cc-offline-banner" data-testid="offline-banner" role="status">
      {!online && (
        <div className="cc-offline-banner__line">
          <strong>Offline.</strong>{' '}
          {pending.length > 0
            ? `${pending.length} queued change${pending.length === 1 ? '' : 's'} will sync when you reconnect.`
            : 'Reconnect to sync.'}
        </div>
      )}
      {online && failed.length > 0 && (
        <div className="cc-offline-banner__line">
          <strong>Sync failed.</strong> {failed.length} change{failed.length === 1 ? '' : 's'} could not be synced —{' '}
          <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={syncing} onClick={() => void retryAll()}>
            Retry
          </button>
        </div>
      )}
      {conflicts.map((op) => (
        <div className="cc-offline-banner__line" key={op.localId} data-testid="conflict-line">
          <strong>Conflicted:</strong> {OP_LABELS[op.op] ?? op.op} — {op.serverError?.message ?? 'the server rejected this change.'}
          <button
            className="cc-btn cc-btn--ghost cc-btn--sm"
            onClick={() => resolveOfflineConflict(op.localId, 'discard')}
            aria-label={`Discard ${OP_LABELS[op.op] ?? op.op}`}
          >
            Discard
          </button>
          <button
            className="cc-btn cc-btn--ghost cc-btn--sm"
            onClick={() => void retryOfflineOp(op.localId)}
            aria-label={`Try ${OP_LABELS[op.op] ?? op.op} again`}
          >
            Try again
          </button>
        </div>
      ))}
      {!online && pending.length === 0 && ops.length > 0 && (
        <div className="cc-offline-banner__line cc-hint">Pending sync will resume automatically.</div>
      )}
    </div>
  );
}