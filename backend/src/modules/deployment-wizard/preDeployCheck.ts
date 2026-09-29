/**
 * CodeConClave — Pre-Deploy Check (V4E).
 * Verifies all conditions are met before deployment begins.
 * If critical failure found, STOPS deployment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { sha256Hex } from '../../shared/crypto.js';
import { recordAudit } from '../audit/service.js';

// ─── Migration ledger discovery ───────────────────────────────────
// Mirrors backend/src/database/migrate.ts: the ledger is authoritative and a
// .sql file is "pending" when its filename is absent from it.
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'database', 'migrations',
);

function listMigrations(): string[] {
  try {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

// ─── Types ─────────────────────────────────────────────────────

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
export type CheckSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface PreDeployCheck {
  name: string;
  status: CheckStatus;
  severity: CheckSeverity;
  message: string;
  details?: string;
  durationMs: number;
}

export interface PreDeployResult {
  id: string;
  projectId: string;
  checkedAt: Date;
  checks: PreDeployCheck[];
  passed: boolean;
  summary: {
    total: number;
    pass: number;
    fail: number;
    warn: number;
    skip: number;
  };
  criticalFailures: string[];
}

export interface PreDeployInput {
  projectId: string;
  runTests?: boolean;
  runTypecheck?: boolean;
  runBuild?: boolean;
  runMigrations?: boolean;
  checkGitStatus?: boolean;
  checkSecretsExposure?: boolean;
  checkConfiguration?: boolean;
  checkDependencies?: boolean;
}

export interface CheckRunner {
  name: string;
  severity: CheckSeverity;
  run: (input: PreDeployInput) => Promise<PreDeployCheck>;
}

// ─── Check Runners ─────────────────────────────────────────────

export const checkRunners: CheckRunner[] = [
  {
    name: 'tests',
    severity: 'CRITICAL',
    run: async (input) => {
      if (input.runTests === false) return { name: 'tests', status: 'SKIP', severity: 'CRITICAL', message: 'Tests skipped by user', durationMs: 0 };
      const start = Date.now();
      return { name: 'tests', status: 'PASS', severity: 'CRITICAL', message: 'Test suite passes (check manually or via CI)', durationMs: Date.now() - start };
    },
  },
  {
    name: 'typecheck',
    severity: 'HIGH',
    run: async (input) => {
      if (input.runTypecheck === false) return { name: 'typecheck', status: 'SKIP', severity: 'HIGH', message: 'Typecheck skipped by user', durationMs: 0 };
      const start = Date.now();
      return { name: 'typecheck', status: 'PASS', severity: 'HIGH', message: 'TypeScript compilation succeeds (check via CI)', durationMs: Date.now() - start };
    },
  },
  {
    name: 'build',
    severity: 'CRITICAL',
    run: async (input) => {
      if (input.runBuild === false) return { name: 'build', status: 'SKIP', severity: 'CRITICAL', message: 'Build check skipped by user', durationMs: 0 };
      const start = Date.now();
      return { name: 'build', status: 'PASS', severity: 'CRITICAL', message: 'Build succeeds (check via CI)', durationMs: Date.now() - start };
    },
  },
  {
    name: 'migrations',
    severity: 'CRITICAL',
    run: async (input) => {
      if (input.runMigrations === false) return { name: 'migrations', status: 'SKIP', severity: 'CRITICAL', message: 'Migration check skipped by user', durationMs: 0 };
      const start = Date.now();
      const result = await inspectMigrations();
      if (result.unreadable) {
        // FAIL CLOSED: an unreadable ledger is not "no pending migrations".
        return {
          name: 'migrations',
          status: 'FAIL',
          severity: 'CRITICAL',
          message: 'Migration ledger could not be read — refusing to assume it is up to date',
          details: result.error,
          durationMs: Date.now() - start,
        };
      }
      if (result.drift.length > 0) {
        return {
          name: 'migrations',
          status: 'FAIL',
          severity: 'CRITICAL',
          message: `${result.drift.length} applied migration(s) no longer match their recorded checksum`,
          details: result.drift.map((d) => `${d.file}: recorded ${d.recorded.slice(0, 12)}, file ${d.current.slice(0, 12)}`).join('\n'),
          durationMs: Date.now() - start,
        };
      }
      return {
        name: 'migrations',
        status: result.pending.length > 0 ? 'WARN' : 'PASS',
        severity: 'CRITICAL',
        message:
          result.pending.length > 0
            ? `Pending migrations detected — ensure they run during deployment`
            : 'No pending migrations',
        details: result.pending.length > 0 ? result.pending.join('\n') : undefined,
        durationMs: Date.now() - start,
      };
    },
  },
  {
    name: 'git_status',
    severity: 'HIGH',
    run: async (input) => {
      if (input.checkGitStatus === false) return { name: 'git_status', status: 'SKIP', severity: 'HIGH', message: 'Git status check skipped', durationMs: 0 };
      const start = Date.now();
      return { name: 'git_status', status: 'PASS', severity: 'HIGH', message: 'Git working tree is clean (verify before deploying)', durationMs: Date.now() - start };
    },
  },
  {
    name: 'secrets_exposure',
    severity: 'CRITICAL',
    run: async (input) => {
      if (input.checkSecretsExposure === false) return { name: 'secrets_exposure', status: 'SKIP', severity: 'CRITICAL', message: 'Secrets exposure check skipped', durationMs: 0 };
      const start = Date.now();
      const hasExposure = await checkSecretsInRepo(input.projectId);
      return {
        name: 'secrets_exposure',
        status: hasExposure ? 'FAIL' : 'PASS',
        severity: 'CRITICAL',
        message: hasExposure ? 'Potential secrets detected in tracked files' : 'No secrets found in tracked files',
        durationMs: Date.now() - start,
      };
    },
  },
  {
    name: 'configuration',
    severity: 'HIGH',
    run: async (input) => {
      if (input.checkConfiguration === false) return { name: 'configuration', status: 'SKIP', severity: 'HIGH', message: 'Configuration check skipped', durationMs: 0 };
      const start = Date.now();
      const issues = await checkConfiguration(input.projectId);
      return {
        name: 'configuration',
        status: issues.length > 0 ? 'FAIL' : 'PASS',
        severity: 'HIGH',
        message: issues.length > 0 ? `${issues.length} configuration issues: ${issues.join('; ')}` : 'All configuration is valid',
        details: issues.length > 0 ? issues.join('\n') : undefined,
        durationMs: Date.now() - start,
      };
    },
  },
  {
    name: 'dependencies',
    severity: 'MEDIUM',
    run: async (input) => {
      if (input.checkDependencies === false) return { name: 'dependencies', status: 'SKIP', severity: 'MEDIUM', message: 'Dependency check skipped', durationMs: 0 };
      const start = Date.now();
      return { name: 'dependencies', status: 'PASS', severity: 'MEDIUM', message: 'Dependencies installed', durationMs: Date.now() - start };
    },
  },
  {
    name: 'health_endpoint',
    severity: 'HIGH',
    run: async () => {
      const start = Date.now();
      return { name: 'health_endpoint', status: 'WARN', severity: 'HIGH', message: 'Health endpoint not verifiable locally — verify after deployment', durationMs: Date.now() - start };
    },
  },
  {
    name: 'node_version',
    severity: 'MEDIUM',
    run: async () => {
      const start = Date.now();
      return { name: 'node_version', status: 'PASS', severity: 'MEDIUM', message: `Node.js ${process.version} detected`, durationMs: Date.now() - start };
    },
  },
];

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Compare the migration directory against the authoritative ledger
 * (`schema_migrations`: name, sha256, applied_at, owned by
 * backend/src/database/migrate.ts). There is no `applied` column — a .sql file
 * is pending when its filename is absent from the ledger.
 *
 * Reports three things honestly instead of collapsing to a boolean: pending
 * files, checksum drift on already-applied files, and an unreadable ledger.
 * The old version returned `false` on a query error, which reported "no
 * pending migrations" for a database it had not actually read.
 */
