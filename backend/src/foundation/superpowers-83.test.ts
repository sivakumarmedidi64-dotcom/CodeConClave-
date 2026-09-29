/**
 * CodeConClave — Stage 83 SUPERPOWERS Tranche E: foresight & intelligence.
 *
 *   TURBO            (#16) — perf finding recorded ONLY with before/after proof;
 *                           improvement % is computed, never self-reported.
 *   CHRONOS          (#17) — "why does the codebase work this way" answered from
 *                           stored decision records (reasoning + assumptions).
 *   PATTERN PROPHET  (#24) — team solution-shapes learned, auto-applied to
 *                           matching triggers, accepted/declined with audit.
 *   DECISION REAPER  (#25) — stale assumptions / 180d horizon surface as
 *                           RECONSIDERING; superseded decisions are exempt.
 *   WHY-WIKI         (#28) — pinned (file, line) why-entries with source links.
 *
 * DB/audit/ids are mocked; all scoring + decision logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    performance_findings: [] as Array<Record<string, unknown>>,
    decision_records: [] as Array<Record<string, unknown>>,
    pattern_signatures: [] as Array<Record<string, unknown>>,
    why_links: [] as Array<Record<string, unknown>>,
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
    performance_findings: { status: 'OPEN', improvement_pct: 0, diagnosis: null },
    decision_records: { status: 'ACTIVE', reconsider_ticket: null },
    pattern_signatures: { usage_count: 0, certified: false, status: 'ENABLED' },
    why_links: { status: 'ACTIVE', line: null, source_ref: null },
  };
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '').replace(/[`"']/g, '');
  }
  function parseVal(col: string, val: unknown): unknown {
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try { return JSON.parse(val); } catch { /* keep raw */ }
    }
    if (col === 'assumptions' || col === 'steps' || col === 'reasons' || col === 'summary') {
      if (typeof val === 'string') { try { return JSON.parse(val); } catch { /* keep raw */ } }
    }
    return val;
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const q = text;
    const lq = q.toLowerCase().trim();
    const params = rawParams.map((p) => p);

    const ins = /insert into (\w+)\s*\(([^\)]+)\)\s*values\s*\((.*)\)/is.exec(q);
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
      for (const [k, v] of Object.entries(defaults)) {
        if (row[k] === undefined) row[k] = v;
      }
      storeRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (/^update \w+/.test(lq)) {
      const table = /^update (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(q);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1]!) - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1]!) - 1])) return { rows: [], rowCount: 0 };
      const setMatch = /set\s+(.+?)\s+where/is.exec(q);
      if (setMatch && target) {
        for (const pair of setMatch[1]!.split(',').map((s) => s.trim())) {
          const eq = pair.indexOf('=');
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
          } else {
            const arith = /^(?:(\w+)\s*\+\s*(\d+)|(\w+)\s*-\s*(\d+))$/.exec(ref);
            if (arith) {
              const cur = Number(target[col] ?? 0);
              target[col] = arith[2] != null ? cur + Number(arith[2]) : cur - Number(arith[4]);
            }
          }
        }
      }
      return { rows: target ? [target] : [], rowCount: 1 };
    }

    if (/^delete from \w+/.test(lq)) {
      const table = /^delete from (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)$/is.exec(q);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const idx = rows.findIndex((r) => r.id === String(params[Number(idRef?.[1] ?? 0) - 1]));
      if (idx < 0) return { rows: [], rowCount: 0 };
      if (ownerRef && String(rows[idx]!.owner_id) !== String(params[Number(ownerRef[1]!) - 1])) return { rows: [], rowCount: 0 };
      const [removed] = rows.splice(idx, 1);
      return { rows: removed ? [removed] : [], rowCount: 1 };
    }

    if (/select \*/.test(lq)) {
      const tableMatch = /from (\w+)/i.exec(q);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatchRaw = /where\s+(.+)$/is.exec(q);
      let whereTail = (whereMatchRaw?.[1] ?? '').replace(/\s+limit\s+\d+$/i, '');
      const whereMatch = whereTail ? { 1: whereTail } : null;
      let filtered = [...rows];
      if (whereMatch) {
        for (const clause of String(whereMatch[1]).split(/\s+and\s+/i)) {
          const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(clause.trim());
          if (m) {
            const val = params[Number(m[2]!) - 1];
            filtered = filtered.filter((r) => String(r[cleanCol(m[1]!)] ?? '') === String(val ?? ''));
          }
        }
      }
      return { rows: filtered, rowCount: filtered.length };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    pool: { query: queryImpl },
    queryMany: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows),
    queryOne: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: {
    PERF_FINDING: 'pff',
    DECISION_RECORD: 'dcr',
    PATTERN_SIGNATURE: 'ptn',
    WHY_LINK: 'whl',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { computeImprovementPct, recordPerformanceFinding, listPerformanceFindings, resolvePerformanceFinding } from '../modules/superpowers/turbo.js';
import { recordDecision, getDecisionHistory, searchDecisions, findDecisionById } from '../modules/superpowers/chronos.js';
import { reapDecisions, recordReconsider, suppressDecision, reviewUnlessSupplanted, decodeAssumptions } from '../modules/superpowers/decisionReaper.js';
import { learnPattern, matchPattern, applyPattern, certifyPattern, listPatterns } from '../modules/superpowers/patternProphet.js';
import { createWhyLink, listWhyLinks, detachWhyLink, findWhyLinkById } from '../modules/superpowers/whyWiki.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

describe('TURBO — proven performance fixes (#16)', () => {
  beforeEach(cleartables);

  it('computes the improvement % deterministically and rejects junk benchmarks', () => {
    expect(computeImprovementPct(100, 40)).toBe(60);
    expect(computeImprovementPct(200, 50)).toBe(75);
    expect(computeImprovementPct(10, 10)).toBe(0);
    expect(() => computeImprovementPct(0, 5)).toThrow(AppError);
    expect(() => computeImprovementPct(-5, 5)).toThrow(AppError);
    expect(() => computeImprovementPct(Number.NaN, 5)).toThrow(AppError);
  });

  it('stores a finding with its computed improvement and audits creation', async () => {
    const f = await recordPerformanceFinding(USER, { target: 'billing/charger', title: 'N+1 on invoice list', benchmarkBefore: 1200, benchmarkAfter: 310 });
    expect(f.benchmark_before).toBe(1200);
    expect(f.benchmark_after).toBe(310);
    expect(f.improvement_pct).toBeCloseTo(74.17, 2);
    expect(f.status).toBe('OPEN');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'perf_finding.created' }));
  });

  it('requires a target and title', async () => {
    await expect(recordPerformanceFinding(USER, { target: '  ', title: 'x', benchmarkBefore: 1, benchmarkAfter: 0.5 })).rejects.toThrow(AppError);
    await expect(recordPerformanceFinding(USER, { target: 'x', title: '', benchmarkBefore: 1, benchmarkAfter: 0.5 })).rejects.toThrow(AppError);
  });

  it('lists newest-first and filters by status', async () => {
    await recordPerformanceFinding(USER, { target: 'a', title: 'first', benchmarkBefore: 100, benchmarkAfter: 50 });
    const second = await recordPerformanceFinding(USER, { target: 'b', title: 'second', benchmarkBefore: 100, benchmarkAfter: 90 });
    await resolvePerformanceFinding(USER, second.id);
    const open = await listPerformanceFindings(USER, { status: 'OPEN' });
    expect(open.length).toBe(1);
    expect(open[0]!.title).toBe('first');
    const fixed = await listPerformanceFindings(USER, { status: 'FIXED' });
    expect(fixed.length).toBe(1);
    expect(fixed[0]!.title).toBe('second');
    expect((await listPerformanceFindings(USER)).length).toBe(2);
  });

  it('closes a finding once and fences off other owners', async () => {
    const f = await recordPerformanceFinding(USER, { target: 'x', title: 'hot loop', benchmarkBefore: 100, benchmarkAfter: 25 });
    expect((await resolvePerformanceFinding(USER, f.id)).status).toBe('FIXED');
    expect((await resolvePerformanceFinding(USER, f.id)).status).toBe('FIXED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'perf_finding.fixed' }));
    await expect(resolvePerformanceFinding(OTHER, f.id)).rejects.toThrow(AppError);
  });
});

