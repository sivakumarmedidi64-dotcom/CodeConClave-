/**
 * CodeConClave — Code Thermostat (Beyond agentic #1, from "thermodynamic code
 * refactoring"). A project's code health as a temperature, 0 (cool) to 100
 * (critical), measured from its real files with an OPEN formula — every part
 * of the number is shown to the user, nothing is a black box:
 *
 *   temperature = 100 × ( 0.30·duplication + 0.20·size + 0.15·nesting
 *                         + 0.10·markers + 0.25·findings )
 *
 *   duplication  share of code lines inside a 6-line block that appears more
 *                than once (30% duplicated = full heat)
 *   size         share of code lines living in files over 400 lines
 *   nesting      share of code files nested 6+ levels deep
 *   markers      TODO/FIXME/HACK/XXX per 1,000 lines (10 = full heat)
 *   findings     severity-weighted findings of CodeConClave's static analyzers
 *                per 1,000 lines (30 = full heat)
 *
 * Every measurement is stored, so the trend is real history.
 */
import { withTenant } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { ANALYZERS } from '../quality-intelligence/analyzers.js';
import type { FindingSeverity } from '../quality-intelligence/types.js';
import { isCodePath, loadProjectSources } from './source.js';

export const WEIGHTS = { duplication: 0.3, size: 0.2, nesting: 0.15, markers: 0.1, findings: 0.25 } as const;
export const LARGE_FILE_LINES = 400;
export const DEEP_NESTING = 6;
const WINDOW = 6;
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { LOW: 1, MEDIUM: 3, HIGH: 6, CRITICAL: 10 };

export type Level = 'COOL' | 'WARM' | 'HOT' | 'CRITICAL';

export interface TemperatureComponents {
  duplication: { value: number; duplicatedLines: number; totalLines: number };
  size: { value: number; linesInLargeFiles: number; largeFiles: number };
  nesting: { value: number; deepFiles: number; codeFiles: number };
  markers: { value: number; count: number; per1kLines: number };
  findings: { value: number; weighted: number; per1kLines: number; bySeverity: Record<FindingSeverity, number> };
}

export interface HotFile {
  path: string;
  heat: number;
  lines: number;
  reasons: string[];
}

export interface Measurement {
  temperature: number;
  level: Level;
  components: TemperatureComponents;
  hottest: HotFile[];
  codeFiles: number;
  lines: number;
}

