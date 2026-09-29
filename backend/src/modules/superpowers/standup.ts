/**
 * CodeConClave — Superpowers: STANDUP FROM REALITY (Master Feature #136).
 *
 * The daily digest is generated from actual artifacts — never self-reported.
 * It reads the append-only agent_events log plus the owner-scoped fix tickets,
 * anomaly scans, risk scores and replay sessions, and partitions events by the
 * calendar day. The JSON summary is indexed exactly by those artifact types so
 * a founder reads the truth in three minutes of decisions.
 *
 * One report per (owner, report_date); re-generating the same day UPDATES the
 * same report. Draft reports become PUBLISHED explicitly (README: the morning
 * digest is the published one). Everything is audited.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type StandupStatus = 'DRAFT' | 'PUBLISHED';

export interface StandupSummary {
  date: string;
  events: Record<string, number> & { total: number };
  fix_tickets: Record<string, number>;
  anomalies: { FLAGGED: number; CLEAN: number; OPEN: number; RESOLVED: number; DISMISSED: number };
  risks: {
    total: number;
    top: Array<{ targetPath: string; band: string; riskScore: number }>;
    LOW: number;
    MEDIUM: number;
    HIGH: number;
    CRITICAL: number;
  };
  replays: { ACTIVE: number; ARCHIVED: number };
  top_fix_titles: string[];
}

export interface StandupReportRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  report_date: string;
  summary: StandupSummary;
  status: StandupStatus;
  created_at: Date;
  updated_at: Date;
}

function rowOf(r: Record<string, unknown>): StandupReportRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    report_date: String(r.report_date),
    summary: (r.summary && typeof r.summary === 'object' ? r.summary : {}) as StandupSummary,
    status: String(r.status) as StandupStatus,
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  };
}

function dayOf(iso: unknown): string {
  return new Date(String(iso)).toISOString().slice(0, 10);
}

export async function generateStandup(userId: string, input: { date?: string; projectId?: string | null } = {}): Promise<StandupReportRow> {
  const reportDate = (input.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw AppError.badRequest('invalid_date', 'date must be YYYY-MM-DD');

  const [eventRows, fixRows, anomalyRows, riskRows, replayRows, existing] = await withTenant<
    [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>]
  >(userId, (db) =>
    Promise.all([
      db.query<Record<string, unknown>>('SELECT * FROM agent_events WHERE owner_id = $1', [userId]).then((r) => r.rows),
      db.query<Record<string, unknown>>('SELECT * FROM fix_tickets WHERE owner_id = $1', [userId]).then((r) => r.rows),
      db.query<Record<string, unknown>>('SELECT * FROM anomaly_scans WHERE owner_id = $1', [userId]).then((r) => r.rows),
      db.query<Record<string, unknown>>('SELECT * FROM risk_scores WHERE owner_id = $1', [userId]).then((r) => r.rows),
      db.query<Record<string, unknown>>('SELECT * FROM replay_sessions WHERE owner_id = $1', [userId]).then((r) => r.rows),
      db
        .query<Record<string, unknown>>('SELECT * FROM standup_reports WHERE owner_id = $1 AND report_date = $2', [userId, reportDate])
        .then((r) => r.rows),
    ]),
  );
  const events: Record<string, number> & { total: number } = { total: 0 };
  for (const ev of eventRows) {
    if (dayOf(ev.created_at) !== reportDate) continue;
    const kind = String(ev.kind);
    events[kind] = (events[kind] ?? 0) + 1;
    events.total += 1;
  }

  const fixTickets: Record<string, number> = {};
  for (const f of fixRows) {
    const s = String(f.status);
    fixTickets[s] = (fixTickets[s] ?? 0) + 1;
  }
  const openTitles = (fixRows as Array<Record<string, unknown>>)
    .filter((f) => String(f.status) !== 'RESOLVED')
    .map((f) => String(f.title ?? f.issue ?? ''))
    .filter(Boolean)
    .slice(0, 3);

  const anomalies: StandupSummary['anomalies'] = {
    FLAGGED: anomalyRows.filter((a) => String(a.verdict) === 'FLAGGED').length,
    CLEAN: anomalyRows.filter((a) => String(a.verdict) === 'CLEAN').length,
    OPEN: anomalyRows.filter((a) => String(a.status) === 'OPEN').length,
    RESOLVED: anomalyRows.filter((a) => String(a.status) === 'RESOLVED').length,
    DISMISSED: anomalyRows.filter((a) => String(a.status) === 'DISMISSED').length,
  };

  const bandCounts: Record<string, number> = {};
  const riskTop: StandupSummary['risks']['top'] = [];
  for (const r of riskRows) {
    const band = String(r.risk_band);
    bandCounts[band] = (bandCounts[band] ?? 0) + 1;
    riskTop.push({ targetPath: String(r.target_path), band, riskScore: Number(r.risk_score) });
  }
  riskTop.sort((a, b) => b.riskScore - a.riskScore);
  const risks: StandupSummary['risks'] = {
    total: riskRows.length,
    top: riskTop.slice(0, 3),
    LOW: bandCounts['LOW'] ?? 0,
    MEDIUM: bandCounts['MEDIUM'] ?? 0,
    HIGH: bandCounts['HIGH'] ?? 0,
    CRITICAL: bandCounts['CRITICAL'] ?? 0,
  };

  const replays = {
    ACTIVE: replayRows.filter((r) => String(r.status) === 'ACTIVE').length,
    ARCHIVED: replayRows.filter((r) => String(r.status) === 'ARCHIVED').length,
  };

  const summary: StandupSummary = {
    date: reportDate,
    events,
    fix_tickets: fixTickets,
    anomalies,
    risks,
    replays,
    top_fix_titles: openTitles,
  };

  if (existing[0]) {
    const id = String(existing[0].id);
    await withTenant(userId, (db) =>
      db.query(
        'UPDATE standup_reports SET summary = $1::jsonb, updated_at = now() WHERE id = $2 AND owner_id = $3',
        [JSON.stringify(summary), id, userId],
      ),
    );
    await recordAudit({
      action: AuditAction.STANDUP_REPORT_GENERATED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'standup_reports',
      resourceId: id,
      detail: { reportDate, events: events.total, fixTickets: Object.keys(fixTickets).length },
    });
    return getStandupReport(userId, id);
  }

  const id = newId(PREFIX.STANDUP_REPORT);
  await withTenant(userId, (db) =>
    db.query(
      `INSERT INTO standup_reports (id, owner_id, project_id, report_date, summary, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'DRAFT')`,
      [id, userId, input.projectId ?? null, reportDate, JSON.stringify(summary)],
    ),
  );
  await recordAudit({
    action: AuditAction.STANDUP_REPORT_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'standup_reports',
    resourceId: id,
    detail: { reportDate, events: events.total },
  });
  return getStandupReport(userId, id);
}

export async function getStandupReport(userId: string, reportId: string): Promise<StandupReportRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, (db) =>
    db
      .query<Record<string, unknown>>('SELECT * FROM standup_reports WHERE id = $1 AND owner_id = $2', [reportId, userId])
      .then((r) => r.rows),
  );
  if (!rows[0]) throw AppError.notFound('Standup report');
  return rowOf(rows[0]);
}

export async function listStandupReports(userId: string, opts: { status?: StandupStatus; date?: string } = {}): Promise<StandupReportRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, (db) =>
    db.query<Record<string, unknown>>('SELECT * FROM standup_reports WHERE owner_id = $1', [userId]).then((r) => r.rows),
  );
  return rows
    .map(rowOf)
    .filter((r) => (opts.status ? r.status === opts.status : true) && (opts.date ? r.report_date === opts.date : true))
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

export async function publishStandupReport(userId: string, reportId: string): Promise<StandupReportRow> {
  const report = await getStandupReport(userId, reportId);
  if (report.status === 'PUBLISHED') return report;
  await withTenant(userId, (db) =>
    db.query(
      "UPDATE standup_reports SET status = 'PUBLISHED', updated_at = now() WHERE id = $1 AND owner_id = $2",
      [reportId, userId],
    ),
  );
  await recordAudit({
    action: AuditAction.STANDUP_REPORT_PUBLISHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'standup_reports',
    resourceId: reportId,
    detail: { reportDate: report.report_date },
  });
  return getStandupReport(userId, reportId);
}