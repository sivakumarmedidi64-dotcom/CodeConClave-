/**
 * CodeConClave — DNA module.
 * Decisions, unresolved work, next actions, discoveries, blockers, project
 * context, relevant files, environment state, verification results.
 * Versioning + conflict detection + MAIN/BRANCH/MERGE for team DNA.
 * Never silently overwrite conflicting branches.
 */
import { pool, withTenant, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { DnaConflictState, DnaKind, DnaScope, AuditAction, type DnaBlock } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { logger } from '../../shared/logger.js';

export interface DnaRow {
  id: string;
  project_id: string;
  owner_id: string;
  kind: string;
  scope: string;
  title: string;
  content: string;
  version: number;
  parent_version_id: string | null;
  conflict_state: string;
  change_summary?: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SaveDnaInput {
  projectId: string;
  kind: string;
  title: string;
  content: string;
  scope?: 'MAIN' | 'BRANCH';
  auto?: boolean;
  parentVersionId?: string | null;
}

async function assertProjectAccess(q: { query: (t: string, p: unknown[]) => Promise<{ rows: unknown[] }> }, projectId: string): Promise<void> {
  const p = await q.query('SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL', [projectId]);
  if (!p.rows[0]) throw AppError.notFound('Project');
}

export async function saveDna(userId: string, input: SaveDnaInput): Promise<DnaRow> {
  const scope = input.scope ?? 'MAIN';
  const kind = Object.values(DnaKind).includes(input.kind as DnaKind)
    ? input.kind
    : DnaKind.PROJECT_CONTEXT;

  return withTenant(userId, async (q) => {
    await assertProjectAccess(q, input.projectId);

    // If the user is saving to MAIN while other MAIN blocks of the same kind
    // were updated by others since the user's last save... conflict detection
    // happens at merge; base versioning handled via dna_versions snapshots.

    const id = newId(PREFIX.DNA);
    const version = 1;
    await q.query(
      `INSERT INTO dna (id, project_id, owner_id, kind, scope, title, content, version, parent_version_id, conflict_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'NONE')`,
      [id, input.projectId, userId, kind, scope, input.title, input.content, version, input.parentVersionId ?? null],
    );
    await q.query(
      `INSERT INTO dna_versions (id, dna_id, version, content_snapshot, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId(PREFIX.DNA), id, version, input.content, userId],
    );
    const rows = await q.query<DnaRow>('SELECT * FROM dna WHERE id = $1', [id]);
    await recordAudit({
      action: AuditAction.DNA_CREATED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'dna',
      resourceId: id,
      detail: { auto: input.auto ?? false },
    });
    return rows.rows[0]!;
  });
}

export async function updateDna(userId: string, dnaId: string, input: { title?: string; content?: string; changeSummary?: string }): Promise<DnaRow> {
  const existing = await getDna(userId, dnaId);
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
  const updated = await withTenant(userId, async (q) => {
    await q.query(`UPDATE dna SET ${fields.join(', ')} WHERE id = $1`, params);
    if (input.content !== undefined) {
      await q.query(
        `INSERT INTO dna_versions (id, dna_id, version, content_snapshot, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId(PREFIX.DNA), dnaId, newVersion, input.content, userId],
      );
      if (input.changeSummary !== undefined) {
        await q.query(
          'UPDATE dna_versions SET change_summary = $2 WHERE dna_id = $1 AND version = $3',
          [dnaId, input.changeSummary, newVersion],
        );
      }
    }
    const rows = await q.query<DnaRow>('SELECT * FROM dna WHERE id = $1', [dnaId]);
    return rows.rows[0]!;
  });
  return updated;
}

export async function getDna(userId: string, dnaId: string): Promise<DnaRow> {
  const rows = await queryMany<DnaRow>(
    `SELECT * FROM dna WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
    [dnaId, userId],
  );
  if (!rows[0]) throw AppError.notFound('DNA block');
  return rows[0];
}

export async function listDna(userId: string, projectId: string, scope?: 'MAIN' | 'BRANCH'): Promise<DnaRow[]> {
  const params: unknown[] = [projectId];
  let scopeClause = '';
  if (scope) {
    params.push(scope);
    scopeClause = `AND scope = $${params.length}`;
  }
  return queryMany<DnaRow>(
    `SELECT * FROM dna WHERE project_id = $1 AND deleted_at IS NULL ${scopeClause}
     ORDER BY updated_at DESC`,
    params,
  );
}

export async function dnaVersions(userId: string, dnaId: string): Promise<unknown[]> {
  await getDna(userId, dnaId);
  return queryMany(
    `SELECT id, version, content_snapshot, created_by, created_at FROM dna_versions
     WHERE dna_id = $1 ORDER BY version DESC`,
    [dnaId],
  );
}

export async function compareDnaVersions(userId: string, dnaId: string, fromVersion: number, toVersion: number): Promise<{ before: string; after: string }> {
  await getDna(userId, dnaId);
  const rows = await queryMany<{ version: number; content_snapshot: string }>(
    'SELECT version, content_snapshot FROM dna_versions WHERE dna_id = $1 AND version IN ($2,$3)',
    [dnaId, fromVersion, toVersion],
  );
  const byVersion = new Map(rows.map((r) => [r.version, r.content_snapshot]));
  const before = byVersion.get(fromVersion);
  const after = byVersion.get(toVersion);
  if (!before || !after) throw AppError.notFound('DNA version');
  return { before, after };
}

export async function restoreDnaVersion(userId: string, dnaId: string, version: number): Promise<DnaRow> {
  const existing = await getDna(userId, dnaId);
  const rows = await queryMany<{ content_snapshot: string }>(
    'SELECT content_snapshot FROM dna_versions WHERE dna_id = $1 AND version = $2',
    [dnaId, version],
  );
  if (!rows[0]) throw AppError.notFound('DNA version');
  const updated = await updateDna(userId, dnaId, { content: rows[0].content_snapshot });
  await recordAudit({ action: AuditAction.DNA_RESTORED, actorUserId: userId, scope: 'USER', tenantId: userId, resourceType: 'dna', resourceId: dnaId, detail: { fromVersion: version, from: existing.version } });
  return updated;
}

// ---------------------------------------------------------------- branches & merge

export async function createBranch(userId: string, projectId: string, baseDnaId: string, title: string, content: string): Promise<DnaRow> {
  const base = await getDna(userId, baseDnaId);
  if (base.project_id !== projectId) throw AppError.forbidden();
  const branch = await saveDna(userId, {
    projectId,
    kind: base.kind,
    title,
    content,
    scope: 'BRANCH',
    parentVersionId: base.id,
  });
  return branch;
}

export async function mergeBranches(userId: string, projectId: string, branchDnaId: string, baseDnaId: string, resolution?: string): Promise<DnaRow> {
  const branch = await getDna(userId, branchDnaId);
  const base = await getDna(userId, baseDnaId);
  if (branch.project_id !== projectId || base.project_id !== projectId) throw AppError.forbidden();
  if (branch.scope !== 'BRANCH' || base.scope !== 'MAIN') {
    throw AppError.badRequest('merge_invalid', 'Merge requires a BRANCH and a MAIN block');
  }

  // Conflict detection: was the base updated after the branch was created?
  const branchCreatedAt = branch.created_at.getTime();
  const baseUpdatedAt = base.updated_at.getTime();
  const baseChangedAfterBranch = baseUpdatedAt > branchCreatedAt + 1000;

  if (baseChangedAfterBranch) {
    // Preserve both; mark conflict; require explicit resolution.
    const conflictId = newId(PREFIX.DNA);
    await pool.query(
      `INSERT INTO dna_conflicts (id, branch_dna_id, base_dna_id, state) VALUES ($1,$2,$3,'CONFLICT')
       ON CONFLICT (branch_dna_id, base_dna_id) DO UPDATE SET state = 'CONFLICT', resolution = NULL, resolved_at = NULL`,
      [conflictId, branch.id, base.id],
    );
    await pool.query("UPDATE dna SET conflict_state = 'CONFLICT' WHERE id IN ($1,$2)", [branch.id, base.id]);
    throw AppError.conflict(
      'dna_conflict',
      'Conflicting DNA changes detected. Both versions are preserved. Provide a resolution to merge.',
      { branchId: branch.id, baseId: base.id },
    );
  }

  const merged = await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE dna SET conflict_state = 'RESOLVED', version = version + 1, parent_version_id = $2, content = $3, scope = 'MAIN', updated_at = now()
       WHERE id = $1`,
      [base.id, branch.id, resolution ?? branch.content],
    );
    await q.query(
      `INSERT INTO dna_versions (id, dna_id, version, content_snapshot, created_by)
       SELECT $1, id, version, content, $2 FROM dna WHERE id = $3`,
      [newId(PREFIX.DNA), userId, base.id],
    );
    await q.query(
      `UPDATE dna_conflicts SET state = 'RESOLVED', resolution = $2, resolved_at = now(), resolved_by = $3
       WHERE branch_dna_id = $1 OR base_dna_id = $1`,
      [branch.id, resolution ?? branch.content, userId],
    );
    const rows = await q.query<DnaRow>('SELECT * FROM dna WHERE id = $1', [base.id]);
    return rows.rows[0]!;
  });
  return merged;
}

