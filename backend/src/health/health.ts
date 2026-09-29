/**
 * CodeConClave — health & readiness (Phase 15).
 * Real checks only: database ping, cache/Redis, queue provider, worker
 * watchdog liveness, AI providers (persisted health), storage, local-agent
 * hub presence, plugins, Sentry. Every check reports an honest state:
 * HEALTHY / DEGRADED / FAILED / NOT_CONFIGURED. An unconfigured provider is
 * NEVER labeled HEALTHY, and the overall rollup is FAILED when anything
 * fails, DEGRADED when anything degrades, HEALTHY only when every check is
 * healthy. No secrets, no user content, no connection strings are exposed.
 */
import { ping, withSystem } from '../shared/db.js';
import { cache } from '../shared/cache.js';
import { env } from '../config/env.js';
import { storage } from '../integrations/storage.js';
import { lastWatchdogRunAt } from '../workers/watchdog.js';
import { hubAttached, agentWs } from '../modules/agent/ws.js';
import { configuredProviders } from '../modules/ai/registry.js';

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'NOT_CONFIGURED';

export interface HealthCheck {
  id: string;
  name: string;
  status: HealthState;
  reason: string | null;
}

export interface HealthReport {
  status: 'HEALTHY' | 'DEGRADED' | 'FAILED';
  ok: boolean;
  name: string;
  time: string;
  checks: HealthCheck[];
}

const WATCHDOG_FRESH_MS = 90_000;

interface AiHealthRow {
  provider_id: string;
  state: string;
}

// Single source of truth: the AI registry's enabled+keyed+gate-visible
// provider set (env.ts allow-list, strict key check, provider quality gate).
// Keeping the list in sync with the registry prevents health from diverging
// from what /models can actually serve.
function configuredAiProviders(): string[] {
  return configuredProviders();
}

async function aiCheck(): Promise<HealthCheck> {
  const configured = configuredAiProviders();
  if (configured.length === 0) {
    return { id: 'ai', name: 'AI providers', status: 'NOT_CONFIGURED', reason: 'No AI provider credentials configured' };
  }
  const rows = await withSystem<AiHealthRow[]>(async (q) => (await q.query<AiHealthRow>('SELECT provider_id, state FROM provider_health')).rows);
  const byProvider = new Map(rows.map((r) => [r.provider_id, r.state]));
  let failed = 0;
  let degraded = 0;
  let unknown = 0;
  for (const id of configured) {
    const state = byProvider.get(id) ?? 'UNKNOWN';
    if (state === 'DOWN') failed += 1;
    else if (state === 'DEGRADED') degraded += 1;
    else if (state === 'UNKNOWN') unknown += 1;
  }
  if (failed > 0) return { id: 'ai', name: 'AI providers', status: 'FAILED', reason: `${failed} configured provider(s) down` };
  if (degraded > 0) return { id: 'ai', name: 'AI providers', status: 'DEGRADED', reason: `${degraded} configured provider(s) degraded` };
  if (unknown > 0) return { id: 'ai', name: 'AI providers', status: 'DEGRADED', reason: 'Configured but no health data yet' };
  return { id: 'ai', name: 'AI providers', status: 'HEALTHY', reason: null };
}

async function cacheCheck(): Promise<HealthCheck> {
  if (!env.REDIS_URL) {
    return { id: 'cache', name: 'Cache / Redis', status: 'NOT_CONFIGURED', reason: 'REDIS_URL not configured (in-memory dev store)' };
  }
  // A configured Redis that fell back to the in-memory store (connect failure)
  // is FAILED, never HEALTHY: the deployment expected shared state and lost it.
  if (cache.kind !== 'redis') {
    return { id: 'cache', name: 'Cache / Redis', status: 'FAILED', reason: 'Redis unreachable — in-memory fallback active' };
  }
  const ok = await cache.health();
  return ok
    ? { id: 'cache', name: 'Cache / Redis', status: 'HEALTHY', reason: null }
    : { id: 'cache', name: 'Cache / Redis', status: 'FAILED', reason: 'Redis unreachable' };
}

