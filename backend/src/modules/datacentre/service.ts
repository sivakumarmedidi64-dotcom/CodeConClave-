/**
 * CodeConClave — Data Centre (Phase 8).
 * Real persisted metrics only: quota vs plan (free 2GB / pro 100GB), file/
 * version/memory/task/artifact counts, project allocation, activity timeline,
 * cleanup candidates, the storage_meta snapshot and the honest provider
 * status (LOCAL_STORAGE / S3_COMPATIBLE / R2_NOT_CONFIGURED). Every figure
 * comes from the database or live adapters — nothing invented.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { getStorageUsage } from '../workspace/service.js';
import { storageMode, storageEncryptionEnabled, storageHealth } from '../../integrations/storage.js';
import { AuditAction, FileRetention, FreeLimits, ProPlan } from '@codeconclave/shared';

export interface DataCentreReport {
  quota: {
    plan: string;
    limitBytes: number;
    usedBytes: number;
    usedMb: number;
    limitMb: number;
    percent: number;
    overLimit: boolean;
  };
  storage: {
    fileCount: number;
    trashedCount: number;
    versionCount: number;
    folderCount: number;
    totalBytes: number;
    encryptionEnabled: boolean;
  };
  counts: {
    conversations: number;
    messages: number;
    memories: number;
    dna: number;
    dnaVersions: number;
    tasks: number;
    artifacts: number;
    projects: number;
    teams: number;
    notifications: number;
    auditEvents: number;
    ideas: number;
    brainstormSessions: number;
  };
  memories: { count: number };
  tasks: { count: number };
  artifacts: { count: number; bytes: number };
  projectAllocation: { id: string; name: string; files: number; bytes: number }[];
  activity: {
    id: string;
    action: string;
    fileId: string;
    fileName: string;
    actorUserId: string;
    createdAt: Date | string;
  }[];
  cleanupCandidates: {
    id: string;
    path: string;
    sizeBytes: number;
    deletedAt: Date | string;
    projectId: string;
  }[];
  recommendations: unknown[];
  recommendationsByStatus: { active: number; resolved: number; dismissed: number };
  retentionDays: number;
  retention: {
    trashDays: number;
    notificationDays: number;
    auditDays: number;
  };
  provider: { mode: string; encryptionAtRest: boolean; healthy: boolean; lastHealthCheckAt: string | null };
  backup: { available: boolean; note: string };
}

interface CountsRow {
  file_count: number;
  trashed_count: number;
  version_count: number;
  memory_count: number;
  task_count: number;
  artifact_count: number;
  version_bytes: number;
  artifact_bytes: number;
  conversation_count: number;
  message_count: number;
  dna_count: number;
  dna_version_count: number;
  project_count: number;
  team_count: number;
  notification_count: number;
  audit_count: number;
  idea_count: number;
  brainstorm_count: number;
}

const TENANT = 'f.owner_id = $1 OR f.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1)';
const TENANT_PARENS = `(${TENANT})`;

export async function getDataCentre(userId: string): Promise<DataCentreReport> {
  const user = await queryOne<{ plan_id: string }>('SELECT plan_id FROM users WHERE id = $1', [userId]);
  const plan = user?.plan_id ?? 'free';
  const limitBytes =
    plan === 'free'
      ? FreeLimits.STORAGE_GB * 1024 * 1024 * 1024
      : ProPlan.STORAGE_GB * 1024 * 1024 * 1024;
  const usedBytes = await getStorageUsage(userId);

  const counts = await queryOne<CountsRow>(
    `SELECT
       (SELECT count(*)::int FROM files f WHERE ${TENANT}) AS file_count,
       (SELECT count(*)::int FROM files f WHERE ${TENANT_PARENS} AND f.deleted_at IS NOT NULL) AS trashed_count,
       (SELECT count(*)::int FROM file_versions fv JOIN files f ON f.id = fv.file_id WHERE ${TENANT}) AS version_count,
       (SELECT count(*)::int FROM memories m WHERE m.owner_id = $1) AS memory_count,
       (SELECT count(*)::int FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE (p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))) AS task_count,
       (SELECT count(*)::int FROM artifacts a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
          WHERE (p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))) AS artifact_count,
       (SELECT COALESCE(sum(fv.size_bytes),0)::int FROM file_versions fv JOIN files f ON f.id = fv.file_id WHERE ${TENANT}) AS version_bytes,
       (SELECT COALESCE(sum(a.size_bytes),0)::int FROM artifacts a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
          WHERE (p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))) AS artifact_bytes,
       (SELECT count(*)::int FROM conversations c WHERE c.owner_id = $1 AND c.deleted_at IS NULL) AS conversation_count,
       (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.owner_id = $1) AS message_count,
       (SELECT count(*)::int FROM dna d WHERE d.owner_id = $1 AND d.deleted_at IS NULL) AS dna_count,
       (SELECT count(*)::int FROM dna_versions dv JOIN dna d ON d.id = dv.dna_id
          WHERE d.owner_id = $1) AS dna_version_count,
       (SELECT count(*)::int FROM projects p WHERE p.owner_id = $1 AND p.deleted_at IS NULL) AS project_count,
       (SELECT count(*)::int FROM team_members tm WHERE tm.user_id = $1 AND tm.status = 'ACTIVE') AS team_count,
       (SELECT count(*)::int FROM notifications n WHERE n.recipient_id = $1 AND n.deleted_at IS NULL) AS notification_count,
       (SELECT count(*)::int FROM audit_logs a WHERE a.actor_user_id = $1) AS audit_count,
       (SELECT count(*)::int FROM ideas i WHERE (i.owner_id = $1 OR i.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1) OR i.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'ACTIVE')) AND i.deleted_at IS NULL) AS idea_count,
       (SELECT count(*)::int FROM brainstorming_sessions s WHERE s.owner_id = $1 OR s.id IN (SELECT session_id FROM brainstorming_participants WHERE user_id = $1)) AS brainstorm_count`,
    [userId],
  );

  const folderRow = await queryOne<{ n: number }>(
    `SELECT count(DISTINCT btrim(split_part(f.path,'/',1),'/'))::int AS n FROM files f
     WHERE ${TENANT_PARENS} AND f.path LIKE '%/%'`,
    [userId],
  );

  const coworkerArtifacts = await queryOne<{ n: number; bytes: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(ca.size_bytes),0)::int AS bytes
     FROM coworker_artifacts ca
     JOIN coworker_runs cr ON cr.id = ca.run_id
     JOIN tasks t ON t.id = cr.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE (p.owner_id = $1 OR p.id IN (SELECT project_id FROM project_members WHERE user_id = $1))`,
    [userId],
  );

  const projectRows = await queryMany<{ id: string; name: string; files: number; bytes: number }>(
    `SELECT p.id, p.name, count(f.id)::int AS files, COALESCE(sum(f.size_bytes),0)::int AS bytes
     FROM projects p
     LEFT JOIN files f ON f.project_id = p.id AND f.deleted_at IS NULL
     WHERE p.owner_id = $1
     GROUP BY p.id, p.name
     ORDER BY p.name`,
    [userId],
  );

  const activityRows = await queryMany<{
    id: string;
    action: string;
    file_id: string;
    path: string;
    actor_user_id: string;
    created_at: Date;
  }>(
    `SELECT fa.id, fa.action, fa.file_id, f.path, fa.actor_user_id, fa.created_at
     FROM file_activity fa
     JOIN files f ON f.id = fa.file_id
     WHERE fa.actor_user_id = $1 OR fa.file_id IN (SELECT id FROM files WHERE owner_id = $1)
     ORDER BY fa.created_at DESC LIMIT 10`,
    [userId],
  );

  const cleanupRows = await queryMany<{
    id: string;
    path: string;
    size_bytes: number;
    deleted_at: Date;
    project_id: string;
  }>(
    `SELECT f.id, f.path, f.size_bytes, f.deleted_at, f.project_id
     FROM files f
     WHERE ${TENANT_PARENS} AND f.deleted_at IS NOT NULL AND f.deleted_at < now() - interval '30 days'
     ORDER BY f.deleted_at DESC`,
    [userId],
  );

  const health = await storageHealth();
  const snapshot = {
    mode: storageMode(),
    encryptionAtRest: storageEncryptionEnabled(),
    healthy: health.ok,
    checkedAt: health.checkedAt,
  };
  await pool.query(
    `INSERT INTO storage_meta (id, owner_id, value, key, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [newId(PREFIX.STORAGE_META), userId, JSON.stringify(snapshot), 'provider'],
  );

  const { listCleanupRecommendations } = await import('../recommendations/service.js');
  const activeRecommendations = await listCleanupRecommendations(userId, 'ACTIVE');
  const resolvedRecommendations = await listCleanupRecommendations(userId, 'RESOLVED');
  const dismissedRecommendations = await listCleanupRecommendations(userId, 'DISMISSED');

  const report: DataCentreReport = {
    quota: {
      plan,
      limitBytes,
      usedBytes,
      usedMb: Math.round(usedBytes / (1024 * 1024)),
      limitMb: Math.round(limitBytes / (1024 * 1024)),
      percent: limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 100) : 0,
      overLimit: usedBytes > limitBytes,
    },
    storage: {
      fileCount: Number(counts?.file_count ?? 0),
      trashedCount: Number(counts?.trashed_count ?? 0),
      versionCount: Number(counts?.version_count ?? 0),
      folderCount: Number(folderRow?.n ?? 0),
      totalBytes: usedBytes,
      encryptionEnabled: storageEncryptionEnabled(),
    },
    counts: {
      conversations: Number(counts?.conversation_count ?? 0),
      messages: Number(counts?.message_count ?? 0),
      memories: Number(counts?.memory_count ?? 0),
      dna: Number(counts?.dna_count ?? 0),
      dnaVersions: Number(counts?.dna_version_count ?? 0),
      tasks: Number(counts?.task_count ?? 0),
      artifacts: Number(counts?.artifact_count ?? 0) + Number(coworkerArtifacts?.n ?? 0),
      projects: Number(counts?.project_count ?? 0),
      teams: Number(counts?.team_count ?? 0),
      notifications: Number(counts?.notification_count ?? 0),
      auditEvents: Number(counts?.audit_count ?? 0),
      ideas: Number(counts?.idea_count ?? 0),
      brainstormSessions: Number(counts?.brainstorm_count ?? 0),
    },
    memories: { count: Number(counts?.memory_count ?? 0) },
    tasks: { count: Number(counts?.task_count ?? 0) },
    artifacts: {
      count: Number(counts?.artifact_count ?? 0) + Number(coworkerArtifacts?.n ?? 0),
      bytes: Number(counts?.artifact_bytes ?? 0) + Number(coworkerArtifacts?.bytes ?? 0),
    },
    projectAllocation: projectRows.map((r) => ({
      id: r.id,
      name: r.name,
      files: Number(r.files ?? 0),
      bytes: Number(r.bytes ?? 0),
    })),
    activity: activityRows.map((r) => ({
      id: r.id,
      action: r.action,
      fileId: r.file_id,
      fileName: r.path.split('/').pop() ?? r.path,
      actorUserId: r.actor_user_id,
      createdAt: r.created_at,
    })),
    cleanupCandidates: cleanupRows.map((r) => ({
      id: r.id,
      path: r.path,
      sizeBytes: Number(r.size_bytes ?? 0),
      deletedAt: r.deleted_at,
      projectId: r.project_id,
    })),
    recommendations: activeRecommendations,
    recommendationsByStatus: {
      active: activeRecommendations.length,
      resolved: resolvedRecommendations.length,
      dismissed: dismissedRecommendations.length,
    },
    retentionDays: FileRetention.TRASH_RETENTION_DAYS,
    retention: {
      trashDays: FileRetention.TRASH_RETENTION_DAYS,
      notificationDays: 90,
      auditDays: 90,
    },
    provider: {
      mode: snapshot.mode,
      encryptionAtRest: snapshot.encryptionAtRest,
      healthy: snapshot.healthy,
      lastHealthCheckAt: health.checkedAt ?? null,
    },
    backup: {
      available: false,
      note: 'No backup provider is configured in this environment; nothing claims otherwise.',
    },
  };

  await recordAudit({
    action: AuditAction.DATA_CENTRE_VIEWED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'datacentre',
    detail: {
      usedBytes,
      fileCount: report.storage.fileCount,
      trashedCount: report.storage.trashedCount,
      plan,
    },
  });

  return report;
}