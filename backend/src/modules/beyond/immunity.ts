/**
 * CodeConClave — Immunity (Beyond agentic #4, from "bug inoculation
 * networks"). When you fix a bug once, you record its pattern as a
 * "vaccine". CodeConClave then checks every one of YOUR projects for the same
 * pattern (and Night Shift re-checks nightly), so the bug is caught
 * everywhere before it bites again.
 *
 * Adapted honestly: the idea's cross-company "herd immunity" would share code
 * signals between strangers — CodeConClave keeps vaccines inside your own
 * account. Patterns are literal text or a SAFE regex (no backreferences or
 * nested repeats, bounded line length), so a pattern can never hang the
 * server.
 */
import { withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { listProjects } from '../projects/service.js';
import { globToRegExp } from '../control/permissionRules.js';
import { loadProjectSources } from './source.js';

export interface Vaccine {
  id: string;
  name: string;
  pattern: string;
  kind: 'literal' | 'regex';
  fileGlob: string | null;
  fixNote: string | null;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  lastScanAt: string | null;
  lastMatchCount: number;
  lastMatches: ImmunityMatch[];
  createdAt: string;
}

export interface ImmunityMatch {
  projectId: string;
  projectName: string;
  path: string;
  line: number;
  preview: string;
}

const MAX_VACCINES = 100;
const MAX_MATCHES = 200;
const MAX_LINE = 2_000;
const MAX_PROJECTS = 20;

/** Refuse regexes that can backtrack catastrophically. Pure (exported for tests). */
export function unsafeRegexReason(pattern: string): string | null {
  if (/\\[1-9]|\\k</.test(pattern)) return 'backreferences are not allowed';
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return 'a repeated group that itself repeats (e.g. (a+)+) is not allowed';
  if (/\(\?<?[=!]/.test(pattern)) return 'lookarounds are not allowed';
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return 'a repeated group with alternatives (e.g. (a|aa)+) is not allowed';
  try {
    new RegExp(pattern);
  } catch (err) {
    return `invalid regex: ${err instanceof Error ? err.message : 'syntax error'}`;
  }
  return null;
}

export function validateVaccine(body: unknown): Omit<Vaccine, 'id' | 'lastScanAt' | 'lastMatchCount' | 'lastMatches' | 'createdAt'> {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const pattern = typeof b.pattern === 'string' ? b.pattern : '';
  const kind = b.kind === 'regex' ? 'regex' : 'literal';
  const fileGlob = typeof b.fileGlob === 'string' && b.fileGlob.trim() ? b.fileGlob.trim() : null;
  const fixNote = typeof b.fixNote === 'string' && b.fixNote.trim() ? b.fixNote.trim().slice(0, 500) : null;
  const severity = (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).find((s) => s === b.severity) ?? 'MEDIUM';
  if (!name || name.length > 80) throw AppError.badRequest('invalid_vaccine_name', 'Give the vaccine a name (up to 80 characters).');
  if (!pattern.trim() || pattern.length > 300) throw AppError.badRequest('invalid_vaccine_pattern', 'The pattern is required (up to 300 characters).');
  if (kind === 'literal' && pattern.trim().length < 4) throw AppError.badRequest('invalid_vaccine_pattern', 'A text pattern needs at least 4 characters, or it would match almost everything.');
  if (kind === 'regex') {
    const why = unsafeRegexReason(pattern);
    if (why) throw AppError.badRequest('unsafe_vaccine_regex', `That regex can't be used: ${why}.`);
  }
  if (fileGlob && fileGlob.length > 120) throw AppError.badRequest('invalid_vaccine_glob', 'The file pattern is too long.');
  return { name, pattern, kind, fileGlob, fixNote, severity };
}

/** Matching lines in one file. Pure (exported for tests). */
export function matchLines(text: string, v: Pick<Vaccine, 'pattern' | 'kind'>, limit = 50): { line: number; preview: string }[] {
  const out: { line: number; preview: string }[] = [];
  const re = v.kind === 'regex' ? new RegExp(v.pattern) : null;
  const needle = v.pattern.toLowerCase();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i]!.length > MAX_LINE ? lines[i]!.slice(0, MAX_LINE) : lines[i]!;
    const hit = re ? re.test(line) : line.toLowerCase().includes(needle);
    if (hit) out.push({ line: i + 1, preview: line.trim().slice(0, 200) });
  }
  return out;
}

interface Row {
  id: string;
  name: string;
  pattern: string;
  kind: 'literal' | 'regex';
  file_glob: string | null;
  fix_note: string | null;
  severity: Vaccine['severity'];
  last_scan_at: Date | null;
  last_match_count: number;
  last_matches: ImmunityMatch[];
  created_at: Date;
}

