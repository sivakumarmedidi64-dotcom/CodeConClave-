/**
 * CodeConClave — Stage 112 SUPERPOWERS Tranche AH: Nutrition Label,
 * Universal Reproduction, Refactor Market, Dogfood Mode, Demo Link.
 *
 *   CODEBASE NUTRITION LABEL (#158)    — repo health label: freshness, risk, debt, coverage, security, velocity.
 *   UNIVERSAL REPRODUCTION (#159)     — reconstruct customer state and reproduce bugs.
 *   AUTONOMOUS REFACTOR MARKET (#160) — propose, benchmark, queue refactors.
 *   DOGFOOD MODE (#161)              — agents file issues, fix CI, write docs.
 *   LIVE DEMO LINK (#162)            — public read-only "ask my codebase" link, auto-expires.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    nutrition_labels: [] as Array<Record<string, unknown>>,
    universal_repro_runs: [] as Array<Record<string, unknown>>,
    refactor_proposals: [] as Array<Record<string, unknown>>,
    dogfood_tasks: [] as Array<Record<string, unknown>>,
    demo_links: [] as Array<Record<string, unknown>>,
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
    NUTRITION_LABEL: 'nlt',
    UNIVERSAL_REPRO: 'urp',
    REFACTOR_MARKET: 'rfm',
    DOGFOOD_MODE: 'dfm',
    DEMO_LINK: 'dml',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { generateNutritionLabel, getNutritionLabel, listNutritionLabels, nutritionLabelReport } from '../modules/superpowers/nutritionLabel.js';
import { createReproRun, confirmReproduction, getReproRun, listReproRuns, universalReproReport } from '../modules/superpowers/universalReproduction.js';
import { proposeRefactor, queueRefactor, getRefactorProposal, listRefactorProposals, refactorMarketReport } from '../modules/superpowers/refactorMarket.js';
import { fileDogfoodTask, getDogfoodTask, listDogfoodTasks, dogfoodModeReport } from '../modules/superpowers/dogfoodMode.js';
import { createDemoLink, expireDemoLink, getDemoLink, listDemoLinks, demoLinkReport } from '../modules/superpowers/demoLink.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('CODEBASE NUTRITION LABEL (#158)', () => {
  beforeEach(() => { cleartables(); });

  it('generates a nutrition label with scores', async () => {
    const label = await generateNutritionLabel(USER, { repo_name: 'my-app', freshness: 85, risk: 15, debt: 20, coverage: 90, security: 95, velocity: 70 });
    expect(label.id).toMatch(/^nlt-/);
    expect(label.repo_name).toBe('my-app');
    expect(label.freshness).toBe(85);
    expect(label.status).toBe('GENERATED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.nutrition_label_generated');
  });

  it('reports nutrition label totals', async () => {
    await generateNutritionLabel(USER, { repo_name: 'repo-a', freshness: 80, risk: 20, debt: 10, coverage: 90, security: 85, velocity: 75 });
    await generateNutritionLabel(USER, { repo_name: 'repo-b', freshness: 60, risk: 40, debt: 30, coverage: 70, security: 60, velocity: 50 });
    const report = await nutritionLabelReport(USER);
    expect(report.labels).toBe(2);
    expect(report.generated).toBe(2);
  });

  it('validates and stays owner-scoped', async () => {
    const label = await generateNutritionLabel(USER, { repo_name: 'repo', freshness: 50, risk: 50, debt: 50, coverage: 50, security: 50, velocity: 50 });
    await expect(getNutritionLabel(OTHER, label.id)).rejects.toThrow(/nutrition_label_not_found/);
    await expect(listNutritionLabels(OTHER)).resolves.toHaveLength(0);
    await expect(generateNutritionLabel(USER, { repo_name: '', freshness: 50, risk: 50, debt: 50, coverage: 50, security: 50, velocity: 50 })).rejects.toThrow(/repo name is required/);
  });
});

describe('UNIVERSAL REPRODUCTION (#159)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a repro run and confirms it', async () => {
    const run = await createReproRun(USER, { bug_description: 'login button unresponsive', version: '2.3.1', data_state: 'production snapshot', flags: ['dark-mode', 'beta-ui'], device: 'iPhone 14', network: 'wifi' });
    expect(run.id).toMatch(/^urp-/);
    expect(run.bug_description).toBe('login button unresponsive');
    expect(run.status).toBe('ATTEMPTED');
    expect(run.flags).toEqual(['dark-mode', 'beta-ui']);
    expect(AUDIT_ACTIONS()).toContain('autonomy.reproduction_attempted');

    const confirmed = await confirmReproduction(USER, run.id, { result: 'Reproduced on iPhone 14 with dark-mode enabled' });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.result).toContain('Reproduced');
    expect(AUDIT_ACTIONS()).toContain('autonomy.reproduction_confirmed');
  });

  it('reports repro run totals', async () => {
    const r1 = await createReproRun(USER, { bug_description: 'crash', version: '1.0', data_state: '', flags: [], device: '', network: '' });
    const r2 = await createReproRun(USER, { bug_description: 'hang', version: '1.1', data_state: '', flags: [], device: '', network: '' });
    await confirmReproduction(USER, r1.id, { result: 'confirmed' });
    const report = await universalReproReport(USER);
    expect(report.runs).toBe(2);
    expect(report.attempted).toBe(1);
    expect(report.confirmed).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const run = await createReproRun(USER, { bug_description: 'bug', version: '1.0', data_state: '', flags: [], device: '', network: '' });
    await expect(getReproRun(OTHER, run.id)).rejects.toThrow(/universal_repro_run_not_found/);
    await expect(listReproRuns(OTHER)).resolves.toHaveLength(0);
    await expect(createReproRun(USER, { bug_description: '', version: '1.0', data_state: '', flags: [], device: '', network: '' })).rejects.toThrow(/bug description is required/);
  });
});

describe('AUTONOMOUS REFACTOR MARKET (#160)', () => {
  beforeEach(() => { cleartables(); });

  it('proposes a refactor and queues it', async () => {
    const proposal = await proposeRefactor(USER, { description: 'Extract auth middleware', file_path: 'src/auth.ts', benchmark_before: 120, benchmark_after: 80 });
    expect(proposal.id).toMatch(/^rfm-/);
    expect(proposal.description).toBe('Extract auth middleware');
    expect(proposal.status).toBe('PROPOSED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.refactor_proposed');

    const queued = await queueRefactor(USER, proposal.id);
    expect(queued.status).toBe('QUEUED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.refactor_queued');
  });

  it('reports refactor proposal totals', async () => {
    await proposeRefactor(USER, { description: 'a', file_path: 'a.ts', benchmark_before: 100, benchmark_after: 50 });
    const p2 = await proposeRefactor(USER, { description: 'b', file_path: 'b.ts', benchmark_before: 200, benchmark_after: 100 });
    await queueRefactor(USER, p2.id);
    const report = await refactorMarketReport(USER);
    expect(report.proposals).toBe(2);
    expect(report.proposed).toBe(1);
    expect(report.queued).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const p = await proposeRefactor(USER, { description: 'x', file_path: 'x.ts', benchmark_before: 10, benchmark_after: 5 });
    await expect(getRefactorProposal(OTHER, p.id)).rejects.toThrow(/refactor_proposal_not_found/);
    await expect(listRefactorProposals(OTHER)).resolves.toHaveLength(0);
    await expect(proposeRefactor(USER, { description: '', file_path: 'x.ts', benchmark_before: 10, benchmark_after: 5 })).rejects.toThrow(/description is required/);
    await expect(proposeRefactor(USER, { description: 'x', file_path: '', benchmark_before: 10, benchmark_after: 5 })).rejects.toThrow(/file path is required/);
  });
});

describe('DOGFOOD MODE (#161)', () => {
  beforeEach(() => { cleartables(); });

  it('files a dogfood task', async () => {
    const task = await fileDogfoodTask(USER, { title: 'Fix CI pipeline', description: 'Tests flaky on main branch', category: 'CI', assignee: 'agent-alpha' });
    expect(task.id).toMatch(/^dfm-/);
    expect(task.title).toBe('Fix CI pipeline');
    expect(task.category).toBe('CI');
    expect(task.status).toBe('FILED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.dogfood_task_filed');
  });

  it('reports dogfood task totals', async () => {
    await fileDogfoodTask(USER, { title: 'a', description: 'desc a', category: 'CI' });
    await fileDogfoodTask(USER, { title: 'b', description: 'desc b', category: 'DOCS' });
    await fileDogfoodTask(USER, { title: 'c', description: 'desc c', category: 'CI' });
    const report = await dogfoodModeReport(USER);
    expect(report.tasks).toBe(3);
    expect(report.filed).toBe(3);
    expect(report.categories).toBe(2);
  });

  it('validates and stays owner-scoped', async () => {
    const task = await fileDogfoodTask(USER, { title: 't', description: 'd', category: 'c' });
    await expect(getDogfoodTask(OTHER, task.id)).rejects.toThrow(/dogfood_task_not_found/);
    await expect(listDogfoodTasks(OTHER)).resolves.toHaveLength(0);
    await expect(fileDogfoodTask(USER, { title: '', description: 'd', category: 'c' })).rejects.toThrow(/title is required/);
    await expect(fileDogfoodTask(USER, { title: 't', description: '', category: 'c' })).rejects.toThrow(/description is required/);
  });
});

describe('LIVE DEMO LINK (#162)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a demo link and expires it', async () => {
    const link = await createDemoLink(USER, { title: 'Public Demo', description: 'Ask my codebase anything', url: 'https://demo.example.com', expires_at: '2026-12-31T23:59:59Z' });
    expect(link.id).toMatch(/^dml-/);
    expect(link.title).toBe('Public Demo');
    expect(link.status).toBe('ACTIVE');
    expect(link.expired_at).toBeNull();
    expect(AUDIT_ACTIONS()).toContain('autonomy.demo_link_created');

    const expired = await expireDemoLink(USER, link.id);
    expect(expired.status).toBe('EXPIRED');
    expect(expired.expired_at).not.toBeNull();
    expect(AUDIT_ACTIONS()).toContain('autonomy.demo_link_expired');
  });

  it('reports demo link totals', async () => {
    await createDemoLink(USER, { title: 'a', description: '', url: 'https://a.com', expires_at: '2026-12-31T23:59:59Z' });
    const l2 = await createDemoLink(USER, { title: 'b', description: '', url: 'https://b.com', expires_at: '2026-12-31T23:59:59Z' });
    await expireDemoLink(USER, l2.id);
    const report = await demoLinkReport(USER);
    expect(report.links).toBe(2);
    expect(report.active).toBe(1);
    expect(report.expired).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const link = await createDemoLink(USER, { title: 'x', description: '', url: 'https://x.com', expires_at: '2026-12-31T23:59:59Z' });
    await expect(getDemoLink(OTHER, link.id)).rejects.toThrow(/demo_link_not_found/);
    await expect(listDemoLinks(OTHER)).resolves.toHaveLength(0);
    await expect(createDemoLink(USER, { title: '', description: '', url: 'https://x.com', expires_at: '2026-12-31T23:59:59Z' })).rejects.toThrow(/title is required/);
    await expect(createDemoLink(USER, { title: 'x', description: '', url: '', expires_at: '2026-12-31T23:59:59Z' })).rejects.toThrow(/url is required/);
    await expect(createDemoLink(USER, { title: 'x', description: '', url: 'https://x.com', expires_at: '' })).rejects.toThrow(/expires_at is required/);
  });
});
