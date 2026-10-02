/**
 * CodeConClave — #29 Workspace Migration Agent (PKG-17).
 * Advisory workspace/codebase migration planning: from a scan of the project's
 * source, classify stack/platform signals and emit a stepwise migration plan
 * (MOVE / RENAME / REWRITE / VERIFY / MANUAL) with per-step risk. Deterministic
 * and advisory — nothing is moved or rewritten automatically.
 */
import { newId } from '../../shared/ids.js';
import { PREFIX } from '../../shared/ids.js';
import type { LoadedSourceFile } from '../quality-intelligence/security.js';
import { listSourceFilesSafe } from './security.js';
import type { MigrationStep, WorkspaceMigrationReport, TruthfulnessState } from './types.js';

const STACK_SIGNALS: Record<string, string[]> = {
  'Node.js': ['node_modules', 'package.json', 'tsconfig.json', '.npmrc'],
  'Python': ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  'Go': ['go.mod', 'main.go'],
  'Java': ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  'Rust': ['Cargo.toml'],
  'Ruby': ['Gemfile', 'Rakefile'],
  'PHP': ['composer.json'],
  'Elixir': ['mix.exs'],
  '.NET': ['.csproj', 'Packages.props'],
};

function detectStack(paths: string[]): string | null {
  let best: string | null = null;
  let bestHits = 0;
  for (const [stack, signals] of Object.entries(STACK_SIGNALS)) {
    let hits = 0;
    for (const s of signals) {
      if (paths.some((p) => p.includes(s))) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = stack;
    }
  }
  return bestHits > 0 ? best : null;
}

function migrationSteps(files: LoadedSourceFile[], fromStack: string | null): MigrationStep[] {
  const steps: MigrationStep[] = [];
  const state: TruthfulnessState = 'HEURISTIC';

  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (fromStack === 'Node.js' && lower.includes('package.json')) {
      steps.push({
        path: f.path,
        action: 'REWRITE',
        reason: 'Rewrite package manifest + lockfile for the target stack/runtime.',
        risk: 'MEDIUM',
        state,
      });
    } else if (fromStack === 'Python' && (lower.includes('requirements.txt') || lower.includes('pyproject.toml'))) {
      steps.push({
        path: f.path,
        action: 'REWRITE',
        reason: 'Translate dependency manifest to the target stack format.',
        risk: 'MEDIUM',
        state,
      });
    } else if (fromStack && lower.endsWith('.env.example')) {
      steps.push({
        path: f.path,
        action: 'VERIFY',
        reason: 'Confirm environment contract maps to the target stack variables.',
        risk: 'LOW',
        state,
      });
    } else if (/(test|spec)\.(ts|tsx|js|jsx|py|go|rs)$/i.test(lower)) {
      steps.push({
        path: f.path,
        action: 'VERIFY',
        reason: 'Migration may change public contracts; re-verify coverage against target stack.',
        risk: 'MEDIUM',
        state,
      });
    }
  }

  if (fromStack) {
    steps.push({
      path: '(workspace root)',
      action: 'MANUAL',
      reason: `Adjust build/CI/CD entrypoints for ${fromStack} → target stack.`,
      risk: 'HIGH',
      state,
    });
  }
  return steps.slice(0, 300);
}

export async function buildMigrationAgentReport(
  userId: string,
  projectId: string,
): Promise<WorkspaceMigrationReport> {
  const { analyzable, skipped } = await listSourceFilesSafe(userId, projectId);
  const fromStack = detectStack(analyzable.map((f) => f.path));
  const steps = migrationSteps(analyzable, fromStack);
  const highRiskCount = steps.filter((s) => s.risk === 'HIGH').length;

  return {
    id: newId(PREFIX.DEVWORKFLOW_MIGRATE),
    projectId,
    generatedAt: new Date().toISOString(),
    fromStack,
    toStack: null,
    filesAnalyzed: analyzable.length,
    steps,
    totalSteps: steps.length,
    highRiskCount,
    state: 'HEURISTIC',
    limitations: [
      'Deterministic static analysis only — no files are moved, renamed, or rewritten.',
      `Stack detection is heuristic; ${skipped.length} file(s) skipped by the intake guard.`,
      'Target-stack mapping is advisory and must be validated on the real destination.',
    ],
  };
}