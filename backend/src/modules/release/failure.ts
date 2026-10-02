/**
 * CodeConClave — PKG-21 — Deployment failure correlation.
 * Correlates deployment → failed stage → evidence → likely cause → next action.
 * Deterministic and evidence-based; NEVER invents a root cause.
 */
import type { DeploymentRecord, FailureCorrelation, GateResult, GateOutcome } from './types.js';

const FAILED_STAGES: { gate: 'build' | 'test' | 'health' | 'smoke'; stage: 'build' | 'test' | 'health' | 'smoke'; name: string; next: string }[] = [
  { gate: 'build', stage: 'build', name: 'Build', next: 'Inspect the build command/logs and fix compile/type errors before redeploying.' },
  { gate: 'test', stage: 'test', name: 'Test', next: 'Inspect failing tests and fix the introduced regression before redeploying.' },
  { gate: 'health', stage: 'health', name: 'Health', next: 'Inspect runtime health: configuration, credentials, and startup errors.' },
  { gate: 'smoke', stage: 'smoke', name: 'Smoke', next: 'Inspect smoke-test failures against the deployed endpoint and environment.' },
];

export function correlateFailure(record: DeploymentRecord): FailureCorrelation {
  const gates: [GateResult | null, 'build' | 'test' | 'health' | 'smoke'][] = [
    [record.buildResult, 'build'],
    [record.testResult, 'test'],
    [record.healthResult, 'health'],
    [record.smokeResult, 'smoke'],
  ];
  const failed = gates.find(([g]) => g?.outcome === 'FAIL') ?? null;
  const stageDef = failed ? FAILED_STAGES.find((s) => s.gate === failed[1]) : undefined;

  const status = record.status;
  const evidence: string[] = [];
  for (const [g] of gates) {
    if (g) evidence.push(`${g.name}: ${g.outcome} — ${g.message}`);
  }

  let likelyCause = 'No verification gates failed; deployment did not reach a verified state.';
  if (stageDef && failed) {
    likelyCause = `${stageDef.name} gate failed: ${(failed[0] as GateResult).message}`;
  }

  return {
    deploymentId: record.id,
    failedStage: failed ? failed[1] : status === 'BLOCKED' ? 'preflight' : null,
    failed: failed ? failed[0] : null,
    status,
    likelyCause,
    affectedService: record.service,
    version: record.version,
    commit: record.git.commitSha ?? null,
    recommendedNextAction: stageDef ? stageDef.next : 'Review the failure reason and the failed deployment record, then redeploy or roll back if an eligible previous release exists.',
    rollbackAvailable: record.rollbackAvailable,
    evidence,
  };
}

export function gateOutcome(pass: boolean, skip = false): GateOutcome {
  if (skip) return 'SKIP';
  return pass ? 'PASS' : 'FAIL';
}
