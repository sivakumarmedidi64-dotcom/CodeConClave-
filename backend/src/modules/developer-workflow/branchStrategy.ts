/**
 * CodeConClave — #31 Branch Strategy Optimizer (PKG-17).
 * Advisory branch-strategy guidance for a workspace: from observed structure
 * (branch-like signals in source/CI files + team-size signals) recommend a
 * branching model. Deterministic and advisory — it does not create or rename
 * branches.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { BranchRecommendation, BranchStrategyReport, TruthfulnessState } from './types.js';

function estimateTeamSize(files: LoadedSourceFile[]): number | null {
  for (const f of files) {
    if (/owner(s)?\.(yml|yaml)|CODEOWNERS/i.test(f.path)) {
      const owners = Array.from(new Set(f.text.split(/\n/).map((l) => l.trim()).filter((l) => l && /^[^#]/.test(l))));
      return Math.max(1, owners.length);
    }
  }
  return null;
}

function estimateCadence(files: LoadedSourceFile[]): string | null {
  for (const f of files) {
    if (/\.github\/workflows\/|\.gitlab-ci\.yml/i.test(f.path)) {
      if (/cron|schedule/i.test(f.text)) return 'scheduled';
      if (/on:\s*(push|merge|pull_request)/i.test(f.text)) return 'push/merge-driven';
    }
  }
  return null;
}

function recommend(teamSize: number | null, cadence: string | null): BranchRecommendation[] {
  const state: TruthfulnessState = 'HEURISTIC';
  const recs: BranchRecommendation[] = [];
  const size = teamSize ?? 1;

  if (size <= 5) {
    recs.push({
      id: newId(PREFIX.DEVWORKFLOW_BRANCH),
      strategy: 'GitHub Flow / Trunk-based',
      reason: `Small team (≈${size}) — short-lived feature branches merged to a single trunk keeps overhead low.`,
      whenToUse: cadence === 'scheduled' ? 'ship continuously on a short cadence' : 'continuous deploys',
      concurrencyRisk: 'LOW',
      state,
    });
  } else {
    recs.push({
      id: newId(PREFIX.DEVWORKFLOW_BRANCH),
      strategy: 'Feature branches + protected trunk + short-lived release branches',
      reason: `Larger team (≈${size}) benefits from isolation and review while keeping releases releasable.`,
      whenToUse: 'multiple engineers shipping in parallel',
      concurrencyRisk: 'MEDIUM',
      state,
    });
  }

  recs.push({
    id: newId(PREFIX.DEVWORKFLOW_BRANCH),
    strategy: 'Long-lived release/hotfix branches only for maintenance',
    reason: 'Keep long-lived branches minimal; every untouched branch adds merge cost and drift.',
    whenToUse: 'maintaining released versions that need patch support',
    concurrencyRisk: 'MEDIUM',
    state,
  });

  recs.push({
    id: newId(PREFIX.DEVWORKFLOW_BRANCH),
    strategy: 'Enforce branch protection + pre-merge CI on the shared trunk',
    reason: 'Protects the integration branch and keeps deploy artifacts predictable.',
    whenToUse: 'any team size shipping to production from a shared branch',
    concurrencyRisk: 'LOW',
    state,
  });

  return recs;
}

export async function buildBranchStrategyReport(
  userId: string,
  projectId: string,
): Promise<BranchStrategyReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const teamSize = estimateTeamSize(analyzable);
  const cadence = estimateCadence(analyzable);
  const recommendations = recommend(teamSize, cadence);

  recommendations.sort((a, b) => (a.concurrencyRisk === 'LOW' ? -1 : 1) - (b.concurrencyRisk === 'LOW' ? -1 : 1));

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    teamSize,
    releaseCadence: cadence,
    recommendations,
    topRecommendation: recommendations[0]?.strategy ?? null,
    state: 'HEURISTIC',
    limitations: [
      'Recommendations are heuristic based on static workspace signals, not live repo history.',
      `${skipped.length} file(s) skipped by the intake guard.`,
      'Advisory only — no branches are created or renamed; no remote is contacted.',
    ],
  };
}