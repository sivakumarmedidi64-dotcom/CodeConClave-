/**
 * CodeConClave — Superpowers: REGRESSION TIME MACHINE (Master Feature #54).
 *
 * "Show me every regression this module ever caused, with the fix that worked."
 * Debugging becomes archaeology; archaeology becomes instant — a timeline of
 * what changed, what broke, and which fix actually worked.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface RegressionEvent {
  ref: string;
  changed: string;
  broke: string;
  fix: string;
  worked: boolean;
}

export interface RegressionTimelineRow {
  id: string;
  owner_id: string;
  module: string;
  events: RegressionEvent[];
  regression_count: number;
  fix_rate: number;
  summary: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): RegressionTimelineRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  module: String(r.module),
  events: (r.events ?? []) as RegressionEvent[],
  regression_count: Number(r.regression_count),
  fix_rate: Number(r.fix_rate),
  summary: String(r.summary),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export function buildTimelineSummary(module: string, events: RegressionEvent[]): { regression_count: number; fix_rate: number; summary: string } {
  const regressionCount = events.length;
  const fixed = events.filter((e) => e.worked).length;
  const fixRate = regressionCount > 0 ? Math.round((fixed / regressionCount) * 100) : 0;
  const summary = `${module} regressed ${regressionCount} time${regressionCount === 1 ? '' : 's'}; ${fixed} fixed by a known-good change (${fixRate}% success)`;
  return { regression_count: regressionCount, fix_rate: fixRate, summary };
}

export async function openTimeline(userId: string, input: { module: string; history: RegressionEvent[] }): Promise<RegressionTimelineRow> {
  if (!input.module || typeof input.module !== 'string') throw AppError.badRequest('invalid_module', 'a module name is required');
  if (!Array.isArray(input.history) || input.history.length === 0) throw AppError.badRequest('empty_history', 'at least one regression is required to open a timeline');
  for (const e of input.history) {
    if (!e.ref || !e.broke || !e.fix) throw AppError.badRequest('incomplete_event', 'every regression needs a ref, what broke, and the fix that worked');
  }
  const stats = buildTimelineSummary(input.module, input.history);
  const id = newId(PREFIX.REGRESSION_TIMELINE);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO regression_timelines (id, owner_id, module, events, regression_count, fix_rate, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.module, input.history, stats.regression_count, stats.fix_rate, stats.summary],
  ));
  await recordAudit({
    action: AuditAction.REGRESSION_TIMELINE_OPENED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'regression_timelines',
    resourceId: id,
    detail: { module: input.module, regressions: input.history.length },
  });
  return getRegressionTimeline(userId, id);
}

export async function addRegression(userId: string, id: string, event: RegressionEvent): Promise<RegressionTimelineRow> {
  const timeline = await getRegressionTimeline(userId, id);
  if (!event.ref || !event.broke || !event.fix) throw AppError.badRequest('incomplete_event', 'every regression needs a ref, what broke, and the fix that worked');
  const events = [...timeline.events, event];
  const stats = buildTimelineSummary(timeline.module, events);
  await withTenant(userId, (q) => q.query(
    'UPDATE regression_timelines SET events = $2, regression_count = $3, fix_rate = $4, summary = $5, updated_at = now() WHERE id = $1 AND owner_id = $6',
    [id, events, stats.regression_count, stats.fix_rate, stats.summary, userId],
  ));
  await recordAudit({
    action: AuditAction.REGRESSION_ADDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'regression_timelines',
    resourceId: id,
    detail: { module: timeline.module, ref: event.ref },
  });
  return getRegressionTimeline(userId, id);
}

export async function getRegressionTimeline(userId: string, id: string): Promise<RegressionTimelineRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM regression_timelines WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('regression_timeline_not_found', 'no regression timeline found for that id');
  return rowOf(row);
}

export async function listRegressionTimelines(userId: string): Promise<RegressionTimelineRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM regression_timelines WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.regression_count - a.regression_count,
  );
}

export async function regressionReport(userId: string): Promise<{ timelines: number; regressions: number; avg_fix_rate: number; most_regressed: string | null }> {
  const timelines = await listRegressionTimelines(userId);
  return {
    timelines: timelines.length,
    regressions: timelines.reduce((s, t) => s + t.regression_count, 0),
    avg_fix_rate: timelines.length ? Math.round(timelines.reduce((s, t) => s + t.fix_rate, 0) / timelines.length) : 0,
    most_regressed: timelines[0]?.module ?? null,
  };
}