export function levelOf(t: number): Level {
  return t < 25 ? 'COOL' : t < 50 ? 'WARM' : t < 75 ? 'HOT' : 'CRITICAL';
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A code line worth comparing for duplication (not blank, not trivial, not an import). Pure. */
export function normalizeLine(line: string): string | null {
  const t = line.trim().replace(/\s+/g, ' ');
  if (t.length < 8) return null;
  if (/^(import |from \S+ import |#include|using |package |'use strict'|"use strict"|export \* from|\/\/|#|\*|\/\*)/.test(t)) return null;
  return t;
}

/** Deepest indentation level of a file (indent unit detected from the file). Pure. */
export function maxNesting(text: string): number {
  const indents: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const lead = /^[\t ]*/.exec(raw)![0];
    indents.push(lead.replace(/\t/g, '    ').length);
  }
  const nonZero = indents.filter((n) => n > 0);
  if (nonZero.length === 0) return 0;
  const unit = Math.max(2, Math.min(...nonZero.filter((n) => n >= 2), 8));
  return Math.max(...indents.map((n) => Math.floor(n / unit)));
}

/** Measure a set of files. Pure and deterministic (exported for tests). */
export function measure(files: { path: string; text: string; fileId?: string }[]): Measurement {
  const code = files.filter((f) => isCodePath(f.path));
  interface PerFile {
    lines: number;
    dupLines: Set<number>;
    depth: number;
    markers: number;
    weighted: number;
    findings: number;
    high: number;
    /** Normalized lines with their real line numbers (duplication windows index into this). */
    norm: { line: number; text: string }[];
  }
  const perFile = new Map<string, PerFile>();
  const windows = new Map<string, { path: string; line: number }[]>();
  let totalLines = 0;
  let markerCount = 0;
  const bySeverity: Record<FindingSeverity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };

  for (const f of code) {
    const rawLines = f.text.split(/\r?\n/);
    const nonBlank = rawLines.filter((l) => l.trim()).length;
    totalLines += nonBlank;
    const markers = (f.text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
    markerCount += markers;
    // Static analyzers already in CodeConClave (code smell, concurrency, leaks, type safety, invariants).
    let weighted = 0;
    let findings = 0;
    let high = 0;
    for (const analyzer of Object.values(ANALYZERS)) {
      for (const finding of analyzer({ fileId: f.fileId ?? f.path, path: f.path, text: f.text }, 50, 0)) {
        weighted += SEVERITY_WEIGHT[finding.severity] ?? 1;
        bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
        findings += 1;
        if (finding.severity === 'HIGH' || finding.severity === 'CRITICAL') high += 1;
      }
    }
    // Duplication windows over normalized lines (line numbers kept for attribution).
    const norm: { line: number; text: string }[] = [];
    rawLines.forEach((l, i) => {
      const n = normalizeLine(l);
      if (n) norm.push({ line: i + 1, text: n });
    });
    perFile.set(f.path, { lines: nonBlank, dupLines: new Set(), depth: maxNesting(f.text), markers, weighted, findings, high, norm });
    for (let i = 0; i + WINDOW <= norm.length; i++) {
      const key = norm.slice(i, i + WINDOW).map((x) => x.text).join('\n');
      const at = windows.get(key) ?? [];
      at.push({ path: f.path, line: i });
      windows.set(key, at);
    }
  }

  for (const hits of windows.values()) {
    if (hits.length < 2) continue;
    for (const h of hits) {
      const pf = perFile.get(h.path)!;
      for (let k = 0; k < WINDOW; k++) pf.dupLines.add(pf.norm[h.line + k]!.line);
    }
  }

  let duplicatedLines = 0;
  let linesInLargeFiles = 0;
  let largeFiles = 0;
  let deepFiles = 0;
  let weightedTotal = 0;
  for (const pf of perFile.values()) {
    duplicatedLines += pf.dupLines.size;
    if (pf.lines > LARGE_FILE_LINES) {
      linesInLargeFiles += pf.lines;
      largeFiles += 1;
    }
    if (pf.depth >= DEEP_NESTING) deepFiles += 1;
    weightedTotal += pf.weighted;
  }

  const per1k = (n: number) => (totalLines > 0 ? (n * 1000) / totalLines : 0);
  const components: TemperatureComponents = {
    duplication: { value: round2(clamp01(totalLines ? duplicatedLines / totalLines / 0.3 : 0)), duplicatedLines, totalLines },
    size: { value: round2(clamp01(totalLines ? linesInLargeFiles / totalLines : 0)), linesInLargeFiles, largeFiles },
    nesting: { value: round2(clamp01(code.length ? deepFiles / code.length : 0)), deepFiles, codeFiles: code.length },
    markers: { value: round2(clamp01(per1k(markerCount) / 10)), count: markerCount, per1kLines: round2(per1k(markerCount)) },
    findings: { value: round2(clamp01(per1k(weightedTotal) / 30)), weighted: weightedTotal, per1kLines: round2(per1k(weightedTotal)), bySeverity },
  };
  const temperature = Math.round(
    100 *
      (WEIGHTS.duplication * components.duplication.value +
        WEIGHTS.size * components.size.value +
        WEIGHTS.nesting * components.nesting.value +
        WEIGHTS.markers * components.markers.value +
        WEIGHTS.findings * components.findings.value),
  );

  const hottest: HotFile[] = [];
  for (const [path, pf] of perFile) {
    const dupShare = pf.lines ? pf.dupLines.size / pf.lines : 0;
    const filePer1k = pf.lines ? (1000 / pf.lines) : 0;
    const heat = Math.round(
      100 *
        (WEIGHTS.duplication * clamp01(dupShare / 0.3) +
          WEIGHTS.size * (pf.lines > LARGE_FILE_LINES ? clamp01(pf.lines / (LARGE_FILE_LINES * 3)) : 0) +
          WEIGHTS.nesting * (pf.depth >= DEEP_NESTING ? clamp01((pf.depth - DEEP_NESTING + 1) / 4) : 0) +
          WEIGHTS.markers * clamp01((pf.markers * filePer1k) / 10) +
          WEIGHTS.findings * clamp01((pf.weighted * filePer1k) / 30)),
    );
    if (heat <= 0) continue;
    const reasons: string[] = [];
    if (pf.dupLines.size > 0) reasons.push(`${Math.round(dupShare * 100)}% of its lines are duplicated`);
    if (pf.lines > LARGE_FILE_LINES) reasons.push(`${pf.lines} lines long`);
    if (pf.depth >= DEEP_NESTING) reasons.push(`nested ${pf.depth} levels deep`);
    if (pf.markers > 0) reasons.push(`${pf.markers} TODO/FIXME marker${pf.markers === 1 ? '' : 's'}`);
    if (pf.findings > 0) reasons.push(`${pf.findings} analyzer finding${pf.findings === 1 ? '' : 's'}${pf.high ? ` (${pf.high} high)` : ''}`);
    hottest.push({ path, heat, lines: pf.lines, reasons });
  }
  hottest.sort((a, b) => b.heat - a.heat || a.path.localeCompare(b.path));

  return { temperature, level: levelOf(temperature), components, hottest: hottest.slice(0, 10), codeFiles: code.length, lines: totalLines };
}

// ---------------------------------------------------------------- storage

export interface TemperatureSnapshot extends Measurement {
  id: string;
  projectId: string;
  source: 'manual' | 'night_shift';
  createdAt: string;
  /** Change since the previous measurement (null for the first one). */
  delta: number | null;
  skipped: { path: string; reason: string }[];
  capped: boolean;
}

interface Row {
  id: string;
  project_id: string;
  temperature: number;
  level: Level;
  components: TemperatureComponents;
  hottest: HotFile[];
  files_measured: number;
  lines_measured: number;
  source: 'manual' | 'night_shift';
  created_at: Date;
}

/** Measure a project now and store the result. */
export async function recordTemperature(userId: string, projectId: string, source: 'manual' | 'night_shift' = 'manual'): Promise<TemperatureSnapshot> {
  const sources = await loadProjectSources(userId, projectId);
  const m = measure(sources.files.map((f) => ({ path: f.path, text: f.text, fileId: f.fileId })));
  const id = newId('tmp');
  const previous = await withTenant(userId, async (q) =>
    (await q.query<{ temperature: number }>(
      'SELECT temperature FROM code_temperature_snapshots WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 1',
      [userId, projectId],
    )).rows[0],
  );
  const row = await withTenant(userId, async (q) =>
    (
      await q.query<Row>(
        `INSERT INTO code_temperature_snapshots (id, user_id, project_id, temperature, level, components, hottest, files_measured, lines_measured, source)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10) RETURNING *`,
        [id, userId, projectId, m.temperature, m.level, JSON.stringify(m.components), JSON.stringify(m.hottest), m.codeFiles, m.lines, source],
      )
    ).rows[0]!,
  );
  return {
    ...m,
    id: row.id,
    projectId,
    source,
    createdAt: new Date(row.created_at).toISOString(),
    delta: previous ? m.temperature - previous.temperature : null,
    skipped: sources.skipped.slice(0, 50),
    capped: sources.capped,
  };
}

/** Stored history, newest first (for the trend line). */
export async function temperatureHistory(userId: string, projectId: string, limit = 30): Promise<{ id: string; temperature: number; level: Level; source: string; createdAt: string; codeFiles: number; lines: number; components: TemperatureComponents; hottest: HotFile[] }[]> {
  const rows = await withTenant(userId, async (q) =>
    (
      await q.query<Row>(
        'SELECT * FROM code_temperature_snapshots WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT $3',
        [userId, projectId, Math.min(Math.max(limit, 1), 100)],
      )
    ).rows,
  );
  return rows.map((r) => ({
    id: r.id,
    temperature: r.temperature,
    level: r.level,
    source: r.source,
    createdAt: new Date(r.created_at).toISOString(),
    codeFiles: r.files_measured,
    lines: r.lines_measured,
    components: r.components,
    hottest: r.hottest,
  }));
}
