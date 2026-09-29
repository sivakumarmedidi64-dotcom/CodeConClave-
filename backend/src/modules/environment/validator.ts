/**
 * CodeConClave — PKG-20 — environment validator.
 * Determines, for a given PROJECT-environment pair, whether each REQUIRED
 * variable is present, malformed, missing or not required. Reports NAMES and a
 * status ONLY — secret values are never read back or returned.
 */
import type { EnvVarReport, EnvVarStatus, Environment } from './types.js';

/** Known variable names that map to a structural "shape" check (name-only). */
const SHAPE_CHECKERS: Record<string, (value: string) => string | null> = {
  DATABASE_URL: (v) => (/^(postgres(?:ql)?|mysql|redis|amqp|mongodb(?:\+srv)?):\/\//.test(v) ? null : 'malformed URL scheme'),
  REDIS_URL: (v) => (/^redis:\/\//.test(v) ? null : 'malformed redis URL'),
  OPENAI_API_KEY: (v) => (v.length >= 8 ? null : 'too short'),
  RAZORPAY_KEY_SECRET: (v) => (v.length >= 8 ? null : 'too short'),
  JWT_SECRET: (v) => (v.length >= 16 ? null : 'too short'),
  SESSION_SECRET: (v) => (v.length >= 16 ? null : 'too short'),
};

export interface RequiredVarConfig {
  env: Environment;
  names: string[];
}

/** Required variable names per environment (from config; comma-separated). */
export function requiredVarNames(env: Environment, resolver: (name: string) => string = (n) => process.env[n] ?? ''): string[] {
  const raw =
    env === 'production' ? resolver('RUNTIME_ENV_REQUIRED_PRODUCTION')
    : env === 'staging' ? resolver('RUNTIME_ENV_REQUIRED_STAGING')
    : resolver('RUNTIME_ENV_REQUIRED_DEVELOPMENT');
  return (raw || '')
    .split(',')
    .map((n) => n.trim().toUpperCase())
    .filter(Boolean);
}

/** Known declared env-var names (used to label NOT_REQUIRED vars present in env). */
export function knownVarNames(resolver: (name: string) => string = (n) => process.env[n] ?? ''): string[] {
  return (resolver('RUNTIME_ENV_KNOWN_VARS') || '')
    .split(',')
    .map((n) => n.trim().toUpperCase())
    .filter(Boolean);
}

/** Validate one variable: PRESENT/MISSING/INVALID/NOT_REQUIRED. Never the value. */
export function validateVar(name: string, required: boolean, probe: (v: string) => string | null, checkValue: (v: string) => string | null): EnvVarReport {
  const value = probe(name);
  if (!required) return { name, status: 'NOT_REQUIRED' };
  if (value === null || value === '') return { name, status: 'MISSING' };
  const shapeError = checkValue(value);
  if (shapeError) return { name, status: 'INVALID', reason: shapeError };
  return { name, status: 'PRESENT' };
}

/**
 * Build an environment-status report. `probeVar` reads a var NAME and returns
 * its presence (boolean) — never its value. `readValue` is used only for
 * structural validation and is deliberately firewalled (kept in this module).
 */
export function validateEnvironment(
  env: Environment,
  opts: {
    probeVar?: (name: string) => string | null;
    required?: string[];
    known?: string[];
  } = {},
): { status: 'VERIFIED' | 'VALID' | 'DEGRADED' | 'INVALID' | 'UNVERIFIED'; requiredVars: EnvVarReport[]; declaredEnv: string | null } {
  const probeVar = opts.probeVar ?? ((name) => process.env[name] ?? null);
  const required = opts.required ?? requiredVarNames(env);
  const known = opts.known ?? knownVarNames();

  const requiredSet = new Set(required.map((n) => n.toUpperCase()));
  const reported = new Set<string>();
  const reports: EnvVarReport[] = [];

  for (const name of required) {
    const upper = name.toUpperCase();
    if (reported.has(upper)) continue;
    const report = validateVar(
      name,
      true,
      (n) => probeVar(n),
      (v) => (SHAPE_CHECKERS[upper] ? SHAPE_CHECKERS[upper]!(v) : null),
    );
    reports.push(report);
    reported.add(upper);
  }

  // Known-but-not-required vars present in the environment are labeled.
  for (const raw of known) {
    const upper = raw.toUpperCase();
    if (reported.has(upper)) continue;
    if (requiredSet.has(upper)) continue;
    if (probeVar(raw)) reports.push({ name: raw, status: 'NOT_REQUIRED' });
    reported.add(upper);
  }

  const missing = reports.filter((r) => r.status === 'MISSING').length;
  const invalid = reports.filter((r) => r.status === 'INVALID').length;
  const declaredEnv = process.env.NODE_ENV ?? null;

  let status: 'VERIFIED' | 'VALID' | 'DEGRADED' | 'INVALID' | 'UNVERIFIED';
  if (required.length === 0 && reports.length === 0) status = 'UNVERIFIED';
  else if (missing === 0 && invalid === 0 && reports.some((r) => r.status === 'PRESENT')) status = 'VERIFIED';
  else if (invalid > 0) status = 'INVALID';
  else if (missing > 0) status = 'DEGRADED';
  else status = 'VALID';

  return { status, requiredVars: reports, declaredEnv };
}
