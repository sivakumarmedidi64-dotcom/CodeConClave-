/**
 * Stage 26F — Flaky Test Hunter.
 *
 * Analyzes repeated test-run records and classifies flakiness:
 *   INTERMITTENT — the same test both passes and fails across runs.
 *   TIMING       — all failures, but duration variance indicates timing
 *                  instability (a slow run crossing a threshold).
 *   ENVIRONMENT  — failures correlate with a specific environment label.
 *   CONCURRENCY  — failures correlate with concurrent execution.
 *   UNCLASSIFIED — insufficient or ambiguous evidence (confidence 0).
 *
 * Honesty rules:
 *   - Classification is deterministic and evidence-backed (run records only).
 *   - Confidence reflects the strength of the evidence; UNCLASSIFIED has 0.
 *   - The hunter ONLY creates investigation tasks for the EXISTING test — it
 *     never deletes or skips tests, and its investigation task description
 *     says so explicitly.
 *   - A test with zero failures is not flaky: analysis is refused.
 *
 * Reuses the existing task engine (createTask), audit, notifications.
 */
import { withTenant, pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, NotificationType } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { notify } from '../notifications/service.js';
import { createTask } from '../execution/tasks.js';

export const FLAKE_CLASSIFICATIONS = ['INTERMITTENT', 'TIMING', 'ENVIRONMENT', 'CONCURRENCY', 'UNCLASSIFIED'] as const;
export type FlakeClassification = (typeof FLAKE_CLASSIFICATIONS)[number];
export type FlakeStatus = 'REPORTED' | 'INVESTIGATING' | 'RESOLVED';

export interface TestRunRecord {
  status: 'PASSED' | 'FAILED';
  durationMs: number;
  timestamp: string;
  environment?: string | null;
  concurrent?: boolean;
}

export interface AnalyzeTestRunsInput {
  projectId: string;
  testId: string;
  testName: string;
  runs: TestRunRecord[];
}

export interface FlakeRecordRow {
  id: string;
  owner_id: string;
  project_id: string;
  test_id: string;
  test_name: string;
  runs_seen: number;
  failures_seen: number;
  classification: FlakeClassification;
  pattern: string | null;
  evidence: unknown[];
  confidence: number;
  investigation_task_id: string | null;
  status: FlakeStatus;
  created_at: Date;
  updated_at: Date;
}

function classify(runs: TestRunRecord[]): { classification: FlakeClassification; pattern: string | null; confidence: number } {
  const failures = runs.filter((r) => r.status === 'FAILED');
  const passes = runs.filter((r) => r.status === 'PASSED');
  if (failures.length > 0 && passes.length > 0) {
    return {
      classification: 'INTERMITTENT',
      pattern: `passes ${passes.length}/${runs.length} runs, fails ${failures.length}/${runs.length}`,
      confidence: Math.round((failures.length / runs.length) * 100) / 100,
    };
  }
  if (failures.length === 0) {
    return { classification: 'UNCLASSIFIED', pattern: 'no failures observed', confidence: 0 };
  }
  const envs = new Map<string, number>();
  for (const r of failures) {
    const key = String(r.environment ?? 'default');
    envs.set(key, (envs.get(key) ?? 0) + 1);
  }
  if (envs.size > 1) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [env, count] of envs) {
      if (count > bestCount) { best = env; bestCount = count; }
    }
    return {
      classification: 'ENVIRONMENT',
      pattern: `failures concentrated on environment "${best}" (${bestCount}/${failures.length} failing runs)`,
      confidence: Math.round((bestCount / failures.length) * 100) / 100,
    };
  }
  if (envs.size === 1 && [...envs.keys()][0] !== 'default' && runs.some((r) => r.environment !== [...envs.keys()][0])) {
    return {
      classification: 'ENVIRONMENT',
      pattern: `all failures on environment "${[...envs.keys()][0]}"`,
      confidence: 0.5,
    };
  }
  const concurrentFailures = failures.filter((r) => r.concurrent === true).length;
  const nonConcurrentFailures = failures.length - concurrentFailures;
  if (concurrentFailures > 0 && nonConcurrentFailures === 0 && runs.some((r) => r.concurrent === false)) {
    return {
      classification: 'CONCURRENCY',
      pattern: `all failures occurred under concurrent execution (${concurrentFailures}/${failures.length} runs)`,
      confidence: 0.5,
    };
  }
  const durations = runs.map((r) => r.durationMs).filter((d) => d > 0);
  if (durations.length >= 2) {
    const max = Math.max(...durations);
    const min = Math.min(...durations);
    if (min > 0 && max / min >= 3) {
      return {
        classification: 'TIMING',
        pattern: `duration instability: ${min}ms .. ${max}ms across ${durations.length} runs`,
        confidence: Math.min(1, Math.round((max / min / 10) * 100) / 100),
      };
    }
  }
  return { classification: 'UNCLASSIFIED', pattern: 'all runs failed uniformly; no discriminating evidence', confidence: 0 };
}

