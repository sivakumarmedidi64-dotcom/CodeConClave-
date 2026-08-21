/**
 * CodeConClave — history module (Phase 13).
 * Unified chronological view over ALREADY-PERSISTED authorized events:
 *   audit_logs (self) + project_activity + file_activity + team_activity.
 * No new event rows are ever created here — History is read-only aggregation.
 * Every event carries source provenance, actor, timestamps, resource scope and
 * a starred state (history_stars marks existing events only).
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, HistorySource } from '@codeconclave/shared';

export interface HistoryEvent {
  id: string;
  source: HistorySource | string;
  eventId: string;
  action: string;
  actorUserId: string | null;
  projectId: string | null;
  teamId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
  starred: boolean;
}

export interface HistoryQuery {
  q?: string;
  source?: string;
  action?: string;
  resourceType?: string;
  projectId?: string;
  actorId?: string;
  teamId?: string;
  dateFrom?: string;
  dateTo?: string;
  starred?: boolean;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const VALID_SOURCES = new Set<string>(Object.values(HistorySource));

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

interface SourceBuild {
  sql: string;
  params: unknown[];
}

/**
 * Build the UNION of authorized sources with filters. Placeholders are
 * globally unique across the combined statement ($1..$n).
 */
function buildUnion(userId: string, f: HistoryQuery): SourceBuild {
  const params: unknown[] = [];
  const next = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const u = next(userId);
  const memberProjects =
    `(SELECT id FROM projects WHERE owner_id = ${u} OR id IN (SELECT project_id FROM project_members WHERE user_id = ${u}))`;

  const qClause = (cols: string[]): string => {
    if (!f.q?.trim()) return '';
    const like = next(`%${escapeLike(f.q.trim())}%`);
    return ` AND (${cols.map((c) => `${c} ILIKE ${like}`).join(' OR ')})`;
  };
  const dateClause = (col: string): string => {
    let s = '';
    if (f.dateFrom) s += ` AND ${col} >= ${next(f.dateFrom)}`;
    if (f.dateTo) s += ` AND ${col} <= ${next(f.dateTo)}`;
    return s;
  };
  const actionClause = (col: string): string => (f.action ? ` AND ${col} = ${next(f.action)}` : '');
  const actorClause = (col: string): string => (f.actorId ? ` AND ${col} = ${next(f.actorId)}` : '');
  const starredClause = (source: string, idCol: string): string =>
    f.starred
      ? ` AND EXISTS (SELECT 1 FROM history_stars hs WHERE hs.owner_id = ${u} AND hs.source = ${next(source)} AND hs.event_id = ${idCol})`
      : '';

  const selects: string[] = [];

  if (!f.source || f.source === HistorySource.AUDIT) {
    let where = `a.actor_user_id = ${u}`;
    where += actionClause('a.action');
    if (f.resourceType) where += ` AND a.resource_type = ${next(f.resourceType)}`;
    where += actorClause('a.actor_user_id');
    where += qClause(['a.action', 'a.resource_type', "a.detail::text"]);
    where += dateClause('a.created_at');
    where += starredClause(HistorySource.AUDIT, 'a.id');
    selects.push(
      `SELECT '${HistorySource.AUDIT}'::text AS source, a.id AS event_id, a.action,
              a.actor_user_id, NULL::text AS project_id, NULL::text AS team_id,
              a.resource_type, a.resource_id, a.detail, a.created_at
       FROM audit_logs a WHERE ${where}`,
    );
  }

  if (!f.source || f.source === HistorySource.PROJECT_ACTIVITY) {
    let where = `pa.project_id IN ${memberProjects}`;
    where += actionClause('pa.action');
    if (f.projectId) where += ` AND pa.project_id = ${next(f.projectId)}`;
    where += actorClause('pa.actor_user_id');
    if (f.teamId) where += ` AND pa.project_id IN (SELECT id FROM projects WHERE team_id = ${next(f.teamId)})`;
    where += qClause(['pa.action', 'pa.detail::text']);
    where += dateClause('pa.created_at');
    where += starredClause(HistorySource.PROJECT_ACTIVITY, 'pa.id');
    selects.push(
      `SELECT '${HistorySource.PROJECT_ACTIVITY}'::text AS source, pa.id AS event_id, pa.action,
              pa.actor_user_id, pa.project_id, NULL::text AS team_id,
              'project'::text AS resource_type, pa.project_id AS resource_id, pa.detail, pa.created_at
       FROM project_activity pa WHERE ${where}`,
    );
  }

  if (!f.source || f.source === HistorySource.FILE_ACTIVITY) {
    let where = `fa.project_id IN ${memberProjects}`;
    where += actionClause('fa.action');
    if (f.projectId) where += ` AND fa.project_id = ${next(f.projectId)}`;
    where += actorClause('fa.actor_user_id');
    if (f.teamId) where += ` AND fa.project_id IN (SELECT id FROM projects WHERE team_id = ${next(f.teamId)})`;
    where += qClause(['fa.action', 'fa.detail::text']);
    where += dateClause('fa.created_at');
    where += starredClause(HistorySource.FILE_ACTIVITY, 'fa.id');
    selects.push(
      `SELECT '${HistorySource.FILE_ACTIVITY}'::text AS source, fa.id AS event_id, fa.action,
              fa.actor_user_id, fa.project_id, NULL::text AS team_id,
              'file'::text AS resource_type, fa.file_id AS resource_id, fa.detail, fa.created_at
       FROM file_activity fa WHERE ${where}`,
    );
  }

  if (!f.source || f.source === HistorySource.TEAM_ACTIVITY) {
    let where = `ta.team_id IN (SELECT team_id FROM team_members WHERE user_id = ${u} AND status = 'ACTIVE')`;
    where += actionClause('ta.action');
    if (f.teamId) where += ` AND ta.team_id = ${next(f.teamId)}`;
    where += actorClause('ta.actor_user_id');
    where += qClause(['ta.action', 'ta.detail::text']);
    where += dateClause('ta.created_at');
    where += starredClause(HistorySource.TEAM_ACTIVITY, 'ta.id');
    selects.push(
      `SELECT '${HistorySource.TEAM_ACTIVITY}'::text AS source, ta.id AS event_id, ta.action,
              ta.actor_user_id, NULL::text AS project_id, ta.team_id,
              'team'::text AS resource_type, ta.team_id AS resource_id, ta.detail, ta.created_at
       FROM team_activity ta WHERE ${where}`,
    );
  }

  return { sql: selects.join('\n  UNION ALL\n  '), params };
}

