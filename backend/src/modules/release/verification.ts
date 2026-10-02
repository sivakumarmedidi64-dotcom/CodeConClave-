/**
 * CodeConClave — PKG-21 — Deployment verification.
 * A release is VERIFIED ONLY when all CONFIGURED verification gates PASS.
 * A provider accepting a request is never treated as success on its own.
 */
import type { DeploymentRecord, DeploymentStatus, GateResult } from './types.js';

/** The four verification gates (build / test / health / smoke). */
export type VerificationGate = 'build' | 'test' | 'health' | 'smoke';

export function computeVerification(gates: {
  build?: GateResult | null;
  test?: GateResult | null;
  health?: GateResult | null;
  smoke?: GateResult | null;
}): { verification: 'VERIFIED' | 'PARTIAL' | 'NOT_VERIFIED'; allPass: boolean } {
  const configured: GateResult[] = [gates.build, gates.test, gates.health, gates.smoke].filter(
    (g): g is GateResult => g != null && g.outcome !== 'SKIP',
  );
  if (configured.length === 0) {
    return { verification: 'NOT_VERIFIED', allPass: false };
  }
  const allPass = configured.every((g) => g.outcome === 'PASS');
  const anyFail = configured.some((g) => g.outcome === 'FAIL');
  if (allPass) return { verification: 'VERIFIED', allPass: true };
  if (anyFail) return { verification: 'PARTIAL', allPass: false };
  // WARN-only gates: not conclusive.
  return { verification: 'PARTIAL', allPass: false };
}

/** A deployment that is VERIFIED and not itself a rollback target-holder is a rollback candidate. */
export function isRollbackEligible(record: Pick<DeploymentRecord, 'status' | 'verification'>): boolean {
  return record.status === 'VERIFIED' && record.verification === 'VERIFIED';
}

/**
 * Recompute a record's derived status after a stage completes. Only all-pass gates
 * ever yield VERIFIED. Manual verification flags a PARTIAL (never fakes VERIFIED).
 */
export function deriveStatus(
  base: DeploymentStatus,
  opts: { gatesAllPass?: boolean; anyGateFail?: boolean; manualVerify?: boolean; blocked?: boolean; rolledBack?: boolean },
): DeploymentStatus {
  if (opts.blocked) return 'BLOCKED';
  if (opts.rolledBack) return 'ROLLED_BACK';
  if (opts.manualVerify) return 'PARTIAL'; // manual verification is never VERIFIED
  if (opts.anyGateFail) return 'FAILED';
  if (opts.gatesAllPass) return 'VERIFIED';
  return base;
}
