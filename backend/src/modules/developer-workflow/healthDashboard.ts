/**
 * CodeConClave — #43 Workspace Health Dashboard (PKG-17).
 * Per-workspace development health assessment. Aggregates static signals of the
 * workspace's dev health (test setup, lint/type config, dependency manifests,
 * build markers, docs) into a score. Deterministic and advisory — it does NOT
 * run builds/tests/lint; it infers readiness from source structure.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { HealthDashboardReport, HealthFacet, TruthfulnessState } from './types.js';

function hasAny(files: LoadedSourceFile[], pattern: RegExp): boolean {
  return files.some((f) => pattern.test(f.path) || pattern.test(f.text));
}

export async function buildHealthDashboardReport(
  userId: string,
  projectId: string,
): Promise<HealthDashboardReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const state: TruthfulnessState = 'HEURISTIC';

  const facets: HealthFacet[] = [
    {
      facet: 'Tests',
      status: hasAny(analyzable, /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)(\.ts)?$/) ? 'PASS' : 'WARN',
      evidence: hasAny(analyzable, /\.(test|spec)\./) ? 'test files present' : 'no test files detected',
      state,
    },
    {
      facet: 'Lint / formatting',
      status: hasAny(analyzable, /\.eslintrc|\.prettierrc|\.stylelintrc|biome\.json|rubocop|flake8|\.golangci/) ? 'PASS' : 'WARN',
      evidence: hasAny(analyzable, /\.eslintrc|\.prettierrc|biome\.json/) ? 'lint config detected' : 'no lint config detected',
      state,
    },
    {
      facet: 'Type/build config',
      status: hasAny(analyzable, /tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|package\.json|pom\.xml|build\.gradle/) ? 'PASS' : 'WARN',
      evidence: hasAny(analyzable, /tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|package\.json/) ? 'build/type config present' : 'no build config detected',
      state,
    },
    {
      facet: 'Dependency manifest',
      status: hasAny(analyzable, /package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json/) ? 'PASS' : 'WARN',
      evidence: hasAny(analyzable, /package\.json|requirements\.txt|go\.mod|Cargo\.toml/) ? 'dependency manifest present' : 'no dependency manifest detected',
      state,
    },
    {
      facet: 'CI workflow',
      status: hasAny(analyzable, /\.github\/workflows|\.gitlab-ci\.yml|circleci|\.buildkite/) ? 'PASS' : 'WARN',
      evidence: hasAny(analyzable, /\.github\/workflows|\.gitlab-ci\.yml/) ? 'CI workflow detected' : 'no CI workflow detected',
      state,
    },
    {
      facet: 'Docs / README',
      status: hasAny(analyzable, /readme\.(md|rst)|\.md$/) ? 'PASS' : 'WARN',
      evidence: hasAny(analyzable, /readme\.md/i) ? 'README present' : 'no README detected',
      state,
    },
  ];

  const weights: Record<string, number> = { PASS: 1, WARN: 0.5, FAIL: 0, 'N/A': 0.5 };
  const totalWeight = facets.length;
  const gained = facets.reduce((s, f) => s + (weights[f.status] ?? 0.5), 0);
  const score = Math.round((gained / totalWeight) * 100);

  const failCount = facets.filter((f) => f.status === 'FAIL').length;
  const warnCount = facets.filter((f) => f.status === 'WARN').length;
  const overallStatus = failCount > 0 ? 'CRITICAL' : warnCount >= 4 ? 'ATTENTION' : 'HEALTHY';

  return {
    id: newId(PREFIX.DEVWORKFLOW_REPORT),
    projectId,
    generatedAt: new Date().toISOString(),
    score,
    overallStatus,
    facets,
    filesScanned: analyzable.length,
    state,
    limitations: [
      'Static inference from source structure only — it does NOT run builds, tests, or lint.',
      `${skipped.length} file(s) skipped by the intake guard.`,
      'Advisory — a PASS here is not proof the workspace actually compiles or passes CI.',
    ],
  };
}