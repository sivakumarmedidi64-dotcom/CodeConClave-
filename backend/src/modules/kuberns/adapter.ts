/**
 * CodeConClave — Kuberns deployment adapter boundary (P4).
 *
 * An honest boundary, not a fabricated integration. The adapter is declared but
 * disabled by default; with no API URL/token it reports CONFIGURATION_REQUIRED
 * and refuses to deploy. It NEVER attests a live Kuberns control plane from the
 * mere presence of a credential: `live` stays false until a real reachability
 * check is implemented and observed.
 */
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

export type KubernsState = 'DISABLED' | 'CONFIGURATION_REQUIRED' | 'CONFIGURED';

export interface KubernsStatus {
  provider: 'kuberns';
  enabled: boolean;
  configured: boolean;
  state: KubernsState;
  /** This deployment never claims a live Kuberns target from static config. */
  live: false;
  reason: string;
  capabilities: string[];
}

export const KUBERNS_CAPABILITIES = ['deploy', 'status', 'logs', 'rollback'] as const;

export function kubernsAdapterEnabled(): boolean {
  return String(env.KUBERNS_ADAPTER_ENABLED).toLowerCase() === 'true';
}

export function kubernsConfigured(): boolean {
  const url = String(env.KUBERNS_API_URL ?? '').trim();
  const token = String(env.KUBERNS_API_TOKEN ?? '').trim();
  return url.length > 0 && token.length > 0;
}

export function kubernsStatus(): KubernsStatus {
  const enabled = kubernsAdapterEnabled();
  const configured = kubernsConfigured();
  if (!enabled) {
    return {
      provider: 'kuberns',
      enabled,
      configured,
      state: 'DISABLED',
      live: false,
      reason: 'Kuberns adapter is disabled on this deployment (set KUBERNS_ADAPTER_ENABLED=true to enable)',
      capabilities: [...KUBERNS_CAPABILITIES],
    };
  }
  if (!configured) {
    return {
      provider: 'kuberns',
      enabled,
      configured,
      state: 'CONFIGURATION_REQUIRED',
      live: false,
      reason: 'KUBERNS_API_URL and KUBERNS_API_TOKEN are required before the Kuberns adapter can deploy',
      capabilities: [...KUBERNS_CAPABILITIES],
    };
  }
  return {
    provider: 'kuberns',
    enabled,
    configured,
    state: 'CONFIGURED',
    live: false,
    reason: 'Kuberns credentials are present but no live target is attested; this deployment cannot deploy through Kuberns yet',
    capabilities: [...KUBERNS_CAPABILITIES],
  };
}

/**
 * Gate before any Kuberns deployment. Throws an honest error while the adapter
 * is disabled or unconfigured — it never fabricates a successful deployment.
 */
export function assertKubernsReady(): KubernsStatus {
  const status = kubernsStatus();
  if (status.state !== 'CONFIGURED') {
    throw AppError.unavailable(
      status.state === 'DISABLED' ? 'kuberns_adapter_disabled' : 'kuberns_configuration_required',
      status.reason,
      { provider: 'kuberns', state: status.state, live: status.live },
    );
  }
  return status;
}

/**
 * Deployment is intentionally unsupported in this phase (boundary only). Kept
 * as an explicit capability probe so callers never assume a live deploy path.
 */
export function kubernsDeploySupported(): false {
  return false;
}