describe('CHRONOS — the why file (#17)', () => {
  beforeEach(cleartables);

  it('records a decision with its reasoning and assumptions', async () => {
    const d = await recordDecision(USER, {
      area: 'Auth', subject: 'JWT vs sessions', decision: 'Stateless JWT',
      reasoning: 'Multi-region replicas made server sessions leaky.',
      author: 'mal', assumptions: ['traffic fits in token size limits'],
    });
    expect(d.assumptions).toEqual(['traffic fits in token size limits']);
    expect(d.status).toBe('ACTIVE');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'decision.recorded' }));
  });

  it('rejects decisions missing any required part', async () => {
    await expect(recordDecision(USER, { area: 'A', subject: '', decision: 'x', reasoning: 'r', author: 'a' })).rejects.toThrow(AppError);
    await expect(recordDecision(USER, { area: 'A', subject: 's', decision: '', reasoning: 'r', author: 'a' })).rejects.toThrow(AppError);
  });

  it('answers why: history by area/status, newest first', async () => {
    await recordDecision(USER, { area: 'Auth', subject: 'sessions', decision: 'A', reasoning: 'r1', author: 'a' });
    await recordDecision(USER, { area: 'Billing', subject: 'prices', decision: 'B', reasoning: 'r2', author: 'a' });
    const authHistory = await getDecisionHistory(USER, 'auth');
    expect(authHistory.length).toBe(1);
    expect(await getDecisionHistory(USER, undefined, 'ACTIVE')).toHaveLength(2);
  });

  it('searches across reasoning and assumptions and validates the term', async () => {
    await recordDecision(USER, { area: 'Auth', subject: 'tokens', decision: 'JWT', reasoning: 'region replicas', author: 'a', assumptions: ['no revocation needed'] });
    const hits = await searchDecisions(USER, 'revocation');
    expect(hits.length).toBe(1);
    expect(hits[0]!.subject).toBe('tokens');
    const regionHits = await searchDecisions(USER, 'region');
    expect(regionHits.length).toBe(1);
    await expect(searchDecisions(USER, '   ')).rejects.toThrow(AppError);
    await expect(findDecisionById(OTHER, hits[0]!.id)).rejects.toThrow(AppError);
  });
});

