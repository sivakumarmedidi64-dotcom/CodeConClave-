/**
 * CodeConClave — Stage 26B: continuity — cross-project pattern memory,
 * handoffs, and the "while you were away" timeline.
 *
 * Cross-project suggestions are opt-in (users.cross_project_memory_opt_in),
 * read-only from OTHER projects the user owns, and are always presented as
 * suggestions — the engine never auto-applies them. Handoffs are exported
 * from REAL state (DNA, decisions, tasks, runs) and saved for review.
 * The timeline aggregates EXISTING tables only — no synthetic events.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

// ---------------------------------------------------------------------------
// Cross-project pattern memory (opt-in)

export interface PatternRow {
  id: string;
  owner_id: string;
  source_project_id: string;
  name: string;
  pattern: string;
  tag: string | null;
  proven: boolean;
  applied_count: number;
  created_at: Date;
}

function mapPattern(row: Record<string, unknown>): PatternRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    source_project_id: String(row.source_project_id),
    name: String(row.name),
    pattern: String(row.pattern),
    tag: row.tag === null ? null : String(row.tag),
    proven: Boolean(row.proven),
    applied_count: Number(row.applied_count ?? 0),
    created_at: new Date(String(row.created_at)),
  };
}

export async function getCrossProjectOptIn(userId: string): Promise<boolean> {
  const rows = await withTenant(userId, async (q) => (
    await q.query<{ cross_project_memory_opt_in: boolean }>(
      'SELECT cross_project_memory_opt_in FROM users WHERE id = $1',
      [userId],
    )
  ).rows);
  return rows[0]?.cross_project_memory_opt_in ?? false;
}

export async function setCrossProjectOptIn(userId: string, enabled: boolean): Promise<boolean> {
  await withTenant(userId, async (q) => {
    await q.query('UPDATE users SET cross_project_memory_opt_in = $1 WHERE id = $2', [enabled, userId]);
  });
  await recordAudit({
    action: AuditAction.CROSS_PROJECT_OPT_IN_CHANGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'users',
    resourceId: userId,
    detail: { enabled },
  });
  return enabled;
}

export async function addPattern(
  userId: string,
  input: { sourceProjectId: string; name: string; pattern: string; tag?: string; proven?: boolean },
): Promise<PatternRow> {
  const name = input.name.trim().slice(0, 200);
  const pattern = input.pattern.trim().slice(0, 4000);
  if (!name || !pattern) throw AppError.badRequest('pattern_required', 'Pattern name and body are required');
  const id = newId(PREFIX.CROSS_PROJECT_PATTERN);
  const rows = await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO cross_project_patterns (id, owner_id, source_project_id, name, pattern, tag, proven)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, userId, input.sourceProjectId, name, pattern, input.tag?.trim().slice(0, 50) ?? null, input.proven ?? false],
    );
    return (
      await q.query<Record<string, unknown>>('SELECT * FROM cross_project_patterns WHERE id = $1', [id])
    ).rows;
  });
  return mapPattern(rows[0]!);
}

/** Suggest patterns from OTHER projects (opt-in gate + tenant-scoped). */
export async function suggestPatterns(
  userId: string,
  projectId: string,
  tag?: string,
): Promise<{ suggestions: PatternRow[]; optIn: boolean }> {
  const optIn = await getCrossProjectOptIn(userId);
  if (!optIn) return { suggestions: [], optIn };
  const rows = await withTenant(userId, async (q) => (
    await q.query<Record<string, unknown>>(
      `SELECT * FROM cross_project_patterns
       WHERE owner_id = $1 AND source_project_id <> $2 ${tag ? 'AND tag = $3' : ''}
       ORDER BY proven DESC, applied_count DESC, created_at DESC LIMIT 10`,
      tag ? [userId, projectId, tag] : [userId, projectId],
    )
  ).rows);
  return { suggestions: rows.map(mapPattern), optIn };
}

function mapHandoff(row: Record<string, unknown>): HandoffRow {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    project_id: row.project_id === null ? null : String(row.project_id),
    title: String(row.title),
    content: String(row.content),
    created_at: new Date(String(row.created_at)),
  };
}

// ---------------------------------------------------------------------------
// Handoffs

export interface HandoffRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  content: string;
  created_at: Date;
}