export async function resolveDnaConflict(userId: string, branchDnaId: string, baseDnaId: string, resolution: string, target: 'branch' | 'base'): Promise<DnaRow> {
  void target;
  const branch = await getDna(userId, branchDnaId);
  const base = await getDna(userId, baseDnaId);
  await pool.query(
    `UPDATE dna_conflicts SET state = 'RESOLVED', resolution = $1, resolved_at = now(), resolved_by = $2
     WHERE branch_dna_id = $3 AND base_dna_id = $4`,
    [resolution, userId, branch.id, base.id],
  );
  await pool.query("UPDATE dna SET conflict_state = 'RESOLVED' WHERE id IN ($1,$2)", [branch.id, base.id]);
  const updated = await updateDna(userId, base.id, { content: resolution });
  return updated;
}

// ---------------------------------------------------------------- export / trash

export async function exportDnaJsonl(userId: string, projectId: string): Promise<string> {
  const blocks = await listDna(userId, projectId);
  return blocks.map((b) => JSON.stringify(toDnaJson(b))).join('\n');
}

export async function softDeleteDna(userId: string, dnaId: string): Promise<void> {
  await getDna(userId, dnaId);
  await pool.query('UPDATE dna SET deleted_at = now() WHERE id = $1', [dnaId]);
}

