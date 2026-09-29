/**
 * CodeConClave â€” Superpowers: CHECKPOINT TIME MACHINE (Master Feature #68).
 *
 * Every coworker task auto-checkpoints. A checkpoint captures the REAL file
 * state of the project at a moment (path -> sha256 + size), plus optional
 * memory/context state supplied by the runtime. A checkpoint can be:
 *
 *   - restored: the manifest is returned so the runtime/UI can rewinds the
 *     sandbox to that exact moment.
 *   - forked: a NEW checkpoint is created as a branch of an existing one (the
 *     "drag the slider, fork from here" UX).
 *
 * Checkpoints are immutable rows: created state is never mutated; forking only
 * ever inserts. Every operation is audited (checkpoint.created / .forked /
 * .restored).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface CheckpointInput {
  taskId: string;
  projectId?: string | null;
  label?: string;
  manifest?: Record<string, unknown>;
}

export interface CheckpointRow {
  id: string;
  owner_id: string;
  task_id: string;
  project_id: string | null;
  label: string | null;
  manifest: Record<string, unknown>;
  forked_from: string | null;
  created_at: Date;
}

interface FileSnapshot {
  path: string;
  sha256: string;
  sizeBytes: number;
}

function rowOf(r: Record<string, unknown>): CheckpointRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    task_id: String(r.task_id),
    project_id: r.project_id === null ? null : String(r.project_id),
    label: r.label === null ? null : String(r.label),
    manifest: r.manifest && typeof r.manifest === 'object' ? (r.manifest as Record<string, unknown>) : {},
    forked_from: r.forked_from === null ? null : String(r.forked_from),
    created_at: new Date(String(r.created_at)),
  };
}

/** Capture the real file manifest for a project from the files table. */
async function captureFilesManifest(userId: string, projectId?: string | null): Promise<FileSnapshot[]> {
  if (!projectId) return [];
  try {
    return await withTenant<FileSnapshot[]>(userId, async (q) =>
      (
        await q.query<FileSnapshot>(
          `SELECT path, sha256, size_bytes AS "sizeBytes" FROM files
           WHERE project_id = $1 AND owner_id = $2 AND deleted_at IS NULL
           ORDER BY path LIMIT 2000`,
          [projectId, userId],
        )
      ).rows,
    );
  } catch {
    return [];
  }
}

export async function createCheckpoint(userId: string, input: CheckpointInput): Promise<CheckpointRow> {
  const taskId = (input.taskId ?? '').trim();
  if (!taskId) throw AppError.badRequest('task_id_required', 'A task id is required');
  const files = await captureFilesManifest(userId, input.projectId ?? null);
  const manifest: Record<string, unknown> = {
    files,
    capturedAt: new Date().toISOString(),
    ...(input.manifest ?? {}),
  };
  const id = newId(PREFIX.TASK_CHECKPOINT);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO task_checkpoint_manifests (id, owner_id, task_id, project_id, label, manifest, forked_from)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,NULL)`,
      [id, userId, taskId, input.projectId ?? null, input.label?.trim()?.slice(0, 200) || null, JSON.stringify(manifest)],
    ),
  );
  await recordAudit({
    action: AuditAction.CHECKPOINT_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task_checkpoint_manifests',
    resourceId: id,
    detail: { taskId, files: files.length },
  });
  return getCheckpoint(userId, id);
}

export async function getCheckpoint(userId: string, checkpointId: string): Promise<CheckpointRow> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        'SELECT * FROM task_checkpoint_manifests WHERE id = $1 AND owner_id = $2',
        [checkpointId, userId],
      )
    ).rows,
  );
  if (!rows[0]) throw AppError.notFound('Checkpoint');
  return rowOf(rows[0]);
}

export async function listCheckpoints(userId: string, taskId: string): Promise<CheckpointRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (
      await q.query<Record<string, unknown>>(
        'SELECT * FROM task_checkpoint_manifests WHERE owner_id = $1 AND task_id = $2 ORDER BY created_at ASC',
        [userId, taskId],
      )
    ).rows,
  );
  return rows.map(rowOf);
}

/** Restore: returns the immutable manifest of the checkpoint as a rewind target.
 *  The runtime consumes manifest.files to restore the sandbox to that state. */
export async function restoreCheckpoint(userId: string, checkpointId: string): Promise<CheckpointRow> {
  const cp = await getCheckpoint(userId, checkpointId);
  await recordAudit({
    action: AuditAction.CHECKPOINT_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task_checkpoint_manifests',
    resourceId: checkpointId,
    detail: { taskId: cp.task_id, files: Array.isArray(cp.manifest?.files) ? (cp.manifest.files as unknown[]).length : 0 },
  });
  return cp;
}

/** Fork: clone this checkpoint's manifest into a brand-new checkpoint for a
 *  task (the "continue from here" branch). The new row is immutable and
 *  references its parent via forked_from. */
export async function forkCheckpoint(userId: string, checkpointId: string, opts: { taskId?: string; label?: string }): Promise<CheckpointRow> {
  const source = await getCheckpoint(userId, checkpointId);
  const taskId = (opts.taskId ?? '').trim() || source.task_id;
  const id = newId(PREFIX.TASK_CHECKPOINT);
  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO task_checkpoint_manifests (id, owner_id, task_id, project_id, label, manifest, forked_from)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        id, userId, taskId, source.project_id,
        opts.label?.trim()?.slice(0, 200) ?? `fork of ${source.id.slice(0, 8)}`,
        JSON.stringify(source.manifest), source.id,
      ],
    ),
  );
  await recordAudit({
    action: AuditAction.CHECKPOINT_FORKED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'task_checkpoint_manifests',
    resourceId: id,
    detail: { sourceCheckpointId: source.id, taskId },
  });
  return getCheckpoint(userId, id);
}