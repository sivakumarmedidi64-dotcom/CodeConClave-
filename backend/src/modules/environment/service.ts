/**
 * CodeConClave — PKG-20 — environment & terminal-safety service.
 * High-level orchestration between the validator, command-safety classifier
 * and the persisted per-project environment session. Names-only — secrets are
 * never accepted, stored, or returned by this module.
 */
import type {
  CommandPreflight,
  CommandRiskReport,
  Environment,
  EnvironmentStatus,
  EnvironmentSwitch,
} from './types.js';
import { validateEnvironment, requiredVarNames } from './validator.js';
import { preflightCommand, classifyCommand } from './safety.js';
import { getActiveEnvironment, switchEnvironment, setEnvironmentState, listSwitches } from './sessions.js';

export interface EnvironmentService {
  getStatus(userId: string, projectId: string, environment?: Environment): Promise<EnvironmentStatus>;
  validate(userId: string, projectId: string, environment: Environment): Promise<EnvironmentStatus>;
  preflight(userId: string, projectId: string, command: string, environment?: Environment): Promise<CommandPreflight>;
  classify(userId: string, command: string): CommandRiskReport;
  select(userId: string, projectId: string, toEnv: Environment, opts?: { reason?: string; confirmed?: boolean }): Promise<Environment>;
  history(userId: string, projectId: string, limit?: number): Promise<EnvironmentSwitch[]>;
}

/**
 * Required-variable harness that supports injection for tests while defaulting
 * to the real process environment (READ ONLY — presence/shape, never values).
 */
function injectedRequired(environment: Environment, valueOf?: (name: string) => string | null): string[] {
  const probe: (name: string) => string | null = valueOf ?? ((n: string): string | null => process.env[n] ?? null);
  return requiredVarNames(environment).filter((n) => Boolean(probe(n)));
}

export interface EnvironmentServiceDeps {
  /**
   * Optional injected env lookup for tests (names-only — the returned VALUE is
   * used only for internal presence/shape validation and is NEVER surfaced).
   */
  valueOf?: (name: string) => string | null;
}

export function createEnvironmentService(deps: EnvironmentServiceDeps = {} as EnvironmentServiceDeps): EnvironmentService {
  const valueOf = deps.valueOf;

  async function statusFor(userId: string, projectId: string, environment: Environment): Promise<EnvironmentStatus> {
    const required = injectedRequired(environment, valueOf);
    const validated = validateEnvironment(environment, {
      probeVar: valueOf,
      required,
    });
    const verifiedRequired = validated.requiredVars.filter((r) => r.status === 'PRESENT' || r.status === 'INVALID').map((r) => r.name);
    const missing = validated.requiredVars.filter((r) => r.status === 'MISSING' || r.status === 'INVALID').map((r) => r.name);

    await setEnvironmentState(userId, projectId, environment, {
      status: validated.status,
      missing,
      invalid: validated.requiredVars.filter((r) => r.status === 'INVALID').map((r) => r.name),
    }).catch(() => undefined);

    return {
      environment,
      status: validated.status,
      requiredVars: validated.requiredVars,
      declaredEnv: validated.declaredEnv,
      blockEnvironmentSensitive: validated.status === 'INVALID' || validated.status === 'UNVERIFIED',
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    async getStatus(userId, projectId, environment) {
      const active = environment ?? (await getActiveEnvironment(userId, projectId));
      return statusFor(userId, projectId, active);
    },
    async validate(userId, projectId, environment) {
      return statusFor(userId, projectId, environment);
    },
    async preflight(userId, projectId, command, environment) {
      const active = environment ?? (await getActiveEnvironment(userId, projectId));
      const validated = await statusFor(userId, projectId, active);
      const cfg = validated.status === 'INVALID' ? 'invalid' : validated.status === 'VERIFIED' ? 'valid' : 'unverified';
      return preflightCommand(active, userId, command || '', cfg);
    },
    classify(userId, command) {
      return classifyCommand(userId, command || '');
    },
    async select(userId, projectId, toEnv, opts) {
      const result = await switchEnvironment(userId, projectId, toEnv, opts);
      if (!result.switched) throw Object.assign(new Error('environment switch requires explicit confirmation'), { requiresConfirmation: true });
      return result.environment;
    },
    history(userId, projectId, limit) {
      return listSwitches(userId, projectId, limit);
    },
  };
}

export const environmentService = createEnvironmentService();