interface UnionRow {
  source: string;
  event_id: string;
  action: string;
  actor_user_id: string | null;
  project_id: string | null;
  team_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

function toEvent(r: UnionRow, userId: string): HistoryEvent {
  return {
    id: `${r.source}:${r.event_id}`,
    source: r.source,
    eventId: r.event_id,
    action: r.action,
    actorUserId: r.actor_user_id ?? null,
    projectId: r.project_id ?? null,
    teamId: r.team_id ?? null,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    summary: r.action,
    detail: r.detail ?? null,
    createdAt: r.created_at,
    starred: false,
  };
}

export async function listHistory(userId: string, f: HistoryQuery = {}) {
  if (f.source && !VALID_SOURCES.has(f.source)) {
    throw AppError.badRequest('invalid_source', `source must be one of: ${[...VALID_SOURCES].join(', ')}`);
  }
  const { sql, params } = buildUnion(userId, f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const order = f.sort === 'asc' ? 'ASC' : 'DESC';

  const totalRows = await queryMany<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) e`, params);
  const total = totalRows[0]?.n ?? 0;
  const rows = await queryMany<UnionRow>(
    `SELECT * FROM (${sql}) e ORDER BY e.created_at ${order}, e.source LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  let starredIds: Set<string> | null = null;
  if (rows.length) {
    const starRows = await queryMany<{ source: string; event_id: string }>(
      'SELECT source, event_id FROM history_stars WHERE owner_id = $1',
      [userId],
    );
    starredIds = new Set(starRows.map((s) => `${s.source}:${s.event_id}`));
  }

  const events = rows.map((r) => {
    const ev = toEvent(r, userId);
    ev.starred = starredIds?.has(ev.id) ?? false;
    return ev;
  });
  return { events, total, limit, offset };
}

// ---------------------------------------------------------------- detail + star

export async function getHistoryEvent(userId: string, source: string, eventId: string): Promise<HistoryEvent> {
  if (!VALID_SOURCES.has(source)) {
    throw AppError.badRequest('invalid_source', `source must be one of: ${[...VALID_SOURCES].join(', ')}`);
  }
  let row: UnionRow | null = null;
  if (source === HistorySource.AUDIT) {
    row = await queryOne<UnionRow>(
      `SELECT '${HistorySource.AUDIT}'::text AS source, a.id AS event_id, a.action, a.actor_user_id,
              NULL::text AS project_id, NULL::text AS team_id, a.resource_type, a.resource_id,
              a.detail, a.created_at
       FROM audit_logs a WHERE a.id = $1 AND a.actor_user_id = $2`,
      [eventId, userId],
    );
  } else if (source === HistorySource.PROJECT_ACTIVITY) {
    row = await queryOne<UnionRow>(
      `SELECT '${HistorySource.PROJECT_ACTIVITY}'::text AS source, pa.id AS event_id, pa.action, pa.actor_user_id,
              pa.project_id, NULL::text AS team_id, 'project'::text AS resource_type,
              pa.project_id AS resource_id, pa.detail, pa.created_at
       FROM project_activity pa
       WHERE pa.id = $1 AND pa.project_id IN (SELECT id FROM projects WHERE owner_id = $2
         OR id IN (SELECT project_id FROM project_members WHERE user_id = $2))`,
      [eventId, userId],
    );
  } else if (source === HistorySource.FILE_ACTIVITY) {
    row = await queryOne<UnionRow>(
      `SELECT '${HistorySource.FILE_ACTIVITY}'::text AS source, fa.id AS event_id, fa.action, fa.actor_user_id,
              fa.project_id, NULL::text AS team_id, 'file'::text AS resource_type,
              fa.file_id AS resource_id, fa.detail, fa.created_at
       FROM file_activity fa
       WHERE fa.id = $1 AND fa.project_id IN (SELECT id FROM projects WHERE owner_id = $2
         OR id IN (SELECT project_id FROM project_members WHERE user_id = $2))`,
      [eventId, userId],
    );
  } else if (source === HistorySource.TEAM_ACTIVITY) {
    row = await queryOne<UnionRow>(
      `SELECT '${HistorySource.TEAM_ACTIVITY}'::text AS source, ta.id AS event_id, ta.action, ta.actor_user_id,
              NULL::text AS project_id, ta.team_id, 'team'::text AS resource_type,
              ta.team_id AS resource_id, ta.detail, ta.created_at
       FROM team_activity ta
       WHERE ta.id = $1 AND ta.team_id IN (SELECT team_id FROM team_members WHERE user_id = $2 AND status = 'ACTIVE')`,
      [eventId, userId],
    );
  }
  if (!row) throw AppError.notFound('History event');
  const event = toEvent(row, userId);
  const stars = await queryMany<{ n: number }>(
    'SELECT count(*)::int AS n FROM history_stars WHERE owner_id = $1 AND source = $2 AND event_id = $3',
    [userId, source, eventId],
  );
  event.starred = (stars[0]?.n ?? 0) > 0;
  return event;
}

export async function setHistoryStar(userId: string, source: string, eventId: string, starred: boolean) {
  await getHistoryEvent(userId, source, eventId);
  if (starred) {
    await pool.query(
      `INSERT INTO history_stars (id, owner_id, source, event_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id, source, event_id) DO NOTHING`,
      [newId(PREFIX.HISTORY_STAR), userId, source, eventId],
    );
  } else {
    await pool.query('DELETE FROM history_stars WHERE owner_id = $1 AND source = $2 AND event_id = $3', [
      userId,
      source,
      eventId,
    ]);
  }
  await recordAudit({
    action: starred ? AuditAction.HISTORY_STARRED : AuditAction.HISTORY_UNSTARRED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'history',
    resourceId: eventId,
    detail: { source },
  });
  return { starred };
}