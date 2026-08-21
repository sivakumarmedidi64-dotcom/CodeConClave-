/**
 * CodeConClave — operations module (Phase 14).
 * Unified, user-facing provider capability status. Every status is derived
 * from real configuration (env), persisted plugin connection state (Phase 10)
 * and AI provider health — nothing is invented. No secret values are ever
 * exposed: capabilities are booleans + sanitized reason strings only.
 */
import { env } from '../../config/env.js';
import { queryMany } from '../../shared/db.js';
import { listConnections, type PluginConnectionRow } from '../plugins/health.js';
import { ProviderStatus } from '@codeconclave/shared';

export type ProviderCategory = 'payments' | 'email' | 'auth' | 'storage' | 'ai' | 'observability' | 'integration';
export type ProviderStatusValue = (typeof ProviderStatus)[keyof typeof ProviderStatus];

export interface ProviderCapabilityEntry {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatusValue;
  reason: string | null;
  capabilities?: { id: string; available: boolean }[];
  lastCheckedAt: string | null;
  lastKnownState?: string | null;
  connectionId?: string | null;
}

/** Redact anything that looks like a credential value; never expose secrets. */
export function sanitizeProviderError(input: string | null | undefined, maxLength = 200): string | null {
  if (!input) return null;
  const redacted = input
    .replace(/((?:key|secret|token|password|authorization|credential)s?[=:]\s*)[^\s&"'`]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|secret|token|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, maxLength);
  return redacted;
}

function pluginStatus(conn: PluginConnectionRow | undefined): { status: ProviderStatusValue; reason: string | null; lastKnownState: string | null } {
  if (!conn) return { status: 'NOT_CONFIGURED', reason: 'Not connected', lastKnownState: null };
  const reason = sanitizeProviderError(conn.last_error);
  switch (conn.state) {
    case 'CONNECTED':
      return { status: 'AVAILABLE', reason: null, lastKnownState: 'CONNECTED' };
    case 'DEGRADED':
      return { status: 'DEGRADED', reason: reason ?? 'Repeated failures', lastKnownState: 'CONNECTED' };
    case 'FAILED':
    case 'ERROR':
      return { status: 'FAILED', reason: reason ?? 'Connection failed', lastKnownState: conn.state === 'ERROR' ? 'DEGRADED' : 'CONNECTED' };
    case 'REAUTH_REQUIRED':
      return { status: 'REQUIRES_REAUTH', reason: reason ?? 'Credentials expired — reauthorize to reconnect', lastKnownState: 'CONNECTED' };
    case 'CONNECTING':
      return { status: 'LIMITED', reason: 'Connecting…', lastKnownState: 'CONNECTING' };
    case 'DISCONNECTED':
      return { status: 'NOT_CONFIGURED', reason: 'Disconnected', lastKnownState: 'CONNECTED' };
    default:
      return { status: 'LIMITED', reason: reason ?? `State ${conn.state}`, lastKnownState: conn.state };
  }
}

interface AiHealthRow {
  provider_id: string;
  state: string;
  last_check_at: Date | null;
}

export interface ProviderStatusReport {
  providers: ProviderCapabilityEntry[];
  generatedAt: string;
}

/**
 * Unified provider capability status for the signed-in user. Plugin-backed
 * providers are per-user; system providers are per-deployment configuration.
 */
export async function providerStatus(userId: string): Promise<ProviderStatusReport> {
  const connections = await listConnections(userId);
  const byType = new Map(connections.map((c) => [c.plugin_type, c]));

  // ---- Razorpay (payments)
  const razorpayApi = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  const razorpayWebhook = Boolean(env.RAZORPAY_WEBHOOK_SECRET) && env.RAZORPAY_MODE === 'webhook';
  const razorpayCapabilities = [
    { id: 'payment_link', available: true },
    { id: 'api', available: razorpayApi },
    { id: 'webhook', available: razorpayWebhook },
  ];
  const razorpayStatus: ProviderStatusValue =
    razorpayApi && razorpayWebhook ? 'AVAILABLE' : 'LIMITED';

  // ---- Resend (email): env config + optional plugin connection
  const resendConn = byType.get('resend');
  const resendEnvConfigured = Boolean(env.RESEND_API_KEY) && env.RESEND_ENABLED === 'true';
  const resendPlugin = pluginStatus(resendConn);
  const resendStatus: ProviderStatusValue = resendPlugin.status === 'NOT_CONFIGURED'
    ? (resendEnvConfigured ? 'AVAILABLE' : 'NOT_CONFIGURED')
    : resendPlugin.status;

  // ---- Google / GitHub (auth integrations)
  const google = pluginStatus(byType.get('google'));
  const github = pluginStatus(byType.get('github'));

  // ---- Sentry (observability)
  const sentryConfigured = Boolean(env.SENTRY_DSN) && env.SENTRY_ENABLED === 'true';

  // ---- Storage
  const storageProvider = env.STORAGE_PROVIDER;
  const storageCapabilities = [{ id: 'object_storage', available: storageProvider !== 'memory' }];
  const storageStatus: ProviderStatusValue =
    storageProvider === 's3'
      ? (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? 'AVAILABLE' : 'LIMITED')
      : storageProvider === 'r2'
        ? (env.CLOUDFLARE_R2_ACCESS_KEY_ID && env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ? 'AVAILABLE' : 'LIMITED')
        : 'LIMITED';

  // ---- AI providers
  const aiRows = await queryMany<AiHealthRow>('SELECT provider_id, state, last_check_at FROM provider_health');
  const aiHealth = new Map(aiRows.map((r) => [r.provider_id, r]));
  const aiConfigured = new Set(configuredAiProviders());
  const aiProviders: ProviderCapabilityEntry[] = [...aiConfigured].sort().map((id) => {
    const health = aiHealth.get(id);
    const status: ProviderStatusValue =
      !health || health.state === 'UNKNOWN' ? 'LIMITED' : health.state === 'HEALTHY' ? 'AVAILABLE' : health.state === 'DEGRADED' ? 'DEGRADED' : 'FAILED';
    return {
      id: `ai:${id}`,
      name: id,
      category: 'ai',
      status,
      reason: !health || health.state === 'UNKNOWN' ? 'Configured; no health data yet' : null,
      lastCheckedAt: health?.last_check_at ? new Date(health.last_check_at).toISOString() : null,
      capabilities: [{ id: 'inference', available: status === 'AVAILABLE' || status === 'DEGRADED' }],
    };
  });

  const providers: ProviderCapabilityEntry[] = [
    {
      id: 'razorpay',
      name: 'Razorpay',
      category: 'payments',
      status: razorpayStatus,
      reason: razorpayApi && razorpayWebhook
        ? null
        : 'Payment Link enabled; API and webhook unavailable until credentials are configured',
      capabilities: razorpayCapabilities,
      lastCheckedAt: null,
    },
    {
      id: 'resend',
      name: 'Resend',
      category: 'email',
      status: resendStatus,
      reason: resendPlugin.status === 'NOT_CONFIGURED' && !resendEnvConfigured
        ? 'Email delivery not configured'
        : resendPlugin.reason,
      capabilities: [{ id: 'email', available: resendStatus === 'AVAILABLE' || resendStatus === 'DEGRADED' }],
      lastCheckedAt: resendConn?.last_health_check_at ? new Date(resendConn.last_health_check_at).toISOString() : null,
      lastKnownState: resendConn ? resendPlugin.lastKnownState : null,
      connectionId: resendConn?.id ?? null,
    },
    {
      id: 'google',
      name: 'Google',
      category: 'auth',
      status: google.status,
      reason: google.reason,
      capabilities: [{ id: 'oauth', available: google.status === 'AVAILABLE' }],
      lastCheckedAt: byType.get('google')?.last_health_check_at ? new Date(byType.get('google')!.last_health_check_at!).toISOString() : null,
      lastKnownState: google.lastKnownState,
      connectionId: byType.get('google')?.id ?? null,
    },
    {
      id: 'github',
      name: 'GitHub',
      category: 'integration',
      status: github.status,
      reason: github.reason,
      capabilities: [{ id: 'integration', available: github.status === 'AVAILABLE' }],
      lastCheckedAt: byType.get('github')?.last_health_check_at ? new Date(byType.get('github')!.last_health_check_at!).toISOString() : null,
      lastKnownState: github.lastKnownState,
      connectionId: byType.get('github')?.id ?? null,
    },
    {
      id: 'sentry',
      name: 'Sentry',
      category: 'observability',
      status: sentryConfigured ? 'AVAILABLE' : 'NOT_CONFIGURED',
      reason: sentryConfigured ? null : 'Error reporting not configured',
      capabilities: [{ id: 'error_tracking', available: sentryConfigured }],
      lastCheckedAt: null,
    },
    {
      id: 'storage',
      name: 'Storage',
      category: 'storage',
      status: storageStatus,
      reason: storageProvider === 'memory'
        ? 'Local memory storage active; object storage (R2/S3) not configured'
        : storageStatus === 'AVAILABLE'
          ? `Object storage active (${storageProvider})`
          : `${storageProvider} provider selected but credentials are incomplete`,
      capabilities: storageCapabilities,
      lastCheckedAt: null,
    },
    ...aiProviders,
  ];

  return { providers, generatedAt: new Date().toISOString() };
}

function configuredAiProviders(): string[] {
  const names: Record<string, string | undefined> = {
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    google: env.GEMINI_API_KEY,
    mistral: env.MISTRAL_API_KEY,
    grok: env.GROK_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
    kimi: env.KIMI_API_KEY,
    nemotron: env.NVIDIA_API_KEY,
    north: env.COHERE_API_KEY,
  };
  return env.AI_PROVIDERS_ENABLED.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((id) => Boolean(names[id]));
}