describe('DECISION REAPER — assumptions expire (#25)', () => {
  beforeEach(cleartables);

  it('does not reap decisions whose assumptions still hold', async () => {
    await recordDecision(USER, { area: 'DB', subject: 'postgres', decision: 'A', reasoning: 'r', author: 'a', assumptions: [{ claim: 'read replicas scale', holds: true }, 'docs exist'] as never });
    expect(await reapDecisions(USER)).toEqual([]);
  });

  it('reaps a decision the moment an assumption no longer holds', async () => {
    await recordDecision(USER, {
      area: 'DB', subject: 'postgres choice', decision: 'A', reasoning: 'r', author: 'a',
      assumptions: [{ claim: 'traffic under 100k rps', holds: false }] as never,
    });
    const reaped = await reapDecisions(USER);
    expect(reaped.length).toBe(1);
    expect(reaped[0]!.reason).toContain('traffic under 100k rps');
  });

  it('reaps decisions past the 180-day horizon and exempts superseded ones', async () => {
    const fresh = await recordDecision(USER, { area: 'X', subject: 'old', decision: 'O', reasoning: 'r', author: 'a' });
    store.tables.decision_records[0]!.decided_at = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const reaped = await reapDecisions(USER);
    expect(reaped.map((r) => r.decision.id)).toEqual([fresh.id]);
    await suppressDecision(USER, fresh.id);
    expect(await reapDecisions(USER)).toEqual([]);
  });

  it('records the reconsider with a note, idempotently, and freezes superseded ones', async () => {
    const d = await recordDecision(USER, { area: 'Y', subject: 'topic', decision: 'D', reasoning: 'r', author: 'a', assumptions: [{ claim: 'still true', holds: false }] as never });
    const rec = await recordReconsider(USER, d.id, 'traffic grew 40x');
    expect(rec.status).toBe('RECONSIDERING');
    expect(rec.reconsider_ticket).toBe('traffic grew 40x');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'decision.reconsidered' }));
    const again = await recordReconsider(USER, d.id);
    expect(again.status).toBe('RECONSIDERING');
    await expect(reviewUnlessSupplanted(USER, d.id)).resolves.toMatchObject({ status: 'RECONSIDERING' });
    await suppressDecision(USER, d.id);
    await expect(reviewUnlessSupplanted(USER, d.id)).rejects.toThrow(AppError);
    expect(decodeAssumptions(['plain'])[0]).toMatchObject({ claim: 'plain', holds: null });
  });
});

