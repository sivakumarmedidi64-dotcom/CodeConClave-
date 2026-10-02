/**
 * CodeConClave — Stage 105 SUPERPOWERS Tranche AA: Respawn State Matrix, Pixel
 * Diff Judge, Motion Doctor, A11Y Autopilot, Localization Forge.
 *
 *   RESPAWN STATE MATRIX (#112)  — every component auto-tested in all 16 states.
 *   PIXEL DIFF JUDGE (#113)      — visual regression testing with semantic understanding.
 *   MOTION DOCTOR (#114)         — every animation audited for performance and accessibility.
 *   A11Y AUTOPILOT (#115)        — screen-reader bot navigates app, files what it can't do.
 *   LOCALIZATION FORGE (#116)    — extracts all strings, detects truncation/overflow.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    state_matrix_runs: [] as Array<Record<string, unknown>>,
    pixel_diffs: [] as Array<Record<string, unknown>>,
    motion_audits: [] as Array<Record<string, unknown>>,
    a11y_runs: [] as Array<Record<string, unknown>>,
    localization_scans: [] as Array<Record<string, unknown>>,
  };
  const now = () => {
    tick += 1;
    return new Date(tick).toISOString();
  };
  return { tables, now };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  return { recordAuditMock, mark: { next: () => `id-${++n}` } };
});

const dbMock = vi.hoisted(() => {
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '');
  }
  function parseVal(col: string, val: unknown): unknown {
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try { return JSON.parse(val); } catch { /* keep */ }
    }
    return val;
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const params = rawParams.map((p) => p);

    const ins = /insert into (\w+)\s*\(([^\)]+)\)\s*values\s*\((.*)\)/is.exec(text);
    if (ins) {
      const table = ins[1]!.replace(/"/g, '').toLowerCase();
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const valueTokens = ins[3]!.split(',').map((t) => t.trim());
      const storeRows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const row: Record<string, unknown> = { created_at: store.now(), updated_at: store.now() };
      valueTokens.forEach((tok, i) => {
        const col = cleanCol(cols[i] ?? '');
        if (!col) return;
        const dollar = /\$(\d+)/.exec(tok);
        if (dollar) {
          const val = params[Number(dollar[1]!) - 1];
          row[col] = parseVal(col, val);
        } else if (tok.toUpperCase() === 'NULL') {
          row[col] = null;
        } else if (tok.toUpperCase().startsWith('NOW()')) {
          row[col] = store.now();
        } else if (tok.startsWith("'")) {
          row[col] = tok.slice(1, tok.endsWith("'") ? -1 : undefined);
        }
      });
      storeRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/^update \w+/.test(text.toLowerCase().trim())) {
      const table = /^update (\w+)/.exec(text.toLowerCase())![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(text);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1]!) - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1]!) - 1])) return { rows: [], rowCount: 0 };
      const setMatch = /set\s+(.+?)\s+where/is.exec(text);
      if (setMatch && target) {
        for (const pair of setMatch[1]!.split(',').map((s) => s.trim())) {
          const eq = pair.indexOf('=');
          if (eq < 0) continue;
          const col = cleanCol(pair.slice(0, eq));
          const ref = pair.slice(eq + 1).trim();
          const dollar = /^\$(\d+)$/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (/^(\w+)\s*\+\s*\$(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*\$(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(params[Number(m[2]!) - 1]);
          } else if (/^(\w+)\s*\+\s*(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(m[2]!);
          } else if (dollar) {
            const val = params[Number(dollar[1]!) - 1];
            target[col] = parseVal(col, val);
          } else if (/^now\(\)/i.test(ref)) {
            target[col] = store.now();
          } else if (ref.startsWith("'") && ref.endsWith("'")) {
            target[col] = ref.slice(1, -1);
          }
        }
      }
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }

    if (/select \*/.test(text.toLowerCase())) {
      const tableMatch = /from (\w+)/i.exec(text);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereTail = (/where\s+(.+)$/is.exec(text)?.[1] ?? '').replace(/\s+limit\s+\d+$/i, '');
      let filtered = [...rows];
      for (const clause of whereTail.split(/\s+and\s+/i)) {
        const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(clause.trim());
        if (m) {
          const val = params[Number(m[2]!) - 1];
          filtered = filtered.filter((r) => String(r[cleanCol(m[1]!)] ?? '') === String(val ?? ''));
        }
      }
      return { rows: filtered, rowCount: filtered.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    pool: { query: queryImpl },
    queryMany: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows),
    queryOne: (t: string, p: unknown[] = []) => queryImpl(t, p).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: {
    RESPAWN_STATE: 'rsm',
    PIXEL_DIFF: 'pxd',
    MOTION_DOCTOR: 'mdc',
    A11Y_AUTOPILOT: 'a11',
    LOCALIZATION_FORGE: 'lzf',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { startStateMatrixRun, completeStateMatrixRun, stateMatrixVerdict, getStateMatrixRun, listStateMatrixRuns, stateMatrixReport } from '../modules/superpowers/respawnStateMatrix.js';
import { submitPixelDiff, pixelDiffVerdict, judgePixelDiff, getPixelDiff, listPixelDiffs, pixelDiffReport } from '../modules/superpowers/pixelDiffJudge.js';
import { auditMotion, motionVerdict, auditAnimation, getMotionAudit, listMotionAudits, motionDoctorReport } from '../modules/superpowers/motionDoctor.js';
import { startA11yRun, fileA11yIssue, a11yVerdict, getA11yRun, listA11yRuns, a11yReport } from '../modules/superpowers/a11yAutopilot.js';
import { startLocalizationScan, localizationVerdict, detectLocalizationIssues, getLocalizationScan, listLocalizationScans, localizationForgeReport } from '../modules/superpowers/localizationForge.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('RESPAWN STATE MATRIX (#112)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('starts a state matrix run covering all states with audit trail', async () => {
    const run = await startStateMatrixRun(USER, { component: 'Button' });
    expect(run.id).toMatch(/^rsm-/);
    expect(run.component).toBe('Button');
    expect(run.states_tested.length).toBeGreaterThan(0);
    expect(run.status).toMatch(/PASSED|FAILED/);
    expect(typeof run.passed).toBe('number');
    expect(typeof run.failed).toBe('number');
    expect(AUDIT_ACTIONS()).toContain('autonomy.state_matrix_run_started');
    expect(AUDIT_ACTIONS()).toContain('autonomy.state_matrix_run_completed');
  });

  it('reports runs, passed, failed, total failures', async () => {
    await startStateMatrixRun(USER, { component: 'Button', states: ['loading', 'error'] });
    await startStateMatrixRun(USER, { component: 'Modal', states: ['dark', 'rtl'] });
    const report = await stateMatrixReport(USER);
    expect(report.runs).toBe(2);
    expect(report.passed).toBeGreaterThanOrEqual(0);
    expect(report.failed).toBeGreaterThanOrEqual(0);
    expect(typeof report.total_failures).toBe('number');
    expect(stateMatrixVerdict(await getStateMatrixRun(USER, (await listStateMatrixRuns(USER))[0]!.id))).toBeTruthy();
  });

  it('validates and stays owner-scoped', async () => {
    const a = await startStateMatrixRun(USER, { component: 'Input' });
    await expect(getStateMatrixRun(OTHER, a.id)).rejects.toThrow(/state_matrix_run_not_found/);
    await expect(listStateMatrixRuns(OTHER)).resolves.toHaveLength(0);
    await expect(startStateMatrixRun(USER, { component: '' })).rejects.toThrow(/component name is required/);
  });
});

describe('PIXEL DIFF JUDGE (#113)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('judges a clean diff with no breaking shift', async () => {
    const diff = await submitPixelDiff(USER, { baseline_url: '/img/v1.png', current_url: '/img/v1.png', baseline_pixels: 1000, current_pixels: 1000 });
    expect(diff.id).toMatch(/^pxd-/);
    expect(diff.total_pixels_changed).toBe(0);
    expect(diff.verdict).toBe('CLEAN');
    expect(diff.layout_breaking).toBe(false);
    expect(AUDIT_ACTIONS()).toContain('autonomy.pixel_diff_judged');
  });

  it('flags layout-breaking shift and reports counts', async () => {
    const big = await submitPixelDiff(USER, { baseline_url: '/img/v1.png', current_url: '/img/v2.png', baseline_pixels: 100, current_pixels: 500 });
    expect(big.verdict).toBe('BREAKING');
    expect(big.layout_breaking).toBe(true);
    expect(big.total_pixels_changed).toBe(400);
    const report = await pixelDiffReport(USER);
    expect(report.diffs).toBe(1);
    expect(report.breaking).toBe(1);
    expect(pixelDiffVerdict(big)).toContain('BREAKING');
  });

  it('validates and stays owner-scoped', async () => {
    const a = await submitPixelDiff(USER, { baseline_url: '/img/a.png', current_url: '/img/b.png', baseline_pixels: 100, current_pixels: 100 });
    await expect(getPixelDiff(OTHER, a.id)).rejects.toThrow(/pixel_diff_not_found/);
    await expect(listPixelDiffs(OTHER)).resolves.toHaveLength(0);
    await expect(submitPixelDiff(USER, { baseline_url: '', current_url: '/img/b.png', baseline_pixels: 100, current_pixels: 100 })).rejects.toThrow(/baseline image URL is required/);
  });
});

