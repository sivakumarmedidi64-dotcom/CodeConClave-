/**
 * CodeConClave — unified trash (Phase 13).
 * Single recovery surface over existing soft-delete systems: files, projects,
 * conversations, memories, DNA and ideas. Lists items inside the 30-day
 * recovery window with deleted-by provenance (best-effort from audit_logs),
 * and supports restore / bulk restore / permanent delete / bulk purge / purge
 * expired. Every destructive action is audited and authorization is always
 * re-checked server-side (no silent destructive operations). Permanent delete
 * blocks on live references (dependency conflicts) instead of cascading
 * silently.
 */
import { pool, queryOne, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, FileRetention, TrashItemType } from '@codeconclave/shared';
import { restoreFile, permanentDeleteFile, purgeExpiredTrash } from '../files/service.js';
import { restoreProject } from '../projects/service.js';
import { restoreConversation } from '../conversations/service.js';
import { restoreMemory } from '../memory/service.js';
import { restoreDna } from '../dna/service.js';
import { restoreIdea, IDEA_TENANT_SQL } from '../ideas/service.js';

export interface TrashItem {
  type: string;
  id: string;
  name: string;
  deletedAt: Date;
  expiresAt: Date;
  deletedBy: string | null;
  projectId: string | null;
  projectName: string | null;
  teamId: string | null;
  teamName: string | null;
  sizeBytes: number;
}

