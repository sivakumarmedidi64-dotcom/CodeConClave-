/**
 * CodeConClave — cleanup recommendations (Phase 13).
 * Real, deterministic candidates derived from database queries only: expired
 * trash, duplicate files, old artifacts, stale file versions, expired
 * notifications. Each recommendation carries a reason, measurable storage
 * impact where available, affected resources, a reversibility classification
 * and the authorization level required to act. Recommendations are persisted
 * (cleanup_recommendations) but NEVER auto-applied — the user decides.
 */
import { pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction, CleanupCandidateType, CleanupRecommendationStatus, FileRetention } from '@codeconclave/shared';

export interface CleanupRecommendationRow {
  id: string;
  owner_id: string;
  candidate_type: string;
  reason: string;
  storage_impact_bytes: number;
  affected: Array<{ id: string; name: string }>;
  reversible: boolean;
  authorization_level: string;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
}

export function toRecommendationJson(r: CleanupRecommendationRow) {
  return {
    id: r.id,
    candidateType: r.candidate_type,
    reason: r.reason,
    storageImpactBytes: Number(r.storage_impact_bytes ?? 0),
    affected: r.affected ?? [],
    reversible: r.reversible,
    authorizationLevel: r.authorization_level,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? null,
  };
}

const TENANT = '(f.owner_id = $1 OR f.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1))';
const TENANT_PARENS = `(${TENANT})`;

interface CandidateSeed {
  candidateType: string;
  reason: string;
  storageImpactBytes: number;
  affected: Array<{ id: string; name: string }>;
  reversible: boolean;
  authorizationLevel: string;
}

/**
 * Regenerate recommendations deterministically: previous ACTIVE rows are
 * replaced, RESOLVED/DISMISSED history is preserved. Idempotent.
 */
