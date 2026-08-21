/**
 * CodeConClave — Stage 26 AI transparency: honest per-provider status snapshot.
 *
 * Status is DERIVED, never assumed: configuration (keys present today) +
 * persisted probe history (provider_health) + registry health overlay. The
 * taxonomy is the shared ProviderStatus set (AVAILABLE / LIMITED / DEGRADED /
 * RATE_LIMITED / QUOTA_EXHAUSTED / OFFLINE / REQUIRES_REAUTH / NOT_CONFIGURED /
 * BLOCKED / FAILED). BLOCKED can only come from an explicit admin block row —
 * nothing in this module ever derives it.
 */
import { ProviderId, ProviderStatus } from '@codeconclave/shared';
import type { ProviderStatus as ProviderStatusType } from '@codeconclave/shared';
import { pool } from '../../shared/db.js';
import { configuredProviders, getRegistry } from './registry.js';
import { deriveStatusFromFailure } from './providers.js';

export interface ProviderStatusRow {
  providerId: string;
  status: ProviderStatusType;
  label: string;
  configured: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  avgLatencyMs: number | null;
}

export const PROVIDER_STATUS_LABELS: Record<ProviderStatusType, string> = {
  AVAILABLE: 'Available — passing probes',
  LIMITED: 'Limited — capability gaps',
  CONFIGURED: 'Configured — not yet probed',
  NOT_CONFIGURED: 'Not configured — no API key on the server',
  REQUIRES_REAUTH: 'Requires reauthentication — credentials rejected',
  DEGRADED: 'Degraded — errors or slow probes',
  FAILED: 'Failed — persistent failures',
  RATE_LIMITED: 'Rate limited — retry later',
  QUOTA_EXHAUSTED: 'Quota exhausted — billing limits reached',
  OFFLINE: 'Offline — provider unreachable or erroring',
  BLOCKED: 'Blocked by administrator',
};

const PROVIDER_ORDER = Object.values(ProviderId);

interface HealthRow {
  provider_id: string;
  state: string;
  last_check_at: string | null;
  last_error: string | null;
  success_count: number;
  failure_count: number;
  consecutive_failures: number;
  avg_latency_ms: number | null;
}

export async function providerStatusSnapshot(): Promise<ProviderStatusRow[]> {
  const [healthResult, configured, registry] = await Promise.all([
    pool.query(`SELECT provider_id, state, last_check_at, last_error, success_count, failure_count, consecutive_failures, avg_latency_ms FROM provider_health`),
    Promise.resolve(configuredProviders()),
    getRegistry(),
  ]);
  const health = new Map<string, HealthRow>((healthResult.rows as HealthRow[]).map((r) => [r.provider_id, r]));
  const registryHealth = new Map<string, string>();
  for (const m of registry) {
    const cur = registryHealth.get(m.providerId);
    if (m.health === 'DOWN') registryHealth.set(m.providerId, 'DOWN');
    else if (m.health === 'DEGRADED' && cur !== 'DOWN') registryHealth.set(m.providerId, 'DEGRADED');
  }

  const snapshot: ProviderStatusRow[] = [];
  for (const providerId of PROVIDER_ORDER) {
    const row = health.get(providerId);
    const configuredNow = configured.includes(providerId);
    let status: ProviderStatusType;
    if (row?.state === 'BLOCKED') {
      status = ProviderStatus.BLOCKED; // explicit admin block only
    } else if (!configuredNow) {
      status = ProviderStatus.NOT_CONFIGURED;
    } else if (row?.state === 'HEALTHY') {
      status = ProviderStatus.AVAILABLE;
    } else if (row?.state === 'DOWN' && row.last_error) {
      status = deriveStatusFromFailure(row.last_error);
    } else if (row?.state === 'DEGRADED') {
      status = ProviderStatus.DEGRADED;
    } else if (row?.state === 'DOWN') {
      status = ProviderStatus.OFFLINE;
    } else if (row?.state === 'UNKNOWN' || !row) {
      const regState = registryHealth.get(providerId);
      status =
        regState === 'DOWN' ? ProviderStatus.OFFLINE : regState === 'DEGRADED' ? ProviderStatus.DEGRADED : ProviderStatus.CONFIGURED;
    } else {
      status = ProviderStatus.DEGRADED;
    }
    snapshot.push({
      providerId,
      status,
      label: PROVIDER_STATUS_LABELS[status],
      configured: configuredNow,
      lastCheckAt: row?.last_check_at ?? null,
      lastError: row?.last_error ?? null,
      successCount: row ? Number(row.success_count) : 0,
      failureCount: row ? Number(row.failure_count) : 0,
      consecutiveFailures: row ? Number(row.consecutive_failures) : 0,
      avgLatencyMs: row?.avg_latency_ms !== null && row?.avg_latency_ms !== undefined ? Number(row.avg_latency_ms) : null,
    });
  }
  return snapshot;
}
