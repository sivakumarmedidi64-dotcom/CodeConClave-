/**
 * CodeConClave — Superpowers: EQUITY METRICS (Master Feature #147).
 *
 * Tracks contribution equity across the whole spectrum of work — commits,
 * reviews, tests, ops, mentoring, docs. The often-invisible work becomes
 * visible in compensation and recognition.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface EquityInput {
  name: string;
  commits: number;
  reviewed: number;
  tests_written: number;
  ops_hours: number;
  docs_written: number;
  mentoring: number;
}

export type EquityTier = 'UNSEEN_WORK_HIGH' | 'UNSEEN_WORK_MEDIUM' | 'CODE_FACING';

export interface EquityScoreRow {
  id: string;
  owner_id: string;
  period: string;
  name: string;
  visible: number;
  invisible: number;
  invisible_share: number;
  tier: EquityTier;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): EquityScoreRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  period: String(r.period),
  name: String(r.name),
  visible: Number(r.visible),
  invisible: Number(r.invisible),
  invisible_share: Number(r.invisible_share),
  tier: r.tier as EquityTier,
  created_at: new Date(r.created_at as string),
});

export function computeEquityOutcome(p: EquityInput): { visible: number; invisible: number; invisible_share: number; tier: EquityTier } {
  const visible = Math.round((p.commits ?? 0) + (p.reviewed ?? 0) * 0.5);
  const invisible = Math.round(
    (p.reviewed ?? 0) * 2 + (p.tests_written ?? 0) * 3 + (p.ops_hours ?? 0) + (p.docs_written ?? 0) * 2 + (p.mentoring ?? 0) * 4,
  );
  const total = visible + invisible;
  const invisibleShare = total === 0 ? 0 : Math.round((invisible / total) * 100) / 100;
  const tier: EquityTier = invisibleShare >= 0.5 ? 'UNSEEN_WORK_HIGH' : invisibleShare >= 0.25 ? 'UNSEEN_WORK_MEDIUM' : 'CODE_FACING';
  return { visible, invisible, invisible_share: invisibleShare, tier };
}

export async function computeEquity(
  userId: string,
  input: { period: string; people: EquityInput[] },
): Promise<{ period: string; people: number; scores: EquityScoreRow[] }> {
  if (!input.period || typeof input.period !== 'string') throw AppError.badRequest('invalid_period', 'a period is required');
  const people = Array.isArray(input.people) ? input.people : [];
  if (people.length === 0) throw AppError.badRequest('empty_people', 'at least one person is required');
  const scores: EquityScoreRow[] = [];
  const seen = new Set<string>();
  for (const p of people) {
    if (!p.name || typeof p.name !== 'string') throw AppError.badRequest('invalid_name', 'each person needs a name');
    if (seen.has(p.name)) throw AppError.badRequest('duplicate_person', `person "${p.name}" listed twice`);
    seen.add(p.name);
    const outcome = computeEquityOutcome(p);
    const id = newId(PREFIX.EQUITY_SCORE);
    await withTenant(userId, (q) => q.query(
      'INSERT INTO equity_scores (id, owner_id, period, name, visible, invisible, invisible_share, tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, userId, input.period, p.name, outcome.visible, outcome.invisible, outcome.invisible_share, outcome.tier],
    ));
    scores.push(await getEquityScore(userId, id));
  }
  await recordAudit({
    action: AuditAction.EQUITY_METRICS_COMPUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'equity_scores',
    resourceId: null,
    detail: { period: input.period, people: people.length },
  });
  return { period: input.period, people: people.length, scores };
}

export async function getEquityScore(userId: string, id: string): Promise<EquityScoreRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM equity_scores WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('equity_score_not_found', 'no equity score found for that id');
  return rowOf(row);
}

export async function listEquityScores(userId: string, filter: { period?: string } = {}): Promise<EquityScoreRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM equity_scores WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.period) rows = rows.filter((r) => r.period === filter.period);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function equityReport(userId: string): Promise<{
  total: number;
  unseen_high: number;
  avg_invisible_share: number;
}> {
  const rows = await listEquityScores(userId);
  const unseenHigh = rows.filter((r) => r.tier === 'UNSEEN_WORK_HIGH').length;
  const avg = rows.length === 0 ? 0 : Math.round((rows.reduce((acc, r) => acc + r.invisible_share, 0) / rows.length) * 100) / 100;
  return { total: rows.length, unseen_high: unseenHigh, avg_invisible_share: avg };
}