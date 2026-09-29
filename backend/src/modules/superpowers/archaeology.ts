/**
 * CodeConClave — Superpowers: COMMIT ARCHAEOLOGIST (Master Feature #56).
 *
 * "What was going on when this function was written?" Origin insights record
 * the first-seen commit, date, author, PR summary and surrounding context for
 * every function worth explaining. Digging into inherited code answers *why
 * something exists* instead of leaving it a mystery; revisiting a site deepens
 * the record.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface OriginInsightRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  file_path: string;
  function_name: string;
  first_seen_commit: string;
  first_seen_date: Date | null;
  author: string;
  pr_summary: string | null;
  context: string | null;
  depth: number;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): OriginInsightRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  file_path: String(r.file_path),
  function_name: String(r.function_name),
  first_seen_commit: String(r.first_seen_commit),
  first_seen_date: r.first_seen_date ? new Date(r.first_seen_date as string) : null,
  author: String(r.author),
  pr_summary: r.pr_summary ? String(r.pr_summary) : null,
  context: r.context ? String(r.context) : null,
  depth: Number(r.depth ?? 1),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export interface RecordOriginInput {
  filePath: string;
  functionName: string;
  commit: string;
  date?: string | null;
  author: string;
  prSummary?: string | null;
  context?: string | null;
  depth?: number;
  projectId?: string | null;
}

export async function recordOrigin(userId: string, input: RecordOriginInput): Promise<OriginInsightRow> {
  const filePath = (input.filePath ?? '').trim();
  const functionName = (input.functionName ?? '').trim();
  const commit = (input.commit ?? '').trim();
  const author = (input.author ?? '').trim();
  if (!filePath || !functionName || !commit || !author) {
    throw AppError.badRequest('incomplete_origin', 'file path, function, commit and author are required');
  }
  const existing = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM file_origin_insights WHERE owner_id = $1 AND file_path = $2 AND function_name = $3',
      [userId, filePath, functionName],
    )).rows[0] ?? null,
  );
  if (existing) {
    const depth = Number(existing.depth ?? 1) + 1;
    const prSummary = input.prSummary !== undefined && input.prSummary !== null ? input.prSummary : existing.pr_summary ? String(existing.pr_summary) : null;
    const context = input.context !== undefined && input.context !== null ? input.context : existing.context ? String(existing.context) : null;
    await withTenant(userId, (q) =>
      q.query(
        'UPDATE file_origin_insights SET pr_summary = $3, context = $4, depth = $5, updated_at = now() WHERE id = $1 AND owner_id = $2',
        [String(existing.id), userId, prSummary, context, depth],
      ),
    );
    await recordAudit({
      action: AuditAction.ARCHAEOLOGY_RECORDED,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'file_origin_insights',
      resourceId: String(existing.id),
      detail: { filePath, functionName, commit, depth, revisited: true },
    });
    return findOrigin(userId, filePath, functionName);
  }
  const id = newId(PREFIX.ORIGIN_INSIGHT);
  await withTenant(userId, (q) =>
    q.query(
      'INSERT INTO file_origin_insights (id, owner_id, project_id, file_path, function_name, first_seen_commit, first_seen_date, author, pr_summary, context, depth) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, userId, input.projectId ?? null, filePath, functionName, commit, input.date ?? null, author, input.prSummary ?? null, input.context ?? null, input.depth ?? 1],
    ),
  );
  await recordAudit({
    action: AuditAction.ARCHAEOLOGY_RECORDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file_origin_insights',
    resourceId: id,
    detail: { filePath, functionName, commit, depth: input.depth ?? 1, revisited: false },
  });
  return findOrigin(userId, filePath, functionName);
}

export async function findOrigin(userId: string, filePath: string, functionName: string): Promise<OriginInsightRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM file_origin_insights WHERE owner_id = $1 AND file_path = $2 AND function_name = $3',
      [userId, filePath, functionName],
    )).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('no_origin_recorded', 'no origin insight recorded for that function');
  return rowOf(row);
}

export async function dig(userId: string, filePath: string, functionName: string): Promise<OriginInsightRow> {
  const insight = await findOrigin(userId, filePath, functionName);
  await recordAudit({
    action: AuditAction.ARCHAEOLOGY_DUG,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'file_origin_insights',
    resourceId: insight.id,
    detail: { filePath, functionName },
  });
  return insight;
}

export async function reconstructByCommit(userId: string, commit: string): Promise<OriginInsightRow[]> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM file_origin_insights WHERE first_seen_commit = $1 AND owner_id = $2', [commit, userId])).rows,
  );
  return rows
    .map(rowOf)
    .sort((a, b) => a.file_path.localeCompare(b.file_path) || a.function_name.localeCompare(b.function_name));
}

export async function listDigs(userId: string, filter: { term?: string } = {}): Promise<OriginInsightRow[]> {
  let rows = (await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM file_origin_insights WHERE owner_id = $1', [userId])).rows,
  )).map(rowOf);
  if (filter.term) {
    const t = filter.term.toLowerCase();
    rows = rows.filter(
      (r) => r.file_path.toLowerCase().includes(t) || r.function_name.toLowerCase().includes(t) || r.author.toLowerCase().includes(t),
    );
  }
  return rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || b.id.localeCompare(a.id));
}