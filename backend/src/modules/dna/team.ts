/**
 * CodeConClave — team DNA module (Phase 6).
 *
 * Team-scoped DNA with MAIN/BRANCH/MERGE semantics mirroring the personal DNA
 * module, plus conflict detection and resolution. Permissions:
 *  - any team member (owner/admin/member): read, create, edit, branch
 *  - owner/admin only: merge branches + resolve conflicts
 * Team DNA is RLS-scoped to team members; it is never globally visible.
 */
import { pool, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AuditAction, DnaKind } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { getTeam, teamRoleFor } from '../teams/service.js';

export interface TeamDnaRow {
  id: string;
  team_id: string;
  created_by: string;
  kind: string;
  scope: string;
  title: string;
  content: string;
  version: number;
  parent_version_id: string | null;
  conflict_state: string;
  status: string;
  change_summary: string | null;
  merged_into_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SaveTeamDnaInput {
  teamId: string;
  kind: string;
  title: string;
  content: string;
  scope?: 'MAIN' | 'BRANCH';
  parentVersionId?: string | null;
  changeSummary?: string | null;
}

function normalizeKind(kind: string): string {
  return Object.values(DnaKind).includes(kind as DnaKind) ? kind : DnaKind.PROJECT_CONTEXT;
}

export async function saveTeamDna(userId: string, input: SaveTeamDnaInput): Promise<TeamDnaRow> {
  const role = await teamRoleFor(userId, input.teamId);
  if (!role) throw AppError.forbidden();
  const scope = input.scope ?? 'MAIN';
  const id = newId(PREFIX.DNA);
  await pool.query(
    `INSERT INTO team_dna (id, team_id, created_by, kind, scope, title, content, version, parent_version_id, conflict_state, change_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'NONE',$10)`,
    [
      id,
      input.teamId,
      userId,
      normalizeKind(input.kind),
      scope,
      input.title,
      input.content,
      1,
      input.parentVersionId ?? null,
      input.changeSummary ?? null,
    ],
  );
  await pool.query(
    `INSERT INTO team_dna_versions (id, dna_id, version, content_snapshot, change_summary, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [newId(PREFIX.DNA), id, 1, input.content, input.changeSummary ?? null, userId],
  );
  await recordAudit({
    action: scope === 'BRANCH' ? AuditAction.DNA_TEAM_BRANCH_CREATED : AuditAction.DNA_TEAM_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'team_dna',
    resourceId: id,
    detail: { teamId: input.teamId },
  });
  return getTeamDna(userId, id);
}

/** Membership-scoped read: only team members can see team DNA. */
export async function getTeamDna(userId: string, dnaId: string): Promise<TeamDnaRow> {
  const rows = await queryMany<TeamDnaRow>(
    `SELECT * FROM team_dna WHERE id = $1 AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = team_dna.team_id AND tm.user_id = $2)`,
    [dnaId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Team DNA block');
  return rows[0];
}

export async function listTeamDna(userId: string, teamId: string, scope?: 'MAIN' | 'BRANCH'): Promise<TeamDnaRow[]> {
  await getTeam(userId, teamId);
  const params: unknown[] = [teamId];
  let scopeClause = '';
  if (scope) {
    params.push(scope);
    scopeClause = `AND scope = $${params.length}`;
  }
  return queryMany<TeamDnaRow>(
    `SELECT * FROM team_dna WHERE team_id = $1 AND deleted_at IS NULL ${scopeClause}
     ORDER BY updated_at DESC`,
    params,
  );
}

export async function teamDnaVersions(userId: string, dnaId: string): Promise<unknown[]> {
  await getTeamDna(userId, dnaId);
  return queryMany(
    `SELECT id, version, content_snapshot, change_summary, created_by, created_at
     FROM team_dna_versions WHERE dna_id = $1 ORDER BY version DESC`,
    [dnaId],
  );
}

export async function updateTeamDna(
  userId: string,
  dnaId: string,
  input: { title?: string; content?: string; changeSummary?: string },
): Promise<TeamDnaRow> {
  const existing = await getTeamDna(userId, dnaId);
  const fields: string[] = [];
  const params: unknown[] = [dnaId];
  if (input.title !== undefined) {
    fields.push(`title = $${params.length + 1}`);
    params.push(input.title);
  }
  if (input.content !== undefined) {
    fields.push(`content = $${params.length + 1}`, `version = version + 1`);
    params.push(input.content);
  }
  if (input.changeSummary !== undefined) {
    fields.push(`change_summary = $${params.length + 1}`);
    params.push(input.changeSummary);
  }
  if (!fields.length) return existing;
  const newVersion = existing.version + 1;
  await pool.query(`UPDATE team_dna SET ${fields.join(', ')} WHERE id = $1`, params);
  if (input.content !== undefined) {
    await pool.query(
      `INSERT INTO team_dna_versions (id, dna_id, version, content_snapshot, change_summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(PREFIX.DNA), dnaId, newVersion, input.content, input.changeSummary ?? null, userId],
    );
  }
  return getTeamDna(userId, dnaId);
}

