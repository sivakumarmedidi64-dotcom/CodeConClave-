/**
 * CodeConClave — Superpowers: BLAMELESS ARCHIVIST (Master Feature #48).
 *
 * After every incident the complete story — timeline + cause + fix + prevention —
 * is filed into project memory in a retrievable way. When a similar issue is
 * worked weeks or months later, the related postmortems surface automatically
 * by token overlap. Incidents become training data, never forgotten threads.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface PostmortemRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  incident_id: string | null;
  title: string;
  summary: string;
  timeline: string | null;
  root_cause: string;
  fix: string;
  prevention: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): PostmortemRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  incident_id: r.incident_id ? String(r.incident_id) : null,
  title: String(r.title),
  summary: String(r.summary),
  timeline: r.timeline ? String(r.timeline) : null,
  root_cause: String(r.root_cause),
  fix: String(r.fix),
  prevention: r.prevention ? String(r.prevention) : null,
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findPostmortemById(userId: string, id: string): Promise<PostmortemRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    q
      .query<Record<string, unknown>>('SELECT * FROM postmortems WHERE id = $1 AND owner_id = $2', [id, userId])
      .then((r) => r.rows[0] ?? null),
  );
  if (!row) throw AppError.notFound('postmortem_not_found', 'no postmortem found for that id');
  return rowOf(row);
}

export interface ArchiveInput {
  incidentId?: string | null;
  projectId?: string | null;
  title: string;
  summary: string;
  timeline?: string | null;
  rootCause: string;
  fix: string;
  prevention?: string | null;
}

export async function archivePostmortem(userId: string, input: ArchiveInput): Promise<PostmortemRow> {
  const title = (input.title ?? '').trim();
  const summary = (input.summary ?? '').trim();
  const rootCause = (input.rootCause ?? '').trim();
  const fix = (input.fix ?? '').trim();
  if (!title || !summary || !rootCause || !fix) {
    throw AppError.badRequest('incomplete_postmortem', 'a postmortem needs a title, summary, root cause and fix');
  }
  if (input.incidentId) {
    const prior = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
      q
        .query<Record<string, unknown>>('SELECT * FROM postmortems WHERE owner_id = $1 AND incident_id = $2', [
          userId,
          input.incidentId,
        ])
        .then((r) => r.rows[0] ?? null),
    );
    if (prior) {
      await withTenant(userId, (q) =>
        q.query(
          'UPDATE postmortems SET summary = $3, timeline = $4, root_cause = $5, fix = $6, prevention = $7, updated_at = now() WHERE id = $1 AND owner_id = $2',
          [String(prior.id), userId, summary, input.timeline ?? null, rootCause, fix, input.prevention ?? null],
        ),
      );
      await recordAudit({
        action: AuditAction.MEMORY_ARCHIVED,
        actorUserId: userId,
        scope: 'USER',
        tenantId: userId,
        resourceType: 'postmortems',
        resourceId: String(prior.id),
        detail: { incidentId: input.incidentId, rearchive: true },
      });
      return findPostmortemById(userId, String(prior.id));
    }
  }
  const id = newId(PREFIX.POSTMORTEM);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO postmortems (id, owner_id, project_id, incident_id, title, summary, timeline, root_cause, fix, prevention) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, userId, input.projectId ?? null, input.incidentId ?? null, title, summary, input.timeline ?? null, rootCause, fix, input.prevention ?? null],
    ),
  );
  await recordAudit({
    action: AuditAction.MEMORY_ARCHIVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'postmortems',
    resourceId: id,
    detail: { incidentId: input.incidentId ?? null, rearchive: false },
  });
  return findPostmortemById(userId, id);
}

export async function listPostmortems(userId: string, filter: { term?: string } = {}): Promise<PostmortemRow[]> {
  let rows = (
    await withTenant<Record<string, unknown>[]>(userId, async (q) =>
      (await q.query<Record<string, unknown>>('SELECT * FROM postmortems WHERE owner_id = $1', [userId])).rows,
    )
  ).map(rowOf);
  if (filter.term) {
    const t = filter.term.toLowerCase();
    rows = rows.filter((r) => r.title.toLowerCase().includes(t) || r.summary.toLowerCase().includes(t) || r.root_cause.toLowerCase().includes(t));
  }
  return rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'is', 'it', 'we', 'i', 'that', 'this', 'with', 'was', 'are', 'at', 'by', 'how', 'what', 'why', 'when', 'did', 'does', 'fix', 'fixed', 'issue']);

export function tokenize(s: unknown): string[] {
  return String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Find postmortems related to a currently-worked problem. Scoring is a pure
 * token-overlap count across title/summary/root cause/fix/prevention.
 */
export async function retrieveRelatedPostmortems(userId: string, input: { query: string; limit?: number }): Promise<PostmortemRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20));
  const qTokens = new Set(tokenize(input.query));
  if (qTokens.size === 0) return [];
  const scored = (await listPostmortems(userId)).map((pm) => {
    const haystack = tokenize([pm.title, pm.summary, pm.root_cause, pm.fix, pm.prevention, pm.timeline].join(' '));
    const overlap = haystack.filter((t) => qTokens.has(t)).length;
    return { pm, overlap };
  });
  const matched = scored
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.pm.created_at.getTime() - a.pm.created_at.getTime()) || b.pm.id.localeCompare(a.pm.id))
    .slice(0, limit);
  const results = matched.map((s) => s.pm);
  if (results.length > 0) {
    await recordAudit({
      action: AuditAction.MEMORY_RETRIEVED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'postmortems',
      resourceId: null,
      detail: { query: input.query, results: results.length },
    });
  }
  return results;
}