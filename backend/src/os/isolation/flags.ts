/**
 * CodeConClave AI OS — real-isolation flag gating helper.
 *
 * `enabled()` is true only when the OS is on AND `AIOS_ISOLATION_ENABLED` is
 * on. The isolation facade remains usable for honest host REPORTING regardless,
 * but real runs stay off by default (default `policy_only` min mode preserves
 * the pre-existing sandbox behavior exactly).
 */
import { env } from '../../config/env.js';
import { IsolationMode, isIsolationMode } from './modes.js';

export function osEnabled(): boolean {
  return env.AIOS_ENABLED === 'true';
}

export function enabled(): boolean {
  return osEnabled() && env.AIOS_ISOLATION_ENABLED === 'true';
}

export function minMode(): IsolationMode {
  const v = isIsolationMode(env.AIOS_ISOLATION_MIN_MODE) ? env.AIOS_ISOLATION_MIN_MODE : IsolationMode.POLICY_ONLY;
  return v;
}

export function containerImage(): string {
  return env.AIOS_CONTAINER_IMAGE;
}

export function containerNetwork(): 'none' | 'bridge' {
  return env.AIOS_CONTAINER_NETWORK === 'bridge' ? 'bridge' : 'none';
}