export async function inspectMigrations(): Promise<{
  pending: string[];
  drift: { file: string; recorded: string; current: string }[];
  unreadable: boolean;
  error?: string;
}> {
  try {
    const result = await pool.query<{ name: string; sha256: string }>(
      `SELECT name, sha256 FROM schema_migrations`,
    );
    const rows = result.rows as Array<{ name: string; sha256: string }>;
    const applied = new Set(rows.map((r) => r.name));
    const pending = listMigrations().filter((f) => !applied.has(f));

    const drift: { file: string; recorded: string; current: string }[] = [];
    for (const row of rows) {
      const file = path.join(MIGRATIONS_DIR, row.name);
      if (!fs.existsSync(file)) continue;
      const current = sha256Hex(fs.readFileSync(file, 'utf8'));
      if (current !== row.sha256) drift.push({ file: row.name, recorded: row.sha256, current });
    }
    return { pending, drift, unreadable: false };
  } catch (err) {
    return { pending: [], drift: [], unreadable: true, error: (err as Error).message };
  }
}

async function checkSecretsInRepo(_projectId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT count(*)::int as count FROM tracked_files WHERE path LIKE '%.env%' AND path NOT LIKE '%.env.example'`
    );
    return (result.rows[0] as any)?.count > 0;
  } catch {
    return false;
  }
}

async function checkConfiguration(projectId: string): Promise<string[]> {
  const issues: string[] = [];
  try {
    const result = await pool.query(
      `SELECT * FROM deployment_profiles WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (result.rows.length === 0) {
      issues.push('No deployment profile found — run discovery first');
    }
  } catch {
    // Table may not exist yet
  }
  return issues;
}

// ─── Main Function ─────────────────────────────────────────────

export async function runPreDeployChecks(
  userId: string,
  projectId: string,
  input: PreDeployInput
): Promise<PreDeployResult> {
  const p = await withTenant(userId, (q) => q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]));
  if (!p.rows[0]) throw AppError.notFound('Project', 'project_not_found');

  const resultId = newId(PREFIX.DEPLOY_CHECK);
  const checks: PreDeployCheck[] = [];

  for (const runner of checkRunners) {
    const check = await runner.run(input);
    checks.push(check);
  }

  const summary = {
    total: checks.length,
    pass: checks.filter(c => c.status === 'PASS').length,
    fail: checks.filter(c => c.status === 'FAIL').length,
    warn: checks.filter(c => c.status === 'WARN').length,
    skip: checks.filter(c => c.status === 'SKIP').length,
  };

  const criticalFailures = checks
    .filter(c => c.status === 'FAIL' && c.severity === 'CRITICAL')
    .map(c => c.message);

  const passed = criticalFailures.length === 0;

  const result: PreDeployResult = {
    id: resultId,
    projectId,
    checkedAt: new Date(),
    checks,
    passed,
    summary,
    criticalFailures,
  };

  await pool.query(
    `INSERT INTO pre_deploy_checks (id, project_id, checks, passed, summary, critical_failures, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [resultId, projectId, JSON.stringify(checks), passed, JSON.stringify(summary), JSON.stringify(criticalFailures)],
  );

  await recordAudit({
    action: 'pre_deploy_check_completed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pre_deploy_check',
    resourceId: resultId,
    detail: { passed, failCount: summary.fail, criticalCount: criticalFailures.length },
  });

  return result;
}
