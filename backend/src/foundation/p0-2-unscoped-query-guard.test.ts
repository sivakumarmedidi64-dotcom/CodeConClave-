/**
 * CodeConClave — P0-2 Phase 3: prevent new unscoped tenant queries.
 *
 * There is no ESLint in this repository, and adding a lint toolchain for a
 * single rule is a larger, riskier change than the rule itself. This is instead
 * a pinned-baseline guard: it measures the number of bare `queryOne`/`queryMany`
 * call sites per file and fails if that count INCREASES.
 *
 * Why a baseline rather than a hard rule: 1200+ existing call sites predate this
 * work, and many are legitimately system-scoped (webhook receivers, background
 * workers, global catalogue reads). A hard "no bare query" rule would fail the
 * build on all of them at once. Pinning the baseline makes the staged migration
 * monotonic — Phase 2 conversions can only move the number down, and a new
 * unscoped query is a hard failure the moment it is introduced.
 *
 * A companion source scan documents the intended conversion target per file so
 * the remaining work is explicit rather than implied.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const backendRoot = resolve(__dirname, '..');
const scanRoots = ['modules', 'shared', 'foundation', 'workers', 'scripts', 'os', 'health', 'middleware', 'observability'];

interface FileUsage {
  file: string;
  calls: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Count bare `queryOne(` / `queryMany(` call sites. These are the pool-level
 * helpers that do NOT establish `app.current_user_id`, so they are the exact
 * population Phase 2 must convert onto withTenant/withSystem.
 */
function countBareCalls(source: string): number {
  const matches = source.match(/\bquery(?:One|Many)\s*[<(]/g);
  return matches ? matches.length : 0;
}

function collect(): { usage: FileUsage[]; total: number } {
  const usage: FileUsage[] = [];
  let total = 0;
  for (const root of scanRoots) {
    const dir = join(backendRoot, root);
    let files: string[];
    try {
      files = walk(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const calls = countBareCalls(readFileSync(file, 'utf8'));
      if (calls > 0) {
        usage.push({ file: relative(backendRoot, file).replace(/\\/g, '/'), calls });
        total += calls;
      }
    }
  }
  usage.sort((a, b) => b.calls - a.calls || a.file.localeCompare(b.file));
  return { usage, total };
}

const { usage, total } = collect();

/**
 * Pinned baseline. Intentionally set to the CURRENT measured value.
 *
 * Each Phase 2 batch that converts paths to withTenant/withSystem must LOWER
 * this number in the same commit. Raising it is the signal that a new unscoped
 * tenant query was introduced.
 *
 * Recorded 2026-09-28 at the start of the staged migration.
 */
const BASELINE_BARE_QUERY_CALLS = 1185;

const HIGH_RISK_TABLES = ['user_api_keys', 'workspaces', 'workspace_shares', 'payment_claims'];

describe('P0-2 Phase 3 — unscoped query guard', () => {
  it('never allows the bare-query population to grow', () => {
    // The guard itself is the deliverable: a regression here means someone added
    // a pool-level query that bypasses the tenant context.
    expect(total).toBeLessThanOrEqual(BASELINE_BARE_QUERY_CALLS);
  });

  it('reports the current migration progress against the baseline', () => {
    const converted = Math.max(0, BASELINE_BARE_QUERY_CALLS - total);
    process.stdout.write(
      `[p0-2-queries] bare=${total} baseline=${BASELINE_BARE_QUERY_CALLS} converted=${converted} files=${usage.length}\n`,
    );
    expect(total).toBeGreaterThan(0);
    expect(usage.length).toBeGreaterThan(0);
  });

  it('identifies the highest-density files as the Phase 2 work queue', () => {
    // A stable, reviewable work queue: the top offenders are converted first so
    // each batch produces a measurable reduction.
    const top = usage.slice(0, 10);
    process.stdout.write(
      `[p0-2-top] ${top.map((u) => `${u.file}=${u.calls}`).join(' ')}\n`,
    );
    expect(top.length).toBeGreaterThan(0);
    // Descending order must hold so the queue is genuinely a priority list.
    for (let i = 1; i < usage.length; i += 1) {
      expect(usage[i - 1].calls).toBeGreaterThanOrEqual(usage[i].calls);
    }
  });

  it('tracks the Phase 2 high-risk resources by file', () => {
    // user_api_keys service is the first converted target; the rest are queued.
    const apiKeysFile = usage.find((u) => u.file.endsWith('apikeys/service.ts'));
    expect(apiKeysFile).toBeDefined();
    process.stdout.write(
      `[p0-2-highrisk] ${HIGH_RISK_TABLES.join(',')} :: apikeys/service.ts bare=${apiKeysFile?.calls ?? 0}\n`,
    );
  });
});
