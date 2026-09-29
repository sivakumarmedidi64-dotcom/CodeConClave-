/**
 * CodeConClave — Superpowers: BUDGET TRANSPARENCY (Master Feature #144).
 *
 * Every team's compute/infrastructure spend visible and attributed to tasks —
 * accountability and incentive alignment, so cost becomes part of
 * decision-making instead of a surprise at invoice time.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CostEntryInput {
  task: string;
  resource: string;
  cost_usd: number;
}

export interface CostAttributionRow {
  id: string;
  owner_id: string;
  team: string;
  period: string;
  task: string;
  resource: string;
  cost_usd: number;
  share: number;
  created_at: Date;
}

const rowOf = (r: Record<string, unknown>): CostAttributionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  team: String(r.team),
  period: String(r.period),
  task: String(r.task),
  resource: String(r.resource),
  cost_usd: Number(r.cost_usd),
  share: Number(r.share),
  created_at: new Date(r.created_at as string),
});

export async function attributeCosts(
  userId: string,
  input: { team: string; period: string; entries: CostEntryInput[] },
): Promise<{ team: string; period: string; entries: number; total_usd: number; results: CostAttributionRow[] }> {
  if (!input.team || typeof input.team !== 'string') throw AppError.badRequest('invalid_team', 'a team is required');
  if (!input.period || typeof input.period !== 'string') throw AppError.badRequest('invalid_period', 'a period is required');
  const entries = Array.isArray(input.entries) ? input.entries : [];
  if (entries.length === 0) throw AppError.badRequest('empty_entries', 'at least one cost entry is required');
  const total = entries.reduce((acc, e) => acc + Number(e.cost_usd), 0);
  for (const e of entries) {
    if (!e.task || typeof e.task !== 'string') throw AppError.badRequest('invalid_task', 'each cost entry needs a task');
    if (!e.resource || typeof e.resource !== 'string') throw AppError.badRequest('invalid_resource', `each cost entry for ${e.task} needs a resource`);
    if (!Number.isFinite(Number(e.cost_usd)) || Number(e.cost_usd) < 0) throw AppError.badRequest('invalid_cost', `cost for ${e.task} must be a non-negative number`);
  }
  const results: CostAttributionRow[] = [];
  const byResource: Record<string, number> = {};
  for (const e of entries) {
    const cost = Number(e.cost_usd);
    const share = total > 0 ? Math.round((cost / total) * 10000) / 100 : 0;
    byResource[e.resource] = (byResource[e.resource] ?? 0) + cost;
    const id = newId(PREFIX.TEAM_COST_ATTRIBUTION);
    await withTenant(userId, (q) => q.query(
      'INSERT INTO team_cost_attributions (id, owner_id, team, period, task, resource, cost_usd, share) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, userId, input.team, input.period, e.task, e.resource, cost, share],
    ));
    results.push(await getCostAttribution(userId, id));
  }
  await recordAudit({
    action: AuditAction.COST_ATTRIBUTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'team_cost_attributions',
    resourceId: null,
    detail: { team: input.team, period: input.period, entries: entries.length, total_usd: total, by_resource: byResource },
  });
  return { team: input.team, period: input.period, entries: entries.length, total_usd: total, results };
}

export async function getCostAttribution(userId: string, id: string): Promise<CostAttributionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM team_cost_attributions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('cost_attribution_not_found', 'no cost attribution found for that id');
  return rowOf(row);
}

export async function listCostAttributions(userId: string, filter: { team?: string } = {}): Promise<CostAttributionRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM team_cost_attributions WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.team) rows = rows.filter((r) => r.team === filter.team);
  return rows.sort((a, b) => a.team.localeCompare(b.team) || a.task.localeCompare(b.task));
}

export async function costReport(userId: string): Promise<{
  teams: number;
  total_usd: number;
  by_team: Record<string, number>;
}> {
  const rows = await listCostAttributions(userId);
  const by_team: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    by_team[r.team] = (by_team[r.team] ?? 0) + r.cost_usd;
    total += r.cost_usd;
  }
  return { teams: Object.keys(by_team).length, total_usd: total, by_team };
}