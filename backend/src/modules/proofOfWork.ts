/**
 * Stage 26G — proof-of-work reports.
 *
 * A report is assembled ONLY from real persisted state: the task row, its
 * plan and plan entries, artifacts, approvals, AI usage ledger
 * (model_usage_logs), and the live preview session for the project. Nothing
 * is fabricated; missing sources are omitted honestly. One report per task
 * (upserted on regeneration).
 */
import { withTenant } from '../shared/db.js';
import { newId, PREFIX } from '../shared/ids.js';
import { AppError } from '../shared/errors.js';
import { AuditAction } from '@codeconclave/shared';
import { recordAudit } from './audit/service.js';

export interface ProofOfWorkReport {
  taskId: string;
  projectId: string;
  request: { title: string; description: string | null };
  plan: { status: string; entries: Array<{ order: number; title: string; status: string }> } | null;
  files: Array<{ path: string; sizeBytes: number }>;
  tests: Array<{ step: string; output: string | null }>;
  evidence: {
    attempts: number;
    errors: Array<{ error_code: string | null; error_detail: string | null }>;
    artifacts: Array<{ kind: string; title: string }>;
  };
  preview: { state: string; version: number } | null;
  approvals: Array<{ status: string; risk_level: string; decision: string | null }>;
  time: { created_at: string; completed_at: string | null; durationMs: number | null };
  ai: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  cost: { totalUsd: number; aiUsd: number };
  generatedAt: string;
}

export interface ProofOfWorkRow {
  id: string;
  owner_id: string;
  task_id: string;
  project_id: string;
  report: ProofOfWorkReport;
  created_at: Date;
  updated_at: Date;
}

