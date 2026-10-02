/**
 * CodeConClave — PKG-23 Memory Lifecycle & Bounded Retention.
 *
 * Developer records stay bounded: nothing grows without limit. Compaction:
 *   - supersede patterns that received NO confirmation/repeat evidence (the
 *     single-observation low-confidence ones) once they exceed a cap,
 *   - mark long-idle OPEN bug incidents as SUPERSEDED,
 *   - cap the newest kept preferences / links per project.
 * Memories themselves are never deleted here — they use the existing memory
 * system's correction/supersession lifecycle. Results are reported honestly.
 */
import { withTenant, pool, queryMany } from '../../shared/db.js';
import { listPatterns, listBugIncidents, type PatternRow, type BugIncidentRow } from './codingRecords.js';

export interface RetentionStats {
  preferences: number;
  patterns: number;
  activePatterns: number;
  bugIncidents: number;
  openIncidents: number;
  links: number;
}

export async function retentionStats(userId: string, projectId?: string | null): Promise<RetentionStats> {
  const [pref, pat, bug, links] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS n FROM dev_preferences WHERE owner_id = $1 ${projectId ? 'AND project_id = $2' : ''}`,
      projectId ? [userId, projectId] : [userId],
    ),
    pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'ACTIVE')::int AS active
         FROM dev_patterns WHERE owner_id = $1 ${projectId ? 'AND project_id = $2' : ''}`,
      projectId ? [userId, projectId] : [userId],
    ),
    pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'OPEN')::int AS open
         FROM dev_bug_incidents WHERE owner_id = $1 ${projectId ? 'AND project_id = $2' : ''}`,
      projectId ? [userId, projectId] : [userId],
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM memorycoding_links WHERE owner_id = $1 ${projectId ? 'AND project_id = $2' : ''}`,
      projectId ? [userId, projectId] : [userId],
    ),
  ]);
  return {
    preferences: pref.rows[0]?.n ?? 0,
    patterns: pat.rows[0]?.n ?? 0,
    activePatterns: pat.rows[0]?.active ?? 0,
    bugIncidents: bug.rows[0]?.n ?? 0,
    openIncidents: bug.rows[0]?.open ?? 0,
    links: links.rows[0]?.n ?? 0,
  };
}

export interface CompactOptions {
  maxPatterns?: number;
  maxPreferences?: number;
  maxLinks?: number;
  staleIncidentDays?: number;
  projectId?: string | null;
}

export async function compact(userId: string, opts: CompactOptions = {}): Promise<Record<string, number>> {
  const maxPatterns = opts.maxPatterns ?? 200;
  const maxPreferences = opts.maxPreferences ?? 400;
  const maxLinks = opts.maxLinks ?? 500;
  const staleDays = opts.staleIncidentDays ?? 90;
  const projectClause = opts.projectId ? 'AND project_id = $2' : '';
  const projectParams = opts.projectId ? [userId, opts.projectId] : [userId];

  // 1. Supercede the lowest-confidence ACTIVE patterns once the cap is exceeded.
  const patterns = await listPatterns(userId, opts.projectId ?? null);
  const weak = patterns
    .filter((p: PatternRow) => p.reject_count === 0 && p.evidence_count < 5)
    .sort((a, b) => (a.evidence_count + a.confirm_count) - (b.evidence_count + b.confirm_count));
  const overCount = patterns.length - maxPatterns;
  const excess = weak.slice(0, Math.max(0, overCount));
  for (const p of excess) {
    await withTenant(userId, (q) =>
      q.query("UPDATE dev_patterns SET status = 'SUPERSEDED', updated_at = now() WHERE id = $1 AND owner_id = $2", [p.id, userId]),
    );
  }

  // 2. Mark long-idle OPEN incidents SUPERSEDED.
  const incidents = await listBugIncidents(userId, opts.projectId ?? undefined);
  const cutoff = Date.now() - staleDays * 86400000;
  for (const b of incidents) {
    if (b.status !== 'OPEN') continue;
    if (Date.now() - (b.last_seen_at?.getTime?.() ?? Date.now()) > staleDays) {
      await withTenant(userId, (q) =>
        q.query(
          "UPDATE dev_bug_incidents SET status = 'SUPERSEDED', updated_at = now() WHERE id = $1 AND owner_id = $2",
          [b.id, userId],
        ),
      );
    }
  }
  void cutoff;

  // 3. Truncate oldest preferences beyond cap (id-aware, owner-scoped).
  const prefRows = await withTenant<{ id: string }[]>(userId, async (q) =>
    (
      await q.query<{ id: string }>(
        `SELECT id FROM dev_preferences WHERE owner_id = $1 ${projectClause} ORDER BY updated_at DESC LIMIT 99999`,
        projectParams,
      )
    ).rows,
  );
  if (prefRows.length > maxPreferences) {
    const drop = prefRows.slice(maxPreferences).map((r) => r.id);
    await withTenant(userId, (q) =>
      q.query('DELETE FROM dev_preferences WHERE id = ANY($1::text[]) AND owner_id = $2', [drop, userId]),
    );
  }

  // 4. Truncate oldest links beyond cap.
  const linkRows = await withTenant<{ id: string }[]>(userId, async (q) =>
    (
      await q.query<{ id: string }>(
        `SELECT id FROM memorycoding_links WHERE owner_id = $1 ${projectClause} ORDER BY created_at DESC LIMIT 99999`,
        projectParams,
      )
    ).rows,
  );
  if (linkRows.length > maxLinks) {
    const drop = linkRows.slice(maxLinks).map((r) => r.id);
    await withTenant(userId, (q) =>
      q.query('DELETE FROM memorycoding_links WHERE id = ANY($1::text[]) AND owner_id = $2', [drop, userId]),
    );
  }

  return {
    patternsSuperseded: excess.length,
    incidentsSuperseded: incidents.filter((b: BugIncidentRow) => b.status === 'OPEN').length,
    preferencesDropped: Math.max(0, prefRows.length - maxPreferences),
    linksDropped: Math.max(0, linkRows.length - maxLinks),
  };
}