export async function generateHandoff(userId: string, projectId?: string | null): Promise<{ title: string; content: string }> {
  const parts: string[] = [];
  let title = 'Project handoff';

  const collected = await withTenant(userId, async (q) => {
    const project = projectId
      ? (await q.query<{ name: string }>('SELECT name FROM projects WHERE id = $1 AND owner_id = $2', [projectId, userId])).rows[0]
      : undefined;
    const dna = projectId
      ? (await q.query<{ kind: string; title: string; content: string; updated_at: string }>(
          `SELECT kind, title, content, updated_at FROM dna WHERE project_id = $1 AND owner_id = $2 AND deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT 20`,
          [projectId, userId],
        )).rows
      : [];
    const decisions = projectId
      ? (await q.query<{ title: string; decision: string; impact: string; created_at: string }>(
          `SELECT title, decision, impact, created_at FROM agent_decisions
           WHERE owner_id = $1 AND project_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 15`,
          [userId, projectId],
        )).rows
      : [];
    const tasks = projectId
      ? (await q.query<{ title: string; status: string; created_at: string }>(
          `SELECT title, status, created_at FROM tasks
           WHERE owner_id = $1 AND project_id = $2 AND status IN ('CREATED','PLANNED','RUNNING','TESTING','BLOCKED','FAILED','WAITING_APPROVAL','WAITING_FOR_LOCAL_AGENT')
           ORDER BY created_at DESC LIMIT 20`,
          [userId, projectId],
        )).rows
      : [];
    const runs = (
      await q.query<{ objective: string | null; status: string; created_at: string }>(
        `SELECT objective, status, created_at FROM ai_agent_runs
         WHERE owner_id = $1 AND status IN ('THINKING','RUNNING','WAITING_FOR_APPROVAL','WAITING_FOR_DEPENDENCY','BLOCKED')
         ORDER BY created_at DESC LIMIT 10`,
        [userId],
      )
    ).rows;
    return { project, dna, decisions, tasks, runs };
  });

  if (collected.project) title = `${collected.project.name} — handoff`;
  parts.push(`# ${title}`);
  parts.push(`Generated ${new Date().toISOString()} — state is read from live records; nothing here is invented.`);

  if (projectId) {
    if (collected.dna.length > 0) {
      parts.push('\n## Current state (DNA)');
      for (const d of collected.dna) parts.push(`- [${d.kind}] ${d.title}: ${d.content.slice(0, 400)}`);
    } else {
      parts.push('\n## Current state (DNA)\n- None recorded yet.');
    }

    if (collected.decisions.length > 0) {
      parts.push('\n## Decisions (source of truth: agent_decisions)');
      for (const d of collected.decisions) parts.push(`- [${d.impact}] ${d.title}: ${d.decision.slice(0, 300)} (${d.created_at.slice(0, 10)})`);
    }

    if (collected.tasks.length > 0) {
      parts.push('\n## Open work (tasks)');
      for (const t of collected.tasks) parts.push(`- [${t.status}] ${t.title}`);
    }
  }

  if (collected.runs.length > 0) {
    parts.push('\n## In-flight agent runs');
    for (const r of collected.runs) parts.push(`- [${r.status}] ${r.objective ?? 'untitled'} (started ${r.created_at.slice(0, 10)})`);
  }

  await recordAudit({
    action: AuditAction.HANDOFF_EXPORTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'projects',
    resourceId: projectId,
    detail: { title },
  });
  return { title, content: parts.join('\n') };
}

export async function saveHandoff(
  userId: string,
  input: { projectId?: string | null; title: string; content: string },
): Promise<HandoffRow> {
  const title = input.title.trim().slice(0, 200);
  const content = input.content.trim();
  if (!title || !content) throw AppError.badRequest('handoff_required', 'Handoff title and content are required');
  const id = newId(PREFIX.HANDOFF);
  const rows = await withTenant(userId, async (q) => {
    await q.query(
      'INSERT INTO handoffs (id, owner_id, project_id, title, content) VALUES ($1,$2,$3,$4,$5)',
      [id, userId, input.projectId ?? null, title, content.slice(0, 20000)],
    );
    return (
      await q.query<Record<string, unknown>>('SELECT * FROM handoffs WHERE id = $1', [id])
    ).rows;
  });
  await recordAudit({
    action: AuditAction.HANDOFF_SAVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'handoffs',
    resourceId: id,
    detail: { title },
  });
  return mapHandoff(rows[0]!);
}

export async function listHandoffs(userId: string, projectId?: string): Promise<HandoffRow[]> {
  const rows = await withTenant(userId, async (q) => (
    await q.query<Record<string, unknown>>(
      `SELECT * FROM handoffs WHERE owner_id = $1 ${projectId ? 'AND project_id = $2' : ''} ORDER BY created_at DESC LIMIT 50`,
      projectId ? [userId, projectId] : [userId],
    )
  ).rows);
  return rows.map(mapHandoff);
}

export async function getHandoff(userId: string, handoffId: string): Promise<HandoffRow> {
  const rows = await withTenant(userId, async (q) => (
    await q.query<Record<string, unknown>>('SELECT * FROM handoffs WHERE id = $1 AND owner_id = $2', [handoffId, userId])
  ).rows);
  if (!rows[0]) throw AppError.notFound('Handoff');
  return mapHandoff(rows[0]);
}

