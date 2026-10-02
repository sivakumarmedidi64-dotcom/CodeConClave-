/**
 * CodeConClave — system health indicator (Phase 15).
 * Polls /health and surfaces the honest server rollup: Operational (HEALTHY),
 * Degraded (critical check degraded/unconfigured, or an optional integration
 * actually broken), Down (FAILED), or Offline (unreachable). Tooltip lists the
 * non-healthy checks with reasons, marking non-critical ones (optional).
 * Failures are silent (no toast) — a broken health endpoint must never break
 * the UI.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHealth, type Health, type HealthCheck } from '../lib/api';

const POLL_MS = 60_000;

type ChipState = 'checking' | 'healthy' | 'degraded' | 'down' | 'offline';

function stateFromHealth(health: Health | null): ChipState {
  if (!health || !health.status) return 'offline';
  if (health.status === 'FAILED') return 'down';
  if (health.status === 'DEGRADED') return 'degraded';
  return 'healthy';
}

function labelFor(state: ChipState): string {
  switch (state) {
    case 'healthy':
      return 'Operational';
    case 'degraded':
      return 'Degraded';
    case 'down':
      return 'Down';
    case 'offline':
      return 'Offline';
    default:
      return 'Checking…';
  }
}

function colorFor(state: ChipState): string {
  switch (state) {
    case 'healthy':
      return '#2e7d32';
    case 'degraded':
      return '#b26a00';
    case 'down':
      return '#c62828';
    case 'offline':
      return '#757575';
    default:
      return '#9e9e9e';
  }
}

function problemChecks(health: Health | null): HealthCheck[] {
  if (!health?.checks) return [];
  return health.checks.filter((c) => c.status === 'FAILED' || c.status === 'DEGRADED' || c.status === 'NOT_CONFIGURED');
}

export function HealthChip() {
  const [state, setState] = useState<ChipState>('checking');
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const timerRef = useRef<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const health = await fetchHealth();
      setState(stateFromHealth(health));
      setChecks(problemChecks(health));
    } catch {
      setState('offline');
      setChecks([]);
    }
  }, []);

  useEffect(() => {
    void poll();
    timerRef.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [poll]);

  const title =
    state === 'healthy'
      ? 'All systems operational'
      : checks.length > 0
        ? `${labelFor(state)} — ${checks.map((c) => (c.critical === false ? `${c.name} (optional)` : c.name)).join(', ')}`
        : `System health: ${labelFor(state).toLowerCase()}`;

  return (
    <span
      className="cc-health-chip"
      role="status"
      aria-label={`System health: ${labelFor(state)}`}
      title={title}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: colorFor(state),
          display: 'inline-block',
        }}
      />
      {labelFor(state)}
    </span>
  );
}