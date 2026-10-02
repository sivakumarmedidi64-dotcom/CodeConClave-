/**
 * CodeConClave AI OS — P3 feature-flag gating helper.
 *
 * Every P3 track is behind its own `AIOS_P3_*` env flag (all default OFF).
 * `enabled(name)` returns true only when the OS is on AND the track flag is on,
 * so a disabled track leaves the pre-existing behavior fully available
 * (independent rollback per track). P3 reuses the canonical P0/P1/P2 primitives.
 */
import { env } from '../../config/env.js';

export type P3Feature =
  | 'github'
  | 'jira'
  | 'slack'
  | 'notifications'
  | 'skill_security'
  | 'context'
  | 'testing'
  | 'security'
  | 'performance'
  | 'architecture'
  | 'team'
  | 'documentation'
  | 'ide';

const FEATURE_FLAG: Record<P3Feature, () => boolean> = {
  github: () => env.AIOS_P3_GITHUB === 'true',
  jira: () => env.AIOS_P3_JIRA === 'true',
  slack: () => env.AIOS_P3_SLACK === 'true',
  notifications: () => env.AIOS_P3_NOTIFICATIONS === 'true',
  skill_security: () => env.AIOS_P3_SKILL_SECURITY === 'true',
  context: () => env.AIOS_P3_CONTEXT === 'true',
  testing: () => env.AIOS_P3_TESTING === 'true',
  security: () => env.AIOS_P3_SECURITY === 'true',
  performance: () => env.AIOS_P3_PERFORMANCE === 'true',
  architecture: () => env.AIOS_P3_ARCHITECTURE === 'true',
  team: () => env.AIOS_P3_TEAM === 'true',
  documentation: () => env.AIOS_P3_DOCUMENTATION === 'true',
  ide: () => env.AIOS_P3_IDE === 'true',
};

/** True if the OS is enabled globally and the given P3 track is on. */
export function enabled(feature: P3Feature): boolean {
  if (env.AIOS_ENABLED !== 'true') return false;
  return FEATURE_FLAG[feature]();
}

/** True when the AI OS is enabled (any P3 track can be on). */
export function osEnabled(): boolean {
  return env.AIOS_ENABLED === 'true';
}
