/**
 * CodeConClave — connectivity indicator (Phase 16).
 * Honest live state: Online (navigator.onLine), Offline, or Reconnecting while
 * the browser is back but the offline queue still has pending work to flush.
 * Never guesses — it derives state from the browser's connectivity events and
 * the real queue contents.
 */
import { useEffect, useState } from 'react';
import { isOnline, type OfflineOp, listOfflineOps, subscribeOffline, lastReconnectMs } from '../lib/offline';

export type ConnectivityState = 'online' | 'offline' | 'reconnecting';

export function ConnectivityIndicator() {
  const [online, setOnline] = useState<boolean>(() => isOnline());
  const [ops, setOps] = useState<OfflineOp[]>(() => listOfflineOps());
  const [reconnectMs, setReconnectMs] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setOnline(isOnline());
    const off = subscribeOffline(setOps);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      off();
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (online && !ops.some((o) => o.status === 'PENDING')) setReconnectMs(lastReconnectMs());
  }, [online, ops]);

  const syncing = online && ops.some((o) => o.status === 'PENDING');
  const state: ConnectivityState = !online ? 'offline' : syncing ? 'reconnecting' : 'online';
  const label = state === 'online' ? 'Online' : state === 'reconnecting' ? 'Reconnecting' : 'Offline';
  const title =
    state === 'reconnecting'
      ? 'Back online — syncing queued changes'
      : state === 'offline'
        ? 'Offline — queued changes will sync when you reconnect'
        : reconnectMs !== null
          ? `Online · last reconnect ${(reconnectMs / 1000).toFixed(1)}s`
          : 'Online';

  return (
    <span
      className={`cc-pill cc-pill--${state === 'online' ? 'success' : state === 'reconnecting' ? 'warn' : 'danger'}`}
      data-testid="connectivity"
      title={title}
      aria-label={`Connectivity: ${label}`}
    >
      {state === 'online' ? '●' : state === 'reconnecting' ? '◐' : '○'} {label}
    </span>
  );
}