export async function createTeamBranch(userId: string, teamId: string, baseDnaId: string, title: string, content: string, changeSummary?: string): Promise<TeamDnaRow> {
  const base = await getTeamDna(userId, baseDnaId);
  if (base.team_id !== teamId) throw AppError.forbidden();
  return saveTeamDna(userId, {
    teamId,
    kind: base.kind,
    title,
    content,
    scope: 'BRANCH',
    parentVersionId: base.id,
    changeSummary,
  });
}

/**
 * Merge a BRANCH into MAIN. Conflict detection mirrors personal DNA: if the
 * base was updated after the branch was created, both versions are preserved
 * and an explicit resolution is required. Owner/admin only.
 */
export async function mergeTeamBranches(
  userId: string,
  teamId: string,
  branchDnaId: string,
  baseDnaId: string,
  resolution?: string,
  changeSummary?: string,
): Promise<TeamDnaRow> {
  const role = await teamRoleFor(userId, teamId);
  if (!role || (role !== 'owner' && role !== 'admin')) {
    throw AppError.forbidden('Only team owners and admins can merge DNA');
  }
  const branch = await getTeamDna(userId, branchDnaId);
  const base = await getTeamDna(userId, baseDnaId);
  if (branch.team_id !== teamId || base.team_id !== teamId) throw AppError.forbidden();
  if (branch.scope !== 'BRANCH' || base.scope !== 'MAIN') {
    throw AppError.badRequest('merge_invalid', 'Merge requires a BRANCH and a MAIN block');
  }

  const baseChangedAfterBranch = base.updated_at.getTime() > branch.created_at.getTime() + 1000;

  if (baseChangedAfterBranch) {
    await pool.query(
      `INSERT INTO team_dna_conflicts (id, branch_dna_id, base_dna_id, state) VALUES ($1,$2,$3,'CONFLICT')
       ON CONFLICT (branch_dna_id, base_dna_id) DO UPDATE SET state = 'CONFLICT', resolution = NULL, resolved_at = NULL`,
      [newId(PREFIX.DNA), branch.id, base.id],
    );
    await pool.query("UPDATE team_dna SET conflict_state = 'CONFLICT' WHERE id IN ($1,$2)", [branch.id, base.id]);
    throw AppError.conflict(
      'team_dna_conflict',
      'Conflicting team DNA changes detected. Both versions are preserved. Provide a resolution to merge.',
      { branchId: branch.id, baseId: base.id },
    );
  }

  const mergedContent = resolution ?? branch.content;
  await pool.query(
    `UPDATE team_dna SET conflict_state = 'RESOLVED', version = version + 1, parent_version_id = $2,
       content = $3, scope = 'MAIN', status = 'MERGED', merged_into_id = $4, change_summary = $5, updated_at = now()
     WHERE id = $1`,
    [base.id, branch.id, mergedContent, branch.id, changeSummary ?? `Merged branch ${branch.title}`],
  );
  await pool.query(
    `INSERT INTO team_dna_versions (id, dna_id, version, content_snapshot, change_summary, created_by)
     SELECT $1, id, version, content, $2, $3 FROM team_dna WHERE id = $4`,
    [newId(PREFIX.DNA), changeSummary ?? null, userId, base.id],
  );
  await pool.query(
    `UPDATE team_dna_conflicts SET state = 'RESOLVED', resolution = $2, resolved_at = now(), resolved_by = $3
     WHERE branch_dna_id = $1 OR base_dna_id = $1`,
    [branch.id, mergedContent, userId],
  );
  await recordAudit({
    action: AuditAction.DNA_TEAM_MERGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'team_dna',
    resourceId: base.id,
    detail: { teamId, branchId: branch.id },
  });
  return getTeamDna(userId, base.id);
}

/** Resolve a team DNA conflict (owner/admin only). */
export async function resolveTeamDnaConflict(userId: string, teamId: string, branchDnaId: string, baseDnaId: string, resolution: string): Promise<TeamDnaRow> {
  const role = await teamRoleFor(userId, teamId);
  if (!role || (role !== 'owner' && role !== 'admin')) {
    throw AppError.forbidden('Only team owners and admins can resolve conflicts');
  }
  const branch = await getTeamDna(userId, branchDnaId);
  const base = await getTeamDna(userId, baseDnaId);
  await pool.query(
    `UPDATE team_dna_conflicts SET state = 'RESOLVED', resolution = $1, resolved_at = now(), resolved_by = $2
     WHERE branch_dna_id = $3 AND base_dna_id = $4`,
    [resolution, userId, branch.id, base.id],
  );
  await pool.query("UPDATE team_dna SET conflict_state = 'RESOLVED' WHERE id IN ($1,$2)", [branch.id, base.id]);
  await recordAudit({
    action: AuditAction.DNA_TEAM_CONFLICT_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'team_dna',
    resourceId: base.id,
    detail: { teamId, branchId: branch.id },
  });
  return updateTeamDna(userId, base.id, { content: resolution, changeSummary: 'Conflict resolved' });
}