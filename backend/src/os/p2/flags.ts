/**
 * CodeConClave AI OS — P2 feature-flag gating helper.
 *
 * Every P2 feature is behind its own `AIOS_P2_*` env flag (all default OFF).
 * `enabled(name)` returns true only when the OS is on AND the feature flag is
 * on, so a disabled feature leaves the pre-existing behavior fully available
 * (independent rollback per feature).
 */
import { env } from '../../config/env.js';

export type P2Feature =
  | 'breakpoint'
  | 'diff'
  | 'replay'
  | 'undo'
  | 'team_cowork'
  | 'stop_rules'
  | 'personality'
  | 'summary'
  | 'smart_files'
  | 'error_fix'
  | 'context_sidebar'
  | 'templates'
  | 'command_palette'
  | 'skills'
  | 'scheduler'
  | 'voice'
  | 'notifications';

const FEATURE_FLAG: Record<P2Feature, () => boolean> = {
  breakpoint: () => env.AIOS_P2_BREAKPOINT === 'true',
  diff: () => env.AIOS_P2_DIFF === 'true',
  replay: () => env.AIOS_P2_REPLAY === 'true',
  undo: () => env.AIOS_P2_UNDO === 'true',
  team_cowork: () => env.AIOS_P2_TEAM_COWORK === 'true',
  stop_rules: () => env.AIOS_P2_STOP_RULES === 'true',
  personality: () => env.AIOS_P2_PERSONALITY === 'true',
  summary: () => env.AIOS_P2_SUMMARY === 'true',
  smart_files: () => env.AIOS_P2_SMART_FILES === 'true',
  error_fix: () => env.AIOS_P2_ERROR_FIX === 'true',
  context_sidebar: () => env.AIOS_P2_CONTEXT_SIDEBAR === 'true',
  templates: () => env.AIOS_P2_TEMPLATES === 'true',
  command_palette: () => env.AIOS_P2_COMMAND_PALETTE === 'true',
  skills: () => env.AIOS_P2_SKILLS === 'true',
  scheduler: () => env.AIOS_P2_SCHEDULER === 'true',
  voice: () => env.AIOS_P2_VOICE === 'true',
  notifications: () => env.AIOS_P2_NOTIFICATIONS === 'true',
};

/** True if the OS is enabled globally and the given P2 feature is on. */
export function enabled(feature: P2Feature): boolean {
  if (env.AIOS_ENABLED !== 'true') return false;
  return FEATURE_FLAG[feature]();
}

/** True when the AI OS is enabled (any P2 feature can be on). */
export function osEnabled(): boolean {
  return env.AIOS_ENABLED === 'true';
}