export async function deleteHandoff(userId: string, handoffId: string): Promise<void> {
  await withTenant(userId, async (q) => {
    await q.query('DELETE FROM handoffs WHERE id = $1 AND owner_id = $2', [handoffId, userId]);
  });
}

// ---------------------------------------------------------------------------
// "While you were away" timeline — aggregates EXISTING tables only.

export interface TimelineItem {
  type: string;
  id: string;
  title: string;
  detail: string | null;
  at: string;
}

export async function getTimeline(userId: string, opts: { since?: string; projectId?: string; limit?: number }): Promise<TimelineItem[]> {
  const since = opts.since ? new Date(opts.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const items: TimelineItem[] = [];

  const push = async (rows: Array<Record<string, unknown>>, type: string, titleOf: (r: Record<string, unknown>) => string, detailOf: (r: Record<string, unknown>) => string | null, atOf: (r: Record<string, unknown>) => string) => {
  for (const r of rows) items.push({ type, id: String(r.id), title: titleOf(r), detail: detailOf(r), at: atOf(r) });
};

  const projectClause = opts.projectId ? 'AND project_id = $3' : '';
  const sinceClause = 'AND created_at >= $2';
  const params = (p: unknown[]) => (opts.projectId ? [...p, opts.projectId] : p);
  const base: unknown[] = [userId, since.toISOString()];

  const timelineRows = await withTenant(userId, async (q) => ({
    tasks: (
      await q.query<Record<string, unknown>>(
        `SELECT id, title, status, created_at FROM tasks WHERE owner_id = $1 ${sinceClause} ${projectClause} ORDER BY created_at DESC LIMIT 100`,
        params(base),
      )
    ).rows,
    runs: (
      await q.query<Record<string, unknown>>(
        `SELECT id, objective, status, created_at FROM ai_agent_runs WHERE owner_id = $1 ${sinceClause} ${projectClause} ORDER BY created_at DESC LIMIT 100`,
        params(base),
      )
    ).rows,
    previews: (
      await q.query<Record<string, unknown>>(
        `SELECT id, state, created_at FROM preview_sessions WHERE owner_id = $1 ${sinceClause} ${projectClause} ORDER BY created_at DESC LIMIT 100`,
        params(base),
      )
    ).rows,
    decisions: (
      await q.query<Record<string, unknown>>(
        `SELECT id, title, impact, created_at FROM agent_decisions WHERE owner_id = $1 ${sinceClause} ${projectClause} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`,
        params(base),
      )
    ).rows,
    debates: (
      await q.query<Record<string, unknown>>(
        `SELECT id, prompt, status, created_at FROM agent_debates WHERE owner_id = $1 ${sinceClause} ${projectClause} ORDER BY created_at DESC LIMIT 100`,
        params(base),
      )
    ).rows,
    audit: (
      await q.query<Record<string, unknown>>(
        `SELECT id, action, created_at FROM audit_logs
         WHERE tenant_id = $1 AND created_at >= $2 AND action IN
           ('APPROVAL_REQUESTED','APPROVAL_RESOLVED','MARKETPLACE_INSTALLED','MARKETPLACE_DISABLED','MARKETPLACE_ENABLED',
            'DECISION_RECORDED','DECISION_CONFLICT_RESOLVED','CROSS_PROJECT_OPT_IN_CHANGED','HANDOFF_SAVED','AGENT_TRUST_CHANGED')
         ORDER BY created_at DESC LIMIT 100`,
        [userId, since.toISOString()],
      )
    ).rows,
  }));

  await push(
    timelineRows.tasks,
    'task', (r) => String(r.title), (r) => `status ${String(r.status)}`, (r) => String(r.created_at),
  );
  await push(
    timelineRows.runs,
    'agent_run', (r) => String(r.objective ?? 'Agent run'), (r) => `status ${String(r.status)}`, (r) => String(r.created_at),
  );
  await push(
    timelineRows.previews,
    'preview', (r) => 'Preview session', (r) => `state ${String(r.state)}`, (r) => String(r.created_at),
  );
  await push(
    timelineRows.decisions,
    'decision', (r) => String(r.title), (r) => `impact ${String(r.impact)}`, (r) => String(r.created_at),
  );
  await push(
    timelineRows.debates,
    'debate', (r) => String(r.prompt).slice(0, 120), (r) => `status ${String(r.status)}`, (r) => String(r.created_at),
  );
  await push(
    timelineRows.audit,
    'audit', (r) => String(r.action), () => null, (r) => String(r.created_at),
  );

  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  return items.slice(0, limit);
}