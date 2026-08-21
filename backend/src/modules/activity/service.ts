/**
 * CodeConClave — activity feed (Phase 13).
 * Read-only aggregation over ALREADY-persisted event tables (project_activity,
 * file_activity, team_activity, audit_logs). No new event rows are ever
 * written here — deduplication happens at read time when the same underlying
 * action was recorded in both an activity table and audit_logs.
 */
import { queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { requireProjectRole } from '../auth/rbac.js';
import { requireTeamRole } from '../teams/service.js';
import { TeamRole } from '@codeconclave/shared';

export interface ActivityEvent {
  id: string;
  source: string;
  action: string;
  actorUserId: string | null;
  projectId: string | null;
  teamId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  summary: string;
  createdAt: Date;
}

interface ActivityRow {
  source: string;
  event_id: string;
  action: string;
  actor_user_id: string | null;
  project_id: string | null;
  team_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: Date;
}

export interface ActivityQuery {
  scope?: 'home' | 'project' | 'team';
  projectId?: string;
  teamId?: string;
  limit?: number;
}

function toActivityEvent(r: ActivityRow): ActivityEvent {
  return {
    id: `${r.source}:${r.event_id}`,
    source: r.source,
    action: r.action,
    actorUserId: r.actor_user_id ?? null,
    projectId: r.project_id ?? null,
    teamId: r.team_id ?? null,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    summary: r.action,
    createdAt: r.created_at,
  };
}

const SELF_PROJECTS = (u: string) =>
  `(SELECT id FROM projects WHERE owner_id = ${u} OR id IN (SELECT project_id FROM project_members WHERE user_id = ${u}))`;
const SELF_TEAMS = (u: string) =>
  `(SELECT team_id FROM team_members WHERE user_id = ${u} AND status = 'ACTIVE')`;

export async function getActivityFeed(userId: string, query: ActivityQuery = {}) {
  const scope = query.scope ?? 'home';
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);

  let selects: string[] = [];

  if (scope === 'home') {
    const u = `$${1}`;
    const projects = SELF_PROJECTS(u);
    const teams = SELF_TEAMS(u);
    selects = [
      `SELECT 'project_activity'::text AS source, pa.id AS event_id, pa.action, pa.actor_user_id,
              pa.project_id, NULL::text AS team_id, 'project'::text AS resource_type,
              pa.project_id AS resource_id, pa.created_at
       FROM project_activity pa WHERE pa.project_id IN ${projects}`,
      `SELECT 'file_activity'::text AS source, fa.id AS event_id, fa.action, fa.actor_user_id,
              fa.project_id, NULL::text AS team_id, 'file'::text AS resource_type,
              fa.file_id AS resource_id, fa.created_at
       FROM file_activity fa WHERE fa.project_id IN ${projects}`,
      `SELECT 'team_activity'::text AS source, ta.id AS event_id, ta.action, ta.actor_user_id,
              NULL::text AS project_id, ta.team_id, 'team'::text AS resource_type,
              ta.team_id AS resource_id, ta.created_at
       FROM team_activity ta WHERE ta.team_id IN ${teams}`,
      `SELECT 'audit'::text AS source, a.id AS event_id, a.action, a.actor_user_id,
              NULL::text AS project_id, NULL::text AS team_id, a.resource_type, a.resource_id, a.created_at
       FROM audit_logs a WHERE a.actor_user_id = ${u}`,
    ];
  } else if (scope === 'project') {
    if (!query.projectId) throw AppError.badRequest('project_required', 'projectId is required for project scope');
    await requireProjectRole(userId, query.projectId, ['owner', 'admin', 'editor', 'member', 'viewer']);
    const p = `$${2}`;
    selects = [
      `SELECT 'project_activity'::text AS source, pa.id AS event_id, pa.action, pa.actor_user_id,
              pa.project_id, NULL::text AS team_id, 'project'::text AS resource_type,
              pa.project_id AS resource_id, pa.created_at
       FROM project_activity pa WHERE pa.project_id = ${p}`,
      `SELECT 'file_activity'::text AS source, fa.id AS event_id, fa.action, fa.actor_user_id,
              fa.project_id, NULL::text AS team_id, 'file'::text AS resource_type,
              fa.file_id AS resource_id, fa.created_at
       FROM file_activity fa WHERE fa.project_id = ${p}`,
    ];
  } else if (scope === 'team') {
    if (!query.teamId) throw AppError.badRequest('team_required', 'teamId is required for team scope');
    await requireTeamRole(userId, query.teamId, [
      TeamRole.OWNER,
      TeamRole.ADMIN,
      TeamRole.EDITOR,
      TeamRole.VIEWER,
      TeamRole.GUEST,
    ]);
    const t = `$${2}`;
    selects = [
      `SELECT 'team_activity'::text AS source, ta.id AS event_id, ta.action, ta.actor_user_id,
              NULL::text AS project_id, ta.team_id, 'team'::text AS resource_type,
              ta.team_id AS resource_id, ta.created_at
       FROM team_activity ta WHERE ta.team_id = ${t}`,
      `SELECT 'project_activity'::text AS source, pa.id AS event_id, pa.action, pa.actor_user_id,
              pa.project_id, p.team_id, 'project'::text AS resource_type,
              pa.project_id AS resource_id, pa.created_at
       FROM project_activity pa JOIN projects p ON p.id = pa.project_id
       WHERE p.team_id = ${t}`,
    ];
  } else {
    throw AppError.badRequest('invalid_scope', 'scope must be home, project or team');
  }

  const union = selects.join('\n  UNION ALL\n  ');
  const params = scope === 'home' ? [userId] : [userId, scope === 'project' ? query.projectId : query.teamId];
  const rows = await queryMany<ActivityRow>(
    `SELECT * FROM (${union}) e ORDER BY e.created_at DESC, e.source LIMIT $${params.length + 1}`,
    [...params, limit],
  );

  const seen = new Set<string>();
  const events: ActivityEvent[] = [];
  for (const row of rows) {
    const key = `${row.action}|${row.resource_id ?? ''}|${row.created_at.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(toActivityEvent(row));
  }

  return { events, total: events.length };
}