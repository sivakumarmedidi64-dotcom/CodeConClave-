/**
 * CodeConClave — PKG-21 — Real provider abstraction.
 * Honest capability states: SUPPORTED / CONFIGURED / UNCONFIGURED /
 * ENVIRONMENT_BLOCKED / UNAVAILABLE / UNSUPPORTED. Adapter existence is NEVER
 * treated as integration. Without a reachable, configured live provider target
 * the execution capability is reported ENVIRONMENT_BLOCKED — not VERIFIED.
 */
import { env } from '../../config/env.js';
import type { ProviderCapability, ProviderCapabilityState, ProviderId } from './types.js';

const ROLLBACK_SUPPORT: ProviderId[] = ['railway', 'render', 'fly.io', 'vercel', 'cloudflare', 'kubernetes'];
const KNOWN: ProviderId[] = ['railway', 'render', 'fly.io', 'vercel', 'cloudflare', 'netlify', 'kubernetes', 'docker'];

/** Which providers this deployment declares as configured (env-driven, read-only). */
function configuredProviders(): ProviderId[] {
  const raw = env.RELEASE_CONFIGURED_PROVIDERS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is ProviderId => (KNOWN as string[]).includes(p));
}

/**
 * Resolve the honest capability for a given provider in the current environment.
 * `providerDeploymentId` present + provider configured + execution reachable →
 * CONFIGURED; otherwise ENVIRONMENT_BLOCKED (no live target reachable here).
 */
export function providerCapability(
  provider: ProviderId | undefined,
  opts: { hasProviderDeploymentId?: boolean; providerConfigured?: boolean } = {},
): ProviderCapability {
  const pid: ProviderId = provider && KNOWN.includes(provider) ? provider : 'unknown';

  if (!KNOWN.includes(pid)) {
    return {
      provider: pid,
      supportsRollback: false,
      state: 'UNSUPPORTED',
      reason: `provider '${pid}' is not a known deployment target`,
      live: false,
    };
  }

  const supportsRollback = ROLLBACK_SUPPORT.includes(pid);
  const declaredConfigured = opts.providerConfigured ?? configuredProviders().includes(pid);
  const hasProviderId = opts.hasProviderDeploymentId ?? false;

  // No reachable live target is ever verified from a static process env.
  if (!declaredConfigured) {
    return {
      provider: pid,
      supportsRollback,
      state: declaredConfigured ? 'UNCONFIGURED' : 'ENVIRONMENT_BLOCKED',
      reason: `provider '${pid}' is not configured/live on this deployment; real execution is environment-blocked`,
      live: false,
    };
  }

  // Declared configured but no deployment reached / no live attestation → blocked.
  if (!hasProviderId) {
    return {
      provider: pid,
      supportsRollback,
      state: 'ENVIRONMENT_BLOCKED',
      reason: `provider '${pid}' configured but no live deployment was attested; execution is environment-blocked`,
      live: false,
    };
  }

  return {
    provider: pid,
    supportsRollback,
    state: 'CONFIGURED',
    reason: `provider '${pid}' is configured and a live deployment id is attested`,
    live: true,
  };
}

/** List capability for every known provider (honest, non-fabricated). */
export function listProviderCapabilities(): ProviderCapability[] {
  return KNOWN.map((p) => providerCapability(p));
}