const toVaccine = (r: Row): Vaccine => ({
  id: r.id,
  name: r.name,
  pattern: r.pattern,
  kind: r.kind,
  fileGlob: r.file_glob,
  fixNote: r.fix_note,
  severity: r.severity,
  lastScanAt: r.last_scan_at ? new Date(r.last_scan_at).toISOString() : null,
  lastMatchCount: r.last_match_count,
  lastMatches: Array.isArray(r.last_matches) ? r.last_matches : [],
  createdAt: new Date(r.created_at).toISOString(),
});

export async function listVaccines(userId: string): Promise<Vaccine[]> {
  const rows = await withTenant(userId, async (q) => (await q.query<Row>('SELECT * FROM immunity_vaccines WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows);
  return rows.map(toVaccine);
}

export async function addVaccine(userId: string, body: unknown): Promise<Vaccine> {
  const v = validateVaccine(body);
  const id = newId('vac');
  const row = await withTenant(userId, async (q) => {
    const n = Number((await q.query<{ n: string }>('SELECT count(*)::text AS n FROM immunity_vaccines WHERE user_id = $1', [userId])).rows[0]?.n ?? 0);
    if (n >= MAX_VACCINES) throw AppError.badRequest('too_many_vaccines', `You can keep up to ${MAX_VACCINES} vaccines.`);
    return (
      await q.query<Row>(
        `INSERT INTO immunity_vaccines (id, user_id, name, pattern, kind, file_glob, fix_note, severity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, userId, v.name, v.pattern, v.kind, v.fileGlob, v.fixNote, v.severity],
      )
    ).rows[0]!;
  });
  return toVaccine(row);
}

export async function deleteVaccine(userId: string, id: string): Promise<boolean> {
  const n = await withTenant(userId, async (q) => (await q.query('DELETE FROM immunity_vaccines WHERE id = $1 AND user_id = $2', [id, userId])).rowCount ?? 0);
  return n > 0;
}

/**
 * Check every project the user owns for each vaccine (or one vaccine).
 * Results are stored on the vaccine so the page and Night Shift can show them.
 */
export async function scanImmunity(
  userId: string,
  vaccineId?: string,
): Promise<{ vaccines: Vaccine[]; projectsScanned: number; filesScanned: number; failed: { projectName: string; reason: string }[] }> {
  const vaccines = (await listVaccines(userId)).filter((v) => !vaccineId || v.id === vaccineId);
  if (vaccineId && vaccines.length === 0) throw AppError.notFound('Vaccine');
  if (vaccines.length === 0) return { vaccines: [], projectsScanned: 0, filesScanned: 0, failed: [] };
  const projects = (await listProjects(userId)).slice(0, MAX_PROJECTS);
  const matches = new Map<string, ImmunityMatch[]>(vaccines.map((v) => [v.id, []]));
  let filesScanned = 0;
  // A project that cannot be read is reported back, never silently skipped.
  const failed: { projectName: string; reason: string }[] = [];
  for (const p of projects) {
    let sources: Awaited<ReturnType<typeof loadProjectSources>>;
    try {
      sources = await loadProjectSources(userId, p.id);
    } catch (err) {
      failed.push({ projectName: p.name, reason: err instanceof Error ? err.message.slice(0, 160) : 'could not be read' });
      continue;
    }
    for (const f of sources.files) {
      filesScanned += 1;
      for (const v of vaccines) {
        const list = matches.get(v.id)!;
        if (list.length >= MAX_MATCHES) continue;
        if (v.fileGlob && !globToRegExp(v.fileGlob).test(f.path)) continue;
        for (const hit of matchLines(f.text, v, MAX_MATCHES - list.length)) {
          list.push({ projectId: p.id, projectName: p.name, path: f.path, line: hit.line, preview: hit.preview });
        }
      }
    }
  }
  const updated: Vaccine[] = [];
  for (const v of vaccines) {
    const list = matches.get(v.id)!;
    const row = await withTenant(userId, async (q) =>
      (
        await q.query<Row>(
          `UPDATE immunity_vaccines SET last_scan_at = now(), last_match_count = $3, last_matches = $4::jsonb WHERE id = $1 AND user_id = $2 RETURNING *`,
          [v.id, userId, list.length, JSON.stringify(list)],
        )
      ).rows[0]!,
    );
    updated.push(toVaccine(row));
  }
  return { vaccines: updated, projectsScanned: projects.length - failed.length, filesScanned, failed };
}