export async function getProofOfWork(userId: string, taskId: string): Promise<ProofOfWorkRow> {
  const rows = await withTenant<ProofOfWorkRow[]>(userId, (db) =>
    db
      .query<ProofOfWorkRow>('SELECT * FROM proof_of_work_reports WHERE owner_id = $1 AND task_id = $2', [userId, taskId])
      .then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Proof-of-work report');
  return rows[0];
}

/** Build a report from real persisted state. Returns null only when the task
 * does not exist or is not owned by the caller. */
export async function generateProofOfWork(userId: string, taskId: string): Promise<ProofOfWorkRow> {
  const task = await withTenant<{
    id: string; project_id: string; owner_id: string; title: string; description: string | null;
    status: string; created_at: string; completed_at: string | null; attempt_count: number;
  } | null>(userId, (db) =>
    db
      .query<{
        id: string; project_id: string; owner_id: string; title: string; description: string | null;
        status: string; created_at: string; completed_at: string | null; attempt_count: number;
      }>('SELECT * FROM tasks WHERE id = $1 AND owner_id = $2', [taskId, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!task) throw AppError.notFound('Task');

  const {
    plan,
    planEntries,
    files,
    tests,
    attempts,
    artifacts,
    preview,
    approvals,
    usage,
  } = await withTenant<{
    plan: { id: string; status: string } | null;
    planEntries: Array<{ order: number; title: string; status: string }>;
    files: Array<{ path: string; size_bytes: number }>;
    tests: Array<{ step: string; output: string | null }>;
    attempts: Array<{ error_code: string | null; error_detail: string | null }>;
    artifacts: Array<{ kind: string; title: string }>;
    preview: { state: string; version: number } | null;
    approvals: Array<{ status: string; risk_level: string; decision: string | null }>;
    usage: Array<{ input_tokens: number; output_tokens: number; estimated_cost_usd: number }>;
  }>(userId, async (db) => {
    const [planRes, filesRes, testsRes, attemptsRes, artifactsRes, previewRes, approvalsRes, usageRes] = await Promise.all([
      db.query<{ id: string; status: string }>(
        'SELECT * FROM plans WHERE id = (SELECT plan_id FROM tasks WHERE id = $1)',
        [taskId],
      ).catch(() => ({ rows: [] as Array<{ id: string; status: string }> })),
      db.query<{ path: string; size_bytes: number }>(
        'SELECT path, size_bytes FROM files WHERE project_id = $1 AND owner_id = $2 AND deleted_at IS NULL ORDER BY path LIMIT 50',
        [task.project_id, userId],
      ),
      db.query<{ step: string; output: string | null }>(
        'SELECT step, output FROM task_steps WHERE task_id = $1 AND output IS NOT NULL ORDER BY created_at',
        [taskId],
      ),
      db.query<{ error_code: string | null; error_detail: string | null }>(
        'SELECT error_code, error_detail FROM task_attempts WHERE task_id = $1 ORDER BY created_at',
        [taskId],
      ),
      db.query<{ kind: string; title: string }>(
        'SELECT kind, title FROM artifacts WHERE task_id = $1 ORDER BY created_at LIMIT 50',
        [taskId],
      ),
      db.query<{ state: string; version: number }>('SELECT state, version FROM preview_sessions WHERE project_id = $1', [task.project_id]),
      db.query<{ status: string; risk_level: string; decision: string | null }>(
        'SELECT status, risk_level, decision FROM approvals WHERE task_id = $1',
        [taskId],
      ),
      db.query<{ input_tokens: number; output_tokens: number; estimated_cost_usd: number }>(
        'SELECT input_tokens, output_tokens, estimated_cost_usd FROM model_usage_logs WHERE task_id = $1',
        [taskId],
      ),
    ]);
    const plan = planRes.rows[0] ?? null;
    const planEntries = plan
      ? (await db.query<{ order: number; title: string; status: string }>(
          'SELECT * FROM plan_entries WHERE plan_id = $1 ORDER BY position ASC',
          [plan.id],
        )).rows
      : [];
    return {
      plan,
      planEntries,
      files: filesRes.rows,
      tests: testsRes.rows,
      attempts: attemptsRes.rows,
      artifacts: artifactsRes.rows,
      preview: previewRes.rows[0] ?? null,
      approvals: approvalsRes.rows,
      usage: usageRes.rows,
    };
  });
  const ai = {
    calls: usage.length,
    inputTokens: usage.reduce((s, u) => s + (Number(u.input_tokens) || 0), 0),
    outputTokens: usage.reduce((s, u) => s + (Number(u.output_tokens) || 0), 0),
    costUsd: Math.round(usage.reduce((s, u) => s + (Number(u.estimated_cost_usd) || 0), 0) * 1e6) / 1e6,
  };

  const completedAt = task.completed_at;
  const durationMs =
    task.completed_at && task.created_at
      ? new Date(task.completed_at).getTime() - new Date(task.created_at).getTime()
      : null;

  const report: ProofOfWorkReport = {
    taskId: task.id,
    projectId: task.project_id,
    request: { title: task.title, description: task.description },
    plan: plan ? { status: plan.status, entries: planEntries.map((e, i) => ({ order: i + 1, title: e.title, status: e.status })) } : null,
    files: files.map((f) => ({ path: f.path, sizeBytes: Number(f.size_bytes) })),
    tests: tests.map((t) => ({ step: t.step, output: t.output })),
    evidence: {
      attempts: Number(task.attempt_count) || 0,
      errors: attempts.map((a) => ({ error_code: a.error_code, error_detail: a.error_detail })),
      artifacts: artifacts.map((a) => ({ kind: a.kind, title: a.title })),
    },
    preview: preview ? { state: preview.state, version: preview.version } : null,
    approvals: approvals.map((a) => ({ status: a.status, risk_level: a.risk_level, decision: a.decision })),
    time: {
      created_at: task.created_at,
      completed_at: completedAt,
      durationMs,
    },
    ai,
    cost: { totalUsd: ai.costUsd, aiUsd: ai.costUsd },
    generatedAt: new Date().toISOString(),
  };

  const id = newId(PREFIX.PROOF_OF_WORK);
  await dbUpsertProofOfWork(userId, taskId, task.project_id, id, report);
  await recordAudit({
    action: AuditAction.PROOF_OF_WORK_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'proof_of_work',
    resourceId: taskId,
    detail: { projectId: task.project_id, taskId, aiCostUsd: ai.costUsd, aiCalls: ai.calls },
  });
  return getProofOfWork(userId, taskId);
}

async function dbUpsertProofOfWork(
  userId: string,
  taskId: string,
  projectId: string,
  id: string,
  report: ProofOfWorkReport,
): Promise<void> {
  await withTenant(userId, (db) =>
    db.query(
      `INSERT INTO proof_of_work_reports (id, owner_id, task_id, project_id, report)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (owner_id, task_id)
       DO UPDATE SET report = EXCLUDED.report, updated_at = now()`,
      [id, userId, taskId, projectId, JSON.stringify(report)],
    ),
  );
}