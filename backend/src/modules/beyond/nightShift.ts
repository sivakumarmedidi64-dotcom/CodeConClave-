/**
 * CodeConClave — Night Shift (Beyond agentic #5, from "algorithmic
 * sleep-cycle optimization"). While you sleep, CodeConClave measures and
 * checks your recently active projects and leaves a morning report:
 *   - Code Thermostat: new temperature, change since last time, hottest files
 *   - Council (deterministic, 0 tokens): files changed in the last 24 hours
 *   - Immunity: every vaccine re-checked across your projects
 *
 * Adapted honestly: the idea's agents "refactor your code overnight". Night
 * Shift never edits code — changing code needs your approval (constitution
 * Part I). It measures, checks and reports; you decide in the morning.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../config/env.js';
import { listProjects } from '../projects/service.js';
import { listFiles } from '../files/service.js';
import { recordTemperature } from './thermostat.js';
import { convene } from './council.js';
import { scanImmunity } from './immunity.js';
import { isCodePath, loadProjectSources } from './source.js';

const MAX_PROJECTS = 5;
const MAX_FILES_REVIEWED = 15;
const ACTIVE_DAYS = 7;

export interface NightShiftSummary {
  projects: { id: string; name: string; temperature: number; level: string; delta: number | null; hottest: { path: string; heat: number; reasons: string[] }[] }[];
  council: { projectId: string; projectName: string; path: string; verdict: string; top: string[] }[];
  immunity: { vaccineId: string; name: string; matches: number }[];
  filesReviewed: number;
  durationMs: number;
  headline: string;
  errors: string[];
}

export interface NightShiftReport {
  id: string;
  trigger: 'manual' | 'schedule';
  startedAt: string;
  finishedAt: string | null;
  summary: NightShiftSummary | Record<string, never>;
}

/** One-line morning headline from a summary. Pure (exported for tests). */
export function headlineOf(s: Omit<NightShiftSummary, 'headline' | 'durationMs'>): string {
  const parts: string[] = [];
  const warmer = s.projects.filter((p) => (p.delta ?? 0) > 0);
  const cooler = s.projects.filter((p) => (p.delta ?? 0) < 0);
  if (s.projects.length === 0) parts.push('No recently active projects to check');
  else parts.push(`${s.projects.length} project${s.projects.length === 1 ? '' : 's'} measured`);
  if (warmer.length) parts.push(`${warmer.length} got warmer`);
  if (cooler.length) parts.push(`${cooler.length} cooled down`);
  const blocked = s.council.filter((c) => c.verdict === 'DO_NOT_SHIP').length;
  if (blocked) parts.push(`${blocked} changed file${blocked === 1 ? '' : 's'} blocked by the Council`);
  const infected = s.immunity.filter((i) => i.matches > 0);
  if (infected.length) parts.push(`${infected.reduce((n, i) => n + i.matches, 0)} Immunity match${infected.length === 1 && infected[0]!.matches === 1 ? '' : 'es'}`);
  return `${parts.join(' · ')}.`;
}