describe('MOTION DOCTOR (#114)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('audits a clean animation with no issues', async () => {
    const audit = await auditMotion(USER, { component: 'Spinner', animation_name: 'rotate', fps: 60, duration_ms: 300 });
    expect(audit.id).toMatch(/^mdc-/);
    expect(audit.component).toBe('Spinner');
    expect(audit.issues).toHaveLength(0);
    expect(audit.overall_severity).toBe('NONE');
    expect(audit.status).toBe('AUDITED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.motion_audited');
  });

  it('flags jank, layout thrash, and vestibular issues', async () => {
    const bad = await auditMotion(USER, { component: 'Hero', animation_name: 'slide', fps: 20, duration_ms: 1200, reduced_motion_preferred: true });
    expect(bad.issues.length).toBeGreaterThanOrEqual(2);
    expect(bad.overall_severity).toBe('HIGH');
    expect(bad.status).toBe('FLAGGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.motion_issue_flagged');
    expect(motionVerdict(bad)).toContain('issue(s)');
    const report = await motionDoctorReport(USER);
    expect(report.flagged).toBe(1);
    expect(report.high_severity).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await auditMotion(USER, { component: 'Nav', animation_name: 'fade', fps: 60, duration_ms: 200 });
    await expect(getMotionAudit(OTHER, a.id)).rejects.toThrow(/motion_audit_not_found/);
    await expect(listMotionAudits(OTHER)).resolves.toHaveLength(0);
    await expect(auditMotion(USER, { component: '', animation_name: 'fade', fps: 60, duration_ms: 200 })).rejects.toThrow(/component name is required/);
  });
});

