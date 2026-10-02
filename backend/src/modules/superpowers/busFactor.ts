/**
 * CodeConClave — Superpowers: BUS-FACTOR ALARM (Master Feature #133).
 *
 * Flags every module whose ownership sits in too few hands — with a concrete
 * pairing / knowledge-transfer plan — so a single departure can never strand
 * the system. "Only one human has edited the auth module in 6 months" becomes
 * a ticket, not a discovery on someone's last day.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type BusFactorSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type BusFactorStatus = 'OPEN' | 'CLEARED';

export interface BusFactorAlarmRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  module: string;
  total_contributors: number;
  active_contributors: number;
  span_days: number;
  severity: BusFactorSeverity;
  knowledge_transfer: { risk: string; primary_owners: string[]; mitigation: string; kt_tasks: string[]; suggested_pairs: string[] };
  status: BusFactorStatus;
  created_at: Date;
  updated_at: Date;
}

export interface ModuleContributions {
  module: string;
  contributors: { name: string; last_active_days: number }[];
  span_days: number;
}

const rowOf = (r: Record<string, unknown>): BusFactorAlarmRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  module: String(r.module),
  total_contributors: Number(r.total_contributors),
  active_contributors: Number(r.active_contributors),
  span_days: Number(r.span_days),
  severity: r.severity as BusFactorSeverity,
  knowledge_transfer: (r.knowledge_transfer ?? {}) as BusFactorAlarmRow['knowledge_transfer'],
  status: (r.status ?? 'OPEN') as BusFactorStatus,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export function classifyBusFactor(total: number, active: number): BusFactorSeverity | null {
  if (total <= 0) return null;
  if (total < 2) return 'CRITICAL';
  if (active <= 1) return 'HIGH';
  if (total < 3) return 'MEDIUM';
  if (active < total) return 'LOW';
  return null;
}

export function buildKnowledgeTransfer(
  module: string,
  severity: BusFactorSeverity,
  total: number,
  active: number,
  contributors: { name: string; last_active_days: number }[],
  spanDays: number,
): BusFactorAlarmRow['knowledge_transfer'] {
  const activeNames = contributors.filter((c) => c.last_active_days <= spanDays).map((c) => c.name).sort();
  const primaryOwners = activeNames.length > 0 ? activeNames : contributors.map((c) => c.name).sort();
  const risk =
    severity === 'CRITICAL'
      ? `one human holds the entire ${module} module`
      : severity === 'HIGH'
        ? `only one active owner left on ${module}`
        : severity === 'MEDIUM'
          ? `too few owners for ${module} (${active}/${total} active)`
          : `ownership concentrating on ${module} (${active}/${total} active)`;
  const mitigation = `spread ${module} ownership: paired changes now, runbook written, decision history recorded`;
  const ktTasks = [
    `Pair on a meaningful change in ${module}`,
    `Write the ${module} runbook and recovery steps`,
    `Record the ${module} decision history and gotchas`,
  ];
  const suggestedPairs: string[] = [];
  for (let i = 1; i < primaryOwners.length; i += 1) {
    suggestedPairs.push(`${primaryOwners[0]!} + ${primaryOwners[i]!}`);
  }
  return { risk, primary_owners: primaryOwners, mitigation, kt_tasks: ktTasks, suggested_pairs: suggestedPairs };
}

export async function scanBusFactor(
  userId: string,
  input: { projectId?: string | null; modules: ModuleContributions[] },
): Promise<{ modules: number; flagged: number; alarms: BusFactorAlarmRow[] }> {
  const modules = Array.isArray(input.modules) ? input.modules : [];
  if (modules.length === 0) throw AppError.badRequest('empty_modules', 'bus factor scan needs at least one module');
  const alarms: BusFactorAlarmRow[] = [];
  let flagged = 0;
  for (const m of modules) {
    if (!m.module || typeof m.module !== 'string') throw AppError.badRequest('invalid_module', 'each module needs a name');
    if (!Array.isArray(m.contributors)) throw AppError.badRequest('invalid_contributors', `contributors for ${m.module} must be a list`);
    if (m.contributors.length === 0) throw AppError.badRequest('invalid_contributors', `contributors for ${m.module} cannot be empty`);
    if (!Number.isFinite(m.span_days) || m.span_days <= 0) throw AppError.badRequest('invalid_span', `span_days for ${m.module} must be positive`);
    const total = m.contributors.length;
    const active = m.contributors.filter((c) => c.last_active_days <= m.span_days).length;
    const severity = classifyBusFactor(total, active);
    if (!severity) continue;
    flagged += 1;
    const id = newId(PREFIX.BUS_FACTOR_ALARM);
    const knowledgeTransfer = buildKnowledgeTransfer(m.module, severity, total, active, m.contributors, m.span_days);
    await withTenant(userId, (q) => q.query(
      'INSERT INTO bus_factor_alarms (id, owner_id, project_id, module, total_contributors, active_contributors, span_days, severity, knowledge_transfer, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, userId, input.projectId ?? null, m.module, total, active, m.span_days, severity, knowledgeTransfer, 'OPEN'],
    ));
    alarms.push(await getBusFactorAlarm(userId, id));
  }
  await recordAudit({
    action: AuditAction.BUS_FACTOR_SCANNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'bus_factor_alarms',
    resourceId: null,
    detail: { modules: modules.length, flagged },
  });
  for (const alarm of alarms) {
    await recordAudit({
      action: AuditAction.BUS_FACTOR_ALARM_RAISED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'bus_factor_alarms',
      resourceId: alarm.id,
      detail: { module: alarm.module, severity: alarm.severity, total: alarm.total_contributors, active: alarm.active_contributors },
    });
  }
  return { modules: modules.length, flagged, alarms };
}

export async function getBusFactorAlarm(userId: string, id: string): Promise<BusFactorAlarmRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM bus_factor_alarms WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('bus_factor_alarm_not_found', 'no bus factor alarm found for that id');
  return rowOf(row);
}

export async function clearBusFactorAlarm(userId: string, id: string): Promise<BusFactorAlarmRow> {
  const alarm = await getBusFactorAlarm(userId, id);
  if (alarm.status === 'CLEARED') return alarm;
  await withTenant(userId, (q) => q.query('UPDATE bus_factor_alarms SET status = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId, 'CLEARED']));
  await recordAudit({
    action: AuditAction.BUS_FACTOR_CLEARED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'bus_factor_alarms',
    resourceId: id,
    detail: { module: alarm.module },
  });
  return getBusFactorAlarm(userId, id);
}

export async function listBusFactorAlarms(userId: string, filter: { severity?: BusFactorSeverity; status?: BusFactorStatus } = {}): Promise<BusFactorAlarmRow[]> {
  let rows = (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM bus_factor_alarms WHERE owner_id = $1', [userId])).rows)).map(rowOf);
  if (filter.severity) rows = rows.filter((f) => f.severity === filter.severity);
  if (filter.status) rows = rows.filter((f) => f.status === filter.status);
  return rows.sort((a, b) => a.status.localeCompare(b.status) || b.created_at.getTime() - a.created_at.getTime());
}

export async function busFactorReport(userId: string): Promise<{
  total: number;
  open: number;
  cleared: number;
  by_severity: Record<BusFactorSeverity, number>;
}> {
  const rows = await listBusFactorAlarms(userId);
  const by_severity: Record<BusFactorSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of rows) by_severity[r.severity] += 1;
  return {
    total: rows.length,
    open: rows.filter((r) => r.status === 'OPEN').length,
    cleared: rows.filter((r) => r.status === 'CLEARED').length,
    by_severity,
  };
}