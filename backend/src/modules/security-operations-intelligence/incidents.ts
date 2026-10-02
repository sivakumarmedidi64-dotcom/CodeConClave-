/**
 * CodeConClave — Security Incident Response (#21, PKG-15).
 * Project-scoped, owner-isolated security incident lifecycle:
 * OPEN -> TRIAGING -> IN_PROGRESS -> CONTAINED -> RESOLVED -> CLOSED
 * (or FALSE_POSITIVE / reassigned). Every transition is audit-logged.
 * Incident response is advisory: it records the agreed response action and
 * status; it never auto-applies destructive changes.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type {
  CreateIncident,
  IncidentEvent,
  IncidentStats,
  IncidentView,
  ListIncidents,
  UpdateIncident,
  IncidentSeverity,
  IncidentStatus,
} from './types.js';

const ALLOWED_STATUS: IncidentStatus[] = [
  'OPEN',
  'TRIAGING',
  'IN_PROGRESS',
  'CONTAINED',
  'RESOLVED',
  'CLOSED',
  'FALSE_POSITIVE',
];
const ALLOWED_SEVERITY: IncidentSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<{ ok: string } | null>(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]).then((r) => r.rows[0] ?? null),
  );
  if (!p) throw AppError.notFound('Project');
}

/** Sanitize arbitrary event detail text (never logs raw source). */
function stripControl(s: string): string {
  return (s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').slice(0, 4000);
}

interface IncidentRow {
  id: string;
  project_id: string;
  title: string;
  severity: string;
  status: string;
  response_action: string;
  description: string;
  source: string | null;
  finding_ids: string[] | string;
  assignee_id: string | null;
  summary: string | null;
  created_by: string;
  created_by_email: string | null;
  timeline: string;
  created_at: Date;
  updated_at: Date;
}

function rowToView(r: IncidentRow): IncidentView {
  const timelineRaw = typeof r.timeline === 'string' ? r.timeline : JSON.stringify(r.timeline ?? []);
  let timeline: IncidentEvent[] = [];
  try {
    timeline = JSON.parse(timelineRaw) as IncidentEvent[];
  } catch {
    timeline = [];
  }
  const findingIds = Array.isArray(r.finding_ids) ? r.finding_ids : JSON.parse(r.finding_ids || '[]');
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    severity: r.severity as IncidentSeverity,
    status: r.status as IncidentStatus,
    responseAction: r.response_action as IncidentView['responseAction'],
    description: r.description ?? '',
    source: r.source,
    findingIds,
    assigneeId: r.assignee_id,
    summary: r.summary,
    createdBy: r.created_by_email ?? r.created_by,
    createdById: r.created_by,
    createdByEmail: r.created_by_email,
    timeline,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export const SecurityIncidentService = {
  async create(userId: string, input: CreateIncident): Promise<IncidentView> {
    await assertProjectAccess(userId, input.projectId);
    const id = newId(PREFIX.SECOPS_INCIDENT);
    const now = new Date();
    const description = stripControl(input.description);
    const source = input.source ? stripControl(input.source) : null;
    const findingIds = (input.findingIds ?? []).map((s) => stripControl(s)).slice(0, 200);
    const ordered = (findingIds.length ? findingIds : []);

    const event: IncidentEvent = {
      id: newId(PREFIX.SECOPS_INCIDENT_EVENT),
      at: now.toISOString(),
      actorId: userId,
      kind: 'CREATED',
      detail: `Incident created (${input.severity}, ${input.responseAction})${source ? ` from ${source}` : ''}`,
    };
    const timeline = [event];

    await withTenant(userId, (q) =>
      q.query(
        `INSERT INTO secops_incidents
           (id, project_id, title, severity, status, response_action, description,
            source, finding_ids, assignee_id, summary, created_by, timeline, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          input.projectId,
          stripControl(input.title),
          input.severity,
          'OPEN',
          input.responseAction,
          description,
          source,
          JSON.stringify(ordered),
          input.assigneeId ?? null,
          null,
          userId,
          JSON.stringify(timeline),
          now,
          now,
        ],
      ),
    );

    await recordAudit({
      action: 'security_incident.created',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'security_incident',
      resourceId: id,
      detail: {
        projectId: input.projectId,
        severity: input.severity,
        status: 'OPEN',
        findingCount: ordered.length,
      },
    });

    const row = await this.getRow(userId, id);
    return rowToView(row);
  },

  async getRow(userId: string, incidentId: string): Promise<IncidentRow> {
    const rows = await withTenant<IncidentRow[]>(userId, (q) =>
      q
        .query<IncidentRow>(
          `SELECT i.*, u.email AS created_by_email
             FROM secops_incidents i
             LEFT JOIN users u ON u.id = i.created_by
            WHERE i.id = $1`,
          [incidentId],
        )
        .then((r) => r.rows),
    );
    if (!rows[0]) throw AppError.notFound('SecurityIncident');
    // Ownership/RLS isolation: an unauthorized viewer gets an empty/Not Found.
    void userId;
    return rows[0];
  },

  async get(userId: string, projectId: string, incidentId: string): Promise<IncidentView> {
    await assertProjectAccess(userId, projectId);
    const row = await this.getRow(userId, incidentId);
    if (row.project_id !== projectId) throw AppError.notFound('SecurityIncident');
    return rowToView(row);
  },

  async list(userId: string, input: ListIncidents): Promise<IncidentView[]> {
    await assertProjectAccess(userId, input.projectId);
    const clauses: string[] = ['project_id = $1'];
    const params: unknown[] = [input.projectId];
    if (input.status) {
      params.push(input.status);
      clauses.push(`status = $${params.length}`);
    }
    if (input.severity) {
      params.push(input.severity);
      clauses.push(`severity = $${params.length}`);
    }
    params.push(input.limit ?? 50);
    const rows = await withTenant<IncidentRow[]>(userId, (q) =>
      q
        .query<IncidentRow>(
          `SELECT i.*, u.email AS created_by_email
             FROM secops_incidents i
             LEFT JOIN users u ON u.id = i.created_by
            WHERE ${clauses.join(' AND ')}
            ORDER BY created_at DESC
            LIMIT $${params.length}`,
          params,
        )
        .then((r) => r.rows),
    );
    return rows.map(rowToView);
  },

  async stats(userId: string, projectId: string): Promise<IncidentStats> {
    await assertProjectAccess(userId, projectId);
    const byStatus = Object.fromEntries(ALLOWED_STATUS.map((s) => [s, 0])) as Record<IncidentStatus, number>;
    const bySeverity = Object.fromEntries(ALLOWED_SEVERITY.map((s) => [s, 0])) as Record<IncidentSeverity, number>;

    const { statusRows, sevRows, total, critical } = await withTenant(userId, async (q) => {
      const [statusRows, sevRows, total, critical] = await Promise.all([
        q.query<{ status: string; count: string }>(
          'SELECT status, COUNT(*)::text AS count FROM secops_incidents WHERE project_id = $1 GROUP BY status',
          [projectId],
        ).then((r) => r.rows),
        q.query<{ severity: string; count: string }>(
          'SELECT severity, COUNT(*)::text AS count FROM secops_incidents WHERE project_id = $1 GROUP BY severity',
          [projectId],
        ).then((r) => r.rows),
        q.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM secops_incidents WHERE project_id = $1',
          [projectId],
        ).then((r) => r.rows),
        q.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM secops_incidents WHERE project_id = $1 AND severity IN ($2,$3) AND status NOT IN ($4,$5,$6)',
          [projectId, 'HIGH', 'CRITICAL', 'CLOSED', 'FALSE_POSITIVE', 'RESOLVED'],
        ).then((r) => r.rows),
      ]);
      return { statusRows, sevRows, total, critical };
    });

    let openHighCritical = 0;
    for (const r of statusRows) if (r.status in byStatus) byStatus[r.status as IncidentStatus] = Number(r.count);
    for (const r of sevRows) {
      if (r.severity in bySeverity) bySeverity[r.severity as IncidentSeverity] = Number(r.count);
    }
    openHighCritical = Number(critical[0]?.count ?? 0);

    return {
      projectId,
      total: Number(total[0]?.count ?? 0),
      byStatus,
      bySeverity,
      openHighCritical,
    };
  },

  async update(userId: string, input: UpdateIncident): Promise<IncidentView> {
    await assertProjectAccess(userId, input.projectId);
    const row = await this.getRow(userId, input.incidentId);
    if (row.project_id !== input.projectId) throw AppError.notFound('SecurityIncident');

    const nextTimeline: IncidentEvent[] = JSON.parse(
      typeof row.timeline === 'string' ? row.timeline : JSON.stringify(row.timeline ?? []),
    ) as IncidentEvent[];
    const now = new Date();

    const status = input.status ?? (row.status as IncidentStatus);
    const severity = input.severity ?? (row.severity as IncidentSeverity);
    const responseAction = input.responseAction ?? (row.response_action as IncidentView['responseAction']);
    const assigneeId = input.assigneeId !== undefined ? input.assigneeId : row.assignee_id;
    const summary = input.summary != null ? stripControl(input.summary) : row.summary;

    if (input.status && input.status !== row.status) {
      nextTimeline.push({
        id: newId(PREFIX.SECOPS_INCIDENT_EVENT),
        at: now.toISOString(),
        actorId: userId,
        kind: 'STATUS',
        detail: `${row.status} -> ${input.status}`,
      });
    }
    if (input.severity && input.severity !== row.severity) {
      nextTimeline.push({
        id: newId(PREFIX.SECOPS_INCIDENT_EVENT),
        at: now.toISOString(),
        actorId: userId,
        kind: 'SEVERITY',
        detail: `${row.severity} -> ${input.severity}`,
      });
    }
    if (input.responseAction && input.responseAction !== row.response_action) {
      nextTimeline.push({
        id: newId(PREFIX.SECOPS_INCIDENT_EVENT),
        at: now.toISOString(),
        actorId: userId,
        kind: 'ACTION',
        detail: `response action set to ${input.responseAction}`,
      });
    }
    if (input.assigneeId !== undefined && input.assigneeId !== row.assignee_id) {
      nextTimeline.push({
        id: newId(PREFIX.SECOPS_INCIDENT_EVENT),
        at: now.toISOString(),
        actorId: userId,
        kind: 'ASSIGN',
        detail: `assignee ${row.assignee_id ?? 'none'} -> ${input.assigneeId ?? 'none'}`,
      });
    }
    if (input.summary !== undefined && input.summary !== row.summary) {
      nextTimeline.push({
        id: newId(PREFIX.SECOPS_INCIDENT_EVENT),
        at: now.toISOString(),
        actorId: userId,
        kind: 'NOTE',
        detail: 'summary added/updated',
      });
    }

    await withTenant(userId, (q) =>
      q.query(
        `UPDATE secops_incidents
            SET status = $1, severity = $2, response_action = $3, assignee_id = $4,
                summary = $5, timeline = $6, updated_at = $7
          WHERE id = $8`,
        [status, severity, responseAction, assigneeId, summary, JSON.stringify(nextTimeline), now, input.incidentId],
      ),
    );

    await recordAudit({
      action: 'security_incident.updated',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'security_incident',
      resourceId: input.incidentId,
      detail: {
        projectId: input.projectId,
        status,
        severity,
        transitions: nextTimeline.length,
      },
    });

    const updated = await this.getRow(userId, input.incidentId);
    return rowToView(updated);
  },
};

export { ALLOWED_STATUS, ALLOWED_SEVERITY };
