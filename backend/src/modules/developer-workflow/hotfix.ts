/**
 * CodeConClave — #33 Hotfix Fast-Track (PKG-17).
 * Advisory hotfix fast-track plan for an incident: from the impact area, produce
 * a minimal-change hotfix plan (smallest surface, containment, quick verify,
 * observe). Deterministic and advisory — no code is changed or deployed.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { HotfixFastTrackReport, HotfixStep, TruthfulnessState } from './types.js';

function inferImpactArea(files: LoadedSourceFile[], incidentTitle: string): string | null {
  const tokens = incidentTitle.toLowerCase().split(/\W+/).filter((t) => t.length >= 3);
  let best: string | null = null;
  let bestHits = 0;
  for (const f of files) {
    const hits = tokens.filter((t) => f.text.toLowerCase().includes(t));
    if (hits.length > bestHits) {
      bestHits = hits.length;
      best = `/` + f.path.split('/').slice(-1)[0];
    }
  }
  return bestHits > 0 ? best : null;
}

function severityOf(incidentTitle: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const t = incidentTitle.toLowerCase();
  if (/critical|down|outage|broken|panic|crash|breach/i.test(t)) return 'CRITICAL';
  if (/error|fail|bug|500|leak|slow/i.test(t)) return 'HIGH';
  if (/warn|odd|regress/i.test(t)) return 'MEDIUM';
  return 'LOW';
}

export async function buildHotfixFastTrackReport(
  userId: string,
  projectId: string,
  incidentTitle: string,
): Promise<HotfixFastTrackReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const state: TruthfulnessState = 'HEURISTIC';
  const severity = severityOf(incidentTitle);
  const impactedArea = inferImpactArea(analyzable, incidentTitle);

  const minimalSurface = impactedArea
    ? `Restrict the change to ${impactedArea} and its direct callers; avoid unrelated refactors in the same hotfix.`
    : 'Contain the change to the smallest set of files that reproduce the incident; add a focused regression test.';

  const steps: HotfixStep[] = [];
  let order = 1;
  steps.push({
    order: order++,
    action: 'Reproduce & isolate',
    owner: 'engineer',
    detail: 'Reproduce the incident, capture the failing input/path, and identify the minimum file(s) involved.',
  });
  steps.push({
    order: order++,
    action: 'Minimal patch',
    owner: 'engineer',
    detail: minimalSurface,
  });
  steps.push({
    order: order++,
    action: 'Containment',
    owner: 'ops',
    detail: severity === 'CRITICAL' ? 'Apply a stop-the-bleed mitigation (kill-switch / feature flag / rollback window) before the full fix lands.' : 'Verify blast radius; confirm the hotfix does not widen impact.',
  });
  steps.push({
    order: order++,
    action: 'Quick verify',
    owner: 'engineer',
    detail: 'Run the focused regression + a small smoke set; confirm the original failure is resolved and no obvious new failure appears.',
  });
  steps.push({
    order: order++,
    action: 'Deploy & observe',
    owner: 'ops',
    detail: 'Ship only the hotfix through the fast-track gate; watch health for a short observe window before fanning out.',
  });
  if (severity === 'CRITICAL' || severity === 'HIGH') {
    steps.push({
      order: order++,
      action: 'Rollback plan ready',
      owner: 'ops',
      detail: 'Prepare a precise rollback target so a bad hotfix can be reverted fast.',
    });
  }
  steps.push({
    order: order++,
    action: 'Follow-up fix',
    owner: 'engineer',
    detail: 'Track the root-cause fix separately from the hotfix so countermeasures land permanently.',
  });

  const estimatedRisk: 'LOW' | 'MEDIUM' | 'HIGH' = severity === 'CRITICAL' ? 'HIGH' : severity === 'HIGH' ? 'MEDIUM' : 'LOW';

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    incidentTitle,
    impactedArea,
    severity,
    minimalSurface,
    steps,
    estimatedRisk,
    state,
    limitations: [
      'Plan is heuristic guidance from the incident title + static source — not a live incident response.',
      `${skipped.length} file(s) skipped by the intake guard.`,
      'Advisory only — no code is changed, deployed, or rolled back.',
    ],
  };
}