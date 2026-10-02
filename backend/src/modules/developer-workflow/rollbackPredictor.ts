/**
 * CodeConClave — #32 Rollback Predictor (PKG-17).
 * Advisory rollback readiness/risk predictor for a workspace. Scores how safe a
 * rollback is likely to be from static change signals (migration presence,
 * config/dependency churn, schema-affecting files). Deterministic and advisory —
 * it never performs a rollback.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { RollbackPredictorReport, RollbackSignal, TruthfulnessState } from './types.js';

function classify(signals: RollbackSignal[]): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (signals.some((s) => s.risk === 'HIGH')) return 'HIGH';
  if (signals.filter((s) => s.risk === 'MEDIUM').length >= 2) return 'MEDIUM';
  return 'LOW';
}

export async function buildRollbackPredictorReport(
  userId: string,
  projectId: string,
  deploymentCommit?: string,
  previousCommit?: string,
): Promise<RollbackPredictorReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const state: TruthfulnessState = 'HEURISTIC';

  const signals: RollbackSignal[] = [];

  const hasMigrations = analyzable.some((f) => /(migration|migrations|db\/)?(0\d+_)?[a-z0-9_]+\.sql$/i.test(f.path) || /_migrat/i.test(f.path));
  if (hasMigrations) {
    signals.push({
      label: 'database migrations present',
      risk: 'HIGH',
      detail: 'Rolling back code without rolling back migrated schema can cause breakage — verify migration reversibility first.',
    });
  }

  const hasConfigChurn = analyzable.some((f) => /\.(env|ya?ml|toml|conf|json)$/i.test(f.path) && /password|secret|token|api[_-]?key/i.test(f.text));
  if (hasConfigChurn) {
    signals.push({
      label: 'config/secret adjust detected',
      risk: 'MEDIUM',
      detail: 'Config/secret changes may not be automatically reverted — confirm the previous values are available.',
    });
  }

  const hasDeployManifest = analyzable.some((f) => /dockerfile|docker-compose|k8s|deploy|\.github\/workflows/i.test(f.path));
  if (hasDeployManifest) {
    signals.push({
      label: 'infrastructure-as-code present',
      risk: 'MEDIUM',
      detail: 'Rollback should be coordinated with the IaC profile to keep environment in sync.',
    });
  }

  if (!deploymentCommit && !previousCommit) {
    signals.push({
      label: 'no explicit commit pair provided',
      risk: 'MEDIUM',
      detail: 'Rollback target/current commits were not supplied — readiness is estimated from workspace signals only.',
    });
  } else if (deploymentCommit === previousCommit) {
    signals.push({
      label: 'commit pair identical',
      risk: 'HIGH',
      detail: 'Current and rollback commit are the same — nothing meaningful would change on rollback.',
    });
  } else {
    signals.push({
      label: 'commit pair provided',
      risk: 'LOW',
      detail: 'A distinct rollback target was supplied.',
    });
  }

  if (analyzable.length === 0) {
    signals.push({
      label: 'no scannable source',
      risk: 'HIGH',
      detail: 'No source files available to estimate rollback risk.',
    });
  }

  const base = Math.max(0, 100 - signals.filter((s) => s.risk === 'HIGH').length * 25 - signals.filter((s) => s.risk === 'MEDIUM').length * 8);
  const readinessScore = base;
  const risk = classify(signals);

  const recommendedAction =
    risk === 'HIGH'
      ? 'Proceed with caution: validate migration reversibility and verify the exact rollback target before reverting.'
      : risk === 'MEDIUM'
        ? 'Rollback is plausible; run a pre-rollback verification (secrets, migrations, IaC sync) first.'
        : 'Low rollback risk observed from workspace signals; still verify the live target before reverting.';

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    readinessScore,
    risk,
    signals,
    recommendedAction,
    state,
    limitations: [
      'Estimate from static workspace signals only — no live deployment history is used.',
      `${skipped.length} file(s) skipped by the intake guard.`,
      'Advisory — no rollback is executed.',
    ],
  };
}