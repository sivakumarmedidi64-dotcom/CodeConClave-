/**
 * CodeConClave — health & readiness (Phase 15).
 * Real checks only: database ping, cache/Redis, queue provider, worker
 * watchdog liveness, AI providers (persisted health), storage, local-agent
 * hub presence, plugins, Sentry. Every check reports an honest state:
 * HEALTHY / DEGRADED / FAILED / NOT_CONFIGURED. An unconfigured provider is
 * NEVER labeled HEALTHY. Checks are split into CRITICAL (required to serve:
 * api, database, cache, queue, worker, ai, storage) and OPTIONAL (sentry,
 * plugin connectors, local-agent presence). The overall rollup is FAILED
 * when any critical check fails, DEGRADED when any critical check degrades
 * or an optional integration is actually broken (never merely unconfigured),
 * HEALTHY only when every critical check is healthy. Unconfigured optional
 * integrations stay visible in the body but never drag the rollup. No
 * secrets, no user content, no connection strings are exposed.
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
  /** Critical checks are required to serve; optional ones never fail the rollup when merely unconfigured. */
  critical: boolean;
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
    return { id: 'ai', name: 'AI providers', status: 'NOT_CONFIGURED', reason: 'No AI provider credentials configured', critical: true };
  }
  const rows = await withSystem<AiHealthRow[]>(async (q) => (await q.query<AiHealthRow>('SELECT provider_id, state FROM provider_health')).rows);
  const byProvider = new Map(rows.map((r) => [r.provider_id, r.state]));
  // These tallies MUST mirror registry.refreshProviderHealth's state mapping,
  // or /health reports HEALTHY for a provider the router is currently
  // excluding. Any state the registry does not treat as usable counts against
  // this check — notably QUOTA_EXHAUSTED (written by a single 429) and BLOCKED,
  // which matched none of the three branches below and therefore produced a
  // false "HEALTHY / reason: null" while zero models were eligible.
  let failed = 0;
  let degraded = 0;
  let usable = 0;
  for (const id of configured) {
    const state = byProvider.get(id) ?? 'UNKNOWN';
    if (state === 'HEALTHY' || state === 'UP') usable += 1;
    else if (state === 'DEGRADED' || state === 'RATE_LIMITED' || state === 'UNKNOWN' || state === 'QUOTA_EXHAUSTED') degraded += 1;
    else failed += 1; // DOWN, BLOCKED, and any other hard exclusion
  }
  // At least one configured provider usable => AI is usable, so a secondary
  // provider being unavailable must not fail the whole system. No usable
  // provider => this check cannot pass, and must say why.
  if (usable === 0 && failed > 0) return { id: 'ai', name: 'AI providers', status: 'FAILED', reason: `no usable AI provider (${failed} down)`, critical: true };
  if (usable === 0) return { id: 'ai', name: 'AI providers', status: 'DEGRADED', reason: `no usable AI provider (${degraded} degraded/quota-limited)`, critical: true };
  if (degraded > 0) return { id: 'ai', name: 'AI providers', status: 'DEGRADED', reason: `${degraded} configured provider(s) degraded or quota-limited`, critical: true };
  return { id: 'ai', name: 'AI providers', status: 'HEALTHY', reason: null, critical: true };
}

async function cacheCheck(): Promise<HealthCheck> {
  if (!env.REDIS_URL) {
    return { id: 'cache', name: 'Cache / Redis', status: 'NOT_CONFIGURED', reason: 'REDIS_URL not configured (in-memory dev store)', critical: true };
  }
  // A configured Redis that fell back to the in-memory store (connect failure)
  // is FAILED, never HEALTHY: the deployment expected shared state and lost it.
  if (cache.kind !== 'redis') {
    return { id: 'cache', name: 'Cache / Redis', status: 'FAILED', reason: 'Redis unreachable — in-memory fallback active', critical: true };
  }
  const ok = await cache.health();
  return ok
    ? { id: 'cache', name: 'Cache / Redis', status: 'HEALTHY', reason: null, critical: true }
    : { id: 'cache', name: 'Cache / Redis', status: 'FAILED', reason: 'Redis unreachable', critical: true };
}