export async function getFlake(userId: string, flakeId: string): Promise<FlakeRecordRow> {
  const rows = await withTenant<FlakeRecordRow[]>(userId, async (q) =>
    (await q.query<FlakeRecordRow>('SELECT * FROM flake_records WHERE id = $1 AND owner_id = $2', [flakeId, userId])).rows,
  );
  if (!rows[0]) throw AppError.notFound('Flake record');
  return rows[0];
}

export async function listFlakes(userId: string, projectId?: string): Promise<FlakeRecordRow[]> {
  const where = projectId ? 'owner_id = $1 AND project_id = $2' : 'owner_id = $1';
  const params = projectId ? [userId, projectId] : [userId];
  return withTenant<FlakeRecordRow[]>(userId, async (q) =>
    (await q.query<FlakeRecordRow>(`SELECT * FROM flake_records WHERE ${where} ORDER BY created_at DESC`, params)).rows,
  );
}

/** Analyze repeated run records and record the flake evidence. */
export async function analyzeTestRuns(userId: string, input: AnalyzeTestRunsInput): Promise<FlakeRecordRow> {
  if (!input.projectId || !input.testId || !input.testName || !Array.isArray(input.runs) || input.runs.length < 2) {
    throw AppError.badRequest('flake_invalid_input', 'projectId, testId, testName and at least 2 runs are required');
  }
  const failures = input.runs.filter((r) => r.status === 'FAILED').length;
  if (failures === 0) {
    throw AppError.conflict('flake_no_failures', 'A test with zero failures is not flaky');
  }
  const { classification, pattern, confidence } = classify(input.runs);
  const id = newId(PREFIX.FLAKE_RECORD);
  await withTenant(userId, (q) => q.query(
    `INSERT INTO flake_records
       (id, owner_id, project_id, test_id, test_name, runs_seen, failures_seen,
        classification, pattern, evidence, confidence, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'REPORTED')`,
    [
      id, userId, input.projectId, input.testId, input.testName,
      input.runs.length, failures, classification, pattern,
      JSON.stringify(input.runs.slice(0, 50)), confidence,
    ],
  ));
  await recordAudit({
    action: AuditAction.FLAKE_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'flake_record',
    resourceId: id,
    detail: { testId: input.testId, classification, failures, runs: input.runs.length },
  });
  return getFlake(userId, id);
}

/**
 * Create an investigation task for the flaky test. The task is explicitly
 * told to investigate and fix the root cause — never to delete or skip the
 * test.
 */
export async function createInvestigationTask(userId: string, flakeId: string): Promise<FlakeRecordRow> {
  const flake = await getFlake(userId, flakeId);
  if (flake.investigation_task_id) {
    throw AppError.conflict('flake_already_investigating', 'An investigation task already exists');
  }
  const task = await createTask({
    userId,
    projectId: flake.project_id,
    title: `Investigate flaky test: ${flake.test_name}`,
    description:
      `Investigate the root cause of flaky test "${flake.test_name}" (${flake.test_id}) — ` +
      `classification ${flake.classification}, ${flake.failures_seen}/${flake.runs_seen} runs failing. ` +
      `Investigate and fix the root cause. Do NOT delete or skip the test.`,
    riskLevel: 'LOW',
  });
  await withTenant(userId, (q) => q.query(
    `UPDATE flake_records SET investigation_task_id = $1, status = 'INVESTIGATING', updated_at = now() WHERE id = $2 AND owner_id = $3`,
    [task.id, flakeId, userId],
  ));
  await recordAudit({
    action: AuditAction.FLAKE_INVESTIGATION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'flake_record',
    resourceId: flakeId,
    detail: { testId: flake.test_id, taskId: task.id },
  });
  await notify(
    userId,
    NotificationType.FLAKE_INVESTIGATION_CREATED,
    'Flake investigation started',
    {
      body: `Investigation task created for flaky test "${flake.test_name}"`,
      resourceType: 'flake_record',
      resourceId: flakeId,
      metadata: { testId: flake.test_id, taskId: task.id },
    },
  );
  return getFlake(userId, flakeId);
}

/** Mark a flake resolved after investigation. */
export async function markFlakeResolved(userId: string, flakeId: string): Promise<FlakeRecordRow> {
  const flake = await getFlake(userId, flakeId);
  if (flake.status === 'RESOLVED') throw AppError.conflict('flake_already_resolved', 'Flake is already resolved');
  await withTenant(userId, (q) => q.query(
    `UPDATE flake_records SET status = 'RESOLVED', updated_at = now() WHERE id = $1 AND owner_id = $2`,
    [flakeId, userId],
  ));
  await recordAudit({
    action: AuditAction.FLAKE_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'flake_record',
    resourceId: flakeId,
    detail: { testId: flake.test_id },
  });
  return getFlake(userId, flakeId);
}