/**
 * CodeConClave — PKG-20 — terminal command safety & environment cross-check.
 * Composes the DETERMINISTIC policy engine (dangerousCommand/riskOfCommand +
 * the runtime evaluateCommand gate) into a SAFE/CAUTION/DANGEROUS/BLOCKED tier.
 * This is NOT a second execution engine and NOT claimed to be perfect — it is a
 * heuristic guard that never lets a DANGEROUS/BLOCKED command run silently.
 */
import { RiskLevel } from '@codeconclave/shared';
import { dangerousCommand, riskOfCommand } from '../execution/policy.js';
import { evaluateCommand } from '../runtime/security.js';
import type { CommandPreflight, CommandRisk, CommandRiskReport, Environment, EnvironmentMismatch } from './types.js';

const DANGEROUS_TARGETS: RegExp[] = [
  /(drop|truncate)\s+(table|database)/gi,
  /flush\s+privileges/gi,
  /railway\s+.*\b(up|deploy|production|prod)\b/i,
  /--prod/i,
  /node_env\s*=\s*production/i,
  /deploy\s+--\s*environment\s*=\s*production/i,
];

const PRODUCTION_TARGETS: RegExp[] = [
  /--prod/i,
  /node_env\s*=\s*production/i,
  /production/gi,
  /\bprod\b/gi,
  /railway\s+.*\b(up|deploy)\b/i,
  /fly\s+deploy/i,
  /vercel\s+--prod/i,
  /serverless\s+deploy/i,
];

const DB_TARGETS: RegExp[] = [
  /(psql|pg_dump|pg_restore|mysql|mongo|redis-cli)/gi,
  /(drop|truncate)\s+(table|database)/gi,
  /flush\s+privileges/gi,
];

/** True when a command carries a production deployment/target signal. */
export function targetsProduction(command: string): boolean {
  return PRODUCTION_TARGETS.some((re) => re.test(command || ''));
}

/** Classify a command into a deterministic risk tier. */
export function classifyCommand(userId: string, command: string): CommandRiskReport {
  const trimmed = (command || '').trim();
  if (!trimmed) {
    return { command, risk: 'BLOCKED', reason: 'empty command', requiresConfirmation: false };
  }
  const dangerous = dangerousCommand(trimmed);
  const decision = evaluateCommand(userId, trimmed);
  const level = riskOfCommand(trimmed);
  if (!decision.allowed) {
    if (dangerous) {
      return {
        command,
        risk: 'DANGEROUS',
        reason: decision.blockedReason ?? 'command is on the deny-by-default dangerous list',
        requiresConfirmation: true,
      };
    }
    // Approval-gated commands (medium/high risk) are CAUTION: confirm, do not auto-run.
    if (decision.requiresApproval) {
      return {
        command,
        risk: 'CAUTION',
        reason: `${level}-risk command — confirm before executing`,
        requiresConfirmation: true,
      };
    }
    return {
      command,
      risk: 'BLOCKED',
      reason: decision.blockedReason ?? 'command denied by terminal policy',
      requiresConfirmation: false,
    };
  }
  if (level === RiskLevel.CRITICAL) {
    return { command, risk: 'DANGEROUS', reason: 'critical-risk command — confirm before executing', requiresConfirmation: true };
  }
  if (level === RiskLevel.HIGH || level === RiskLevel.MEDIUM) {
    return { command, risk: 'CAUTION', reason: `${level}-risk command — review before executing`, requiresConfirmation: true };
  }
  return { command, risk: 'SAFE', reason: 'low-risk command', requiresConfirmation: false };
}

/** Detect which database/environment a command would target (names only). */
export function detectDatabaseTarget(command: string): 'development' | 'staging' | 'production' | 'unknown' | 'none' {
  const c = command || '';
  if (!DB_TARGETS.some((re) => re.test(c))) return 'none';
  if (PRODUCTION_TARGETS.some((re) => re.test(c))) return 'production';
  if (/staging/gi.test(c)) return 'staging';
  if (/development|dev|localhost|127\.0\.0\.1/i.test(c)) return 'development';
  return 'unknown';
}

/** Detect a production-environment mismatch between requested env and command. */
export function detectEnvironmentMismatch(environment: Environment, command: string): EnvironmentMismatch {
  const targets = detectDatabaseTarget(command);
  const prodTarget = targetsProduction(command);
  if (prodTarget && environment !== 'production') {
    return { detected: true, detail: `command targets production but active environment is ${environment}` };
  }
  if (environment === 'production' && targets === 'development') {
    return { detected: true, detail: 'production environment with a development-targeted command' };
  }
  if (targets === 'production' && isDestructiveDbCommand(command)) {
    return { detected: true, detail: 'destructive database command in production' };
  }
  return { detected: false, detail: '' };
}

/** True when this command is destructive DB work (drop/truncate/flush). */
export function isDestructiveDbCommand(command: string): boolean {
  return /(drop|truncate)\s+(table|database)|flush\s+privileges/gi.test(command || '');
}

/**
 * Full preflight: environment × command risk × configuration × db target →
 * a structured action decision. Never silently executes DANGEROUS commands.
 */
export function preflightCommand(
  environment: Environment,
  userId: string,
  command: string,
  configuration: 'valid' | 'invalid' | 'unverified' = 'valid',
): CommandPreflight {
  const risk = classifyCommand(userId, command);
  const dbTarget = detectDatabaseTarget(command);
  const mismatch = detectEnvironmentMismatch(environment, command);

  let action: CommandPreflight['action'] = 'execute';

  // BLOCK identities are never execute-able.
  if (risk.risk === 'BLOCKED') {
    action = 'blocked';
  } else if (risk.risk === 'DANGEROUS' || risk.requiresConfirmation) {
    action = 'confirmation_required';
  }

  // Production hard guards.
  if (environment === 'production') {
    if (isDestructiveDbCommand(command)) {
      action = 'blocked';
    } else if (dbTarget === 'production' || risk.risk !== 'SAFE') {
      action = 'confirmation_required';
    }
  }

  // Dev environment running production deployment commands → require confirmation.
  if (environment !== 'production' && targetsProduction(command)) {
    action = action === 'blocked' ? 'blocked' : 'confirmation_required';
  }

  // Staging with missing/invalid configuration → block secret-sensitive work.
  if (environment === 'staging' && configuration === 'invalid') {
    action = 'blocked';
  }

  // Mismatch always at least requires confirmation.
  if (mismatch.detected && action === 'execute') {
    action = 'confirmation_required';
  }

  return { environment, commandRisk: risk, configuration, databaseTarget: dbTarget, action, mismatch };
}