/** Run Night Shift now for one user. Never edits code. */
export async function runNightShift(userId: string, trigger: 'manual' | 'schedule' = 'manual'): Promise<NightShiftReport> {
  const started = Date.now();
  const id = newId('nsr');
  await withTenant(userId, (q) => q.query(`INSERT INTO night_shift_reports (id, user_id, trigger) VALUES ($1,$2,$3)`, [id, userId, trigger]));
  const errors: string[] = [];
  const since = Date.now() - ACTIVE_DAYS * 86_400_000;
  const all = await listProjects(userId);
  const active = all
    .filter((p) => new Date((p as { updated_at?: Date | string }).updated_at ?? 0).getTime() >= since)
    .slice(0, MAX_PROJECTS);
  const projects: NightShiftSummary['projects'] = [];
  const council: NightShiftSummary['council'] = [];
  let filesReviewed = 0;
  const dayAgo = Date.now() - 86_400_000;

  for (const p of active) {
    try {
      const snap = await recordTemperature(userId, p.id, 'night_shift');
      projects.push({
        id: p.id,
        name: p.name,
        temperature: snap.temperature,
        level: snap.level,
        delta: snap.delta,
        hottest: snap.hottest.slice(0, 3).map((h) => ({ path: h.path, heat: h.heat, reasons: h.reasons })),
      });
    } catch (err) {
      errors.push(`${p.name}: temperature not measured (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`);
    }
    try {
      const files = await listFiles(userId, p.id);
      const changed = files
        .filter((f) => !f.isDirectory && isCodePath(f.path) && new Date(f.updatedAt).getTime() >= dayAgo)
        .slice(0, MAX_FILES_REVIEWED - filesReviewed);
      if (changed.length === 0) continue;
      const sources = await loadProjectSources(userId, p.id, { onlyFileIds: changed.map((f) => f.id) });
      const paths = files.map((f) => f.path);
      for (const src of sources.files) {
        const r = await convene({ path: src.path, text: src.text, projectPaths: paths });
        filesReviewed += 1;
        if (r.consensus.verdict === 'SHIP') continue;
        const top = r.lenses
          .flatMap((l) => l.findings.filter((f) => f.severity !== 'LOW').map((f) => `${l.bot}: ${f.title}${f.line ? ` (line ${f.line})` : ''}`))
          .slice(0, 3);
        council.push({ projectId: p.id, projectName: p.name, path: src.path, verdict: r.consensus.verdict, top });
      }
    } catch (err) {
      errors.push(`${p.name}: changed files not reviewed (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`);
    }
  }

  let immunity: NightShiftSummary['immunity'] = [];
  try {
    const scan = await scanImmunity(userId);
    immunity = scan.vaccines.map((v) => ({ vaccineId: v.id, name: v.name, matches: v.lastMatchCount }));
    for (const f of scan.failed) errors.push(`Immunity could not read ${f.projectName} (${f.reason})`);
  } catch (err) {
    errors.push(`Immunity not checked (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`);
  }

  const base = { projects, council, immunity, filesReviewed, errors };
  const summary: NightShiftSummary = { ...base, headline: headlineOf(base), durationMs: Date.now() - started };
  await withTenant(userId, (q) =>
    q.query(`UPDATE night_shift_reports SET finished_at = now(), summary = $3::jsonb WHERE id = $1 AND user_id = $2`, [id, userId, JSON.stringify(summary)]),
  );
  try {
    const { notify } = await import('../notifications/service.js');
    const { NotificationType } = await import('@codeconclave/shared');
    await notify(userId, NotificationType.DIGEST_DAILY, 'Night Shift report is ready', {
      body: summary.headline,
      resourceType: 'night_shift',
      resourceId: id,
    });
  } catch (err) {
    logger.warn('night shift notification not sent', { error: err instanceof Error ? err.message : String(err) });
  }
  return { id, trigger, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), summary };
}

export async function listNightShiftReports(userId: string, limit = 10): Promise<NightShiftReport[]> {
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<{ id: string; trigger: 'manual' | 'schedule'; started_at: Date; finished_at: Date | null; summary: NightShiftSummary }>(
        'SELECT id, trigger, started_at, finished_at, summary FROM night_shift_reports WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2',
        [userId, Math.min(Math.max(limit, 1), 50)],
      )
    ).rows,
  );
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    summary: r.summary ?? {},
  }));
}

/** The user's local hour, using the same offset as the weekly reset (330 = IST). Pure. */
export function localHour(now: Date, offsetMinutes: number): number {
  return Math.floor((((now.getTime() / 60_000 + offsetMinutes) % 1440) + 1440) % 1440 / 60);
}

/**
 * Watchdog sweep: users who turned Night Shift on (prefs.night_shift_enabled)
 * get one run per night at their chosen hour (prefs.night_shift_hour, default
 * 2 AM). At most 2 users per sweep keeps the watchdog responsive.
 */
export async function sweepNightShift(now = new Date()): Promise<number> {
  const hourNow = localHour(now, env.USAGE_WEEK_RESET_OFFSET_MINUTES);
  const due = await withSystem(async (q) =>
    (
      await q.query<{ owner_id: string }>(
        `SELECT p.owner_id FROM user_preferences p
          WHERE (p.prefs->>'night_shift_enabled') = 'true'
            AND (CASE WHEN (p.prefs->>'night_shift_hour') ~ '^[0-9]{1,2}$' THEN (p.prefs->>'night_shift_hour')::int ELSE 2 END) = $1
            AND NOT EXISTS (SELECT 1 FROM night_shift_reports r WHERE r.user_id = p.owner_id AND r.started_at > now() - interval '20 hours')
          LIMIT 2`,
        [hourNow],
      )
    ).rows,
  );
  let ran = 0;
  for (const { owner_id } of due) {
    try {
      await runNightShift(owner_id, 'schedule');
      ran += 1;
    } catch (err) {
      logger.warn('night shift run failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return ran;
}