describe('PATTERN PROPHET — scaffold before asked (#24)', () => {
  beforeEach(cleartables);

  it('learns a team pattern and audits it', async () => {
    const p = await learnPattern(USER, {
      triggerType: 'SCHEMA_CHANGE', trigger: 'ALTER TABLE stk_prices',
      steps: ['add feature flag', 'write 0084 migration', 'record audit log'],
    });
    expect(p.steps).toHaveLength(3);
    expect(p.status).toBe('ENABLED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'pattern.learned' }));
  });

  it('rejects missing/bad trigger data', async () => {
    await expect(learnPattern(USER, { triggerType: 'SCHEMA_CHANGE', trigger: '', steps: ['a'] })).rejects.toThrow(AppError);
    await expect(learnPattern(USER, { triggerType: 'NEW_MODULE', trigger: 'x', steps: [] })).rejects.toThrow(AppError);
    await expect(learnPattern(USER, { triggerType: 'BOGUS' as never, trigger: 'x', steps: ['a'] })).rejects.toThrow(AppError);
  });

  it('re-learning the same trigger+type upgrades the steps, not the identity', async () => {
    const a = await learnPattern(USER, { triggerType: 'SCHEMA_CHANGE', trigger: 'stk_prices', steps: ['migration'] });
    const b = await learnPattern(USER, { triggerType: 'SCHEMA_CHANGE', trigger: 'stk_prices', steps: ['migration', 'feature flag', 'audit'] });
    expect(b.id).toBe(a.id);
    expect(b.steps).toHaveLength(3);
    expect((await listPatterns(USER)).length).toBe(1);
  });

  it('matches exact triggers and falls back to most-used enabled pattern', async () => {
    await learnPattern(USER, { triggerType: 'SCHEMA_CHANGE', trigger: 'adds_price_flag', steps: ['flag'] });
    await learnPattern(USER, { triggerType: 'SCHEMA_CHANGE', trigger: 'adds_tenant', steps: ['migration'] });
    const exact = await matchPattern(USER, 'SCHEMA_CHANGE', 'adds_tenant');
    expect(exact!.trigger).toBe('adds_tenant');
    expect(await matchPattern(USER, 'ENDPOINT_ADD', 'anything')).toBeNull();
  });

  it('applies the pattern: scaffold + team-pattern-applied flag + usage bump', async () => {
    const p = await learnPattern(USER, { triggerType: 'NEW_MODULE', trigger: 'ledger', steps: ['scaffold module', 'wire DI'] });
    const applied = await applyPattern(USER, p.id, { trigger: 'start ledger' });
    expect(applied.flagged).toBe(true);
    expect(applied.scaffold).toEqual(['scaffold module', 'wire DI']);
    expect(applied.pattern.usage_count).toBe(1);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'pattern.applied' }));
    expect(await applyPattern(USER, p.id, { trigger: 'again' }).then((x) => x.pattern.usage_count)).toBe(2);
  });

  it('certifies accept/decline and blocks applying a declined pattern', async () => {
    const p = await learnPattern(USER, { triggerType: 'DEPENDENCY_UPGRADE', trigger: 'node 22', steps: ['pin versions'] });
    const declined = await certifyPattern(USER, p.id, false);
    expect(declined.status).toBe('DISABLED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'pattern.declined' }));
    await expect(applyPattern(USER, p.id, { trigger: 'up' })).rejects.toThrow(AppError);
    expect(await matchPattern(USER, 'DEPENDENCY_UPGRADE')).toBeNull();
    const accepted = await certifyPattern(USER, p.id, true);
    expect(accepted.certified).toBe(true);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'pattern.accepted' }));
  });

  it('lists by trigger type/status ordered by usage', async () => {
    const p = await learnPattern(USER, { triggerType: 'ENDPOINT_ADD', trigger: 'prices', steps: ['route'] });
    await learnPattern(USER, { triggerType: 'ENDPOINT_ADD', trigger: 'orders', steps: ['route', 'test'] });
    await applyPattern(USER, p.id, { trigger: 'prices' });
    const list = await listPatterns(USER, { triggerType: 'ENDPOINT_ADD' });
    expect(list[0]!.trigger).toBe('prices');
    const disabledOnly = await listPatterns(USER, { status: 'DISABLED' });
    expect(disabledOnly.length).toBe(0);
  });
});