export async function restoreDna(userId: string, dnaId: string): Promise<DnaRow> {
  const result = await pool.query(
    'UPDATE dna SET deleted_at = NULL WHERE id = $1 AND owner_id = $2 RETURNING *',
    [dnaId, userId],
  );
  if (!result.rows[0]) throw AppError.notFound('DNA block');
  return result.rows[0] as DnaRow;
}

export async function trashDna(userId: string): Promise<DnaRow[]> {
  return queryMany<DnaRow>(
    `SELECT * FROM dna WHERE owner_id = $1 AND deleted_at IS NOT NULL
     AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC`,
    [userId],
  );
}

export function toDnaJson(d: DnaRow): DnaBlock {
  return {
    id: d.id,
    projectId: d.project_id,
    ownerId: d.owner_id,
    kind: d.kind as DnaBlock['kind'],
    scope: d.scope as DnaBlock['scope'],
    title: d.title,
    content: d.content,
    version: d.version,
    parentVersionId: d.parent_version_id,
    conflictState: d.conflict_state as DnaBlock['conflictState'],
    deletedAt: d.deleted_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

// ---------------------------------------------------------------- Phase 6: prompt retrieval + auto-save

/**
 * Prompt-safe DNA retrieval (Phase 6): MAIN blocks only, conflicts excluded,
 * newest first. Used by the chat pipeline via retrieveScopedContext.
 */
export async function retrieveDnaForPrompt(userId: string, projectId?: string | null, limit = 5): Promise<string[]> {
  const rows = await queryMany<DnaRow>(
    `SELECT * FROM dna
     WHERE owner_id = $1 AND deleted_at IS NULL AND scope = 'MAIN'
       AND conflict_state <> 'CONFLICT'
       AND ($2::text IS NULL OR project_id = $2)
     ORDER BY updated_at DESC LIMIT $3`,
    [userId, projectId ?? null, limit],
  );
  return rows.map((d) => `[${d.kind} v${d.version}]: ${d.title} — ${String(d.content).slice(0, 500)}`);
}

/**
 * Auto-save project DNA after a task completes (Phase 6). Fire-and-forget:
 * failures are logged, never propagated — a completed task must not be undone
 * by a failed DNA write.
 */
export async function autoSaveTaskDna(input: {
  userId: string;
  projectId: string;
  taskId: string;
  title: string;
  description: string;
  outcome: string;
}): Promise<void> {
  try {
    await saveDna(input.userId, {
      projectId: input.projectId,
      kind: DnaKind.PROJECT_CONTEXT,
      title: `Task ${input.taskId.slice(0, 12)}: ${input.title.slice(0, 120)}`,
      content: `Completed task: ${input.description.slice(0, 2000)}\nOutcome: ${input.outcome.slice(0, 3000)}`,
      auto: true,
    });
  } catch (err) {
    logger.warn('auto DNA save failed', { taskId: input.taskId, error: (err as Error).message });
  }
}