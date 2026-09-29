/**
 * CodeConClave — PKG-20 Integrated Terminal + Environment Safety — types.
 * Environment awareness (DEVELOPMENT/STAGING/PRODUCTION) with names-only
 * validation, command-risk classification, and preflight cross-checks.
 * SECRET VALUES ARE NEVER TRANSPORTED IN THESE TYPES.
 */
export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Validation status of a single environment variable (NAME only, never value). */
export type EnvVarStatus = 'PRESENT' | 'MISSING' | 'INVALID' | 'NOT_REQUIRED' | 'UNVERIFIED';

export interface EnvVarReport {
  name: string;
  status: EnvVarStatus;
  /** Present only when INVALID — the malformed REASON, never the value. */
  reason?: string;
}

export interface EnvironmentStatus {
  environment: Environment;
  status: 'VERIFIED' | 'VALID' | 'DEGRADED' | 'INVALID' | 'UNVERIFIED';
  requiredVars: EnvVarReport[];
  declaredEnv: string | null;
  blockEnvironmentSensitive: boolean;
  checkedAt: string;
}

/** Deterministic command-risk classification (never claimed perfect). */
export type CommandRisk = 'SAFE' | 'CAUTION' | 'DANGEROUS' | 'BLOCKED';

export interface CommandRiskReport {
  command: string;
  risk: CommandRisk;
  reason: string;
  requiresConfirmation: boolean;
}

export interface EnvironmentMismatch {
  detected: boolean;
  detail: string;
}

export interface CommandPreflight {
  environment: Environment;
  commandRisk: CommandRiskReport;
  configuration: 'valid' | 'invalid' | 'unverified';
  databaseTarget: 'development' | 'staging' | 'production' | 'unknown' | 'none';
  action: 'execute' | 'confirmation_required' | 'blocked';
  mismatch: EnvironmentMismatch;
}

export interface EnvironmentSwitch {
  id: string;
  projectId: string;
  fromEnv: Environment | null;
  toEnv: Environment;
  reason?: string;
  confirmed: boolean;
  createdAt: string;
}