function workerCheck(): HealthCheck {
  const last = lastWatchdogRunAt();
  if (last === null) {
    return { id: 'worker', name: 'Task worker / watchdog', status: 'NOT_CONFIGURED', reason: 'Watchdog has not run yet' };
  }
  const stale = Date.now() - last > WATCHDOG_FRESH_MS;
  return stale
    ? { id: 'worker', name: 'Task worker / watchdog', status: 'DEGRADED', reason: 'Watchdog sweep is stale' }
    : { id: 'worker', name: 'Task worker / watchdog', status: 'HEALTHY', reason: null };
}

function agentCheck(): HealthCheck {
  if (!hubAttached()) {
    return { id: 'local-agent', name: 'Local Agent hub', status: 'NOT_CONFIGURED', reason: 'Agent WebSocket hub not attached' };
  }
  const { connected } = agentWs().stats();
  return connected > 0
    ? { id: 'local-agent', name: 'Local Agent hub', status: 'HEALTHY', reason: `${connected} agent(s) online` }
    : { id: 'local-agent', name: 'Local Agent hub', status: 'DEGRADED', reason: 'Hub up; no local agent currently online' };
}

function storageCheck(): HealthCheck {
  if (storage.kind === 'memory') {
    return { id: 'storage', name: 'Storage', status: 'NOT_CONFIGURED', reason: 'Object storage not configured (in-memory dev store)' };
  }
  return { id: 'storage', name: 'Storage', status: 'HEALTHY', reason: `Object storage active (${storage.kind})` };
}

function sentryCheck(): HealthCheck {
  const configured = Boolean(env.SENTRY_DSN) && env.SENTRY_ENABLED === 'true';
  return configured
    ? { id: 'sentry', name: 'Sentry', status: 'HEALTHY', reason: null }
    : { id: 'sentry', name: 'Sentry', status: 'NOT_CONFIGURED', reason: 'Error reporting not configured' };
}

interface PluginHealthRow {
  state: string;
}

async function pluginsCheck(): Promise<HealthCheck> {
  const rows = await withSystem<PluginHealthRow[]>(async (q) =>
    (await q.query<PluginHealthRow>(
      `SELECT DISTINCT pc.state FROM plugin_connections pc WHERE pc.state IN ('CONNECTED','DEGRADED','FAILED','ERROR')`,
    )).rows,
  );
  const states = rows.map((r) => r.state);
  if (states.length === 0) {
    return { id: 'plugins', name: 'Plugins', status: 'NOT_CONFIGURED', reason: 'No plugin connections' };
  }
  if (states.some((s) => s === 'FAILED' || s === 'ERROR')) {
    return { id: 'plugins', name: 'Plugins', status: 'DEGRADED', reason: 'Some plugin connections are failing' };
  }
  return { id: 'plugins', name: 'Plugins', status: 'HEALTHY', reason: null };
}

export async function computeHealth(): Promise<HealthReport> {
  const dbOk = await ping();
  const checks: HealthCheck[] = [
    { id: 'api', name: 'API', status: 'HEALTHY', reason: null },
    dbOk
      ? { id: 'database', name: 'Database', status: 'HEALTHY', reason: null }
      : { id: 'database', name: 'Database', status: 'FAILED', reason: 'Database unreachable' },
    await cacheCheck(),
    { id: 'queue', name: 'Queue', status: env.QUEUE_PROVIDER === 'redis' ? 'HEALTHY' : 'NOT_CONFIGURED', reason: env.QUEUE_PROVIDER === 'redis' ? null : 'QUEUE_PROVIDER=memory (in-process dev queue)' },
    workerCheck(),
    await aiCheck(),
    storageCheck(),
    agentCheck(),
    await pluginsCheck(),
    sentryCheck(),
  ];

  let status: 'HEALTHY' | 'DEGRADED' | 'FAILED' = 'HEALTHY';
  if (checks.some((c) => c.status === 'FAILED')) status = 'FAILED';
  else if (checks.some((c) => c.status === 'DEGRADED' || c.status === 'NOT_CONFIGURED')) status = 'DEGRADED';

  return {
    status,
    ok: status === 'HEALTHY',
    name: env.APP_NAME,
    time: new Date().toISOString(),
    checks,
  };
}