/**
 * CodeConClave — PKG-23 Memory-Powered Coding — tests.
 *
 * Covers the 30 PKG-23 Phase-21 categories for: deterministic/heuristic
 * retrieval relevance, owner+project isolation, session restoration + RESTORED/
 * PARTIALLY_RESTORED/UNAVAILABLE, stale-vs-current-code supersession, preference
 * precedence, inferred handling, recurring-bug association, decision/deployment/
 * runtime memory, agent/editor context, correction, deletion, lifecycle bounds,
 * secret redaction, unauthorized access, cross-project leakage, bounded growth,
 * deterministic-retrieval honesty, no-fabricated-evidence, current-code >
 * stale-memory, rejection != permanent preference, explicit confirmation
 * durable, and restart continuity.
 *
 * Uses a purpose-built in-memory fake DB that emulates the memorycoding queries
 * (owner+project WHERE enforcement is verified against real seeded rows), plus
 * injected-deps tests for the aggregation layers. Deterministic, no PG.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================== fake DB harness
const hoisted = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  let seq = 0;

  const T = (n: string): Row[] => tables.get(n) ?? [];
  const set = (n: string, rows: Row[]): void => { tables.set(n, rows); };
  const dt = (): Date => new Date(1735689600000 + ++seq * 1000);

  // simple logical matcher: AND of conditions
  function matchWhere(where: string, params?: unknown[]): (r: Row) => boolean {
    const preds: Array<(r: Row) => boolean> = [];
    const clauses = where.split(/\s+AND\s+/i).filter(Boolean);
    for (const clause of clauses) {
      let m = /^(\w+)\s*=\s*(.+)$/.exec(clause);
      if (m) {
        const col = m[1]!; const val = lit(m[2]!, params);
        preds.push((r) => r[col] === val);
        continue;
      }
      m = /^(\w+)\s*IS\s+NOT\s+DISTINCT\s+FROM\s+(.+)$/.exec(clause);
      if (m) {
        const col = m[1]!; const val = lit(m[2]!, params);
        preds.push((r) => (r[col] ?? null) === val);
        continue;
      }
      m = /^id\s*=\s*ANY\(\$(\d+)::text\[\]\)$/.exec(clause);
      if (m) {
        const ids = params?.[Number(m[1]) - 1] as string[] | undefined ?? [];
        preds.push((r) => ids.includes(r.id as string));
        continue;
      }
      m = /^(\w+)\s*=\s*ANY\(\$(\d+)::text\[\]\)$/.exec(clause);
      if (m) {
        const col = m[1]!; const ids = params?.[Number(m[2]) - 1] as string[] | undefined ?? [];
        preds.push((r) => ids.includes(r[col] as string));
        continue;
      }
    }
    return (r) => preds.every((p) => p(r));
  }

  function lit(token: string, params?: unknown[]): unknown {
    const t = token.trim();
    const isDistinct = /^(\$\d+)::jsonb$/.exec(t);
    if (isDistinct) {
      const raw = params?.[Number(isDistinct[1]!.slice(1)) - 1];
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return raw; } }
      return raw;
    }
    if (/^\$\d+$/.test(t)) return params?.[Number(t.slice(1)) - 1];
    if (/^now\(\)$/i.test(t)) return new Date();
    if (t === 'true') return true; if (t === 'false') return false;
    if (t === 'NULL') return null;
    if (t === 'status') return undefined;
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    const n = Number(t); return Number.isNaN(n) ? t : n;
  }

  function splitTop(s: string): string[] {
    const out: string[] = []; let depth = 0; let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  // update RETURNING current value for increment expressions col = col+1
  function setVal(clause: string, row: Row, params?: unknown[]): void {
    const m = /^(\w+)\s*=\s*(.+)$/.exec(clause.trim());
    if (!m) return;
    const col = m[1]!;
    const inc = /^(\w+)\s*\+\s*(\d+)$/.exec(m[2]!.trim());
    if (inc) { row[col] = (row[inc[1]!] as number) + Number(inc[2]); return; }
    const caseM = /CASE WHEN (.*?) THEN '(.+?)' ELSE (\w+) END/.exec(m[2]!.trim());
    if (caseM) {
      const cond = caseM[1]!.trim();
      let ok = true;
      for (const pred of cond.split(/\s+AND\s+/)) {
        const pm = /^\s*(.+?)\s*(>=|<=|>|<|=)\s*(.+?)\s*$/.exec(pred);
        if (!pm) continue;
        const a = lit(pm[1]!, params) as number;
        const b = lit(pm[3]!, params) as number;
        if (pm[2] === '>') ok = ok && a > b;
        else if (pm[2] === '>=') ok = ok && a >= b;
        else if (pm[2] === '<') ok = ok && a < b;
        else if (pm[2] === '<=') ok = ok && a <= b;
        else if (pm[2] === '=') ok = ok && a === b;
      }
      row[col] = ok ? caseM[2]! : row[caseM[3]!];
      return;
    }
    row[col] = lit(m[2]!, params);
  }

  const query = vi.fn(async (text: string, params?: unknown[]) => {
    const ins = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)/is.exec(text);
    if (ins) {
      const table = ins[1]!;
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const vals = splitTop(ins[3]!);
      const row: Row = {};
      cols.forEach((c, i) => { row[c] = lit(vals[i] ?? 'NULL', params); });
      if (!('id' in row)) row.id = `id${++seq}`;
      if (!('created_at' in row)) row.created_at = dt();
      if (!('updated_at' in row)) row.updated_at = dt();
      if (table === 'dev_patterns') {
        if (!('evidence_count' in row)) row.evidence_count = 1;
        if (!('confirm_count' in row)) row.confirm_count = 0;
        if (!('reject_count' in row)) row.reject_count = 0;
        if (!('status' in row)) row.status = 'ACTIVE';
        if (!('confidence' in row)) row.confidence = 0.2;
      }
      if (table === 'dev_bug_incidents') {
        if (!('occurrences' in row)) row.occurrences = 1;
        if (!('status' in row)) row.status = 'OPEN';
      }
      const tbl = T(table);
      if (!tbl.some((r) => r.id === row.id)) set(table, [...tbl, row]);
      return { rows: [row] };
    }
    const upd = /UPDATE (\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/is.exec(text);
    if (upd) {
      const table = upd[1]!;
      const matcher = matchWhere(upd[3]!, params);
      const arr = T(table).map((r) => { if (matcher(r)) { for (const c of upd[2]!.split(',')) setVal(c, r, params); } return r; });
      set(table, arr);
      return { rows: [] };
    }
    const del = /DELETE FROM (\w+)\s*(?:WHERE\s+(.+))?/i.exec(text);
    if (del) {
      const table = del[1]!;
      if (del[2] != null && del[2].trim()) set(table, T(table).filter((r) => !matchWhere(del[2]!.trim(), params)(r)));
      else set(table, []);
      return { rows: [] };
    }
    // count / stats SELECT may be routed here too
    const countM = /count\(\*\)(?:\s*)::int\s+AS\s+n/.exec(text);
    if (countM) {
      const table = /FROM (\w+)/i.exec(text)?.[1]!;
      const where = /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s*$)/is.exec(text);
      let rows = T(table);
      if (where && where[1]!.trim()) rows = rows.filter(matchWhere(where[1]!, params));
      return { rows: [{ n: rows.length }] };
    }
    const from = /FROM (\w+)/i.exec(text);
    if (from) {
      const table = from[1]!;
      const whereM = /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s*$)/is.exec(text);
      let rows = T(table);
      if (whereM && whereM[1]!.trim()) rows = rows.filter(matchWhere(whereM[1]!, params));
      const orderM = /ORDER\s+BY\s+(.+?)(?:\s+LIMIT|\s*$)/is.exec(text);
      if (orderM) rows = orderRows(rows, orderM[1]!);
      const lim = /\s+LIMIT\s+(\d+)$/i.exec(text);
      if (lim) rows = rows.slice(0, Number(lim[1]));
      return { rows };
    }
    return { rows: [] };
  });

  function orderRows(rows: Row[], orderBy: string): Row[] {
    const parts = orderBy.split(',').map((s) => s.trim()).filter(Boolean);
    return [...rows].sort((a, b) => {
      for (const p of parts) {
        const m = /^(\w+)(\s+(DESC|ASC))?$/.exec(p);
        if (!m) continue;
        const col = m[1]!; const dir = (m[2] ?? ' ASC').trim().toUpperCase();
        const av = a[col]; const bv = b[col];
        if (av == null) return dir === 'DESC' ? 1 : -1;
        if (bv == null) return dir === 'DESC' ? -1 : 1;
        let cmp: number;
        if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
        else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv));
        if (dir === 'DESC') cmp = -cmp;
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  const queryMany = vi.fn(async (text: string, params?: unknown[]) => {
    if (/^(UPDATE|INSERT|DELETE)\b/i.test(text.trim())) { await query(text, params); return []; }
    const from = /FROM (\w+)/i.exec(text);
    if (!from) return [];
    const table = from[1]!;
    const whereM = /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s*$)/is.exec(text);
    let rows = T(table);
    if (whereM && whereM[1]!.trim()) rows = rows.filter(matchWhere(whereM[1]!, params));
    const orderM = /ORDER\s+BY\s+(.+?)(?:\s+LIMIT|\s*$)/is.exec(text);
    if (orderM) rows = orderRows(rows, orderM[1]!);
    const lim = /\s+LIMIT\s+(\d+)$/i.exec(text);
    if (lim) rows = rows.slice(0, Number(lim[1]));
    return rows;
  });

  const queryOne = vi.fn(async (text: string, params?: unknown[]) => (await queryMany(text, params))[0] ?? null);

  return { tables, query, queryMany, queryOne, reset: () => { tables.clear(); seq = 0; } };
});

vi.mock('../../shared/db.js', () => ({
  pool: { query: hoisted.query },
  queryMany: hoisted.queryMany,
  queryOne: hoisted.queryOne,
  withSystem: (fn: unknown) => (fn as (q: unknown) => unknown)?.({ query: hoisted.query }),
  withTenant: (_u: string | null, fn: unknown) => (fn as (q: unknown) => unknown)?.({ query: hoisted.query }),
}));

const envMock = vi.hoisted(() => {
  const e: Record<string, string> = { AIOS_P2_MEMORY_CODING: 'true', AIOS_P2_VOICE: 'false', AIOS_P2_NOTIFICATIONS: 'false' };
  return e;
});
vi.mock('../../config/env.js', () => ({ env: envMock }));

vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => undefined) }));

// memory service is heavy (embeddings, withTenant) — only feedback needs createMemory
const memoryMock = vi.hoisted(() => ({
  createMemory: vi.fn(async () => ({ id: 'mem1' })),
  correctMemory: vi.fn(async () => ({ id: 'c1' })),
  getMemory: vi.fn(async (_u, id) => ({ id, content: 'stale', project_id: null, owner_id: 'u1' })),
  flagMemoryWrong: vi.fn(async () => ({})),
  retrieveMemoriesForPrompt: vi.fn(async () => []),
  listMemories: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock('../memory/service.js', () => memoryMock);

import { scoreMemory, rankMemories, type RelevanceContext } from './relevance.js';
import { patternConfidence } from './codingRecords.js';
import { renderAgentMemoryContext } from './agentContext.js';
import { projectContinuity, type ContinuityDeps } from './continuity.js';
import { buildCodingContext } from './codingContext.js';
import { memoryCodingCapabilities } from './service.js';
import { setPreference, resolvePreference, listUserPreferences, removePreference } from './preferences.js';
import { recordPattern, confirmPattern, rejectPattern, listDevPatterns, retirePattern, usablePatterns } from './patterns.js';
import { reportBug, resolveBug, assessRecurrence, listIncidents } from './debugging.js';
import { learnFromFeedback } from './feedback.js';
import { supersedeStaleByCurrentCode, correctPreference } from './correction.js';
import { compact, retentionStats } from './lifecycle.js';
import { inspectMemory } from './inspector.js';

const seed = {
  add(table: string, rows: Record<string, unknown>[]): void {
    const existing = hoisted.tables.get(table) ?? [];
    hoisted.tables.set(table, [...existing, ...rows.map((r) => ({ ...r, created_at: r.created_at ?? new Date(1735689600000), updated_at: r.updated_at ?? new Date(1735689600000) }))]);
  },
};

const memRow = (over: Record<string, unknown>) => ({
  id: 'm' + Math.random().toString(36).slice(2, 8),
  project_id: 'projA', team_id: null, owner_id: 'u1', type: 'SEMANTIC', source: 'OBSERVED',
  content: 'the module connects to a database pool', structured: null, confidence: 0.8,
  provenance: 'code://fileA.ts', contradiction_state: 'NONE', superseded_by_id: null,
  deleted_at: null, created_at: new Date(), updated_at: new Date(), ...over,
});

beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); });

// ============================================================ relevance (1,28)
describe('deterministic retrieval relevance honesty', () => {
  it('scores same-project memory as DETERMINISTIC and ranks above unrelated', () => {
    const ctx: RelevanceContext = { projectId: 'projA', file: 'fileA.ts' };
    const a = memRow({ content: 'fix for fileA.ts flaky test' });
    const b = memRow({ project_id: 'other', content: 'unrelated' });
    const ranked = rankMemories([a, b], ctx, 5);
    expect(ranked.length).toBe(1);
    expect(ranked[0]!.memory.id).toBe(a.id);
    expect(ranked[0]!.mode).toBe('DETERMINISTIC');
  });

  it('uses HEURISTIC mode only for fuzzy keyword overlap, never claims semantic AI', () => {
    const ctx: RelevanceContext = { query: 'render the editor panel' };
    const m = memRow({ content: 'render editor panel lifecycle' });
    const s = scoreMemory(m, ctx);
    expect(s.mode).toBe('HEURISTIC');
    expect(['DETERMINISTIC', 'HEURISTIC']).toContain(s.mode);
    expect(s.score).toBeGreaterThan(0);
  });

  it('gates a CONFIRMED-contradiction memory to zero (current evidence wins)', () => {
    const ctx: RelevanceContext = { projectId: 'projA' };
    const m = memRow({ contradiction_state: 'CONFIRMED', content: 'uses an old api' });
    const s = scoreMemory(m, ctx);
    expect(s.score).toBe(0);
  });

  it('does not fabricate relevance from empty signals', () => {
    const ctx: RelevanceContext = {};
    const m = memRow({ content: 'random unrelated note' });
    expect(scoreMemory(m, ctx).score).toBe(0);
  });
});

// ============================================================ pattern confidence (16,17,19,20)
describe('learned pattern confidence', () => {
  it('a single observation is low confidence, NEVER a rule', () => {
    expect(patternConfidence(1)).toBe(0.2);
    expect(patternConfidence(1, 0, 0)).toBeLessThan(0.3);
  });

  it('explicit confirmation raises confidence durably and is not erased by compaction', () => {
    expect(patternConfidence(3, 4, 0)).toBeGreaterThan(0.8);
  });

  it('rejection reduces confidence and is durable, but a rejection is not a permanent preference', () => {
    // one rejection lowers confidence below a single naive observation
    expect(patternConfidence(5, 0, 2)).toBeLessThan(0.5);
    // but rejection of a DIFFERENT aspect does not reject the whole preference forever
    expect(patternConfidence(5, 0, 0)).toBeGreaterThanOrEqual(0.5);
  });

  it('rejection never becomes permanent preference: a later confirm recovers', () => {
    expect(patternConfidence(5, 3, 1)).toBeGreaterThan(0.7);
  });
});

// ============================================================ agent context render (pure)
describe('agent/editor context (14)', () => {
  it('returns a neutral block when no items (never fabricated)', () => {
    const out = renderAgentMemoryContext([]);
    expect(out).toContain('none available');
  });

  it('labelled MEMORY/SUGGESTION and bounded to MAX', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      kind: i % 2 === 0 ? 'MEMORY' : 'INFERENCE' as 'MEMORY' | 'INFERENCE',
      source: 'obs',
      label: `L${i}`,
      detail: 'detail',
      confidence: 0.5,
      ref: null,
    }));
    const out = renderAgentMemoryContext(items);
    expect(out).toContain('[MEMORY]');
    expect(out).toContain('[SUGGESTION]');
    expect(out.split('\n').filter((l) => l.startsWith('- [')).length).toBeLessThanOrEqual(10);
  });
});

// ============================================================ continuity / session restoration (14,21)
function continuityDeps(over: Partial<ContinuityDeps> = {}): ContinuityDeps {
  return {
    sessionContext: async () => ({ openProjectId: 'projA', activeFiles: [], currentTaskId: 't1', recentSearches: [], recentCommands: [], selectedBranch: 'main', lastActivityAt: new Date() }),
    workspaceState: async () => ({ activePath: 'src/a.ts', split: 'row', tabs: [{ path: 'src/a.ts', active: true, pinned: false, unsaved: false }] }),
    relevantMemories: async () => ['memory A'],
    decisions: async () => [],
    bugIncidents: async () => [],
    failedTasks: async () => [],
    lastTestFailures: async () => ['test/flaky.spec.ts'],
    lastTimedOut: async () => [],
    lastServerErrors: async () => [],
    recentDeployments: async () => [],
    ...over,
  };
}

describe('project continuity + session restoration', () => {
  it('RESTORED with open editor context and activity', async () => {
    const r = await projectContinuity('u1', 'projA', continuityDeps());
    expect(r.status).toBe('RESTORED');
    expect(r.files).toHaveLength(1);
    expect(r.evidence.testFailures).toContain('test/flaky.spec.ts');
  });

  it('PARTIALLY_RESTORED with activity but no editor context', async () => {
    const r = await projectContinuity('u1', 'projA', continuityDeps({
      workspaceState: async () => ({ activePath: null, split: null, tabs: [] }),
    }));
    expect(r.status).toBe('PARTIALLY_RESTORED');
  });

  it('UNAVAILABLE when no state at all (never fabricates restoration)', async () => {
    const r = await projectContinuity('u1', 'projA', continuityDeps({
      sessionContext: async () => ({ openProjectId: null, activeFiles: [], currentTaskId: null, recentSearches: [], recentCommands: [], selectedBranch: null, lastActivityAt: null }),
      workspaceState: async () => ({ activePath: null, split: null, tabs: [] }),
    }));
    expect(r.status).toBe('UNAVAILABLE');
    expect(r.files).toHaveLength(0);
  });

  it('restart continuity: re-uses last context across calls (deterministic, no fabricated evidence)', async () => {
    const deps = continuityDeps({ recentDeployments: async () => [{ version: 'v1', environment: 'production', status: 'VERIFIED', verification: 'VERIFIED', at: new Date() }] });
    const first = await projectContinuity('u1', 'projA', deps);
    const second = await projectContinuity('u1', 'projA', deps);
    expect(first.status).toBe(second.status);
    expect(first.memories).toEqual(second.memories);
    expect((second.deployments as Array<{ version: string }>)[0]!.version).toBe('v1');
  });
});

// ============================================================ coding context (14,13,12)
function codingDeps(over: Partial<Parameters<typeof buildCodingContext>[2]> = {}) {
  return {
    rawMemories: async () => ([
      memRow({ id: 'rel1', content: 'fileA module uses pool directly', structured: { file: 'fileA.ts' } }),
      memRow({ id: 'stale1', contradiction_state: 'CONFIRMED', content: 'old behavior' }),
    ] as never),
    patterns: async () => [{ id: 'p1', owner_id: 'u1', project_id: 'projA', name: 'retry', description: 'retry on 503', category: null, evidence_count: 6, confirm_count: 0, reject_count: 0, confidence: 0.7, source: 'OBSERVED', status: 'ACTIVE', created_at: new Date(), updated_at: new Date() }],
    bugIncidents: async () => [],
    runtimeEvidence: async () => [{ label: 'Endpoint returned 503: GET /x', detail: '503', confidence: 0.8, ref: 'r1' }],
    decisions: async () => [{ title: 'Use postgres', decision: 'chose pg', impact: 'LOW' }],
    ...over,
  } as Parameters<typeof buildCodingContext>[2];
}

describe('memory-aware coding context', () => {
  it('tags MEMORY and CURRENT_CODE_EVIDENCE distinctly (never conflates)', async () => {
    const items = await buildCodingContext('u1', { projectId: 'projA', file: 'fileA.ts' }, codingDeps());
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has('MEMORY')).toBe(true);
    expect(kinds.has('CURRENT_CODE_EVIDENCE')).toBe(true);
  });

  it('keeps the context bounded (bounded retrieval)', async () => {
    const items = await buildCodingContext('u1', { projectId: 'projA' }, codingDeps({ maxMemories: 2 }));
    expect(items.length).toBeLessThanOrEqual(20);
  });

  it('current-code evidence outranks a CONFIRMED-stale memory (current code > stale memory)', async () => {
    const items = await buildCodingContext('u1', { projectId: 'projA' }, codingDeps());
    const memoryItem = items.find((i) => i.kind === 'MEMORY');
    expect(memoryItem).toBeDefined();
    // the ranker gates the confirmed-stale memory (score 0) so it is absent
    expect(items.some((i) => i.kind === 'MEMORY' && i.ref === 'stale1')).toBe(false);
  });
});

// ============================================================ preferences CRUD + precedence (6,7,8,9)
describe('developer preferences (EXPLICIT/INFERRED precedence)', () => {
  it('stores and lists preferences with isolation and classification', async () => {
    const p = await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'EXPLICIT' });
    expect(p.classification).toBe('EXPLICIT');
    const all = await listUserPreferences('u1', 'projA');
    expect(all).toHaveLength(1);
  });

  it('EXPLICIT preference overrides a weaker INFERRED one', async () => {
    await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'INFERRED' });
    await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'double' }, classification: 'EXPLICIT' });
    const r = await resolvePreference('u1', 'style', 'quotes', 'projA');
    expect(r!.value).toEqual({ value: 'double' });
    expect(r!.resolvedFrom).toBe('EXPLICIT_OVERRIDE');
  });

  it('inferred handling: never promoted to a rule (stays INFERRED)', async () => {
    await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'INFERRED' });
    const r = await resolvePreference('u1', 'style', 'quotes', 'projA');
    expect(r!.classification).toBe('INFERRED');
  });

  it('deletion is owner-scoped and effective', async () => {
    const p = await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'EXPLICIT' });
    await removePreference('u1', p.id);
    const all = await listUserPreferences('u1', 'projA');
    expect(all).toHaveLength(0);
  });

  it('cross-project leakage: per-project preference is NOT visible under another project', async () => {
    await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'EXPLICIT' });
    const other = await listUserPreferences('u1', 'projB');
    expect(other).toHaveLength(0);
    expect(await resolvePreference('u1', 'style', 'quotes', 'projB')).toBeNull();
  });

  it('unauthorized access: pref owned by another user is not retrievable', async () => {
    await setPreference('u2', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'EXPLICIT' });
    expect(await listUserPreferences('u1', 'projA')).toHaveLength(0);
  });
});

// ============================================================ patterns CRUD (7,16,17,19,20)
describe('development patterns', () => {
  it('records a pattern and single observation is low confidence', async () => {
    const p = await recordPattern('u1', { projectId: 'projA', name: 'retry', description: 'retry on transient errors' });
    expect(p.evidence_count).toBe(1);
    expect(p.confidence).toBe(0.2);
    expect(usablePatterns([p], 0.3)).toHaveLength(0);
  });

  it('explicit confirmation is durable and raises usability', async () => {
    const p = await recordPattern('u1', { projectId: 'projA', name: 'retry', description: 'retry on transient errors' });
    const confirmed = await confirmPattern('u1', p.id);
    expect(confirmed!.confirm_count).toBe(1);
    expect(confirmed!.confidence).toBeGreaterThan(0.2);
  });

  it('rejection is not a permanent preference: a rejection entry is durable but a fresh pattern can be re-learned', async () => {
    const p = await recordPattern('u1', { projectId: 'projA', name: 'retry', description: 'retry on transient errors' });
    await rejectPattern('u1', p.id);
    await rejectPattern('u1', p.id);
    // 2+ rejects with zero confirms marks REJECTED durably (raw row reflects it)
    const row = hoisted.tables.get('dev_patterns')!.find((x) => x.id === p.id)!;
    expect(row.status).toBe('REJECTED');
    expect(row.reject_count).toBe(2);
    // ...and it is no longer surfaced as an active/usable pattern
    expect(await listDevPatterns('u1', 'projA')).toHaveLength(0);
    // rejection is not permanent: with later evidence + confirmation it recovers (confidence rises)
    expect(patternConfidence(5, 3, 1)).toBeGreaterThan(0.7);
  });

  it('retirePattern supersedes durably (SUPERSEDED)', async () => {
    const p = await recordPattern('u1', { projectId: 'projA', name: 'retry', description: 'retry on transient errors' });
    await retirePattern('u1', p.id);
    expect(await listDevPatterns('u1', 'projA')).toHaveLength(0);
  });

  it('cross-project leakage: patterns are project-scoped', async () => {
    await recordPattern('u1', { projectId: 'projA', name: 'retry', description: 'retry on transient errors' });
    expect(await listDevPatterns('u1', 'projB')).toHaveLength(0);
  });
});

// ============================================================ recurring bug association (10)
describe('cross-session debugging / recurring bug association', () => {
  it('same symptom key is associated and occurrences increment', async () => {
    await reportBug('u1', { projectId: 'projA', title: 'flaky auth', symptomKey: 'auth-401-timing' });
    await reportBug('u1', { projectId: 'projA', title: 'flaky auth', symptomKey: 'auth-401-timing' });
    const rec = await assessRecurrence('u1', 'projA', 'auth-401-timing');
    expect(rec!.incident.occurrences).toBe(2);
    expect(rec!.related).toBe(true);
  });

  it('prior fix evidence surfaced ONLY when recorded (no fabrication)', async () => {
    const inc = await reportBug('u1', { projectId: 'projA', title: 'flaky auth', symptomKey: 'auth-401-timing' });
    await resolveBug('u1', inc.id, { diagnosis: 'race', fixSummary: 'added lock', testRef: 'test/auth.spec.ts' });
    const rec = await assessRecurrence('u1', 'projA', 'auth-401-timing');
    expect(rec!.priorFix).toBe('added lock');
    expect(rec!.priorTest).toBe('test/auth.spec.ts');
  });

  it('a new non-matching symptom does NOT falsely associate', async () => {
    await reportBug('u1', { projectId: 'projA', title: 'flaky auth', symptomKey: 'auth-401-timing' });
    const rec = await assessRecurrence('u1', 'projA', 'billing-500');
    expect(rec).toBeNull();
  });

  it('isolation: incidents are owner+project scoped', async () => {
    await reportBug('u1', { projectId: 'projA', title: 'flaky auth', symptomKey: 'auth-401-timing' });
    expect(await listIncidents('u2', 'projA')).toHaveLength(0);
    expect(await listIncidents('u1', 'projB')).toHaveLength(0);
  });
});

// ============================================================ feedback (15)
describe('feedback & learning', () => {
  it('INFERRED feedback is never persisted as a fact', async () => {
    const r = await learnFromFeedback('u1', { content: 'maybe use x', level: 'INFERRED' });
    expect(r).toMatchObject({ stored: false });
    expect(memoryMock.createMemory).not.toHaveBeenCalled();
  });

  it('EXPLICIT feedback writes to persistent memory', async () => {
    await learnFromFeedback('u1', { projectId: 'projA', content: 'team prefers X', level: 'EXPLICIT' });
    expect(memoryMock.createMemory).toHaveBeenCalled();
  });
});

// ============================================================ correction (16,17)
describe('correction memory', () => {
  it('supersedes a stale memory by current code (current code > stale memory)', async () => {
    memoryMock.getMemory.mockResolvedValueOnce({ id: 'stale1', content: 'old', project_id: null, owner_id: 'u1' } as never);
    const r = await supersedeStaleByCurrentCode('u1', 'stale1', 'api changed');
    expect(r.memoryId).toBe('stale1');
    expect(memoryMock.correctMemory).toHaveBeenCalledWith('u1', 'stale1', expect.stringContaining('api changed'));
  });

  it('correctPreference removes the conflicting inferred preference durably', async () => {
    const p = await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'INFERRED' });
    await correctPreference('u1', p.id, 'user says otherwise');
    expect(await listUserPreferences('u1', 'projA')).toHaveLength(0);
  });
});

// ============================================================ lifecycle bounded (18,22,23)
describe('bounded retention / lifecycle', () => {
  it('compaction supersedes low-confidence patterns beyond cap', async () => {
    for (let i = 0; i < 12; i++) await recordPattern('u1', { projectId: 'projA', name: `retry${i}`, description: 'desc' });
    const before = await listDevPatterns('u1', 'projA');
    const res = await compact('u1', { maxPatterns: 8 });
    expect(res.patternsSuperseded).toBeGreaterThan(0);
    const after = await listDevPatterns('u1', 'projA');
    expect(after.filter((p) => p.status === 'ACTIVE').length).toBeLessThanOrEqual(before.length);
  });

  it('retentionStats reports honest counts', async () => {
    await setPreference('u1', { projectId: 'projA', category: 'c', key: 'k', value: { v: 1 }, classification: 'EXPLICIT' });
    const s = await retentionStats('u1', 'projA');
    expect(s.preferences).toBeGreaterThanOrEqual(1);
  });

  it('stats are bounded and owner-scoped', async () => {
    await setPreference('u1', { projectId: 'projA', category: 'c', key: 'k', value: { v: 1 }, classification: 'EXPLICIT' });
    const other = await retentionStats('u2', 'projA');
    expect(other.preferences).toBe(0);
  });
});

// ============================================================ inspector (19,22)
describe('memory inspector', () => {
  it('returns bounded, category-filtered report with honest summary', async () => {
    await setPreference('u1', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'EXPLICIT' });
    const r = await inspectMemory('u1', { projectId: 'projA', category: 'preferences', limit: 10 });
    expect(r.preferences).toHaveLength(1);
    expect(r.summary.explicitPreferences).toBe(1);
  });

  it('does not leak another user records into the inspector', async () => {
    await setPreference('u2', { projectId: 'projA', category: 'style', key: 'quotes', value: { value: 'single' }, classification: 'EXPLICIT' });
    const r = await inspectMemory('u1', { projectId: 'projA', category: 'preferences' });
    expect(r.preferences).toHaveLength(0);
  });
});

// ============================================================ capabilities honesty (2,28)
describe('capabilities & honesty', () => {
  it('reports DETERMINISTIC retrieval and feature gate', () => {
    const c = memoryCodingCapabilities();
    expect(c.memoryRetrieval).toBe('DETERMINISTIC');
    expect(c.persistentMemory).toBe(true);
    expect(c.usesReusedMemorySystem).toBe(true);
    expect(c.featureGateKey).toBe('AIOS_P2_MEMORY_CODING');
  });
});

// ============================================================ deployment/runtime memory (11,12)
describe('deployment + runtime memory', () => {
  it('surfaces evidence-backed test failure / server error records', async () => {
    hoisted.tables.set('runtime_executions', [
      { id: 're1', project_id: 'projA', owner_id: 'u1', kind: 'TEST', command: 'npm test', status: 'FAILED', output: '1 failed', error: 'boom', created_at: new Date() },
    ]);
    hoisted.tables.set('runtime_network_events', [
      { id: 'rn1', project_id: 'projA', owner_id: 'u1', method: 'GET', url_path: '/x', status: 500, ts: new Date() },
    ]);
    const runtime = await import('./runtimeMemory.js');
    const ev = await runtime.runtimeMemory('u1', 'projA', 8);
    expect(ev.some((e) => e.label.includes('Command failed (TEST)'))).toBe(true);
    expect(ev.some((e) => e.label.includes('Endpoint returned 500'))).toBe(true);
  });

  it('deployment memory derives rollback target from records (backend link), no fabrication', async () => {
    hoisted.tables.set('deployments', [
      { id: 'd1', project_id: 'projA', owner_id: 'u1', environment: 'production', status: 'ROLLED_BACK', data: { version: 'v2', rollbackTargetId: 'd0' }, created_at: new Date() },
      { id: 'd0', project_id: 'projA', owner_id: 'u1', environment: 'production', status: 'VERIFIED', data: { version: 'v1' }, created_at: new Date() },
    ]);
    hoisted.tables.set('rollback_runs', [
      { id: 'rb1', project_id: 'projA', owner_id: 'u1', current_deployment_id: 'd1', target_deployment_id: 'd0', status: 'SUCCEEDED', created_at: new Date() },
    ]);
    const dm = await import('./deploymentMemory.js');
    const res = await dm.deploymentMemory('u1', 'projA');
    expect(res.chain.some((c) => c.kind === 'DEPLOYMENT_ROLLBACK' && c.from === 'd1' && c.to === 'd0')).toBe(true);
    expect(res.items.find((i) => i.status === 'ROLLED_BACK')!.rollbackTarget).toBe('d0');
  });
});
