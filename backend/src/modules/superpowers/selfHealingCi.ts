/**
 * CodeConClave — Superpowers: SELF-HEALING CI (Master Feature #8).
 *
 * Before a PR even enters the pipeline the coworker predicts whether CI will
 * fail, using historical failure signatures — and pre-empts it with the likely
 * fix. Prevention beats cure; fewer failed CI runs = faster feedback loops.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface FailureSignature {
  name: string;
  pattern: string;
  count: number;
  fix: string;
}

export interface CisHealScanRow {
  id: string;
  owner_id: string;
  diff: string;
  matched_signature?: string;
  score: number;
  likely_fix?: string;
  action: 'PREEMPTED' | 'CLEAN';
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CisHealScanRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  diff: String(r.diff),
  matched_signature: r.matched_signature ? String(r.matched_signature) : undefined,
  score: Number(r.score),
  likely_fix: r.likely_fix ? String(r.likely_fix) : undefined,
  action: r.action as CisHealScanRow['action'],
  created_at: new Date(r.created_at as string),
});

export function matchFailureSignatures(diff: string, signatures: FailureSignature[]): { name: string; count: number; fix: string } | null {
  const matches = signatures
    .map((s) => ({ name: s.name, count: s.count, fix: s.fix, hits: (diff.match(new RegExp(s.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length }))
    .filter((m) => m.hits > 0);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.count * b.hits - a.count * a.hits || a.name.localeCompare(b.name));
  return { name: matches[0]!.name, count: matches[0]!.count, fix: matches[0]!.fix };
}

export async function scanCiForHealing(
  userId: string,
  input: { diff: string; signatures?: FailureSignature[] },
): Promise<{ scan: CisHealScanRow; preempted: boolean }> {
  if (!input.diff || typeof input.diff !== 'string') throw AppError.badRequest('invalid_diff', 'a diff is required to scan');
  const signatures = Array.isArray(input.signatures) ? input.signatures : [];
  const match = matchFailureSignatures(input.diff, signatures);
  const action: CisHealScanRow['action'] = match ? 'PREEMPTED' : 'CLEAN';
  const id = newId(PREFIX.SELF_HEAL_SCAN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO self_heal_scans (id, owner_id, diff, matched_signature, score, likely_fix, action) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.diff, match?.name ?? null, match ? match.count : 0, match?.fix ?? null, action],
  ));
  if (match) {
    await recordAudit({
      action: AuditAction.CI_HEAL_PREEMPTED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'self_heal_scans',
      resourceId: id,
      detail: { signature: match.name, score: match.count, fix: match.fix },
    });
  }
  return { scan: await getCiHealScan(userId, id), preempted: !!match };
}

export async function getCiHealScan(userId: string, id: string): Promise<CisHealScanRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM self_heal_scans WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('self_heal_scan_not_found', 'no self-heal scan found for that id');
  return rowOf(row);
}

export async function listCiHealScans(userId: string): Promise<CisHealScanRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM self_heal_scans WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function cishealReport(userId: string): Promise<{ scans: number; preempted: number; clean: number }> {
  const rows = await listCiHealScans(userId);
  return {
    scans: rows.length,
    preempted: rows.filter((r) => r.action === 'PREEMPTED').length,
    clean: rows.filter((r) => r.action === 'CLEAN').length,
  };
}