function workerCheck(): HealthCheck {
  const last = lastWatchdogRunAt();
  if (last === null) {
    return { id: 'worker', name: 'Task worker / watchdog', status: 'NOT_CONFIGURED', reason: 'Watchdog has not run yet', critical: true };
  }
  const stale = Date.now() - last > WATCHDOG_FRESH_MS;
  return stale
    ? { id: 'worker', name: 'Task worker / watchdog', status: 'DEGRADED', reason: 'Watchdog sweep is stale', critical: true }
    : { id: 'worker', name: 'Task worker / watchdog', status: 'HEALTHY', reason: null, critical: true };
}

function agentCheck(): HealthCheck {
  if (!hubAttached()) {
    return { id: 'local-agent', name: 'Local Agent hub', status: 'NOT_CONFIGURED', reason: 'Agent WebSocket hub not attached (no desktop paired)', critical: false };
  }
  const { connected } = agentWs().stats();
  return connected > 0
    ? { id: 'local-agent', name: 'Local Agent hub', status: 'HEALTHY', reason: `${connected} agent(s) online`, critical: false }
    : { id: 'local-agent', name: 'Local Agent hub', status: 'DEGRADED', reason: 'Hub up; no local agent currently online (local work waits)', critical: false };
}

async function storageCheck(): Promise<HealthCheck> {
  if (storage.kind === 'memory') {
    return { id: 'storage', name: 'Storage', status: 'NOT_CONFIGURED', reason: 'Object storage not configured (ephemeral local disk — set STORAGE_PROVIDER=postgres|s3|r2)', critical: true };
  }
  const ok = await storage.health();
  return ok
    ? { id: 'storage', name: 'Storage', status: 'HEALTHY', reason: `Object storage active (${storage.kind})`, critical: true }
    : { id: 'storage', name: 'Storage', status: 'FAILED', reason: `Object storage unreachable (${storage.kind})`, critical: true };
}

function sentryCheck(): HealthCheck {
  const configured = Boolean(env.SENTRY_DSN) && env.SENTRY_ENABLED === 'true';
  return configured
    ? { id: 'sentry', name: 'Sentry', status: 'HEALTHY', reason: null, critical: false }
    : { id: 'sentry', name: 'Sentry', status: 'NOT_CONFIGURED', reason: 'Error reporting not configured', critical: false };
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
    return { id: 'plugins', name: 'Plugins', status: 'NOT_CONFIGURED', reason: 'No plugin connections', critical: false };
  }
  if (states.some((s) => s === 'FAILED' || s === 'ERROR')) {
    return { id: 'plugins', name: 'Plugins', status: 'DEGRADED', reason: 'Some plugin connections are failing', critical: false };
  }
  return { id: 'plugins', name: 'Plugins', status: 'HEALTHY', reason: null, critical: false };
}

export async function computeHealth(): Promise<HealthReport> {
  const dbOk = await ping();
  const checks: HealthCheck[] = [
    { id: 'api', name: 'API', status: 'HEALTHY', reason: null, critical: true },
    dbOk
      ? { id: 'database', name: 'Database', status: 'HEALTHY', reason: null, critical: true }
      : { id: 'database', name: 'Database', status: 'FAILED', reason: 'Database unreachable', critical: true },
    await cacheCheck(),
    { id: 'queue', name: 'Queue', status: env.QUEUE_PROVIDER === 'redis' ? 'HEALTHY' : 'NOT_CONFIGURED', reason: env.QUEUE_PROVIDER === 'redis' ? null : 'QUEUE_PROVIDER=memory (in-process dev queue)', critical: true },
    workerCheck(),
    await aiCheck(),
    await storageCheck(),
    agentCheck(),
    await pluginsCheck(),
    sentryCheck(),
  ];

  // Rollup: critical checks decide FAILED/DEGRADED; unconfigured OPTIONAL
  // checks stay visible but never drag the rollup. An optional integration
  // that is actually broken (FAILED/DEGRADED, e.g. a failing plugin
  // connection) surfaces as DEGRADED — honest, but the app keeps serving.
  const critical = checks.filter((c) => c.critical);
  const optional = checks.filter((c) => !c.critical);
  let status: 'HEALTHY' | 'DEGRADED' | 'FAILED' = 'HEALTHY';
  if (critical.some((c) => c.status === 'FAILED')) status = 'FAILED';
  else if (critical.some((c) => c.status === 'DEGRADED' || c.status === 'NOT_CONFIGURED')) status = 'DEGRADED';
  else if (optional.some((c) => c.status === 'FAILED' || c.status === 'DEGRADED')) status = 'DEGRADED';

  return {
    status,
    ok: status === 'HEALTHY',
    name: env.APP_NAME,
    time: new Date().toISOString(),
    checks,
  };
}