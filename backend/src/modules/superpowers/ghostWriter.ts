/**
 * CodeConClave — Superpowers: GHOST WRITER (Master Feature #20).
 *
 * Maintains a parallel shadow implementation of any module so whole
 * architectural approaches can be A/B tested. The shadow builds on a branch,
 * benchmarks against real numbers, and ships a side-by-side verdict:
 * latency, throughput, complexity, maintenance burden. Evidence, not opinion.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type GhostWriteStatus = 'DRAFTED' | 'BENCHMARKED' | 'SHIPPED';

export interface GhostWriteRow {
  id: string;
  owner_id: string;
  module: string;
  alternative: string;
  branch: string;
  verdict: string | null;
  latency_before: number | null;
  latency_after: number | null;
  throughput_before: number | null;
  throughput_after: number | null;
  complexity_delta: number;
  maintenance_delta: number;
  status: GhostWriteStatus;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): GhostWriteRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  module: String(r.module),
  alternative: String(r.alternative),
  branch: String(r.branch),
  verdict: r.verdict === null || r.verdict === undefined ? null : String(r.verdict),
  latency_before: r.latency_before === null || r.latency_before === undefined ? null : Number(r.latency_before),
  latency_after: r.latency_after === null || r.latency_after === undefined ? null : Number(r.latency_after),
  throughput_before: r.throughput_before === null || r.throughput_before === undefined ? null : Number(r.throughput_before),
  throughput_after: r.throughput_after === null || r.throughput_after === undefined ? null : Number(r.throughput_after),
  complexity_delta: Number(r.complexity_delta),
  maintenance_delta: Number(r.maintenance_delta),
  status: r.status as GhostWriteStatus,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

/** LOC proxy: text weight drives complexity and maintenance burden deltas. */
export function structuralDeltas(module: string, alternative: string): { complexity_delta: number; maintenance_delta: number } {
  const moduleSize = Math.round(module.length / 40);
  const alternativeSize = Math.round(alternative.length / 40);
  return { complexity_delta: alternativeSize - moduleSize, maintenance_delta: alternativeSize };
}

/** The benchmark's verdict: shadow wins only when it is strictly better on latency and no worse on throughput. */
export function benchmarkVerdict(input: { latencyBefore: number; latencyAfter: number; throughputBefore: number; throughputAfter: number }): string {
  const better = input.latencyAfter < input.latencyBefore && input.throughputAfter >= input.throughputBefore;
  return better
    ? 'shadow wins: latency down and throughput up'
    : 'tradeoff: the shadow changes the profile without winning outright';
}

export async function writeGhost(userId: string, input: { module: string; alternative: string }): Promise<GhostWriteRow> {
  if (!input.module || typeof input.module !== 'string') throw AppError.badRequest('invalid_module', 'a module name is required');
  if (!input.alternative || typeof input.alternative !== 'string') throw AppError.badRequest('invalid_alternative', 'a shadow implementation is required');
  const branch = `shadow/${input.module.toLowerCase().replace(/\s+/g, '-')}`;
  const id = newId(PREFIX.GHOST_WRITE);
  await withTenant(userId, (q) => q.query('INSERT INTO ghost_writes (id, owner_id, module, alternative, branch, complexity_delta, maintenance_delta, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
    id,
    userId,
    input.module,
    input.alternative,
    branch,
    structuralDeltas(input.module, input.alternative).complexity_delta,
    structuralDeltas(input.module, input.alternative).maintenance_delta,
    'DRAFTED',
  ]));
  await recordAudit({
    action: AuditAction.GHOST_WRITTEN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ghost_writes',
    resourceId: id,
    detail: { module: input.module, branch },
  });
  return getGhostWrite(userId, id);
}

export async function benchmarkGhost(
  userId: string,
  id: string,
  input: { latencyBefore: number; latencyAfter: number; throughputBefore: number; throughputAfter: number },
): Promise<GhostWriteRow> {
  const write = await getGhostWrite(userId, id);
  if (write.status !== 'DRAFTED') throw AppError.badRequest('ghost_already_benchmarked', 'this shadow implementation has already been benchmarked');
  if ([input.latencyBefore, input.latencyAfter, input.throughputBefore, input.throughputAfter].some((n) => typeof n !== 'number' || n < 0)) {
    throw AppError.badRequest('invalid_benchmark', 'benchmark numbers must be non-negative');
  }
  const verdict = benchmarkVerdict(input);
  await withTenant(userId, (q) => q.query(
    'UPDATE ghost_writes SET latency_before = $2, latency_after = $3, throughput_before = $4, throughput_after = $5, verdict = $6, status = $7, updated_at = now() WHERE id = $1 AND owner_id = $8',
    [id, input.latencyBefore, input.latencyAfter, input.throughputBefore, input.throughputAfter, verdict, 'BENCHMARKED', userId],
  ));
  await recordAudit({
    action: AuditAction.GHOST_BENCHMARKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ghost_writes',
    resourceId: id,
    detail: { verdict, latencyAfter: input.latencyAfter, throughputAfter: input.throughputAfter },
  });
  return getGhostWrite(userId, id);
}

export async function shipGhost(userId: string, id: string): Promise<GhostWriteRow> {
  const write = await getGhostWrite(userId, id);
  if (write.status === 'DRAFTED') throw AppError.badRequest('ghost_not_benchmarked', 'benchmark the shadow before shipping it');
  if (write.status === 'SHIPPED') throw AppError.badRequest('ghost_already_shipped', 'this shadow implementation is already shipped');
  await withTenant(userId, (q) => q.query('UPDATE ghost_writes SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3', [id, 'SHIPPED', userId]));
  await recordAudit({
    action: AuditAction.GHOST_SHIPPED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'ghost_writes',
    resourceId: id,
    detail: { module: write.module, verdict: write.verdict ?? '' },
  });
  return getGhostWrite(userId, id);
}

export async function getGhostWrite(userId: string, id: string): Promise<GhostWriteRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM ghost_writes WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('ghost_write_not_found', 'no ghost write found for that id');
  return rowOf(row);
}

export async function listGhostWrites(userId: string): Promise<GhostWriteRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM ghost_writes WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function ghostWriterReport(userId: string): Promise<{ writes: number; shipped: number; wins: number }> {
  const writes = await listGhostWrites(userId);
  return {
    writes: writes.length,
    shipped: writes.filter((w) => w.status === 'SHIPPED').length,
    wins: writes.filter((w) => w.verdict?.startsWith('shadow wins')).length,
  };
}