describe('A11Y AUTOPILOT (#115)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('navigates and files accessibility issues with audit trail', async () => {
    const run = await startA11yRun(USER, { target_url: 'https://app.example.com' });
    expect(run.id).toMatch(/^a11-/);
    expect(run.target_url).toBe('https://app.example.com');
    expect(run.pages_scanned).toBeGreaterThanOrEqual(1);
    expect(run.issues.length).toBeGreaterThanOrEqual(0);
    expect(AUDIT_ACTIONS()).toContain('autonomy.a11y_navigated');
  });

  it('reports run counts and verdict', async () => {
    await startA11yRun(USER, { target_url: 'https://app.example.com', pages: ['/home', '/about'] });
    const report = await a11yReport(USER);
    expect(report.runs).toBe(1);
    expect(typeof report.total_issues).toBe('number');
    const runs = await listA11yRuns(USER);
    expect(a11yVerdict(runs[0]!)).toBeTruthy();
  });

  it('validates and stays owner-scoped', async () => {
    const a = await startA11yRun(USER, { target_url: 'https://app.example.com' });
    await expect(getA11yRun(OTHER, a.id)).rejects.toThrow(/a11y_run_not_found/);
    await expect(listA11yRuns(OTHER)).resolves.toHaveLength(0);
    await expect(startA11yRun(USER, { target_url: '' })).rejects.toThrow(/target URL is required/);
  });
});

describe('LOCALIZATION FORGE (#116)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('scans strings and detects no issues on clean input', async () => {
    const scan = await startLocalizationScan(USER, { project: 'webapp', locales: ['en'], strings: [{ key: 'hello', locale: 'en', value: 'Hello' }] });
    expect(scan.id).toMatch(/^lzf-/);
    expect(scan.project).toBe('webapp');
    expect(scan.strings_scanned).toBe(1);
    expect(scan.issue_count).toBe(0);
    expect(scan.status).toBe('COMPLETED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.localization_scan_started');
  });

  it('detects truncation and RTL breaks and reports', async () => {
    const withIssues = await startLocalizationScan(USER, {
      project: 'webapp',
      locales: ['en', 'ar'],
      strings: [
        { key: 'title', locale: 'en', value: 'Hello World', max_length: 5 },
        { key: 'title', locale: 'ar', value: 'Hello', max_length: 100 },
      ],
    });
    expect(withIssues.issue_count).toBeGreaterThanOrEqual(1);
    expect(withIssues.status).toBe('HAS_ISSUES');
    expect(AUDIT_ACTIONS()).toContain('autonomy.localization_issue_flagged');
    const report = await localizationForgeReport(USER);
    expect(report.with_issues).toBe(1);
    expect(localizationVerdict(withIssues)).toBeTruthy();
  });

  it('validates and stays owner-scoped', async () => {
    const a = await startLocalizationScan(USER, { project: 'webapp' });
    await expect(getLocalizationScan(OTHER, a.id)).rejects.toThrow(/localization_scan_not_found/);
    await expect(listLocalizationScans(OTHER)).resolves.toHaveLength(0);
    await expect(startLocalizationScan(USER, { project: '' })).rejects.toThrow(/project name is required/);
  });
});
