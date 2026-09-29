/**
 * CodeConClave — #35 Feature Flag Orchestrator (PKG-17).
 * Advisory feature-flag inventory + lifecycle/rollout guidance for a workspace.
 * Scans source for flag-style conditionals (env toggles, boolean gating) and
 * classifies each as PROPOSED / ACTIVE / RELEASED / STALE with a rollout-level
 * note. Deterministic and advisory — no flag is created, toggled, or removed.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { FeatureFlagOrchestratorReport, FlagEntry, TruthfulnessState } from './types.js';

const FLAG_PATTERNS = [
  /\benv\.([A-Z][A-Z0-9_]*)\b/g,
  /\b(?:FLAG|FEATURE)[_A-Z0-9]*\b/g,
  /\b(?:isEnabled|featureEnabled|flagEnabled)\(['"]([A-Za-z0-9_-]+)['"]\)/g,
  /\bfeatureFlags?\[['"]([A-Za-z0-9_-]+)['"]\]/g,
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
];

function collectFlags(files: LoadedSourceFile[]): Map<string, { count: number; firstPath: string; sample: string }> {
  const map = new Map<string, { count: number; firstPath: string; sample: string }>();
  for (const f of files) {
    for (const pattern of FLAG_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(f.text)) !== null) {
        const name = (m[1] || m[0]).trim();
        if (name.length < 3 || name.length > 80) continue;
        const existing = map.get(name);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(name, { count: 1, firstPath: f.path, sample: f.text.split('\n').find((l) => l.includes(name))?.trim().slice(0, 120) ?? '' });
        }
      }
    }
  }
  return map;
}

function classifyLifecycle(count: number): { lifecycle: FlagEntry['lifecycle']; risk: FlagEntry['risk']; note: string } {
  if (count === 0) return { lifecycle: 'PROPOSED', risk: 'LOW', note: 'declared but not referenced' };
  if (count === 1) return { lifecycle: 'ACTIVE', risk: 'MEDIUM', note: 'single reference — check for dead/stale branches' };
  if (count >= 15) return { lifecycle: 'STALE', risk: 'HIGH', note: 'many references suggest the flag should be promoted or removed' };
  return { lifecycle: 'RELEASED', risk: 'LOW', note: 'reasonably contained usage' };
}

export async function buildFeatureFlagOrchestratorReport(
  userId: string,
  projectId: string,
): Promise<FeatureFlagOrchestratorReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const state: TruthfulnessState = 'HEURISTIC';
  const flags = collectFlags(analyzable);

  const flagsInventory: FlagEntry[] = [];
  for (const [name, info] of flags) {
    const { lifecycle, risk, note } = classifyLifecycle(info.count);
    flagsInventory.push({
      name,
      lifecycle,
      risk,
      rolloutLevel: rolloutLevelFor(lifecycle),
      note: `${note} (${info.count} ref(s), first in ${info.firstPath})`,
    });
  }
  flagsInventory.sort((a, b) => (a.risk === 'HIGH' ? -1 : 0) - (b.risk === 'HIGH' ? -1 : 0));

  const totalFlags = flagsInventory.length;
  const staleCount = flagsInventory.filter((f) => f.lifecycle === 'STALE').length;
  const recommendedAction =
    staleCount > 0
      ? `Promote ${staleCount} stale flag(s) to default-on and remove them from code via a normal release.`
      : totalFlags === 0
        ? 'No feature-flag style conditionals were found in the scanned source.'
        : 'Flag usage looks contained; schedule a cleanup review for any flag older than one release.';

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    flagsInventory,
    totalFlags,
    staleCount,
    recommendedAction,
    state,
    limitations: [
      'Flag detection is heuristic over source text; it does not read the live toggle table or runtime state.',
      `${skipped.length} file(s) skipped by the intake guard.`,
      'Advisory only — no flag is created, toggled, or removed.',
    ],
  };
}

function rolloutLevelFor(lifecycle: FlagEntry['lifecycle']): string {
  switch (lifecycle) {
    case 'PROPOSED': return 'not yet rolled out';
    case 'ACTIVE': return 'progressive / percentage rollout suggested';
    case 'RELEASED': return 'default-on, flag removal scheduled';
    case 'STALE': return 'promote or remove';
    default: return 'unknown';
  }
}