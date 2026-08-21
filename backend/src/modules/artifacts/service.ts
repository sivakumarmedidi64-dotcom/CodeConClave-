/**
 * CodeConClave — Artifact Center (Phase 8).
 * Task-scoped artifacts with authorization (owner/editor/member), SHA-256
 * verified content (inline or storage-backed), merged task + coworker
 * artifact listing, downloads and artifact→file references.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/crypto.js';
import { storage } from '../../integrations/storage.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, ArtifactKind } from '@codeconclave/shared';

export const ARTIFACT_STORAGE_PREFIX = 'codeconclave';

const ALLOWED_ROLES = new Set(['owner', 'editor', 'member']);

export interface ArtifactRow {
  id: string;
  task_id: string | null;
  name: string;
  kind: string;
  sha256: string;
  size_bytes: number;
  storage_key: string | null;
  content: string | null;
  attempt_id: string | null;
  verification: string | null;
  created_by: string | null;
  created_at: Date | string;
  task_title?: string | null;
  run_id?: string | null;
  coworker_type?: string | null;
}

export interface ArtifactView {
  id: string;
  name: string;
  kind: string;
  sha256: string;
  sizeBytes: number;
  content: string | null;
  storageKey: string | null;
  verification: string | null;
  attemptId: string | null;
  createdAt: Date | string;
  taskId: string | null;
  taskTitle: string | null;
  runId?: string | null;
  coworkerType?: string | null;
  source: 'task' | 'coworker';
}

function toView(row: ArtifactRow, source: 'task' | 'coworker'): ArtifactView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes ?? 0),
    content: row.content ?? null,
    storageKey: row.storage_key ?? null,
    verification: row.verification ?? null,
    attemptId: row.attempt_id ?? null,
    createdAt: row.created_at,
    taskId: row.task_id ?? null,
    taskTitle: row.task_title ?? null,
    runId: row.run_id ?? null,
    coworkerType: row.coworker_type ?? null,
    source,
  };
}

export interface CreateArtifactInput {
  userId: string;
  taskId: string;
  name: string;
  kind: string;
  content?: string;
  buffer?: Buffer;
  verification?: string | null;
  attemptId?: string | null;
}

export async function createTaskArtifact(input: CreateArtifactInput): Promise<ArtifactView> {
  const task = await queryOne<{ project_id: string; owner_id: string }>(
    'SELECT project_id, owner_id FROM tasks WHERE id = $1',
    [input.taskId],
  );
  if (!task) throw AppError.notFound('Task');

  if (task.owner_id !== input.userId) {
    const member = await queryOne<{ role: string }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [task.project_id, input.userId],
    );
    if (!member || !ALLOWED_ROLES.has(member.role)) {
      throw AppError.forbidden('artifact_access_denied', 'You do not have permission to add artifacts to this task');
    }
  }

  if (!Object.values(ArtifactKind).includes(input.kind as ArtifactKind)) {
    throw AppError.badRequest('invalid_kind', `kind must be one of: ${Object.values(ArtifactKind).join(', ')}`);
  }

  const id = newId(PREFIX.ARTIFACT);
  const content = input.content ?? null;
  const buffer = input.buffer ?? null;
  const sha = sha256Hex(buffer ?? Buffer.from(content ?? ''));
  const sizeBytes = buffer ? buffer.length : Buffer.byteLength(content ?? '');
  const storageKey =
    buffer !== null ? `${ARTIFACT_STORAGE_PREFIX}/artifacts/${task.project_id}/${input.taskId}/${id}` : null;

  if (buffer !== null) {
    await storage.put(storageKey!, buffer);
  }

  await pool.query(
    `INSERT INTO artifacts
       (id, task_id, name, kind, storage_key, sha256, size_bytes, content,
        attempt_id, verification, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
    [
      id, input.taskId, input.name, input.kind, storageKey, sha, sizeBytes, content,
      input.attemptId ?? null, input.verification ?? null, input.userId,
    ],
  );

  await recordAudit({
    action: AuditAction.ARTIFACT_CREATED,
    actorUserId: input.userId,
    scope: 'USER',
    tenantId: input.userId,
    resourceType: 'artifact',
    resourceId: id,
    detail: { taskId: input.taskId, kind: input.kind, name: input.name, sizeBytes },
  });

  const row = await queryOne<ArtifactRow>('SELECT * FROM artifacts a WHERE a.id = $1', [id]);
  if (!row) throw new Error('artifact insert returned no row');
  return toView(row, 'task');
}

export interface ArtifactFilters {
  taskId?: string;
  projectId?: string;
  kind?: string;
}

const ARTIFACT_TENANT =
  '(p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))';

export async function listArtifacts(userId: string, filters: ArtifactFilters = {}): Promise<ArtifactView[]> {
  const taskParams: unknown[] = [userId];
  const taskClauses: string[] = [ARTIFACT_TENANT];
  const coworkerParams: unknown[] = [userId];
  const coworkerClauses: string[] = [ARTIFACT_TENANT];

  if (filters.projectId) {
    taskParams.push(filters.projectId);
    taskClauses.push(`t.project_id = $${taskParams.length}`);
    coworkerParams.push(filters.projectId);
    coworkerClauses.push(`t.project_id = $${coworkerParams.length}`);
  }
  if (filters.taskId) {
    taskParams.push(filters.taskId);
    taskClauses.push(`a.task_id = $${taskParams.length}`);
    coworkerParams.push(filters.taskId);
    coworkerClauses.push(`t.id = $${coworkerParams.length}`);
  }
  if (filters.kind) {
    taskParams.push(filters.kind);
    taskClauses.push(`a.kind = $${taskParams.length}`);
    coworkerParams.push(filters.kind);
    coworkerClauses.push(`ca.kind = $${coworkerParams.length}`);
  }

  const taskRows = await queryMany<ArtifactRow>(
    `SELECT a.id, a.name, a.kind, a.sha256, a.size_bytes, a.content, a.storage_key,
            a.verification, a.attempt_id, a.created_at, a.task_id, t.title AS task_title
     FROM artifacts a
     JOIN tasks t ON t.id = a.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE ${taskClauses.join('\n  AND ')}
     ORDER BY a.created_at DESC`,
    taskParams,
  );
  const coworkerRows = await queryMany<ArtifactRow>(
    `SELECT ca.id, ca.name, ca.kind, ca.sha256, ca.size_bytes, ca.content, ca.storage_key,
            ca.verification, ca.attempt_id, ca.created_at, ca.run_id, cr.coworker_type,
            t.id AS task_id, t.title AS task_title
     FROM coworker_artifacts ca
     JOIN coworker_runs cr ON cr.id = ca.run_id
     JOIN tasks t ON t.id = cr.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE ${coworkerClauses.join('\n  AND ')}
     ORDER BY ca.created_at DESC`,
    coworkerParams,
  );

  const all = [
    ...coworkerRows.map((r) => toView(r, 'coworker')),
    ...taskRows.map((r) => toView(r, 'task')),
  ];
  all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return all;
}

async function assertArtifactAccess(userId: string, artifactId: string): Promise<ArtifactRow> {
  const row = await queryOne<ArtifactRow>(
    `SELECT a.* FROM artifacts a
     JOIN tasks t ON t.id = a.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE a.id = $1 AND (${ARTIFACT_TENANT})`,
    [artifactId, userId],
  );
  if (!row) throw AppError.notFound('Artifact');
  return row;
}

export async function downloadArtifact(
  userId: string,
  artifactId: string,
): Promise<{ content: string; encoding: 'utf8' | 'base64'; mimeType: string | null; name: string }> {
  const artifact = await assertArtifactAccess(userId, artifactId);
  const row = await queryOne<{ content: string | null; storage_key: string | null }>(
    'SELECT content, storage_key FROM artifacts WHERE id = $1',
    [artifactId],
  );
  let content: string;
  let encoding: 'utf8' | 'base64';
  if (row?.content !== null && row?.content !== undefined) {
    content = row.content;
    encoding = 'utf8';
  } else if (row?.storage_key) {
    const raw = await storage.get(row.storage_key);
    if (sha256Hex(raw) !== artifact.sha256) {
      throw AppError.conflict('hash_mismatch', 'Stored artifact content hash does not match the record');
    }
    content = raw.toString('base64');
    encoding = 'base64';
  } else {
    throw AppError.conflict('content_missing', 'Artifact has no stored content');
  }
  await recordAudit({
    action: AuditAction.ARTIFACT_DOWNLOADED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'artifact',
    resourceId: artifactId,
  });
  return { content, encoding, mimeType: null, name: artifact.name };
}

export interface ReferenceRow {
  id: string;
  file_id: string;
  ref_type: string;
  ref_id: string;
  created_by: string | null;
  created_at: Date | string;
}

export async function artifactReferences(userId: string, artifactId: string): Promise<ReferenceRow[]> {
  await assertArtifactAccess(userId, artifactId);
  const rows = await queryMany<ReferenceRow>(
    `SELECT fr.id, fr.file_id, fr.ref_type, fr.ref_id, fr.created_by, fr.created_at
     FROM file_references fr
     WHERE fr.ref_type = 'artifact' AND fr.ref_id = $1`,
    [artifactId],
  );
  return rows;
}