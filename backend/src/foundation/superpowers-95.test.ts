/**
 * CodeConClave — Stage 95 SUPERPOWERS Tranche Q: Regression Time Machine,
 * Knowledge Diffusion, Human-AI Fusion Scoring, Rubber Duck Mode, Code Translator.
 *
 *   REGRESSION TIME MACHINE (#54) — every regression this module ever caused,
 *                                   with the fix that worked, on a timeline.
 *   KNOWLEDGE DIFFUSION (#55)      — one engineer's breakthrough becomes every
 *                                   agent's baseline, retrieved per area.
 *   HUMAN-AI FUSION SCORING (#57)  — where value comes from, in numbers, and
 *                                   where to push the mix next.
 *   RUBBER DUCK MODE (#60)         — Socratic questions until YOU find it.
 *   CODE TRANSLATOR (#61)          — your code, explained in the language you
 *                                   think in.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    regression_timelines: [] as Array<Record<string, unknown>>,
    knowledge_diffusions: [] as Array<Record<string, unknown>>,
    fusion_scores: [] as Array<Record<string, unknown>>,
    duck_sessions: [] as Array<Record<string, unknown>>,
    code_translations: [] as Array<Record<string, unknown>>,
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
    REGRESSION_TIMELINE: 'rtm',
    KNOWLEDGE_LESSON: 'kld',
    FUSION_SAMPLE: 'fus',
    DUCK_SESSION: 'duk',
    CODE_TRANSLATION: 'ctl',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { openTimeline, buildTimelineSummary, addRegression, getRegressionTimeline, listRegressionTimelines, regressionReport } from '../modules/superpowers/regressionTimeline.js';
import { seedLesson, coveringAgents, diffuseLesson, retrieveLesson, getLesson, listLessons, knowledgeReport } from '../modules/superpowers/knowledgeDiffusion.js';
import { recordFusionSample, fusionMix, getFusionSample, listFusionSamples, fusionReport, fusionTrend } from '../modules/superpowers/fusionScoring.js';
import { startDuckSession, socraticTurns, foundIt, getDuckSession, listDuckSessions, duckReport } from '../modules/superpowers/rubberDuck.js';
import { translateCode, keywordExplanation, getCodeTranslation, listCodeTranslations, codeTranslatorReport } from '../modules/superpowers/codeTranslator.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

const PAY_REG = (worked: boolean, ref: string, fix: string): { ref: string; changed: string; broke: string; fix: string; worked: boolean } => ({
  ref,
  changed: 'shipped a change',
  broke: 'broke something',
  fix,
  worked,
});

// ── REGRESSION TIME MACHINE (#54) ───────────────────────────────────────────

describe('REGRESSION TIME MACHINE — archaeology, instant (#54)', () => {
  beforeEach(cleartables);

  it('summarizes the timeline with the fix rate', () => {
    const stats = buildTimelineSummary('payments', [PAY_REG(true, 'c1', 'dedupe key'), PAY_REG(false, 'c2', 'exponential backoff')]);
    expect(stats.regression_count).toBe(2);
    expect(stats.fix_rate).toBe(50);
    expect(stats.summary).toContain('payments regressed 2 times');
    expect(stats.summary).toContain('1 fixed by a known-good change');
  });

  it('opens a module timeline from history', async () => {
    const timeline = await openTimeline(USER, { module: 'payments', history: [PAY_REG(true, 'c1', 'dedupe key'), PAY_REG(false, 'c2', 'exponential backoff')] });
    expect(timeline.id).toMatch(/^rtm-/);
    expect(timeline.events).toHaveLength(2);
    expect(timeline.regression_count).toBe(2);
    expect(timeline.fix_rate).toBe(50);
    expect(AUDIT_ACTIONS()).toContain('autonomy.regression_timeline_opened');
  });

  it('grows with new regressions, reports, and stays owner-scoped', async () => {
    const timeline = await openTimeline(USER, { module: 'payments', history: [PAY_REG(true, 'c1', 'dedupe key')] });
    const grown = await addRegression(USER, timeline.id, PAY_REG(true, 'c2', 'backoff'));
    expect(grown.regression_count).toBe(2);
    expect(grown.fix_rate).toBe(100);
    expect(AUDIT_ACTIONS()).toContain('autonomy.regression_added');

    await openTimeline(USER, { module: 'auth', history: [PAY_REG(false, 'c1', 'session store')] });
    await openTimeline(USER, { module: 'billing', history: [PAY_REG(true, 'c1', 'stale lock'), PAY_REG(true, 'c2', 'retry once')] });

    const report = await regressionReport(USER);
    expect(report.timelines).toBe(3);
    expect(report.regressions).toBe(5);
    expect(report.most_regressed).toBe('payments');

    const authTimeline = (await listRegressionTimelines(USER)).find((t) => t.module === 'auth')!;
    await expect(getRegressionTimeline(OTHER, authTimeline.id)).rejects.toThrow(/regression_timeline_not_found/);
    await expect(openTimeline(USER, { module: '', history: [PAY_REG(true, 'c1', 'x')] })).rejects.toThrow(AppError);
    await expect(openTimeline(USER, { module: 'm', history: [] })).rejects.toThrow(/at least one regression/);
    await expect(addRegression(USER, authTimeline.id, { ref: '', changed: 'x', broke: '', fix: '', worked: true })).rejects.toThrow(/needs a ref/);
  });
});

// ── KNOWLEDGE DIFFUSION (#55) ───────────────────────────────────────────────

describe('KNOWLEDGE DIFFUSION — one breakthrough, everyone\u2019s baseline (#55)', () => {
  beforeEach(cleartables);

  it('routes a lesson to the right agent domains by area', () => {
    expect(coveringAgents('webhook race conditions')).toEqual(['runtime-agent']);
    expect(coveringAgents('payments billing session auth')).toEqual(['billing-agent', 'auth-agent']);
    expect(coveringAgents('css render bug')).toEqual(['frontend-agent']);
  });

  it('seeds and diffuses a lesson to carrying agents', async () => {
    const lesson = await seedLesson(USER, {
      topic: 'webhook races',
      lesson: 'dedupe webhook deliveries by event id before applying them',
      area: 'webhook race conditions',
    });
    expect(lesson.id).toMatch(/^kld-/);
    expect(lesson.status).toBe('SEEDED');
    expect(lesson.agents).toEqual(['runtime-agent']);
    expect(lesson.reaches).toBe(1);
    expect(AUDIT_ACTIONS()).toContain('autonomy.knowledge_seeded');

    const diffused = await diffuseLesson(USER, lesson.id);
    expect(diffused.status).toBe('DIFFUSED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.knowledge_diffused');
    await expect(diffuseLesson(USER, lesson.id)).rejects.toThrow(/only a fresh/);
  });

  it('retrieves the lesson for anyone touching that area, then reports', async () => {
    await seedLesson(USER, { topic: 'webhook races', lesson: 'dedupe by event id', area: 'webhook race conditions' });
    await seedLesson(USER, { topic: 'payments ids', lesson: 'idempotency keys', area: 'payments billing' });

    const hit = await retrieveLesson(USER, { area: 'billing session' });
    expect(hit.lessons).toHaveLength(1);
    expect(hit.lessons[0]!.topic).toBe('payments ids');
    expect(hit.note).toContain('1 lesson(s) surface');
    expect(AUDIT_ACTIONS()).toContain('autonomy.knowledge_retrieved');

    const again = await retrieveLesson(USER, { area: 'billing session' });
    expect(again.lessons[0]!.retrievals).toBe(2);

    const miss = await retrieveLesson(USER, { area: 'css render' });
    expect(miss.lessons).toHaveLength(0);
    expect(miss.note).toContain('no lesson covers');

    await seedLesson(USER, { topic: 'auth tokens', lesson: 'short-lived sessions', area: 'session auth login' });
    const report = await knowledgeReport(USER);
    expect(report.lessons).toBe(3);
    expect(report.seeded).toBe(3);
    expect(report.diffused).toBe(0);
    expect(report.coverage).toBe(50);
    expect(report.retrievals).toBe(2);

    const otherLesson = (await listLessons(USER)).find((l) => l.topic === 'auth tokens')!;
    await expect(getLesson(OTHER, otherLesson.id)).rejects.toThrow(/knowledge_lesson_not_found/);
    await expect(seedLesson(USER, { topic: '', lesson: 'x', area: 'auth' })).rejects.toThrow(AppError);
    await expect(retrieveLesson(USER, { area: '' })).rejects.toThrow(/area is required/);
  });
});

// ── HUMAN-AI FUSION SCORING (#57) ───────────────────────────────────────────

describe('HUMAN-AI FUSION SCORING — the mix, in numbers (#57)', () => {
  beforeEach(cleartables);

  it('labels the mix and says where to push next', () => {
    expect(fusionMix(30, 70)).toEqual({ total: 100, human_share: 30, label: 'agent-led', verdict: 'push toward humans next' });
    expect(fusionMix(40, 60).human_share).toBe(40);
    expect(fusionMix(40, 60).label).toBe('balanced');
    expect(fusionMix(40, 60).verdict).toBe('10x compound active');
    expect(fusionMix(80, 20)).toEqual({ total: 100, human_share: 80, label: 'human-led', verdict: 'push toward agents next' });
  });

  it('records a window and files the score', async () => {
    const sample = await recordFusionSample(USER, { window: '2026-09-01', human_points: 40, agent_points: 60 });
    expect(sample.id).toMatch(/^fus-/);
    expect(sample.total).toBe(100);
    expect(sample.human_share).toBe(40);
    expect(sample.label).toBe('balanced');
    expect(sample.verdict).toBe('10x compound active');
    expect(AUDIT_ACTIONS()).toContain('autonomy.fusion_scored');
  });

  it('trends the mix over time, reports, and stays owner-scoped', async () => {
    await recordFusionSample(USER, { window: 'w1', human_points: 20, agent_points: 80 });
    const recent = await recordFusionSample(USER, { window: 'w2', human_points: 40, agent_points: 60 });

    const trend = await fusionTrend(USER);
    expect(trend.samples).toBe(2);
    expect(trend.avg_human_share).toBe(30);
    expect(trend.direction).toBe('more human-led');
    expect(trend.last_label).toBe('balanced');

    const report = await fusionReport(USER);
    expect(report.samples).toBe(2);
    expect(report.balanced_windows).toBe(1);

    await expect(getFusionSample(OTHER, recent.id)).rejects.toThrow(/fusion_sample_not_found/);
    await expect(recordFusionSample(USER, { window: '', human_points: 1, agent_points: 1 })).rejects.toThrow(AppError);
    await expect(recordFusionSample(USER, { window: 'w3', human_points: -1, agent_points: 1 })).rejects.toThrow(/non-negative/);
  });
});

// ── RUBBER DUCK MODE (#60) ──────────────────────────────────────────────────

describe('RUBBER DUCK MODE — the question that unlocks it (#60)', () => {
  beforeEach(cleartables);

  it('scaffolds Socratic turns around your exact problem', () => {
    const turns = socraticTurns('I am getting null pointer exceptions in the payment handler');
    expect(turns).toHaveLength(4);
    expect(turns[0]!).toContain('the payment handler');
    expect(turns[0]!).toContain('null');
    expect(turns[2]!).toContain('changed');
  });

  it('opens a session and asks one question at a time', async () => {
    const session = await startDuckSession(USER, { problem: 'I am getting null pointer exceptions in the payment handler' });
    expect(session.id).toMatch(/^duk-/);
    expect(session.status).toBe('SEARCHING');
    expect(session.turns).toHaveLength(4);
    expect(AUDIT_ACTIONS()).toContain('autonomy.duck_session_started');
  });

  it('records the aha, reports, and stays owner-scoped', async () => {
    const session = await startDuckSession(USER, { problem: 'hang in the checkout queue' });
    const found = await foundIt(USER, session.id, 'the queue pop was serializing on the lock again');
    expect(found.status).toBe('FOUND');
    expect(found.resolution).toContain('queue pop');
    expect(AUDIT_ACTIONS()).toContain('autonomy.duck_session_found');
    await expect(foundIt(USER, session.id, 'twice')).rejects.toThrow(/already found/);

    const second = await startDuckSession(USER, { problem: 'auth works locally but not in prod' });
    await expect(foundIt(USER, second.id, '')).rejects.toThrow(/what you figured out/);
    const secondFound = await foundIt(USER, second.id, 'the prod env rewrote the token scope');
    expect(secondFound.status).toBe('FOUND');

    const report = await duckReport(USER);
    expect(report.sessions).toBe(2);
    expect(report.searching).toBe(0);
    expect(report.found).toBe(2);

    await expect(getDuckSession(OTHER, session.id)).rejects.toThrow(/duck_session_not_found/);
    await expect(startDuckSession(USER, { problem: '' })).rejects.toThrow(/problem you are trying to debug/);
  });
});

// ── CODE TRANSLATOR (#61) ───────────────────────────────────────────────────

describe('CODE TRANSLATOR — speaks your language, not the code\u2019s (#61)', () => {
  beforeEach(cleartables);

  it('names constructs in the target paradigm', () => {
    expect(keywordExplanation('if (x) return 1;')).toBe('condition');
    expect(keywordExplanation('for (;;) {}')).toBe('iteration');
    expect(keywordExplanation('try { send() }')).toBe('error handling');
    expect(keywordExplanation('#include <pg.h>')).toBe('dependency declaration');
    expect(keywordExplanation('int x = 0;')).toBe('plain statement');
  });

  it('explains C++ to a Python dev with paradigm notes', async () => {
    const translation = await translateCode(USER, {
      source_lang: 'cpp',
      target_lang: 'python',
      source: 'int x = 0;\nif (x) return 1;\nfor (;;) {}',
    });
    expect(translation.id).toMatch(/^ctl-/);
    expect(translation.summary).toContain('cpp → python');
    expect(translation.summary).toContain('3 line(s) explained');
    expect(translation.steps).toHaveLength(3);
    expect(translation.steps[1]!.explanation).toBe('condition');
    expect(translation.steps[2]!.explanation).toBe('iteration');
    expect(translation.notes[0]!).toContain('early returns');
    expect(translation.notes[1]!).toContain('for a python developer');
    expect(AUDIT_ACTIONS()).toContain('autonomy.code_translated');
  });

  it('reports, persists, and stays owner-scoped', async () => {
    await translateCode(USER, { source_lang: 'cpp', target_lang: 'rust', source: 'void f() { panic!("x"); }' });
    const second = await translateCode(USER, { source_lang: 'js', target_lang: 'python', source: 'const x = await load();' });

    const report = await codeTranslatorReport(USER);
    expect(report.translations).toBe(2);
    expect(report.total_lines).toBe(2);
    expect(report.target_languages).toBe(2);

    await expect(getCodeTranslation(OTHER, second.id)).rejects.toThrow(/code_translation_not_found/);
    await expect(listCodeTranslations(USER)).resolves.toHaveLength(2);
    await expect(translateCode(USER, { source_lang: '', target_lang: 'python', source: 'x' })).rejects.toThrow(AppError);
    await expect(translateCode(USER, { source_lang: 'cpp', target_lang: 'python', source: '   \n  ' })).rejects.toThrow(/no code to translate/);
  });
});