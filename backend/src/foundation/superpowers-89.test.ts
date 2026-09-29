/**
 * CodeConClave — Stage 89 SUPERPOWERS Tranche K: team & organization scale 2.
 *
 *   KNOWLEDGE HANDOFF       (#135) — one click produces a leaver's brain
 *                                    export for the replacement.
 *   REVIEW LOAD BALANCER    (#137) — a batch of PR reviews distributed by
 *                                    expertise, availability and quality.
 *   PERFORMANCE REVIEW DATA (#141) — evidence-derived 360 feedback.
 *   BUDGET TRANSPARENCY     (#144) — compute spend attributed to tasks.
 *   EQUITY METRICS          (#147) — often-invisible work made visible.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    knowledge_exports: [] as Array<Record<string, unknown>>,
    review_load_plans: [] as Array<Record<string, unknown>>,
    performance_digests: [] as Array<Record<string, unknown>>,
    team_cost_attributions: [] as Array<Record<string, unknown>>,
    equity_scores: [] as Array<Record<string, unknown>>,
  };
  return { tables, now: () => new Date().toISOString() };
});

const { recordAuditMock, mark } = vi.hoisted(() => {
  const recordAuditMock = vi.fn(async () => {});
  let n = 0;
  return { recordAuditMock, mark: { next: () => `id-${++n}` } };
});

const dbMock = vi.hoisted(() => {
  const DEFAULTS: Record<string, Record<string, unknown>> = {
    knowledge_exports: {},
    review_load_plans: { project_id: null },
    performance_digests: {},
    team_cost_attributions: {},
    equity_scores: {},
  };
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
      const defaults = DEFAULTS[table] ?? {};
      for (const [k, v] of Object.entries(defaults)) if (row[k] === undefined) row[k] = v;
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
          const dollar = /\$(\d+)/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (dollar) {
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
    KNOWLEDGE_EXPORT: 'kex',
    REVIEW_LOAD_PLAN: 'rlp',
    PERFORMANCE_DIGEST: 'prf',
    TEAM_COST_ATTRIBUTION: 'tca',
    EQUITY_SCORE: 'eqs',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { exportKnowledge, getKnowledgeExport, listKnowledgeExports, knowledgeExportReport, buildKnowledgeDigest } from '../modules/superpowers/knowledgeHandoff.js';
import { balanceReviews, getReviewLoadPlan, listReviewLoadPlans, reviewLoadReport, balanceReviewLoad } from '../modules/superpowers/reviewLoad.js';
import { generatePerformanceDigest, getPerformanceDigest, listPerformanceDigests, performanceDigestReport, computePerformanceScore } from '../modules/superpowers/performanceData.js';
import { attributeCosts, getCostAttribution, listCostAttributions, costReport } from '../modules/superpowers/budgetTransparency.js';
import { computeEquity, getEquityScore, listEquityScores, equityReport, computeEquityOutcome } from '../modules/superpowers/equityMetrics.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── KNOWLEDGE HANDOFF (#135) ────────────────────────────────────────────────

describe('KNOWLEDGE HANDOFF — a leaver becomes a brain export, not a loss (#135)', () => {
  beforeEach(cleartables);

  it('exports everything the person touched, decided and corrected in FULL scope', async () => {
    const doc = await exportKnowledge(USER, {
      person: 'alex',
      modules: [
        { module: 'auth', commits: 40 },
        { module: 'payments', commits: 10 },
        { module: 'search', commits: 22 },
      ],
      decisions: [{ context: 'auth', decision: 'stateless JWT' }],
      corrections: [{ pattern: 'slow query guard', applied: 3 }],
    });
    expect(doc.person).toBe('alex');
    expect(doc.scope).toBe('FULL');
    expect(doc.id).toMatch(/^kex-/);
    expect(doc.digest).toContain('BRAIN EXPORT: alex');
    expect(doc.digest).toContain('TOP MODULES: auth (40 commits), search (22 commits), payments (10 commits)');
    expect(doc.digest).toContain('- auth: stateless JWT');
    expect(doc.digest).toContain('slow query guard: applied 3x');
    expect(AUDIT_ACTIONS()).toContain('team.knowledge_export_generated');
  });

  it('ESSENTIAL scope trims to top modules and drops the corrections section', () => {
    const digest = buildKnowledgeDigest('alex', 'ESSENTIAL', [
      { module: 'b', commits: 5 },
      { module: 'a', commits: 99 },
      { module: 'c', commits: 3 },
      { module: 'd', commits: 2 },
    ], [{ context: 'a', decision: 'x' }], [{ pattern: 'p', applied: 1 }]);
    expect(digest).not.toContain('CORRECTIONS');
    expect(digest).toContain('TOUCHES (3): a, b, c');
  });

  it('persists, lists by person and reports scope counts; stays user-scoped', async () => {
    await exportKnowledge(USER, { person: 'alex', modules: [{ module: 'm', commits: 1 }] });
    await exportKnowledge(USER, { person: 'alex', modules: [{ module: 'm', commits: 1 }], scope: 'ESSENTIAL' });
    const doc = await exportKnowledge(USER, { person: 'bella', modules: [{ module: 'm', commits: 1 }] });
    expect(await listKnowledgeExports(USER, { person: 'alex' })).toHaveLength(2);
    const report = await knowledgeExportReport(USER);
    expect(report.total).toBe(3);
    expect(report.by_scope.FULL).toBe(2);
    expect(report.by_scope.ESSENTIAL).toBe(1);
    await expect(getKnowledgeExport(OTHER, doc.id)).rejects.toThrow(/knowledge_export_not_found/);
  });

  it('rejects missing person and empty exports', async () => {
    await expect(exportKnowledge(USER, { person: '', modules: [{ module: 'm', commits: 1 }] })).rejects.toThrow(AppError);
    await expect(exportKnowledge(USER, { person: 'x' })).rejects.toThrow(AppError);
    await expect(exportKnowledge(USER, { person: 'x', scope: 'TINY' as never })).rejects.toThrow(AppError);
  });
});

// ── REVIEW LOAD BALANCER (#137) ─────────────────────────────────────────────

describe('REVIEW LOAD BALANCER — nobody drowns in reviews, nobody starves (#137)', () => {
  beforeEach(cleartables);

  it('assigns each PR to the highest-quality available reviewer', async () => {
    const plan = await balanceReviews(USER, {
      items: [{ pr: 'pr-1', module: 'auth' }],
      reviewers: [
        { name: 'ana', modules: ['auth', 'payments'], availability: true, max_open: 5, quality: 0.9 },
        { name: 'ben', modules: ['auth'], availability: true, max_open: 5, quality: 0.6 },
      ],
    });
    expect(plan.item_count).toBe(1);
    expect(plan.assigned).toBe(1);
    expect(plan.plan[0]!.reviewer).toBe('ana');
    expect(plan.plan[0]!.reason).toContain('quality 0.9');
    expect(plan.id).toMatch(/^rlp-/);
    expect(AUDIT_ACTIONS()).toContain('team.review_load_balanced');
  });

  it('respects max_open capacity and spills to the next reviewer', () => {
    const entries = balanceReviewLoad(
      [
        { pr: 'pr-1', module: 'auth' },
        { pr: 'pr-2', module: 'auth' },
      ],
      [
        { name: 'ana', modules: ['auth'], availability: true, max_open: 1, quality: 0.9 },
        { name: 'ben', modules: ['auth'], availability: true, max_open: 5, quality: 0.8 },
      ],
    );
    expect(entries[0]!.reviewer).toBe('ana');
    expect(entries[1]!.reviewer).toBe('ben');
    expect(entries[1]!.reason).toContain('load 0 of 5');
  });

  it('skips unavailable reviewers and marks unavoidable gaps as unassigned', () => {
    const entries = balanceReviewLoad(
      [{ pr: 'pr-1', module: 'ml' }],
      [{ name: 'ana', modules: ['auth'], availability: true, max_open: 5, quality: 0.9 }],
    );
    expect(entries[0]!.reviewer).toBeNull();
    expect(entries[0]!.reason).toContain('no available reviewer');
  });

  it('breaks ties by load then name; persists, reports, stays user-scoped', async () => {
    const tied = balanceReviewLoad(
      [{ pr: 'pr-1', module: 'db' }],
      [
        { name: 'zoe', modules: ['db'], availability: true, max_open: 5, quality: 0.7 },
        { name: 'ada', modules: ['db'], availability: true, max_open: 5, quality: 0.7 },
      ],
    );
    expect(tied[0]!.reviewer).toBe('ada');

    const plan = await balanceReviews(USER, {
      items: [
        { pr: 'p1', module: 'auth' },
        { pr: 'p2', module: 'pay' },
      ],
      reviewers: [
        { name: 'ana', modules: ['auth'], availability: true, max_open: 5, quality: 0.9 },
        { name: 'ben', modules: ['pay'], availability: true, max_open: 5, quality: 0.8 },
      ],
    });
    const report = await reviewLoadReport(USER);
    expect(report.plans).toBe(1);
    expect(report.items).toBe(2);
    expect(report.assigned).toBe(2);
    expect(report.unassigned).toBe(0);
    await expect(getReviewLoadPlan(OTHER, plan.id)).rejects.toThrow(/review_load_plan_not_found/);
    await expect(balanceReviews(USER, { items: [], reviewers: [{ name: 'a', modules: ['x'], availability: true, max_open: 1, quality: 0.5 }] })).rejects.toThrow(AppError);
    await expect(balanceReviews(USER, { items: [{ pr: 'p', module: 'm' }], reviewers: [] })).rejects.toThrow(AppError);
  });
});

// ── PERFORMANCE REVIEW DATA (#141) ──────────────────────────────────────────

describe('PERFORMANCE REVIEW DATA — 360 feedback with evidence, not vibes (#141)', () => {
  beforeEach(cleartables);

  it('scores a strong contributor EXCELLENT with real metrics', async () => {
    const digest = await generatePerformanceDigest(USER, {
      person: 'ana',
      period: '2026-Q2',
      delivered: 10,
      authored_lines: 4000,
      review_count: 20,
      review_comments: 40,
      mentoring: 5,
      ops_hours: 12,
    });
    expect(digest.score).toBe(95);
    expect(digest.tier).toBe('EXCELLENT');
    expect(digest.metrics.comments_per_review).toBe(2);
    expect(digest.narrative).toContain('ana');
    expect(digest.id).toMatch(/^prf-/);
    expect(AUDIT_ACTIONS()).toContain('team.performance_digest_generated');
  });

  it('reports a low-activity contributor as RISING', () => {
    expect(computePerformanceScore({ delivered: 0, authored_lines: 0, review_count: 0, review_comments: 0, mentoring: 0, ops_hours: 0, missed_deadlines: 0, comments_per_review: 0 }).tier).toBe('RISING');
    const dig = computePerformanceScore({ delivered: 8, authored_lines: 3000, review_count: 2, review_comments: 3, mentoring: 1, ops_hours: 0, missed_deadlines: 0, comments_per_review: 1.5 });
    expect(dig.score).toBeGreaterThanOrEqual(50);
  });

  it('flags reliability problems in the narrative', async () => {
    const digest = await generatePerformanceDigest(USER, { person: 'ben', period: '2026-Q2', delivered: 2, missed_deadlines: 4 });
    expect(digest.narrative).toContain('Reliability flag');
    expect(digest.metrics.missed_deadlines).toBe(4);
  });

  it('persists, lists by person and reports; stays user-scoped', async () => {
    await generatePerformanceDigest(USER, { person: 'ana', period: 'Q1', delivered: 10, authored_lines: 4000, review_count: 20, mentoring: 5 });
    await generatePerformanceDigest(USER, { person: 'ben', period: 'Q1', delivered: 1 });
    const digest = await generatePerformanceDigest(USER, { person: 'ana', period: 'Q2', delivered: 1 });
    expect(await listPerformanceDigests(USER, { person: 'ana' })).toHaveLength(2);
    const report = await performanceDigestReport(USER);
    expect(report.total).toBe(3);
    expect(report.by_tier.EXCELLENT).toBe(1);
    await expect(getPerformanceDigest(OTHER, digest.id)).rejects.toThrow(/performance_digest_not_found/);
    await expect(generatePerformanceDigest(USER, { person: '', period: 'Q1' })).rejects.toThrow(AppError);
    await expect(generatePerformanceDigest(USER, { person: 'x', period: 'Q1', review_count: -1 })).rejects.toThrow(AppError);
  });
});

// ── BUDGET TRANSPARENCY (#144) ──────────────────────────────────────────────

describe('BUDGET TRANSPARENCY — spend attributed to tasks, visible (#144)', () => {
  beforeEach(cleartables);

  it('attributes each entry and computes its share of the total', async () => {
    const result = await attributeCosts(USER, {
      team: 'payments',
      period: '2026-M08',
      entries: [
        { task: 'migrate queue', resource: 'compute', cost_usd: 30 },
        { task: 'splunk ingest', resource: 'compute', cost_usd: 70 },
      ],
    });
    expect(result.total_usd).toBe(100);
    expect(result.entries).toBe(2);
    expect(result.results[0]!.share).toBe(30);
    expect(result.results[1]!.share).toBe(70);
    expect(result.results[0]!.id).toMatch(/^tca-/);
    expect(result.results[0]!.team).toBe('payments');
    expect(AUDIT_ACTIONS()).toContain('team.cost_attributed');
  });

  it('attributes zero-cost entries with zero shares', async () => {
    const result = await attributeCosts(USER, { team: 'web', period: '2026-M08', entries: [{ task: 'free tier', resource: 'none', cost_usd: 0 }] });
    expect(result.total_usd).toBe(0);
    expect(result.results[0]!.share).toBe(0);
  });

  it('rolls up per-team totals and lists by team; stays user-scoped', async () => {
    await attributeCosts(USER, { team: 'nfra', period: 'P', entries: [{ task: 'x', resource: 'r', cost_usd: 10 }, { task: 'y', resource: 'r', cost_usd: 20 }] });
    const result = await attributeCosts(USER, { team: 'web', period: 'P', entries: [{ task: 'z', resource: 's', cost_usd: 5 }] });
    expect(await listCostAttributions(USER, { team: 'nfra' })).toHaveLength(2);
    const report = await costReport(USER);
    expect(report.teams).toBe(2);
    expect(report.total_usd).toBe(35);
    expect(report.by_team.nfra).toBe(30);
    await expect(getCostAttribution(OTHER, result.results[0]!.id)).rejects.toThrow(/cost_attribution_not_found/);
  });

  it('rejects empty and malformed input', async () => {
    await expect(attributeCosts(USER, { team: '', period: 'P', entries: [{ task: 'x', resource: 'r', cost_usd: 1 }] })).rejects.toThrow(AppError);
    await expect(attributeCosts(USER, { team: 't', period: 'P', entries: [] })).rejects.toThrow(AppError);
    await expect(attributeCosts(USER, { team: 't', period: 'P', entries: [{ task: 'x', resource: 'r', cost_usd: -1 }] })).rejects.toThrow(AppError);
    await expect(attributeCosts(USER, { team: 't', period: 'P', entries: [{ task: '', resource: 'r', cost_usd: 1 }] })).rejects.toThrow(AppError);
  });
});

// ── EQUITY METRICS (#147) ───────────────────────────────────────────────────

describe('EQUITY METRICS — the invisible work becomes visible (#147)', () => {
  beforeEach(cleartables);

  it('surfaces reviewers/testers/ops people as UNSEEN_WORK_HIGH', async () => {
    const outcome = await computeEquity(USER, {
      period: '2026-Q3',
      people: [
        { name: 'ana', commits: 5, reviewed: 10, tests_written: 5, ops_hours: 20, docs_written: 2, mentoring: 3 },
      ],
    });
    expect(outcome.people).toBe(1);
    const score = outcome.scores[0]!;
    expect(score.visible).toBe(10);
    expect(score.invisible).toBe(71);
    expect(score.invisible_share).toBe(0.88);
    expect(score.tier).toBe('UNSEEN_WORK_HIGH');
    expect(score.id).toMatch(/^eqs-/);
    expect(AUDIT_ACTIONS()).toContain('team.equity_metrics_computed');
  });

  it('classifies code-heavy contributors as CODE_FACING', () => {
    const outcome = computeEquityOutcome({ name: 'zoe', commits: 50, reviewed: 0, tests_written: 0, ops_hours: 0, docs_written: 0, mentoring: 0 });
    expect(outcome.visible).toBe(50);
    expect(outcome.invisible).toBe(0);
    expect(outcome.invisible_share).toBe(0);
    expect(outcome.tier).toBe('CODE_FACING');
  });

  it('persists per-person scores, lists by period and reports; stays user-scoped', async () => {
    await computeEquity(USER, { period: 'Q1', people: [{ name: 'ana', commits: 5, reviewed: 10, tests_written: 5, ops_hours: 20, docs_written: 2, mentoring: 3 }, { name: 'ben', commits: 5, reviewed: 0 }] });
    const scores = await computeEquity(USER, { period: 'Q2', people: [{ name: 'zoe', commits: 50, reviewed: 0 }] });
    expect(await listEquityScores(USER, { period: 'Q1' })).toHaveLength(2);
    const report = await equityReport(USER);
    expect(report.total).toBe(3);
    expect(report.unseen_high).toBe(1);
    expect(report.avg_invisible_share).toBeGreaterThan(0);
    await expect(getEquityScore(OTHER, scores.scores[0]!.id)).rejects.toThrow(/equity_score_not_found/);
  });

  it('rejects empty, duplicate and unnamed inputs', async () => {
    await expect(computeEquity(USER, { period: '', people: [{ name: 'a', commits: 1 }] })).rejects.toThrow(AppError);
    await expect(computeEquity(USER, { period: 'P', people: [] })).rejects.toThrow(AppError);
    await expect(computeEquity(USER, { period: 'P', people: [{ name: 'a', commits: 1 }, { name: 'a', commits: 2 }] })).rejects.toThrow(AppError);
    await expect(computeEquity(USER, { period: 'P', people: [{ name: '', commits: 1 }] })).rejects.toThrow(AppError);
  });
});