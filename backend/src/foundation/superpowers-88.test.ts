/**
 * CodeConClave — Stage 88 SUPERPOWERS Tranche J: team & organization scale.
 *
 *   BUS-FACTOR ALARM        (#133) — modules owned by too few humans are
 *                                    flagged with a pairing / knowledge-
 *                                    transfer plan.
 *   REVIEW ROUTER           (#134) — every PR routed to the reviewer with the
 *                                    deepest expertise, availability and load.
 *   PAIRING SCHEDULER       (#139) — senior + junior automatically paired on
 *                                    complex tasks.
 *   ONBOARDING ROADMAP      (#140) — personalized first-week task roadmap
 *                                    scoped to role, team and seniority.
 *   ASYNC DECISION PLATFORM (#142) — structured voting with evidence and
 *                                    recorded dissent; resolution by weighted
 *                                    majority.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    bus_factor_alarms: [] as Array<Record<string, unknown>>,
    review_assignments: [] as Array<Record<string, unknown>>,
    pairing_schedules: [] as Array<Record<string, unknown>>,
    onboarding_roadmaps: [] as Array<Record<string, unknown>>,
    async_decisions: [] as Array<Record<string, unknown>>,
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
    bus_factor_alarms: { project_id: null },
    review_assignments: { project_id: null },
    pairing_schedules: { project_id: null },
    onboarding_roadmaps: { project_id: null },
    async_decisions: { project_id: null },
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
    BUS_FACTOR_ALARM: 'bfa',
    REVIEW_ASSIGNMENT: 'rvr',
    PAIRING_SCHEDULE: 'psc',
    ONBOARDING_ROADMAP: 'obr',
    ASYNC_DECISION: 'adc',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { scanBusFactor, getBusFactorAlarm, clearBusFactorAlarm, listBusFactorAlarms, busFactorReport, classifyBusFactor } from '../modules/superpowers/busFactor.js';
import { routeCodeReview, getReviewAssignment, rankReviewers, listReviewAssignments, reviewRouteReport } from '../modules/superpowers/reviewRouter.js';
import { schedulePairing, acceptPairing, completePairing, getPairingSchedule, listPairingSchedules, pairingReport, pickPair } from '../modules/superpowers/pairingScheduler.js';
import { generateOnboardingRoadmap, getOnboardingRoadmap, listOnboardingRoadmaps, onboardingRoadmapReport, buildRoadmapTasks } from '../modules/superpowers/onboardingRoadmap.js';
import { proposeDecision, getAsyncDecision, castDecisionVote, resolveDecision, closeDecision, listAsyncDecisions, asyncDecisionReport, resolveDecisions } from '../modules/superpowers/asyncDecision.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── BUS-FACTOR ALARM (#133) ─────────────────────────────────────────────────

describe('BUS-FACTOR ALARM — a single departure can never strand a module (#133)', () => {
  beforeEach(cleartables);

  it('flags a single-owner module as CRITICAL with a knowledge-transfer plan', async () => {
    const result = await scanBusFactor(USER, {
      modules: [
        { module: 'auth', contributors: [{ name: 'ana', last_active_days: 3 }], span_days: 180 },
      ],
    });
    expect(result.modules).toBe(1);
    expect(result.flagged).toBe(1);
    const alarm = result.alarms[0]!;
    expect(alarm.module).toBe('auth');
    expect(alarm.severity).toBe('CRITICAL');
    expect(alarm.total_contributors).toBe(1);
    expect(alarm.active_contributors).toBe(1);
    expect(alarm.id).toMatch(/^bfa-/);
    expect(alarm.knowledge_transfer.risk).toContain('auth');
    expect(alarm.knowledge_transfer.kt_tasks).toHaveLength(3);
    expect(alarm.knowledge_transfer.primary_owners).toEqual(['ana']);
    expect(AUDIT_ACTIONS()).toContain('team.bus_factor_scanned');
    expect(AUDIT_ACTIONS()).toContain('team.bus_factor_alarm_raised');
  });

  it('escalates correctly across contributor counts and recency', () => {
    expect(classifyBusFactor(1, 1)).toBe('CRITICAL');
    expect(classifyBusFactor(3, 1)).toBe('HIGH');
    expect(classifyBusFactor(2, 2)).toBe('MEDIUM');
    expect(classifyBusFactor(4, 3)).toBe('LOW');
    expect(classifyBusFactor(4, 4)).toBeNull();
    expect(classifyBusFactor(0, 0)).toBeNull();
  });

  it('generates pairing suggestions among the active owners', async () => {
    const result = await scanBusFactor(USER, {
      modules: [
        { module: 'billing', contributors: [{ name: 'ana', last_active_days: 2 }, { name: 'ben', last_active_days: 4 }], span_days: 180 },
      ],
    });
    expect(result.flagged).toBe(1);
    const plan = result.alarms[0]!.knowledge_transfer;
    expect(plan.suggested_pairs).toContain('ana + ben');
  });

  it('clears an alarm once and rolls up a report; stays user-scoped', async () => {
    const result = await scanBusFactor(USER, {
      modules: [
        { module: 'a', contributors: [{ name: 'x', last_active_days: 1 }], span_days: 30 },
        { module: 'b', contributors: [{ name: 'y', last_active_days: 1 }], span_days: 30 },
        { module: 'c', contributors: [{ name: 'z', last_active_days: 1 }], span_days: 30 },
      ],
    });
    const target = result.alarms[1]!;
    const cleared = await clearBusFactorAlarm(USER, target.id);
    expect(cleared.status).toBe('CLEARED');
    expect((await clearBusFactorAlarm(USER, target.id)).status).toBe('CLEARED');
    expect(AUDIT_ACTIONS().filter((a) => a === 'team.bus_factor_cleared')).toHaveLength(1);

    const report = await busFactorReport(USER);
    expect(report.total).toBe(3);
    expect(report.open).toBe(2);
    expect(report.cleared).toBe(1);
    expect(report.by_severity.CRITICAL).toBe(3);

    expect((await listBusFactorAlarms(USER, { status: 'CLEARED' }))[0]!.id).toBe(target.id);
    await expect(getBusFactorAlarm(OTHER, target.id)).rejects.toThrow(/bus_factor_alarm_not_found/);
    await expect(getBusFactorAlarm(USER, 'bfa-nope')).rejects.toThrow(AppError);
  });

  it('rejects malformed input and skips healthy modules', async () => {
    await expect(scanBusFactor(USER, { modules: [] })).rejects.toThrow(AppError);
    const healthy = await scanBusFactor(USER, {
      modules: [
        { module: 'ok', contributors: [{ name: 'a', last_active_days: 1 }, { name: 'b', last_active_days: 2 }, { name: 'c', last_active_days: 3 }], span_days: 30 },
      ],
    });
    expect(healthy.flagged).toBe(0);
    expect(healthy.alarms).toHaveLength(0);
    await expect(scanBusFactor(USER, { modules: [{ module: 'x', contributors: [], span_days: 30 }] })).rejects.toThrow(AppError);
  });
});

// ── REVIEW ROUTER (#134) ────────────────────────────────────────────────────

describe('REVIEW ROUTER — route every PR to the deepest knowledge, alive (#134)', () => {
  beforeEach(cleartables);

  it('routes to the highest expertise among available reviewers', async () => {
    const assignment = await routeCodeReview(USER, {
      module: 'payments',
      expertise: [
        { reviewer: 'ana', score: 92 },
        { reviewer: 'ben', score: 80 },
        { reviewer: 'cat', score: 88 },
      ],
      availability: ['ana', 'cat'],
    });
    expect(assignment.selected_reviewer).toBe('ana');
    expect(assignment.expertise_score).toBe(92);
    expect(assignment.module).toBe('payments');
    expect(assignment.id).toMatch(/^rvr-/);
    expect(assignment.ranking[0]!.reason).toContain('highest expertise score 92');
    expect(assignment.ranking).toHaveLength(2);
    expect(AUDIT_ACTIONS()).toContain('team.review_routed');
  });

  it('breaks expertise ties by live load, then alphabetically', () => {
    const byLoad = rankReviewers('mod', [
      { reviewer: 'zara', score: 80 },
      { reviewer: 'ada', score: 80 },
    ], ['zara', 'ada'], [{ reviewer: 'zara', open_reviews: 5 }, { reviewer: 'ada', open_reviews: 1 }]);
    expect(byLoad.selected.reviewer).toBe('ada');
    expect(byLoad.selected.reason).toContain('load');

    const byName = rankReviewers('mod', [
      { reviewer: 'zara', score: 80 },
      { reviewer: 'ada', score: 80 },
    ], ['zara', 'ada']);
    expect(byName.selected.reviewer).toBe('ada');
    expect(byName.selected.reason).toContain('alphabetically');
  });

  it('excludes unavailable reviewers even if they are most expert', async () => {
    const assignment = await routeCodeReview(USER, {
      module: 'payments',
      expertise: [
        { reviewer: 'ana', score: 99 },
        { reviewer: 'ben', score: 60 },
      ],
      availability: ['ben'],
    });
    expect(assignment.selected_reviewer).toBe('ben');
    expect(assignment.ranking).toHaveLength(1);
  });

  it('persists the route, lists by module and rolls up a report; user-scoped', async () => {
    const a = await routeCodeReview(USER, { module: 'auth', expertise: [{ reviewer: 'x', score: 90 }, { reviewer: 'y', score: 70 }], availability: ['x', 'y'] });
    await routeCodeReview(USER, { module: 'auth', expertise: [{ reviewer: 'x', score: 90 }, { reviewer: 'y', score: 70 }], availability: ['x', 'y'] });
    await routeCodeReview(USER, { module: 'search', expertise: [{ reviewer: 'y', score: 95 }, { reviewer: 'x', score: 60 }], availability: ['y', 'x'] });
    expect(await listReviewAssignments(USER, { module: 'auth' })).toHaveLength(2);
    const report = await reviewRouteReport(USER);
    expect(report.total).toBe(3);
    expect(report.by_reviewer.x).toBe(2);
    expect(report.by_reviewer.y).toBe(1);
    await expect(getReviewAssignment(OTHER, a.id)).rejects.toThrow(/review_assignment_not_found/);
    await expect(routeCodeReview(USER, { module: 'm', expertise: [], availability: ['a'] })).rejects.toThrow(AppError);
    await expect(routeCodeReview(USER, { module: 'm', expertise: [{ reviewer: 'r', score: 5 }], availability: [] })).rejects.toThrow(AppError);
    await expect(routeCodeReview(USER, { module: 'm', expertise: [{ reviewer: 'gone', score: 5 }], availability: ['other'] })).rejects.toThrow(AppError);
  });
});

// ── PAIRING SCHEDULER (#139) ────────────────────────────────────────────────

describe('PAIRING SCHEDULER — complex tasks get a systematic senior/junior pair (#139)', () => {
  beforeEach(cleartables);

  it('pairs a senior with a junior for CRITICAL tasks', async () => {
    const pairing = await schedulePairing(USER, {
      task: 'split payments monolith',
      complexity: 'CRITICAL',
      team: [
        { name: 'ana', level: 'SENIOR' },
        { name: 'ben', level: 'JUNIOR' },
        { name: 'cat', level: 'MID' },
      ],
    });
    expect(pairing.senior).toBe('ana');
    expect(pairing.junior).toBe('ben');
    expect(pairing.complexity).toBe('CRITICAL');
    expect(pairing.status).toBe('SCHEDULED');
    expect(pairing.pairing_reason.rationale).toContain('ana');
    expect(pairing.pairing_reason.rationale).toContain('ben');
    expect(pairing.id).toMatch(/^psc-/);
    expect(AUDIT_ACTIONS()).toContain('team.pairing_scheduled');
  });

  it('uses MID as senior when no SENIOR exists and breaks name ties deterministically', async () => {
    const pairing = await schedulePairing(USER, {
      task: 'rewrite queue',
      complexity: 'COMPLEX',
      team: [
        { name: 'ben', level: 'MID' },
        { name: 'zoe', level: 'JUNIOR' },
      ],
    });
    expect(pairing.senior).toBe('ben');
    expect(pairing.junior).toBe('zoe');
    expect(pickPair([{ name: 'a', level: 'JUNIOR' }, { name: 'b', level: 'JUNIOR' }])).toBeNull();
  });

  it('walks a pairing through accept → complete, idempotently', async () => {
    const pairing = await schedulePairing(USER, {
      task: 'backfill migration',
      complexity: 'COMPLEX',
      team: [{ name: 'ana', level: 'SENIOR' }, { name: 'ben', level: 'JUNIOR' }],
    });
    expect((await acceptPairing(USER, pairing.id)).status).toBe('ACCEPTED');
    expect((await acceptPairing(USER, pairing.id)).status).toBe('ACCEPTED');
    expect(AUDIT_ACTIONS().filter((a) => a === 'team.pairing_accepted')).toHaveLength(1);
    const completed = await completePairing(USER, pairing.id);
    expect(completed.status).toBe('COMPLETED');
    const report = await pairingReport(USER);
    expect(report.total).toBe(1);
    expect(report.accepted).toBe(0);
    expect(report.completed).toBe(1);
    expect((await listPairingSchedules(USER, { status: 'COMPLETED' }))[0]!.id).toBe(pairing.id);
  });

  it('rejects non-complex tasks, unsuitable teams, and unknown ids', async () => {
    await expect(schedulePairing(USER, {
      task: 'tweak css',
      complexity: 'SIMPLE',
      team: [{ name: 'ana', level: 'SENIOR' }, { name: 'ben', level: 'JUNIOR' }],
    })).rejects.toThrow(AppError);
    await expect(schedulePairing(USER, {
      task: 'x',
      complexity: 'COMPLEX',
      team: [{ name: 'ana', level: 'SENIOR' }, { name: 'cat', level: 'SENIOR' }],
    })).rejects.toThrow(AppError);
    await expect(getPairingSchedule(OTHER, 'psc-nope')).rejects.toThrow(AppError);
  });
});

// ── ONBOARDING ROADMAP (#140) ───────────────────────────────────────────────

describe('ONBOARDING ROADMAP — the first week is a shipped plan (#140)', () => {
  beforeEach(cleartables);

  it('generates a role-scoped task per day with goal and deliverable', async () => {
    const roadmap = await generateOnboardingRoadmap(USER, {
      role: 'Frontend',
      team: 'growth',
      seniority: 'JUNIOR',
      days: 5,
    });
    expect(roadmap.days).toBe(5);
    expect(roadmap.tasks).toHaveLength(5);
    expect(roadmap.tasks.map((t) => t.day)).toEqual([1, 2, 3, 4, 5]);
    for (const task of roadmap.tasks) {
      expect(task.title.length).toBeGreaterThan(0);
      expect(task.goal.length).toBeGreaterThan(0);
      expect(task.deliverable.length).toBeGreaterThan(0);
    }
    expect(roadmap.tasks.some((t) => t.title.includes('growth'))).toBe(true);
    expect(roadmap.id).toMatch(/^obr-/);
    expect(AUDIT_ACTIONS()).toContain('team.onboarding_roadmap_generated');
  });

  it('scopes depth by seniority: SENIOR shifts the sequence', () => {
    const tasks = buildRoadmapTasks('Backend', 'core', 'SENIOR', 3);
    expect(tasks.map((t) => t.title)).not.toEqual(buildRoadmapTasks('Backend', 'core', 'JUNIOR', 3).map((t) => t.title));
    expect(buildRoadmapTasks('Database', 'warehouse', 'SENIOR', 3)[0]!.title).toContain('warehouse');
  });

  it('clamps days to 1..10 and rejects empty role/team', async () => {
    const wide = await generateOnboardingRoadmap(USER, { role: 'DevOps', team: 'infra', seniority: 'SENIOR', days: 50 });
    expect(wide.days).toBe(10);
    expect(wide.tasks).toHaveLength(10);
    const tiny = await generateOnboardingRoadmap(USER, { role: 'DevOps', team: 'infra', seniority: 'SENIOR', days: 0 });
    expect(tiny.days).toBe(1);
    await expect(generateOnboardingRoadmap(USER, { role: '', team: 'x', seniority: 'JUNIOR' })).rejects.toThrow(AppError);
    await expect(generateOnboardingRoadmap(USER, { role: 'x', team: '', seniority: 'JUNIOR' })).rejects.toThrow(AppError);
  });

  it('persists, lists by role and reports; user-scoped', async () => {
    await generateOnboardingRoadmap(USER, { role: 'Frontend', team: 'a', seniority: 'JUNIOR', days: 5 });
    await generateOnboardingRoadmap(USER, { role: 'Backend', team: 'b', seniority: 'SENIOR', days: 5 });
    const roadmap = await generateOnboardingRoadmap(USER, { role: 'Backend', team: 'c', seniority: 'MID', days: 5 });
    expect(await listOnboardingRoadmaps(USER, { role: 'Backend' })).toHaveLength(2);
    const report = await onboardingRoadmapReport(USER);
    expect(report.total).toBe(3);
    expect(report.by_seniority.JUNIOR).toBe(1);
    expect(report.by_seniority.SENIOR).toBe(1);
    await expect(getOnboardingRoadmap(OTHER, roadmap.id)).rejects.toThrow(/onboarding_roadmap_not_found/);
  });
});

// ── ASYNC DECISION PLATFORM (#142) ──────────────────────────────────────────

describe('ASYNC DECISION PLATFORM — structured voting with dissent, resolved (#142)', () => {
  beforeEach(cleartables);

  it('proposes a decision with options and evidence; stays OPEN', async () => {
    const decision = await proposeDecision(USER, {
      title: 'move to event-driven?',
      description: 'async workflow vs queue',
      options: [
        { key: 'evt', label: 'event-driven', impact: 'rework' },
        { key: 'que', label: 'queue-first', impact: 'smaller change' },
      ],
      evidence: ['traction data', 'cost model'],
      voters: ['ana', 'ben', 'cat'],
    });
    expect(decision.title).toBe('move to event-driven?');
    expect(decision.status).toBe('OPEN');
    expect(decision.resolved_option).toBeNull();
    expect(decision.options).toHaveLength(2);
    expect(decision.evidence).toEqual(['traction data', 'cost model']);
    expect(decision.id).toMatch(/^adc-/);
    expect(AUDIT_ACTIONS()).toContain('team.decision_proposed');
  });

  it('records votes and dissents; unresolved until every voter has voted', async () => {
    const decision = await proposeDecision(USER, {
      title: 'db choice',
      description: 'pg vs serverless',
      options: [
        { key: 'pg', label: 'postgres', impact: 'ops' },
        { key: 'serverless', label: 'serverless', impact: 'cost' },
      ],
      voters: ['ana', 'ben'],
    });
    const first = await castDecisionVote(USER, decision.id, { voter: 'ana', option: 'pg', weight: 2, dissent: 'operating overhead' });
    expect(first.resolved).toBe(false);
    expect(AUDIT_ACTIONS()).toContain('team.decision_vote_cast');
    expect(AUDIT_ACTIONS()).toContain('team.decision_dissent_logged');
    const still = await getAsyncDecision(USER, decision.id);
    expect(still.status).toBe('OPEN');
    await expect(resolveDecision(USER, decision.id)).rejects.toThrow(/pending voters: ben/);
  });

  it('resolves by weighted majority once every voter has voted', async () => {
    const decision = await proposeDecision(USER, {
      title: 'registry',
      description: 'which package registry',
      options: [
        { key: 'npm', label: 'npm', impact: 'default' },
        { key: 'pnpm', label: 'pnpm', impact: 'faster' },
      ],
      voters: ['ana', 'ben'],
    });
    await castDecisionVote(USER, decision.id, { voter: 'ana', option: 'npm', weight: 1 });
    const ben = await castDecisionVote(USER, decision.id, { voter: 'ben', option: 'pnpm', weight: 3 });
    expect(ben.resolved).toBe(true);
    const result = await resolveDecision(USER, decision.id);
    expect(result.winner).toBe('pnpm');
    expect(result.decision.status).toBe('DECIDED');
    expect(result.decision.resolved_option).toBe('pnpm');
    expect(AUDIT_ACTIONS()).toContain('team.decision_resolved');
  });

  it('breaks weighted ties by fewer dissents, then alphabetically', () => {
    const tie = resolveDecisions(['ana', 'ben'], [
      { voter: 'ben', option: 'b', weight: 1 },
      { voter: 'ana', option: 'a', weight: 1 },
    ], [{ voter: 'ben', concern: 'b is risky' }]);
    expect(tie.resolved).toBe(true);
    expect(tie.winner).toBe('a');

    const alpha = resolveDecisions(['ana', 'ben'], [
      { voter: 'ben', option: 'b', weight: 1 },
      { voter: 'ana', option: 'a', weight: 1 },
    ], []);
    expect(alpha.winner).toBe('a');

    const weighted = resolveDecisions(['ana', 'ben'], [
      { voter: 'ana', option: 'x', weight: 2 },
      { voter: 'ben', option: 'y', weight: 2 },
    ], []);
    expect(weighted.resolved).toBe(true);
    expect(weighted.tally.x).toBe(2);
  });

  it('closes decisions and reports statuses; stays user-scoped', async () => {
    const decision = await proposeDecision(USER, {
      title: 'rename',
      description: 'rename package',
      options: [{ key: 'a', label: 'a', impact: 'x' }, { key: 'b', label: 'b', impact: 'y' }],
      voters: ['ana'],
    });
    await castDecisionVote(USER, decision.id, { voter: 'ana', option: 'b', weight: 1 });
    await resolveDecision(USER, decision.id);
    await closeDecision(USER, decision.id);
    const closed = await getAsyncDecision(USER, decision.id);
    expect(closed.status).toBe('CLOSED');
    expect((await closeDecision(USER, decision.id)).status).toBe('CLOSED');
    const report = await asyncDecisionReport(USER);
    expect(report.total).toBe(1);
    expect(report.by_status.CLOSED).toBe(1);
    expect((await listAsyncDecisions(USER, { status: 'CLOSED' }))[0]!.id).toBe(decision.id);
    await expect(getAsyncDecision(OTHER, decision.id)).rejects.toThrow(/async_decision_not_found/);
  });

  it('rejects duplicate options, unknown voters-option keys, double votes and late votes', async () => {
    await expect(proposeDecision(USER, {
      title: 'x',
      description: 'y',
      options: [{ key: 'a', label: 'a', impact: 'x' }, { key: 'a', label: 'b', impact: 'y' }],
    })).rejects.toThrow(AppError);
    await expect(proposeDecision(USER, { title: 'x', description: 'y', options: [{ key: 'a', label: 'a', impact: 'x' }] })).rejects.toThrow(AppError);
    const decision = await proposeDecision(USER, {
      title: 'x',
      description: 'y',
      options: [{ key: 'a', label: 'a', impact: 'x' }, { key: 'b', label: 'b', impact: 'y' }],
      voters: ['ana'],
    });
    await expect(castDecisionVote(USER, decision.id, { voter: 'zoe', option: 'a', weight: 1 })).rejects.toThrow(/not registered/);
    const open = await proposeDecision(USER, {
      title: 'y',
      description: 'z',
      options: [{ key: 'a', label: 'a', impact: 'x' }, { key: 'b', label: 'b', impact: 'y' }],
    });
    await expect(castDecisionVote(USER, open.id, { voter: 'zoe', option: 'zz', weight: 1 })).rejects.toThrow(/not in this decision/);
    await castDecisionVote(USER, decision.id, { voter: 'ana', option: 'a', weight: 1 });
    await expect(castDecisionVote(USER, decision.id, { voter: 'ana', option: 'b', weight: 1 })).rejects.toThrow(/already voted/);
    await expect(castDecisionVote(USER, decision.id, { voter: 'ana', option: 'a', weight: 0 })).rejects.toThrow(AppError);
  });
});