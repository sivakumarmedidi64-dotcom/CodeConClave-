/**
 * CodeConClave — Stage 99 SUPERPOWERS Tranche U: Challenge Mode, Ask My
 * Codebase Live, Cost Badge, Cost Thermometer, Drift Police.
 *
 *   CHALLENGE MODE (#82)        — product idea → production quality in 24h, defended.
 *   ASK MY CODEBASE LIVE (#83)  — public read-only Q&A link, auto-expiring.
 *   COST BADGE (#84)            — the infra cost delta on every PR.
 *   COST THERMOMETER (#85)      — live spend trend across PRs.
 *   DRIFT POLICE (#86)          — IaC truth; reconcile or file the precise fix.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    product_challenges: [] as Array<Record<string, unknown>>,
    codebase_shares: [] as Array<Record<string, unknown>>,
    cost_estimates: [] as Array<Record<string, unknown>>,
    cost_thermometers: [] as Array<Record<string, unknown>>,
    drift_reports: [] as Array<Record<string, unknown>>,
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
          } else if (/^(\w+)\s*\+\s*(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(m[2]!);
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
    withSystem: async (fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: {
    CHALLENGE: 'chl',
    CODEBASE_SHARE: 'cbs',
    COST_ESTIMATE: 'cse',
    COST_THERMOMETER: 'ctm',
    DRIFT_REPORT: 'dft',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { startChallenge, buildChallengeTrack, defendDecisions, CHALLENGE_TRACKS, getChallenge, listChallenges, challengeReport } from '../modules/superpowers/challengeMode.js';
import { createCodebaseLink, answerPublicQuestion, expireShare, getShare, listShares, codebaseShareReport } from '../modules/superpowers/askCodebaseLive.js';
import { estimateCost, costDeltaFor, getCostEstimate, listCostEstimates, costBadgeReport } from '../modules/superpowers/costBadge.js';
import { takeThermometerReading, temperatureFor, getThermometerReading, listReadings, thermometerReport } from '../modules/superpowers/costThermometer.js';
import { diffStates, diffState, reconcileDrift, fileDriftFix, getDriftReport, listDriftReports, driftReportSummary } from '../modules/superpowers/driftPolice.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('CHALLENGE MODE (#82)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('kicks off a 24h challenge with the full production pipeline', async () => {
    expect(CHALLENGE_TRACKS).toHaveLength(7);
    const c = await startChallenge(USER, { idea: 'a git-powered doc site for founders' });
    expect(c.id).toMatch(/^chl-/);
    expect(c.tracks).toHaveLength(7);
    expect(c.tracks[0]!.status).toBe('READY');
    expect(c.status).toBe('RUNNING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.challenge_started');
  });

  it('builds tracks in order to production quality', async () => {
    const c = await startChallenge(USER, { idea: 'a git-powered doc site for founders' });
    await expect(buildChallengeTrack(USER, c.id, { track: 'code' })).rejects.toThrow(/one at a time/);
    await expect(buildChallengeTrack(USER, c.id, { track: 'marketing' })).rejects.toThrow(/buildable tracks/);

    const realized = await buildChallengeTrack(USER, c.id, { track: 'architecture' });
    expect(realized.tracks[0]!.status).toBe('REALIZED');
    expect(realized.tracks[0]!.note).toContain('components');
    expect(realized.tracks[1]!.status).toBe('READY');
    expect(AUDIT_ACTIONS()).toContain('autonomy.challenge_track_realized');

    for (const track of CHALLENGE_TRACKS.slice(1)) {
      await buildChallengeTrack(USER, c.id, { track });
    }
    const done = await getChallenge(USER, c.id);
    expect(done.tracks.every((t) => t.status === 'REALIZED')).toBe(true);
    expect(done.tracks[6]!.note).toContain('quickstart');
  });

  it('defends every decision once everything ships', async () => {
    const c = await startChallenge(USER, { idea: 'a git-powered doc site for founders' });
    await expect(defendDecisions(USER, c.id)).rejects.toThrow(/before the defense/);
    for (const track of CHALLENGE_TRACKS) await buildChallengeTrack(USER, c.id, { track });

    const defended = await defendDecisions(USER, c.id);
    expect(defended.status).toBe('COMPLETE');
    expect(defended.defense).toHaveLength(7);
    expect(defended.defense[0]!.question).toBe('defend the architecture decisions');
    expect(AUDIT_ACTIONS()).toContain('autonomy.challenge_defense_held');
    expect(AUDIT_ACTIONS()).toContain('autonomy.challenge_completed');
    await expect(defendDecisions(USER, c.id)).rejects.toThrow(/already happened/);
    await expect(buildChallengeTrack(USER, c.id, { track: 'code' })).rejects.toThrow(/already completed/);
  });

  it('reports and stays owner-scoped', async () => {
    const a = await startChallenge(USER, { idea: 'a git-powered doc site for founders' });
    await buildChallengeTrack(USER, a.id, { track: 'architecture' });

    const report = await challengeReport(USER);
    expect(report.challenges).toBe(1);
    expect(report.complete).toBe(0);
    expect(report.tracks_realized).toBe(1);
    await expect(getChallenge(OTHER, a.id)).rejects.toThrow(/challenge_not_found/);
    await expect(listChallenges(OTHER)).resolves.toHaveLength(0);
    await expect(startChallenge(USER, { idea: '' })).rejects.toThrow(/a product idea is required/);
  });
});

describe('ASK MY CODEBASE LIVE (#83)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('spins up a public read-only link that auto-expires in 24h', async () => {
    const s = await createCodebaseLink(USER, { project: 'CodeNest', pitch: 'agents that ship and defend' });
    expect(s.id).toMatch(/^cbs-/);
    expect(s.token).toMatch(/^pub-/);
    expect(s.status).toBe('LIVE');
    expect(new Date(s.expires_at).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(AUDIT_ACTIONS()).toContain('autonomy.codebase_share_created');
  });

  it('answers public questions from the scoped read-only view', async () => {
    const s = await createCodebaseLink(USER, { project: 'CodeNest', pitch: 'agents that ship and defend' });
    const answer = await answerPublicQuestion(s.token, 'how does editing work?');
    expect(answer.answer).toContain('read-only');
    expect(answer.answer).toContain('CodeNest');
    expect(answer.answer).toContain('no write access granted');

    const latest = await getShare(USER, s.id);
    expect(latest.question_count).toBe(1);
    const report = await codebaseShareReport(USER);
    expect(report.questions).toBe(1);
    expect(AUDIT_ACTIONS()).toContain('autonomy.codebase_question_answered');
  });

  it('rejects questions after the share auto-expires', async () => {
    const s = await createCodebaseLink(USER, { project: 'CodeNest', pitch: 'agents that ship and defend' });
    store.tables.codebase_shares[0]!.expires_at = '2020-01-01T00:00:00.000Z';
    await expect(answerPublicQuestion(s.token, 'how does editing work?')).rejects.toThrow(/fresh one/);

    const expired = await expireShare(USER, s.id);
    expect(expired.status).toBe('EXPIRED');
    await expect(expireShare(USER, s.id)).rejects.toThrow(/already expired/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.codebase_share_expired');
    await expect(answerPublicQuestion(s.token, 'how does editing work?')).rejects.toThrow(/fresh one/);
  });

  it('reports and stays owner-scoped', async () => {
    const a = await createCodebaseLink(USER, { project: 'CodeNest', pitch: 'agents that ship and defend' });
    const report = await codebaseShareReport(USER);
    expect(report.shares).toBe(1);
    expect(report.live).toBe(1);
    await expect(getShare(OTHER, a.id)).rejects.toThrow(/codebase_share_not_found/);
    await expect(listShares(OTHER)).resolves.toHaveLength(0);
    await expect(createCodebaseLink(USER, { project: '', pitch: 'x' })).rejects.toThrow(/project name/);
    await expect(answerPublicQuestion('nope', 'q')).rejects.toThrow(/codebase_share_not_found/);
  });
});

describe('COST BADGE (#84)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('puts the monthly infra delta on the PR', async () => {
    const feature = await estimateCost(USER, { context: 'feat: search indexer', component: 'feature', units: 40000, traffic: 'current traffic' });
    expect(feature.id).toMatch(/^cse-/);
    expect(feature.delta).toBe(2);
    expect(feature.badge).toBe('+~$2/month at current traffic');
    expect(costDeltaFor('feature', 40000)).toBe(2);

    const scale = await estimateCost(USER, { context: 'scale web +2', component: 'scale', units: 2, traffic: '40k req/mo' });
    expect(scale.delta).toBe(60);
    expect(scale.badge).toBe('+~$60/month at current traffic');
    expect(AUDIT_ACTIONS()).toContain('autonomy.cost_badge_generated');
  });

  it('shows savings when a PR takes infra away', async () => {
    const down = await estimateCost(USER, { context: 'retire legacy cache', component: 'storage', units: -200, traffic: 'current traffic' });
    expect(down.delta).toBe(-40);
    expect(down.badge).toBe('~$40/month saved at current traffic');
  });

  it('reports and stays owner-scoped', async () => {
    const a = await estimateCost(USER, { context: 'feat: search indexer', component: 'feature', units: 40000, traffic: 'current traffic' });
    await estimateCost(USER, { context: 'scale web +2', component: 'scale', units: 2, traffic: '40k req/mo' });
    await estimateCost(USER, { context: 'retire legacy cache', component: 'storage', units: -200, traffic: 'current traffic' });

    const report = await costBadgeReport(USER);
    expect(report.estimates).toBe(3);
    expect(report.monthly_delta_total).toBe(22);
    await expect(getCostEstimate(OTHER, a.id)).rejects.toThrow(/cost_estimate_not_found/);
    await expect(listCostEstimates(OTHER)).resolves.toHaveLength(0);
    await expect(estimateCost(USER, { context: 'x', component: 'ml' as never, units: 1, traffic: '' })).rejects.toThrow(/feature, scale, storage/);
  });
});

describe('COST THERMOMETER (#85)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('maps the spend trend to a temperature', () => {
    expect(temperatureFor(10)).toBe('cool');
    expect(temperatureFor(30)).toBe('warm');
    expect(temperatureFor(150)).toBe('hot');
    expect(temperatureFor(900)).toBe('boiling');
  });

  it('takes a reading from the cost estimates', async () => {
    await estimateCost(USER, { context: 'scale web +2', component: 'scale', units: 10, traffic: '40k req/mo' });
    await estimateCost(USER, { context: 'feat: search indexer', component: 'feature', units: 80000, traffic: 'current traffic' });

    const reading = await takeThermometerReading(USER);
    expect(reading.id).toMatch(/^ctm-/);
    expect(reading.total_delta).toBe(304);
    expect(reading.temperature).toBe('hot');
    expect(AUDIT_ACTIONS()).toContain('autonomy.cost_thermometer_reading');

    const report = await thermometerReport(USER);
    expect(report.readings).toBe(1);
    expect(report.latest!.temperature).toBe('hot');
  });

  it('reads cool with no deltas and stays owner-scoped', async () => {
    const a = await takeThermometerReading(USER);
    await estimateCost(USER, { context: 'feat: search indexer', component: 'feature', units: 1000, traffic: 'current traffic' });
    const b = await takeThermometerReading(USER);
    expect(b.total_delta).toBe(0.05);
    expect(b.temperature).toBe('cool');

    await expect(getThermometerReading(OTHER, a.id)).rejects.toThrow(/cost_reading_not_found/);
    await expect(listReadings(OTHER)).resolves.toHaveLength(0);
  });
});

describe('DRIFT POLICE (#86)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('classifies drift against declared IaC state', async () => {
    const report = await diffState(USER, {
      iac: { web: 'sha-a', db: 'sha-b', cache: 'sha-c' },
      actual: { web: 'sha-a', db: 'sha-d', redis: 'sha-z' },
    });
    expect(report.id).toMatch(/^dft-/);
    expect(report.status).toBe('OPEN');
    expect(report.drifts.map((d) => d.kind).sort()).toEqual(['added', 'modified', 'removed']);
    const modified = report.drifts.find((d) => d.resource === 'db')!;
    expect(modified.expected).toBe('sha-b');
    expect(modified.actual).toBe('sha-d');
    expect(AUDIT_ACTIONS()).toContain('autonomy.drift_state_diffed');
  });

  it('reconciles a drift by adopting actual state as truth', async () => {
    const report = await diffState(USER, { iac: { db: 'sha-b' }, actual: { db: 'sha-d' } });
    const reconciled = await reconcileDrift(USER, report.id, { resource: 'db' });
    expect(reconciled.drifts[0]!.resolution).toBe('RECONCILED');
    await expect(reconcileDrift(USER, report.id, { resource: 'db' })).rejects.toThrow(/already resolved/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.drift_reconciled');
  });

  it('files a precise fix for a stubborn drift; clean diffs stay clean', async () => {
    const report = await diffState(USER, { iac: { cache: 'sha-c' }, actual: { cache: 'sha-c' } });
    expect(report.status).toBe('CLEAN');
    expect(report.drifts).toHaveLength(0);

    const dirty = await diffState(USER, { iac: { cache: 'sha-c' }, actual: { cache: 'sha-z' } });
    const fixed = await fileDriftFix(USER, dirty.id, { resource: 'cache' });
    expect(fixed.drifts[0]!.resolution).toBe('FIX_FILED');
    expect(fixed.drifts[0]!.fix).toContain('terraform_plan_fix');
    expect(fixed.drifts[0]!.fix).toContain('sha-c');
    expect(fixed.drifts[0]!.fix).toContain('sha-z');
    await expect(fileDriftFix(USER, dirty.id, { resource: 'nope' })).rejects.toThrow(/not part of this drift report/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.drift_fix_filed');
  });

  it('summarizes and stays owner-scoped', async () => {
    const a = await diffState(USER, { iac: { db: 'sha-b', cache: 'sha-c' }, actual: { db: 'sha-d', redis: 'sha-z' } });
    await reconcileDrift(USER, a.id, { resource: 'db' });
    await fileDriftFix(USER, a.id, { resource: 'cache' });
    await diffState(USER, { iac: { clean: 'x' }, actual: { clean: 'x' } });
    await diffState(USER, { iac: { web: 'sha-a' }, actual: { web: 'sha-w' } });

    const summary = await driftReportSummary(USER);
    expect(summary.reports).toBe(3);
    expect(summary.clean).toBe(1);
    expect(summary.open_drifts).toBe(2);
    expect(summary.reconciled).toBe(1);
    expect(summary.fixes_filed).toBe(1);

    await expect(getDriftReport(OTHER, a.id)).rejects.toThrow(/drift_report_not_found/);
    await expect(listDriftReports(OTHER)).resolves.toHaveLength(0);
    await expect(diffState(USER, { iac: 'nope' as never, actual: {} })).rejects.toThrow(/declared IaC state/);
  });
});