function expiresAt(deletedAt: Date): Date {
  return new Date(new Date(deletedAt).getTime() + FileRetention.TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function deletedByLookup(
  userId: string,
  resourceType: string,
  action: string,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const rows = await queryMany<{ resource_id: string; actor_user_id: string }>(
    `SELECT DISTINCT ON (resource_id) resource_id, actor_user_id
     FROM audit_logs
     WHERE actor_user_id = $1 AND resource_type = $2 AND resource_id = ANY($3::text[]) AND action = $4
     ORDER BY resource_id, created_at DESC`,
    [userId, resourceType, ids, action],
  );
  for (const r of rows) map.set(r.resource_id, r.actor_user_id);
  return map;
}

const TENANT = '(f.owner_id = $1 OR f.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1))';
const TENANT_PARENS = `(${TENANT})`;
const WINDOW = `${FileRetention.TRASH_RETENTION_DAYS} days`;

export async function listTrash(userId: string): Promise<{ items: TrashItem[]; total: number }> {
  const items: TrashItem[] = [];

  const files = await queryMany<{
    id: string;
    path: string;
    size_bytes: number;
    deleted_at: Date;
    project_id: string;
    project_name: string | null;
    team_id: string | null;
    team_name: string | null;
  }>(
    `SELECT f.id, f.path, f.size_bytes, f.deleted_at, f.project_id,
            p.name AS project_name, p.team_id, t.name AS team_name
     FROM files f
     JOIN projects p ON p.id = f.project_id
     LEFT JOIN teams t ON t.id = p.team_id
     WHERE ${TENANT_PARENS} AND f.deleted_at IS NOT NULL AND f.deleted_at > now() - $2::interval
     ORDER BY f.deleted_at DESC LIMIT 200`,
    [userId, WINDOW],
  );
  const fileDeleters = await deletedByLookup(userId, 'file', 'file.trashed', files.map((f) => f.id));
  for (const f of files) {
    items.push({
      type: TrashItemType.FILE,
      id: f.id,
      name: f.path,
      deletedAt: f.deleted_at,
      expiresAt: expiresAt(f.deleted_at),
      deletedBy: fileDeleters.get(f.id) ?? null,
      projectId: f.project_id,
      projectName: f.project_name,
      teamId: f.team_id,
      teamName: f.team_name,
      sizeBytes: Number(f.size_bytes ?? 0),
    });
  }

  const projects = await queryMany<{ id: string; name: string; deleted_at: Date; team_id: string | null; team_name: string | null }>(
    `SELECT p.id, p.name, p.deleted_at, p.team_id, t.name AS team_name
     FROM projects p
     LEFT JOIN teams t ON t.id = p.team_id
     WHERE p.owner_id = $1 AND p.deleted_at IS NOT NULL AND p.deleted_at > now() - $2::interval
     ORDER BY p.deleted_at DESC LIMIT 200`,
    [userId, WINDOW],
  );
  const projectDeleters = await deletedByLookup(userId, 'project', 'project.deleted', projects.map((p) => p.id));
  for (const p of projects) {
    items.push({
      type: TrashItemType.PROJECT,
      id: p.id,
      name: p.name,
      deletedAt: p.deleted_at,
      expiresAt: expiresAt(p.deleted_at),
      deletedBy: projectDeleters.get(p.id) ?? null,
      projectId: null,
      projectName: null,
      teamId: p.team_id,
      teamName: p.team_name,
      sizeBytes: 0,
    });
  }

  const conversations = await queryMany<{ id: string; title: string; deleted_at: Date }>(
    `SELECT id, title, deleted_at FROM conversations
     WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at > now() - $2::interval
     ORDER BY deleted_at DESC LIMIT 200`,
    [userId, WINDOW],
  );
  const conversationDeleters = await deletedByLookup(userId, 'conversation', 'conversation.deleted', conversations.map((c) => c.id));
  for (const c of conversations) {
    items.push({
      type: TrashItemType.CONVERSATION,
      id: c.id,
      name: c.title,
      deletedAt: c.deleted_at,
      expiresAt: expiresAt(c.deleted_at),
      deletedBy: conversationDeleters.get(c.id) ?? null,
      projectId: null,
      projectName: null,
      teamId: null,
      teamName: null,
      sizeBytes: 0,
    });
  }

  const memories = await queryMany<{ id: string; content: string; deleted_at: Date }>(
    `SELECT id, content, deleted_at FROM memories
     WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at > now() - $2::interval
     ORDER BY deleted_at DESC LIMIT 200`,
    [userId, WINDOW],
  );
  const memoryDeleters = await deletedByLookup(userId, 'memory', 'memory.deleted', memories.map((m) => m.id));
  for (const m of memories) {
    items.push({
      type: TrashItemType.MEMORY,
      id: m.id,
      name: m.content.slice(0, 120),
      deletedAt: m.deleted_at,
      expiresAt: expiresAt(m.deleted_at),
      deletedBy: memoryDeleters.get(m.id) ?? null,
      projectId: null,
      projectName: null,
      teamId: null,
      teamName: null,
      sizeBytes: 0,
    });
  }

  const dna = await queryMany<{ id: string; title: string; deleted_at: Date }>(
    `SELECT id, title, deleted_at FROM dna
     WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at > now() - $2::interval
     ORDER BY deleted_at DESC LIMIT 200`,
    [userId, WINDOW],
  );
  const dnaDeleters = await deletedByLookup(userId, 'dna', 'dna.deleted', dna.map((d) => d.id));
  for (const d of dna) {
    items.push({
      type: TrashItemType.DNA,
      id: d.id,
      name: d.title,
      deletedAt: d.deleted_at,
      expiresAt: expiresAt(d.deleted_at),
      deletedBy: dnaDeleters.get(d.id) ?? null,
      projectId: null,
      projectName: null,
      teamId: null,
      teamName: null,
      sizeBytes: 0,
    });
  }

  const ideas = await queryMany<{ id: string; title: string; deleted_at: Date; project_id: string | null; team_id: string | null }>(
    `SELECT i.id, i.title, i.deleted_at, i.project_id, i.team_id FROM ideas i
     WHERE ${IDEA_TENANT_SQL} AND i.deleted_at IS NOT NULL AND i.deleted_at > now() - $2::interval
     ORDER BY i.deleted_at DESC LIMIT 200`,
    [userId, WINDOW],
  );
  const ideaDeleters = await deletedByLookup(userId, 'idea', 'idea.trashed', ideas.map((i) => i.id));
  for (const i of ideas) {
    items.push({
      type: TrashItemType.IDEA,
      id: i.id,
      name: i.title,
      deletedAt: i.deleted_at,
      expiresAt: expiresAt(i.deleted_at),
      deletedBy: ideaDeleters.get(i.id) ?? null,
      projectId: i.project_id,
      projectName: null,
      teamId: i.team_id,
      teamName: null,
      sizeBytes: 0,
    });
  }

  items.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
  return { items, total: items.length };
}

// ---------------------------------------------------------------- restore

export async function restoreItem(userId: string, type: string, id: string): Promise<void> {
  switch (type) {
    case TrashItemType.FILE: {
      const row = await queryOne<{ project_id: string }>(
        `SELECT project_id FROM files f WHERE id = $2 AND deleted_at IS NOT NULL AND ${TENANT_PARENS}`,
        [userId, id],
      );
      if (!row) throw AppError.notFound('File');
      await restoreFile(userId, row.project_id, id);
      break;
    }
    case TrashItemType.PROJECT:
      await restoreProject(userId, id);
      break;
    case TrashItemType.CONVERSATION:
      await restoreConversation(userId, id);
      break;
    case TrashItemType.MEMORY:
      await restoreMemory(userId, id);
      break;
    case TrashItemType.DNA:
      await restoreDna(userId, id);
      break;
    case TrashItemType.IDEA:
      await restoreIdea(userId, id);
      break;
    default:
      throw AppError.badRequest('invalid_type', `Unsupported trash item type: ${type}`);
  }
  await recordAudit({
    action: AuditAction.TRASH_RESTORED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: type,
    resourceId: id,
  });
}

export interface BulkItemResult {
  type: string;
  id: string;
  ok: boolean;
  errorCode?: string;
  message?: string;
}

export async function restoreBulk(userId: string, items: Array<{ type: string; id: string }>): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = [];
  for (const item of items) {
    try {
      await restoreItem(userId, item.type, item.id);
      results.push({ type: item.type, id: item.id, ok: true });
    } catch (err) {
      results.push({
        type: item.type,
        id: item.id,
        ok: false,
        errorCode: err instanceof AppError ? err.errorCode : 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------- permanent delete

/** Reference checks: permanent deletion must never orphan live dependents. */
async function assertNoLiveReferences(type: string, id: string): Promise<void> {
  if (type === TrashItemType.PROJECT) {
    const counts = await queryMany<{ n: number }>(
      `SELECT (
        (SELECT count(*)::int FROM tasks WHERE project_id = $1)
        + (SELECT count(*)::int FROM files WHERE project_id = $1 AND deleted_at IS NULL)
        + (SELECT count(*)::int FROM conversations WHERE project_id = $1 AND deleted_at IS NULL)
        + (SELECT count(*)::int FROM memories WHERE project_id = $1 AND deleted_at IS NULL)
      )::int AS n`,
      [id],
    );
    if ((counts[0]?.n ?? 0) > 0) {
      throw AppError.conflict('dependency_conflict', 'Project still has live tasks, files, conversations or memories');
    }
  } else if (type === TrashItemType.CONVERSATION) {
    const counts = await queryMany<{ n: number }>(
      'SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1',
      [id],
    );
    if ((counts[0]?.n ?? 0) > 0) {
      throw AppError.conflict('dependency_conflict', 'Conversation still has messages');
    }
  } else if (type === TrashItemType.MEMORY) {
    const counts = await queryMany<{ n: number }>(
      `SELECT (
        (SELECT count(*)::int FROM memory_sources WHERE memory_id = $1)
        + (SELECT count(*)::int FROM memory_relationships WHERE memory_a_id = $1 OR memory_b_id = $1)
      )::int AS n`,
      [id],
    );
    if ((counts[0]?.n ?? 0) > 0) {
      throw AppError.conflict('dependency_conflict', 'Memory still has sources or relationships');
    }
  } else if (type === TrashItemType.DNA) {
    const counts = await queryMany<{ n: number }>(
      `SELECT (
        (SELECT count(*)::int FROM dna_versions WHERE dna_id = $1)
        + (SELECT count(*)::int FROM dna_conflicts WHERE branch_dna_id = $1 OR base_dna_id = $1)
      )::int AS n`,
      [id],
    );
    if ((counts[0]?.n ?? 0) > 0) {
      throw AppError.conflict('dependency_conflict', 'DNA block still has versions or conflicts');
    }
  }
}

export async function purgeItem(userId: string, type: string, id: string): Promise<void> {
  switch (type) {
    case TrashItemType.FILE: {
      const row = await queryOne<{ project_id: string }>(
        `SELECT project_id FROM files f WHERE id = $2 AND deleted_at IS NOT NULL AND ${TENANT_PARENS}`,
        [userId, id],
      );
      if (!row) throw AppError.notFound('File');
      await permanentDeleteFile(userId, row.project_id, id);
      break;
    }
    case TrashItemType.PROJECT: {
      const row = await queryOne<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM projects WHERE id = $1 AND owner_id = $2',
        [id, userId],
      );
      if (!row) throw AppError.notFound('Project');
      if (!row.deleted_at) throw AppError.conflict('not_trashed', 'Only trashed items can be permanently deleted');
      await assertNoLiveReferences(type, id);
      await pool.query('DELETE FROM projects WHERE id = $1 AND owner_id = $2', [id, userId]);
      break;
    }
    case TrashItemType.CONVERSATION: {
      const row = await queryOne<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM conversations WHERE id = $1 AND owner_id = $2',
        [id, userId],
      );
      if (!row) throw AppError.notFound('Conversation');
      if (!row.deleted_at) throw AppError.conflict('not_trashed', 'Only trashed items can be permanently deleted');
      await assertNoLiveReferences(type, id);
      await pool.query('DELETE FROM conversations WHERE id = $1 AND owner_id = $2', [id, userId]);
      break;
    }
    case TrashItemType.MEMORY: {
      const row = await queryOne<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM memories WHERE id = $1 AND owner_id = $2',
        [id, userId],
      );
      if (!row) throw AppError.notFound('Memory');
      if (!row.deleted_at) throw AppError.conflict('not_trashed', 'Only trashed items can be permanently deleted');
      await assertNoLiveReferences(type, id);
      await pool.query('DELETE FROM memories WHERE id = $1 AND owner_id = $2', [id, userId]);
      break;
    }
    case TrashItemType.DNA: {
      const row = await queryOne<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM dna WHERE id = $1 AND owner_id = $2',
        [id, userId],
      );
      if (!row) throw AppError.notFound('DNA block');
      if (!row.deleted_at) throw AppError.conflict('not_trashed', 'Only trashed items can be permanently deleted');
      await assertNoLiveReferences(type, id);
      await pool.query('DELETE FROM dna WHERE id = $1 AND owner_id = $2', [id, userId]);
      break;
    }
    case TrashItemType.IDEA: {
      const row = await queryOne<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM ideas i WHERE i.id = $1 AND ${IDEA_TENANT_SQL}`,
        [id, userId],
      );
      if (!row) throw AppError.notFound('Idea');
      if (!row.deleted_at) throw AppError.conflict('not_trashed', 'Only trashed items can be permanently deleted');
      await pool.query('DELETE FROM ideas WHERE id = $1', [id]);
      break;
    }
    default:
      throw AppError.badRequest('invalid_type', `Unsupported trash item type: ${type}`);
  }
  await recordAudit({
    action: AuditAction.TRASH_PURGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: type,
    resourceId: id,
    detail: { permanent: true },
  });
}

export async function purgeBulk(userId: string, items: Array<{ type: string; id: string }>): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = [];
  for (const item of items) {
    try {
      await purgeItem(userId, item.type, item.id);
      results.push({ type: item.type, id: item.id, ok: true });
    } catch (err) {
      results.push({
        type: item.type,
        id: item.id,
        ok: false,
        errorCode: err instanceof AppError ? err.errorCode : 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Purge everything past the recovery window. Files reuse the existing
 * file-level expiry sweep; other types purge per-item, skipping any item that
 * hits a dependency conflict (never silent destruction).
 */
export async function purgeExpired(userId: string): Promise<{ purged: BulkItemResult[]; skipped: BulkItemResult[] }> {
  const purged: BulkItemResult[] = [];
  const skipped: BulkItemResult[] = [];

  const filePurged = await purgeExpiredTrash(userId);
  if (filePurged > 0) purged.push({ type: TrashItemType.FILE, id: '(batch)', ok: true });

  const targets: Array<{ type: string; id: string }> = [];
  const collect = async (sql: string, type: string) => {
    const rows = await queryMany<{ id: string }>(sql, [userId]);
    targets.push(...rows.map((r) => ({ type, id: r.id })));
  };
  await collect(
    `SELECT id FROM projects WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - $2::interval`,
    TrashItemType.PROJECT,
  );
  await collect(
    `SELECT id FROM conversations WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - $2::interval`,
    TrashItemType.CONVERSATION,
  );
  await collect(
    `SELECT id FROM memories WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - $2::interval`,
    TrashItemType.MEMORY,
  );
  await collect(
    `SELECT id FROM dna WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - $2::interval`,
    TrashItemType.DNA,
  );
  await collect(
    `SELECT id FROM ideas WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at < now() - $2::interval`,
    TrashItemType.IDEA,
  );

  for (const item of targets) {
    try {
      await purgeItem(userId, item.type, item.id);
      purged.push({ type: item.type, id: item.id, ok: true });
    } catch (err) {
      skipped.push({
        type: item.type,
        id: item.id,
        ok: false,
        errorCode: err instanceof AppError ? err.errorCode : 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { purged, skipped };
}