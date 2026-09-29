/**
 * CodeConClave — Superpowers: TIME TRAVELER (Master Feature #21).
 *
 * Reconstructs the full historical context of any point in time — code state,
 * tests, dependencies, the reasoning that was in the air — and diffs it
 * against today to show exactly what changed and why.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface TimeTravelSnapshotRow {
  id: string;
  owner_id: string;
  ref: string;
  file: string;
  code: string;
  tests: string[];
  dependencies: string[];
  reasoning: string;
  diff: { added: number; removed: number };
  summary: string;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): TimeTravelSnapshotRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  ref: String(r.ref),
  file: String(r.file),
  code: String(r.code),
  tests: (r.tests ?? []) as string[],
  dependencies: (r.dependencies ?? []) as string[],
  reasoning: String(r.reasoning),
  diff: (r.diff ?? { added: 0, removed: 0 }) as { added: number; removed: number },
  summary: String(r.summary),
  created_at: new Date(r.created_at as string),
});

/** Line-level drift between two snapshots, computed on unique lines. */
export function computeHistoryDiff(current: string, past: string): { added: number; removed: number } {
  const currentLines = new Set(current.split('\n').filter((l) => l.trim().length > 0));
  const pastLines = new Set(past.split('\n').filter((l) => l.trim().length > 0));
  const added = [...currentLines].filter((l) => !pastLines.has(l)).length;
  const removed = [...pastLines].filter((l) => !currentLines.has(l)).length;
  return { added, removed };
}

export async function reconstructHistory(
  userId: string,
  input: { ref: string; file: string; code: string; currentCode: string; tests?: string[]; dependencies?: string[]; reasoning?: string },
): Promise<TimeTravelSnapshotRow> {
  if (!input.ref || typeof input.ref !== 'string') throw AppError.badRequest('invalid_ref', 'a point in time is required');
  if (!input.file || typeof input.file !== 'string') throw AppError.badRequest('invalid_file', 'a file path is required');
  if (!input.code || typeof input.code !== 'string') throw AppError.badRequest('invalid_code', 'the historical code state is required');

  const diff = computeHistoryDiff(input.currentCode ?? '', input.code);
  const summary = `at ${input.ref}, ${input.file} drifts by ${diff.added + diff.removed} changed lines (${diff.added} added / ${diff.removed} removed) against today`;
  const id = newId(PREFIX.TIME_TRAVEL_SNAPSHOT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO time_travel_snapshots (id, owner_id, ref, file, code, tests, dependencies, reasoning, diff, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, userId, input.ref, input.file, input.code, input.tests ?? [], input.dependencies ?? [], input.reasoning ?? '', diff, summary],
  ));
  await recordAudit({
    action: AuditAction.TIME_TRAVEL_RECONSTRUCTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'time_travel_snapshots',
    resourceId: id,
    detail: { ref: input.ref, file: input.file, diff },
  });
  return getSnapshot(userId, id);
}

export async function getSnapshot(userId: string, id: string): Promise<TimeTravelSnapshotRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM time_travel_snapshots WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('time_travel_snapshot_not_found', 'no time travel snapshot found for that id');
  return rowOf(row);
}

export async function listSnapshots(userId: string): Promise<TimeTravelSnapshotRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM time_travel_snapshots WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function timeTravelReport(userId: string): Promise<{ snapshots: number; total_drift: number; avg_drift: number }> {
  const snapshots = await listSnapshots(userId);
  const total = snapshots.reduce((s, x) => s + x.diff.added + x.diff.removed, 0);
  return {
    snapshots: snapshots.length,
    total_drift: total,
    avg_drift: snapshots.length ? Math.round(total / snapshots.length) : 0,
  };
}