/**
 * CodeConClave — Superpowers: CHURN DETECTIVE (Master Feature #78).
 *
 * Find the exact code paths where users give up — rage clicks, error loops,
 * form abandonment — and draft the fix with the evidence in hand.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type ChurnSignal = 'rage_click' | 'error_loop' | 'form_abandoned';

export interface ChurnEventRow {
  id: string;
  owner_id: string;
  locale: string;
  action: string;
  signal: ChurnSignal;
  occurrences: number;
  fix_draft: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ChurnEventRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  locale: String(r.locale),
  action: String(r.action),
  signal: String(r.signal) as ChurnSignal,
  occurrences: Number(r.occurrences),
  fix_draft: r.fix_draft == null ? null : String(r.fix_draft),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

const SIGNALS: ChurnSignal[] = ['rage_click', 'error_loop', 'form_abandoned'];
const REMEDY: Record<ChurnSignal, string> = {
  rage_click: 'decelerating feedback + an undo path',
  error_loop: 'guard-rails on the failing path + retry limits',
  form_abandoned: 'inline validation + a visible save state',
};

export function churnRemedy(signal: ChurnSignal): string {
  return REMEDY[signal];
}

export async function reportChurnEvent(userId: string, input: { locale: string; action: string; signal: ChurnSignal; occurrences?: number }): Promise<ChurnEventRow> {
  if (!input.locale || typeof input.locale !== 'string') throw AppError.badRequest('invalid_locale', 'the surface/locale is required');
  if (!input.action || typeof input.action !== 'string') throw AppError.badRequest('invalid_action', 'the code path is required');
  if (!SIGNALS.includes(input.signal)) throw AppError.badRequest('invalid_signal', 'the signal must be rage_click, error_loop, or form_abandoned');
  const occurrences = typeof input.occurrences === 'number' && Number.isFinite(input.occurrences) ? Math.max(1, Math.floor(input.occurrences)) : 1;
  const id = newId(PREFIX.CHURN_EVENT);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO churn_events (id, owner_id, locale, action, signal, occurrences, fix_draft, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.locale, input.action, input.signal, occurrences, null, 'WATCHED'],
  ));
  await recordAudit({
    action: AuditAction.CHURN_EVENT_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'churn_events',
    resourceId: id,
    detail: { locale: input.locale, action: input.action, signal: input.signal },
  });
  return getChurnEvent(userId, id);
}

/** The fix, drafted with the evidence. */
export async function draftChurnFix(userId: string, id: string): Promise<ChurnEventRow> {
  const event = await getChurnEvent(userId, id);
  if (event.status !== 'WATCHED') throw AppError.badRequest('churn_fix_already_drafted', 'this churn fix was already drafted');
  const fix_draft = `fix "${event.action}": users hit ${event.signal} (×${event.occurrences}) — add ${REMEDY[event.signal]}`;
  await withTenant(userId, (q) => q.query('UPDATE churn_events SET fix_draft = $2, status = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, fix_draft, 'DRAFTED', userId]));
  await recordAudit({
    action: AuditAction.CHURN_FIX_DRAFTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'churn_events',
    resourceId: id,
    detail: { action: event.action, signal: event.signal },
  });
  return getChurnEvent(userId, id);
}

export async function getChurnEvent(userId: string, id: string): Promise<ChurnEventRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM churn_events WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('churn_event_not_found', 'no churn event found for that id');
  return rowOf(row);
}

export async function listChurnEvents(userId: string): Promise<ChurnEventRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM churn_events WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function churnReport(userId: string): Promise<{ events: number; rage_clicks: number; error_loops: number; abandoned: number; drafted: number }> {
  const events = await listChurnEvents(userId);
  return {
    events: events.length,
    rage_clicks: events.filter((e) => e.signal === 'rage_click').length,
    error_loops: events.filter((e) => e.signal === 'error_loop').length,
    abandoned: events.filter((e) => e.signal === 'form_abandoned').length,
    drafted: events.filter((e) => e.status === 'DRAFTED').length,
  };
}