describe('WHY-WIKI — linked why entries (#28)', () => {
  beforeEach(cleartables);

  it('pins a why entry to a file line with its source', async () => {
    const link = await createWhyLink(USER, {
      filePath: 'src/rates.ts', line: 42, reason: 'rounded to avoid float drift', sourceType: 'commit', sourceRef: 'abc123',
    });
    expect(link.line).toBe(42);
    expect(link.status).toBe('ACTIVE');
    expect(link.source_ref).toBe('abc123');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'why_link.created' }));
    const listed = await listWhyLinks(USER, 'src/rates.ts');
    expect(listed.length).toBe(1);
    expect(listed[0]!.id).toBe(link.id);
  });

  it('requires filePath, reason and sourceType', async () => {
    await expect(createWhyLink(USER, { filePath: '', reason: 'r', sourceType: 'commit' })).rejects.toThrow(AppError);
    await expect(createWhyLink(USER, { filePath: 'a.ts', reason: '', sourceType: 'commit' })).rejects.toThrow(AppError);
    await expect(createWhyLink(USER, { filePath: 'a.ts', reason: 'r', sourceType: '' })).rejects.toThrow(AppError);
  });

  it('detaches a link to keep history while stopping resolution', async () => {
    const link = await createWhyLink(USER, { filePath: 'auth.ts', line: 7, reason: 'why', sourceType: 'decision' });
    expect((await detachWhyLink(USER, link.id)).status).toBe('DETACHED');
    expect((await detachWhyLink(USER, link.id)).status).toBe('DETACHED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'why_link.detached' }));
    await expect(findWhyLinkById(OTHER, link.id)).rejects.toThrow(AppError);
  });

  it('lists all links newest-first', async () => {
    const a = await createWhyLink(USER, { filePath: 'a.ts', reason: 'one', sourceType: 'commit' });
    const b = await createWhyLink(USER, { filePath: 'b.ts', reason: 'two', sourceType: 'pr' });
    const all = await listWhyLinks(USER);
    expect(all[0]!.id).toBe(b.id);
    expect(all.some((w) => w.id === a.id)).toBe(true);
  });
});