export async function generateCleanupRecommendations(userId: string) {
  await pool.query(
    "DELETE FROM cleanup_recommendations WHERE owner_id = $1 AND status = 'ACTIVE'",
    [userId],
  );

  const candidates: CandidateSeed[] = [];

  const expiredFiles = await queryMany<{ id: string; path: string; size_bytes: number }>(
    `SELECT f.id, f.path, f.size_bytes FROM files f
     WHERE ${TENANT_PARENS} AND f.deleted_at IS NOT NULL AND f.deleted_at < now() - $2::interval
     ORDER BY f.deleted_at DESC`,
    [userId, `${FileRetention.TRASH_RETENTION_DAYS} days`],
  );
  if (expiredFiles.length) {
    const bytes = expiredFiles.reduce((n, f) => n + Number(f.size_bytes ?? 0), 0);
    candidates.push({
      candidateType: CleanupCandidateType.EXPIRED_TRASH,
      reason: `${expiredFiles.length} file(s) are past the ${FileRetention.TRASH_RETENTION_DAYS}-day recovery window`,
      storageImpactBytes: bytes,
      affected: expiredFiles.slice(0, 50).map((f) => ({ id: f.id, name: f.path })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const expiredConversations = await queryMany<{ id: string; title: string }>(
    `SELECT id, title FROM conversations WHERE owner_id = $1 AND deleted_at IS NOT NULL
       AND deleted_at < now() - $2::interval`,
    [userId, `${FileRetention.TRASH_RETENTION_DAYS} days`],
  );
  if (expiredConversations.length) {
    candidates.push({
      candidateType: CleanupCandidateType.EXPIRED_TRASH,
      reason: `${expiredConversations.length} conversation(s) are past the ${FileRetention.TRASH_RETENTION_DAYS}-day recovery window`,
      storageImpactBytes: 0,
      affected: expiredConversations.slice(0, 50).map((c) => ({ id: c.id, name: c.title })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const expiredMemories = await queryMany<{ id: string; content: string }>(
    `SELECT id, content FROM memories WHERE owner_id = $1 AND deleted_at IS NOT NULL
       AND deleted_at < now() - $2::interval`,
    [userId, `${FileRetention.TRASH_RETENTION_DAYS} days`],
  );
  if (expiredMemories.length) {
    candidates.push({
      candidateType: CleanupCandidateType.EXPIRED_TRASH,
      reason: `${expiredMemories.length} memory item(s) are past the ${FileRetention.TRASH_RETENTION_DAYS}-day recovery window`,
      storageImpactBytes: 0,
      affected: expiredMemories.slice(0, 50).map((m) => ({ id: m.id, name: m.content.slice(0, 120) })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const expiredDna = await queryMany<{ id: string; title: string }>(
    `SELECT id, title FROM dna WHERE owner_id = $1 AND deleted_at IS NOT NULL
       AND deleted_at < now() - $2::interval`,
    [userId, `${FileRetention.TRASH_RETENTION_DAYS} days`],
  );
  if (expiredDna.length) {
    candidates.push({
      candidateType: CleanupCandidateType.EXPIRED_TRASH,
      reason: `${expiredDna.length} DNA item(s) are past the ${FileRetention.TRASH_RETENTION_DAYS}-day recovery window`,
      storageImpactBytes: 0,
      affected: expiredDna.slice(0, 50).map((d) => ({ id: d.id, name: d.title })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const expiredIdeas = await queryMany<{ id: string; title: string }>(
    `SELECT id, title FROM ideas WHERE owner_id = $1 AND deleted_at IS NOT NULL
       AND deleted_at < now() - $2::interval`,
    [userId, `${FileRetention.TRASH_RETENTION_DAYS} days`],
  );
  if (expiredIdeas.length) {
    candidates.push({
      candidateType: CleanupCandidateType.EXPIRED_TRASH,
      reason: `${expiredIdeas.length} idea(s) are past the ${FileRetention.TRASH_RETENTION_DAYS}-day recovery window`,
      storageImpactBytes: 0,
      affected: expiredIdeas.slice(0, 50).map((i) => ({ id: i.id, name: i.title })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const duplicates = await queryMany<{ id: string; path: string; size_bytes: number }>(
    `SELECT f.id, f.path, f.size_bytes FROM files f
     WHERE ${TENANT_PARENS} AND f.deleted_at IS NULL AND f.sha256 IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM files g
         WHERE g.sha256 = f.sha256 AND g.project_id = f.project_id
           AND g.deleted_at IS NULL AND g.id < f.id
       )
     ORDER BY f.path LIMIT 200`,
    [userId],
  );
  if (duplicates.length) {
    const bytes = duplicates.reduce((n, f) => n + Number(f.size_bytes ?? 0), 0);
    candidates.push({
      candidateType: CleanupCandidateType.DUPLICATE_FILES,
      reason: `${duplicates.length} file(s) share content (same sha256) with an earlier copy in the same project`,
      storageImpactBytes: bytes,
      affected: duplicates.slice(0, 50).map((f) => ({ id: f.id, name: f.path })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const oldArtifacts = await queryMany<{ id: string; name: string; size_bytes: number }>(
    `SELECT a.id, a.name, a.size_bytes FROM artifacts a
     JOIN tasks t ON t.id = a.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE (p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))
       AND a.created_at < now() - interval '90 days'
     ORDER BY a.created_at ASC LIMIT 200`,
    [userId],
  );
  if (oldArtifacts.length) {
    const bytes = oldArtifacts.reduce((n, a) => n + Number(a.size_bytes ?? 0), 0);
    candidates.push({
      candidateType: CleanupCandidateType.OLD_ARTIFACTS,
      reason: `${oldArtifacts.length} artifact(s) are older than 90 days`,
      storageImpactBytes: bytes,
      affected: oldArtifacts.slice(0, 50).map((a) => ({ id: a.id, name: a.name })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const staleVersions = await queryMany<{ id: string; size_bytes: number; file_id: string }>(
    `SELECT fv.id, fv.size_bytes, fv.file_id FROM file_versions fv
     JOIN files f ON f.id = fv.file_id
     WHERE ${TENANT_PARENS} AND fv.created_at < now() - interval '90 days'
       AND fv.version < f.version
     ORDER BY fv.created_at ASC LIMIT 200`,
    [userId],
  );
  if (staleVersions.length) {
    const bytes = staleVersions.reduce((n, v) => n + Number(v.size_bytes ?? 0), 0);
    candidates.push({
      candidateType: CleanupCandidateType.STALE_VERSIONS,
      reason: `${staleVersions.length} file version(s) are older than 90 days and superseded`,
      storageImpactBytes: bytes,
      affected: staleVersions.slice(0, 50).map((v) => ({ id: v.id, name: v.file_id })),
      reversible: false,
      authorizationLevel: 'owner',
    });
  }

  const expiredNotifications = await queryMany<{ id: string; type: string }>(
    `SELECT id, type FROM notifications
     WHERE recipient_id = $1 AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < now()
     ORDER BY expires_at ASC LIMIT 200`,
    [userId],
  );
  if (expiredNotifications.length) {
    candidates.push({
      candidateType: CleanupCandidateType.EXPIRED_NOTIFICATIONS,
      reason: `${expiredNotifications.length} notification(s) have expired`,
      storageImpactBytes: 0,
      affected: expiredNotifications.slice(0, 50).map((n) => ({ id: n.id, name: n.type })),
      reversible: true,
      authorizationLevel: 'owner',
    });
  }

  for (const c of candidates) {
    await pool.query(
      `INSERT INTO cleanup_recommendations
         (id, owner_id, candidate_type, reason, storage_impact_bytes, affected, reversible, authorization_level)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [
        newId(PREFIX.CLEANUP),
        userId,
        c.candidateType,
        c.reason,
        c.storageImpactBytes,
        JSON.stringify(c.affected),
        c.reversible,
        c.authorizationLevel,
      ],
    );
  }

  if (candidates.length) {
    await recordAudit({
      action: AuditAction.CLEANUP_RECOMMENDED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'cleanup',
      detail: { count: candidates.length, types: candidates.map((c) => c.candidateType) },
    });
  }

  return candidates.length;
}

export async function listCleanupRecommendations(userId: string, status?: string) {
  const params: unknown[] = [userId];
  let where = 'owner_id = $1';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const rows = await queryMany<CleanupRecommendationRow>(
    `SELECT * FROM cleanup_recommendations WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(toRecommendationJson);
}

export async function resolveCleanupRecommendation(userId: string, recommendationId: string, status: string) {
  if (status !== CleanupRecommendationStatus.RESOLVED && status !== CleanupRecommendationStatus.DISMISSED) {
    throw AppError.badRequest('invalid_status', 'status must be RESOLVED or DISMISSED');
  }
  const rows = await queryMany<CleanupRecommendationRow>(
    `UPDATE cleanup_recommendations SET status = $1, resolved_at = now()
     WHERE id = $2 AND owner_id = $3 AND status = 'ACTIVE'
     RETURNING *`,
    [status, recommendationId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Cleanup recommendation');
  await recordAudit({
    action: AuditAction.CLEANUP_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'cleanup',
    resourceId: recommendationId,
    detail: { status },
  });
  return toRecommendationJson(rows[0]);
}