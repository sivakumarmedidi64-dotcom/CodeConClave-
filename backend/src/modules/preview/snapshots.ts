/**
 * Stage 26G — preview snapshots + visual diff (before/after).
 *
 * A snapshot captures the REAL session state at a point in time (state,
 * build log, version). The visual diff is honest: it returns the previous and
 * current snapshots only when at least two snapshots exist for the project —
 * otherwise null. Snapshot capture is best-effort from build transitions and
 * never fabricates a build result.
 */
import { queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { getPreview, type PreviewSessionRow } from './service.js';

export interface PreviewSnapshotRow {
  id: string;
  owner_id: string;
  project_id: string;
  version: number;
  state: string;
  build_log: string[] | null;
  created_at: Date;
}

export interface VisualDiff {
  projectId: string;
  before: PreviewSnapshotRow | null;
  after: PreviewSnapshotRow | null;
  available: boolean;
}

/** Capture a snapshot of the current session (best-effort; never throws). */
export async function capturePreviewSnapshot(
  userId: string,
  projectId: string,
): Promise<PreviewSnapshotRow | null> {
  try {
    const session = await getPreview(userId, projectId);
    const existing = await queryMany<PreviewSnapshotRow>(
      'SELECT * FROM preview_snapshots WHERE project_id = $1 AND version = $2',
      [projectId, session.version],
    );
    if (existing[0]) return existing[0];
    const id = `${session.id}.v${session.version}`;
    await dbPoolInsert(userId, projectId, session, id);
    await recordAudit({
      action: AuditAction.PREVIEW_SNAPSHOT_CAPTURED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'preview_snapshot',
      resourceId: id,
      detail: { projectId, version: session.version, state: session.state },
    }).catch(() => undefined);
    return {
      id,
      owner_id: userId,
      project_id: projectId,
      version: session.version,
      state: session.state,
      build_log: session.build_log ?? null,
      created_at: new Date(),
    };
  } catch {
    return null;
  }
}

async function dbPoolInsert(
  userId: string,
  projectId: string,
  session: PreviewSessionRow,
  id: string,
): Promise<void> {
  const { pool } = await import('../../shared/db.js');
  await pool.query(
    `INSERT INTO preview_snapshots (id, owner_id, project_id, version, state, build_log)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (project_id, version) DO NOTHING`,
    [id, userId, projectId, session.version, session.state, JSON.stringify(session.build_log ?? [])],
  );
}

/** Visual diff: the two most recent snapshots for the project, or null when
 * fewer than two exist (honest — no fabricated before/after). */
export async function previewVisualDiff(userId: string, projectId: string): Promise<VisualDiff> {
  await getPreview(userId, projectId);
  const snapshots = await queryMany<PreviewSnapshotRow>(
    'SELECT * FROM preview_snapshots WHERE owner_id = $1 AND project_id = $2 ORDER BY version DESC LIMIT 2',
    [userId, projectId],
  );
  const before = snapshots[1] ?? null;
  const after = snapshots[0] ?? null;
  await recordAudit({
    action: AuditAction.PREVIEW_DIFF_VIEWED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'preview_snapshot',
    resourceId: projectId,
    detail: { projectId, available: Boolean(before && after) },
  }).catch(() => undefined);
  return { projectId, before, after, available: Boolean(before && after) };
}

/** Auto-capture hook called from build transitions (before/after a build). */
export async function snapshotOnTransition(userId: string, projectId: string): Promise<void> {
  await capturePreviewSnapshot(userId, projectId).catch(() => undefined);
}