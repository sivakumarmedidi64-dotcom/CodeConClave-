/**
 * CodeConClave AI OS — P2.7 AI Personality.
 *
 * Behavior-only steering for a cowork session. Personality modes
 * (CONSERVATIVE / BALANCED / AGGRESSIVE / METHODICAL) tune HOW the agent works
 * (parallelism appetite, retry appetite, verification strictness, exploration
 * breadth). It NEVER changes security boundaries: stop rules, capabilities and
 * approval requirements always win. No personality mode can broaden authority.
 */
import { AppError } from '../../shared/errors.js';
import type { P2Feature } from './flags.js';

export const PersonalityMode = {
  CONSERVATIVE: 'CONSERVATIVE',
  BALANCED: 'BALANCED',
  AGGRESSIVE: 'AGGRESSIVE',
  METHODICAL: 'METHODICAL',
} as const;
export type PersonalityMode = (typeof PersonalityMode)[keyof typeof PersonalityMode];

export interface PersonalityConfig {
  mode: PersonalityMode;
  /** Max parallel branches the agent may attempt in this mode. */
  maxParallelism: number;
  /** Max allowed retries for a failing op (personality-level, below rule caps). */
  maxRetries: number;
  /** Whether verification of results is mandatory (conservative/methodical do more). */
  strictVerification: boolean;
  /** Exploration breadth across candidate files/strategies. */
  exploration: 'narrow' | 'medium' | 'broad';
  /** Risk appetite label for UX/steering only (never an authority override). */
  riskLabel: string;
}

const MODES: Record<PersonalityMode, Omit<PersonalityConfig, 'mode'>> = {
  CONSERVATIVE: { maxParallelism: 1, maxRetries: 0, strictVerification: true, exploration: 'narrow', riskLabel: 'low' },
  BALANCED: { maxParallelism: 2, maxRetries: 1, strictVerification: true, exploration: 'medium', riskLabel: 'moderate' },
  AGGRESSIVE: { maxParallelism: 4, maxRetries: 2, strictVerification: false, exploration: 'broad', riskLabel: 'elevated' },
  METHODICAL: { maxParallelism: 1, maxRetries: 1, strictVerification: true, exploration: 'narrow', riskLabel: 'cautious' },
};

export class Personality {
  private config: PersonalityConfig;

  constructor(
    mode: PersonalityMode,
    private feature: () => P2Feature | null,
  ) {
    this.config = { mode, ...MODES[mode] };
  }

  isEnabled(): boolean {
    return this.feature() === 'personality';
  }

  switchMode(mode: PersonalityMode): PersonalityConfig {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_personality_disabled', 'personality feature is off');
    this.config = { mode, ...MODES[mode] };
    return this.config;
  }

  get(): PersonalityConfig {
    return this.config;
  }

  /**
   * Advisory: how eagerly the agent may proceed along a path. Personality may
   * TUNE the agent's approach but can never CONVERT a denied rule into an
   * allowed one. `ruleAllows` is the stop-rule/capability authority — when it is
   * false, personality returns false regardless of mode.
   */
  mayProceed(opts: { ruleAllows: boolean; opSensitivity: 'routine' | 'sensitive' | 'critical' }): boolean {
    if (!this.isEnabled()) return opts.ruleAllows;
    if (!opts.ruleAllows) return false; // rules always win
    // behavioral gate only:
    if (opts.opSensitivity === 'critical') {
      return this.config.mode === 'CONSERVATIVE' || this.config.mode === 'METHODICAL' || this.config.maxRetries > 0;
    }
    return true;
  }
}
