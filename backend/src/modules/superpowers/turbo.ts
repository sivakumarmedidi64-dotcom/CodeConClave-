/**
 * CodeConClave — Superpowers: TURBO (Master Feature #16).
 *
 * Performance problems with PROOF: a finding is only recorded with a
 * before/after benchmark pair measured in the same environment. The actual
 * improvement % is computed and persisted up front, so a fix can never claim
 * "this looks faster" without numbers attached to the exact function/module.
 *
 * Deterministic, owner-scoped, audited, closable. Fully mock-testable.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PerfFindingInput {
  target: string;
  title: string;
  diagnosis?: string;
  benchmarkBefore: number;
  benchmarkAfter: number;
  projectId?: string | null;
}

export interface PerfFindingRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  target: string;
  title: string;
  diagnosis: string | null;
  benchmark_before: number;
  benchmark_after: number;
  improvement_pct: number;
  status: 'OPEN' | 'FIXED';
  created_at: Date;
  updated_at: Date;
}

export function computeImprovementPct(before: number, after: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) throw AppError.badRequest('invalid_benchmark', 'benchmarks must be finite positive numbers');
  return Math.round(((before - after) / before) * 10000) / 100;
}

const rowOf = (r: Record<string, unknown>): PerfFindingRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  target: String(r.target),
  title: String(r.title),
  diagnosis: r.diagnosis ? String(r.diagnosis) : null,
  benchmark_before: Number(r.benchmark_before),
  benchmark_after: Number(r.benchmark_after),
  improvement_pct: Number(r.improvement_pct),
  status: r.status as PerfFindingRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function recordPerformanceFinding(userId: string, input: PerfFindingInput): Promise<PerfFindingRow> {
  const target = String(input.target ?? '').trim();
  const title = String(input.title ?? '').trim();
  if (!target) throw AppError.badRequest('invalid_target', 'target is required');
  if (!title) throw AppError.badRequest('invalid_title', 'title is required');
  const improvement = computeImprovementPct(input.benchmarkBefore, input.benchmarkAfter);
  const id = newId(PREFIX.PERF_FINDING);
  const sql =
    'INSERT INTO performance_findings (id, owner_id, project_id, target, title, diagnosis, benchmark_before, benchmark_after, improvement_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)';
  await withTenant(userId, (q) => q.query(sql, [id, userId, input.projectId ?? null, target, title, input.diagnosis ?? null, input.benchmarkBefore, input.benchmarkAfter, improvement]));
  await recordAudit({
    action: AuditAction.PERF_FINDING_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'performance_findings',
    resourceId: id,
    detail: { target, improvement },
  });
  return findPerfFindingById(userId, id);
}

async function findPerfFindingById(userId: string, id: string): Promise<PerfFindingRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>(
    'SELECT * FROM performance_findings WHERE id = $1 AND owner_id = $2 LIMIT 1',
    [id, userId],
  )).rows[0] ?? null);
  if (!row) throw AppError.notFound('perf_finding_not_found', 'performance finding not found');
  return rowOf(row);
}

export async function listPerformanceFindings(userId: string, filter: { status?: 'OPEN' | 'FIXED' } = {}): Promise<PerfFindingRow[]> {
  const rows = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM performance_findings WHERE owner_id = $1', [userId])).rows);
  const out = rows.map(rowOf).sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
  if (filter.status) return out.filter((r) => r.status === filter.status);
  return out;
}

export async function resolvePerformanceFinding(userId: string, id: string): Promise<PerfFindingRow> {
  const finding = await findPerfFindingById(userId, id);
  if (finding.status !== 'FIXED') {
    await withTenant(userId, (q) => q.query("UPDATE performance_findings SET status = 'FIXED', updated_at = now() WHERE id = $1 AND owner_id = $2", [id, userId]));
  }
  await recordAudit({
    action: AuditAction.PERF_FINDING_FIXED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'performance_findings',
    resourceId: id,
    detail: { improvement_pct: finding.improvement_pct },
  });
  return findPerfFindingById(userId, id);
}