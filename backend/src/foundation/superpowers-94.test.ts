/**
 * CodeConClave — Stage 94 SUPERPOWERS Tranche P: Institutional Transfer,
 * Context Compressor, Concept Gap Detector, Negotiator, Org Memory Portability.
 *
 *   INSTITUTIONAL TRANSFER (#26) — a departing engineer's brain export:
 *                                  commits, reviews, corrections, patterns.
 *   CONTEXT COMPRESSOR (#27)      — 10k lines of context becomes one dense,
 *                                  accurate, cited paragraph.
 *   CONCEPT GAP DETECTOR (#49)    — one concept under three names, three
 *                                  schemas, three bugs; unification plan built.
 *   NEGOTIATOR (#51)              — impossible requirements become the exact
 *                                  question, with options and tradeoffs.
 *   ORG MEMORY PORTABILITY (#53)  — one-click export of the knowledge graph;
 *                                  portable and queryable forever.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    institutional_exports: [] as Array<Record<string, unknown>>,
    context_compressions: [] as Array<Record<string, unknown>>,
    concept_gap_scans: [] as Array<Record<string, unknown>>,
    negotiation_drafts: [] as Array<Record<string, unknown>>,
    memory_exports: [] as Array<Record<string, unknown>>,
  };
  return { tables, now: () => new Date().toISOString() };
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
    INSTITUTIONAL_EXPORT: 'xpr',
    CONTEXT_COMPRESSION: 'cco',
    CONCEPT_GAP_SCAN: 'cgs',
    NEGOTIATION_DRAFT: 'neg',
    MEMORY_EXPORT: 'mex',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { exportBrain, compileBrainExport, packageExport, getInstitutionalExport, listInstitutionalExports, institutionalReport } from '../modules/superpowers/institutionalTransfer.js';
import { compressContext, compressText, getCompression, listCompressions, contextCompressorReport } from '../modules/superpowers/contextCompressor.js';
import { runConceptScan, buildUnificationPlan, unifyConcept, resolveConceptGap, getConceptScan, listConceptScans, conceptGapReport } from '../modules/superpowers/conceptGapDetector.js';
import { draftNegotiation, draftQuestion, resolveNegotiation, getNegotiationDraft, listNegotiationDrafts, negotiatorReport } from '../modules/superpowers/negotiator.js';
import { exportMemoryGraph, estimateExportSize, queryExport, getMemoryExport, listMemoryExports, memoryPortabilityReport } from '../modules/superpowers/memoryPortability.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── INSTITUTIONAL TRANSFER (#26) ────────────────────────────────────────────

describe('INSTITUTIONAL TRANSFER — the brain is the asset (#26)', () => {
  beforeEach(cleartables);

  it('compiles the export into per-kind counts and a summary', () => {
    const compiled = compileBrainExport('aaron', [
      { kind: 'commit', subject: 'disable edge validation', note: 'abc123' },
      { kind: 'commit', subject: 'wire the queue', note: 'def456' },
      { kind: 'review', subject: 'requested retry tests', note: 'pr-12' },
      { kind: 'correction', subject: 'authz assumes job ran', note: 'sc-3' },
      { kind: 'pattern', subject: 'background validation pattern', note: 'mem-1' },
    ]);
    expect(compiled.exports).toEqual({ commit: 2, review: 1, correction: 1, pattern: 1 });
    expect(compiled.highlights).toHaveLength(5);
    expect(compiled.summary).toContain("aaron's brain export");
    expect(compiled.summary).toContain('2 commits');
    expect(compiled.summary).toContain('1 patterns');
  });

  it('fires a brain export for a departing engineer', async () => {
    const exp = await exportBrain(USER, {
      engineer: 'aaron',
      entries: [
        { kind: 'commit', subject: 'disable edge validation', note: 'abc123' },
        { kind: 'review', subject: 'requested retry tests', note: 'pr-12' },
        { kind: 'correction', subject: 'authz assumes job ran', note: 'sc-3' },
        { kind: 'pattern', subject: 'background validation', note: 'mem-1' },
      ],
    });
    expect(exp.id).toMatch(/^xpr-/);
    expect(exp.status).toBe('DRAFTED');
    expect(exp.exports.commit).toBe(1);
    expect(exp.exports.pattern).toBe(1);
    expect(exp.summary).toContain('4 pieces of context preserved');
    expect(AUDIT_ACTIONS()).toContain('autonomy.transfer_exported');
  });

  it('packages once, reports, and stays owner-scoped', async () => {
    const exp = await exportBrain(USER, { engineer: 'aaron', entries: [{ kind: 'commit', subject: 's', note: 'n' }] });
    const packaged = await packageExport(USER, exp.id);
    expect(packaged.status).toBe('PACKAGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.transfer_packaged');
    await expect(packageExport(USER, exp.id)).rejects.toThrow(/already packaged/);

    const report = await institutionalReport(USER);
    expect(report.exports).toBe(1);
    expect(report.packaged).toBe(1);
    expect(report.total_pieces).toBe(1);

    await exportBrain(USER, { engineer: 'beyonce', entries: [{ kind: 'commit', subject: 's2', note: 'n2' }, { kind: 'correction', subject: 'c', note: 'cc' }] });
    expect(await listInstitutionalExports(USER)).toHaveLength(2);
    await expect(getInstitutionalExport(OTHER, exp.id)).rejects.toThrow(/institutional_export_not_found/);
    await expect(exportBrain(USER, { engineer: '', entries: [{ kind: 'commit', subject: 's', note: 'n' }] })).rejects.toThrow(AppError);
    await expect(exportBrain(USER, { engineer: 'aaron', entries: [] })).rejects.toThrow(/nothing to export/);
    await expect(exportBrain(USER, { engineer: 'aaron', entries: [{ kind: 'commit', subject: '', note: 'n' }] })).rejects.toThrow(/needs a subject/);
  });
});

// ── CONTEXT COMPRESSOR (#27) ────────────────────────────────────────────────

describe('CONTEXT COMPRESSOR — density you can trust (#27)', () => {
  beforeEach(cleartables);

  it('keeps the single best sentence per source and cites it', () => {
    const { summary, density, citations } = compressText('validation timeout', [
      'The sync path was slow. We deferred validation to the background job.',
      'Validators deferred to the job caused the 5pm timeouts.',
    ]);
    expect(summary).toBe('We deferred validation to the background job [1] Validators deferred to the job caused the 5pm timeouts [2]');
    expect(summary.includes('The sync path was slow')).toBe(false);
    expect(density).toBe(86);
    expect(citations).toEqual(['source 1', 'source 2']);
  });

  it('compresses real context into a citable paragraph', async () => {
    const comp = await compressContext(USER, {
      topic: 'validation timeout',
      sources: [
        'The sync path was slow. We deferred validation to the background job.',
        'Validators deferred to the job caused the 5pm timeouts.',
      ],
    });
    expect(comp.id).toMatch(/^cco-/);
    expect(comp.source_count).toBe(2);
    expect(comp.summary).toContain('background job [1]');
    expect(comp.citations).toEqual(['source 1', 'source 2']);
    expect(AUDIT_ACTIONS()).toContain('autonomy.context_compressed');
  });

  it('persists, reports average density, and stays owner-scoped', async () => {
    await compressContext(USER, { topic: 'a', sources: ['one two three four five. six seven.'] });
    const second = await compressContext(USER, { topic: 'b', sources: ['the needle. the haystack.'] });
    expect(await listCompressions(USER)).toHaveLength(2);
    const report = await contextCompressorReport(USER);
    expect(report.compressions).toBe(2);
    expect(report.avg_density).toBeGreaterThan(0);
    await expect(getCompression(OTHER, second.id)).rejects.toThrow(/context_compression_not_found/);
    await expect(compressContext(USER, { topic: '', sources: ['x'] })).rejects.toThrow(AppError);
    await expect(compressContext(USER, { topic: 't', sources: [] })).rejects.toThrow(/at least one source/);
  });
});

// ── CONCEPT GAP DETECTOR (#49) ──────────────────────────────────────────────

describe('CONCEPT GAP DETECTOR — three names, one bug (#49)', () => {
  beforeEach(cleartables);

  it('counts real schema divergence and builds migration paths', () => {
    const plan = buildUnificationPlan('account', ['account', 'user', 'member'], [
      { name: 'users', path: 'src/users.ts', usage: 'signup' },
      { name: 'members', path: 'src/members.ts', usage: 'org roles' },
      { name: 'accounts', path: 'src/accounts.ts', usage: 'billing' },
    ]);
    expect(plan.schema_count).toBe(3);
    expect(plan.migration_paths).toEqual(['merge user resource into account (account)', 'merge member resource into account (account)']);
    expect(plan.unification).toContain('3 different ways');
    expect(plan.unification).toContain('onto account');
  });

  it('scans the codebase and files the gap with a unification plan', async () => {
    const scan = await runConceptScan(USER, {
      concept: 'account',
      aliases: ['account', 'user', 'member'],
      locations: [
        { name: 'users', path: 'src/users.ts', usage: 'signup' },
        { name: 'members', path: 'src/members.ts', usage: 'org roles' },
        { name: 'accounts', path: 'src/accounts.ts', usage: 'billing' },
      ],
    });
    expect(scan.id).toMatch(/^cgs-/);
    expect(scan.status).toBe('FOUND');
    expect(scan.schema_count).toBe(3);
    expect(scan.migration_paths).toHaveLength(2);
    expect(AUDIT_ACTIONS()).toContain('autonomy.concept_gap_found');
  });

  it('walks the gap FOUND -> UNIFYING -> RESOLVED', async () => {
    const scan = await runConceptScan(USER, {
      concept: 'account',
      aliases: ['account', 'user', 'member'],
      locations: [
        { name: 'user', path: 'a.ts', usage: 'x' },
        { name: 'member', path: 'b.ts', usage: 'y' },
      ],
    });
    const unifying = await unifyConcept(USER, scan.id);
    expect(unifying.status).toBe('UNIFYING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.concept_unification_started');

    const resolved = await resolveConceptGap(USER, scan.id);
    expect(resolved.status).toBe('RESOLVED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.concept_gap_resolved');

    // resolve before unify is rejected
    await runConceptScan(USER, { concept: 'user', aliases: ['user', 'account'], locations: [{ name: 'u', path: 'a', usage: 'x' }, { name: 'a', path: 'b', usage: 'y' }] });
    const pending = await runConceptScan(USER, { concept: 'workspace', aliases: ['workspace', 'org'], locations: [{ name: 'w', path: 'a', usage: 'x' }, { name: 'o', path: 'b', usage: 'y' }] });
    await expect(resolveConceptGap(USER, pending.id)).rejects.toThrow(/start unification/);
    await expect(resolveConceptGap(USER, 'cgs-missing')).rejects.toThrow(/concept_gap_scan_not_found/);

    const report = await conceptGapReport(USER);
    expect(report.scans).toBe(3);
    expect(report.unifying).toBe(0);
    expect(report.resolved).toBe(1);

    await expect(getConceptScan(OTHER, scan.id)).rejects.toThrow(/concept_gap_scan_not_found/);
    await expect(runConceptScan(USER, { concept: 'account', aliases: ['account'], locations: [{ name: 'a', path: 'a', usage: 'x' }, { name: 'b', path: 'b', usage: 'y' }] })).rejects.toThrow(/at least 2 aliases/);
    await expect(runConceptScan(USER, { concept: 'account', aliases: ['account', 'user'], locations: [{ name: 'a', path: 'a', usage: 'x' }] })).rejects.toThrow(/at least 2 locations/);
    await expect(runConceptScan(USER, { concept: 'account', aliases: ['account', 'user'], locations: [{ name: 'same', path: 'a', usage: 'x' }, { name: 'same', path: 'b', usage: 'y' }] })).rejects.toThrow(/no gap/);
  });
});

// ── NEGOTIATOR (#51) ────────────────────────────────────────────────────────

describe('NEGOTIATOR — draft the question, never silently pick a side (#51)', () => {
  beforeEach(cleartables);

  it('turns a contradiction into the exact question with options', () => {
    const question = draftQuestion({
      requirement: 'real-time sync AND offline-first',
      conflict: 'real-time sync conflicts with offline-first when there is no conflict resolution',
      interpretations: [
        { label: 'offline-wins', tradeoff: 'read clients may see stale data' },
        { label: 'sync-wins', tradeoff: 'offline edits can be lost' },
        { label: 'hybrid', tradeoff: 'automatic merge with conflicts surfaced to the user' },
      ],
    });
    expect(question).toContain('conflicts with offline-first');
    expect(question).toContain('Pick one');
    expect(question).toContain('3) hybrid');
  });

  it('drafts the negotiation without picking a side', async () => {
    const draft = await draftNegotiation(USER, {
      requirement: 'real-time sync AND offline-first',
      conflict: 'real-time sync conflicts with offline-first when there is no conflict resolution',
      interpretations: [
        { label: 'offline-wins', tradeoff: 'read clients may see stale data' },
        { label: 'sync-wins', tradeoff: 'offline edits can be lost' },
        { label: 'hybrid', tradeoff: 'automatic merge with conflicts surfaced to the user' },
      ],
      recommended: 'hybrid',
    });
    expect(draft.id).toMatch(/^neg-/);
    expect(draft.status).toBe('PENDING');
    expect(draft.recommended).toBe('hybrid');
    expect(draft.interpretations).toHaveLength(3);
    expect(AUDIT_ACTIONS()).toContain('autonomy.negotiation_drafted');
  });

  it('resolves only on a real interpretation, reports, and stays owner-scoped', async () => {
    const draft = await draftNegotiation(USER, {
      requirement: 'real-time sync AND offline-first',
      interpretations: [
        { label: 'offline-wins', tradeoff: 'stale reads' },
        { label: 'sync-wins', tradeoff: 'lost edits' },
      ],
    });
    const resolved = await resolveNegotiation(USER, draft.id, 'sync-wins');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolution).toBe('sync-wins');
    expect(AUDIT_ACTIONS()).toContain('autonomy.negotiation_resolved');

    const pending = await draftNegotiation(USER, {
      requirement: 'local-first AND multi-player',
      interpretations: [
        { label: 'conflicts', tradeoff: 'shown to the user' },
        { label: 'sequence', tradeoff: 'last write wins' },
      ],
    });
    await expect(resolveNegotiation(USER, pending.id, 'neither')).rejects.toThrow(/must be one of conflicts, sequence/);
    await expect(resolveNegotiation(USER, pending.id, 'sequence')).resolves.toMatchObject({ status: 'RESOLVED', resolution: 'sequence' });
    await expect(resolveNegotiation(USER, pending.id, 'conflicts')).rejects.toThrow(/already resolved/);
    await expect(resolveNegotiation(USER, draft.id, 'offline-wins')).rejects.toThrow(/already resolved/);

    const report = await negotiatorReport(USER);
    expect(report.drafts).toBe(2);
    expect(report.resolved).toBe(2);
    expect(report.pending).toBe(0);

    await expect(getNegotiationDraft(OTHER, draft.id)).rejects.toThrow(/negotiation_draft_not_found/);
    await expect(draftNegotiation(USER, { requirement: '', interpretations: [] })).rejects.toThrow(AppError);
    await expect(draftNegotiation(USER, { requirement: 'q', interpretations: [{ label: 'a', tradeoff: 'aa' }] })).rejects.toThrow(/at least 2/);
  });
});

// ── ORG MEMORY PORTABILITY (#53) ────────────────────────────────────────────

describe('ORG MEMORY PORTABILITY — leave anytime, take everything (#53)', () => {
  beforeEach(cleartables);

  it('estimates archive size from component counts', () => {
    expect(estimateExportSize([
      { kind: 'memory_gravity', count: 1200 },
      { kind: 'dna', count: 45 },
      { kind: 'decision_history', count: 87 },
    ])).toBe(685056);
  });

  it('exports the knowledge graph, portable in one click', async () => {
    const exp = await exportMemoryGraph(USER, {
      components: [
        { kind: 'memory_gravity', count: 1200 },
        { kind: 'dna', count: 45 },
        { kind: 'decision_history', count: 87 },
      ],
    });
    expect(exp.id).toMatch(/^mex-/);
    expect(exp.components).toEqual(['memory_gravity', 'dna', 'decision_history']);
    expect(exp.archive_ref).toBe(`memory-export-${exp.id}`);
    expect(exp.size_bytes).toBe(685056);
    expect(exp.status).toBe('EXPORTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.memory_exported');
  });

  it('is queryable after export, reports totals, and stays owner-scoped', async () => {
    await exportMemoryGraph(USER, { components: [{ kind: 'memory_gravity', count: 1200 }, { kind: 'dna', count: 45 }, { kind: 'decision_history', count: 87 }] });
    const exp = await exportMemoryGraph(USER, { components: [{ kind: 'decision_history', count: 10 }, { kind: 'patterns', count: 3 }] });

    const hit = await queryExport(USER, exp.id, 'decision');
    expect(hit.matches).toHaveLength(1);
    expect(hit.matches[0]!.kind).toBe('decision_history');
    expect(hit.matches[0]!.count).toBe(10);
    expect(hit.answer).toContain('found 10 entries');

    const miss = await queryExport(USER, exp.id, 'tax-filing');
    expect(miss.matches).toHaveLength(0);
    expect(miss.answer).toContain('no component');
    await expect(queryExport(USER, exp.id, '')).rejects.toThrow(/query term/);

    const report = await memoryPortabilityReport(USER);
    expect(report.exports).toBe(2);
    expect(report.total_entries).toBe(1345);
    expect(report.total_bytes).toBe(685056 + (10 + 3) * 512 + 2 * 1024);

    await expect(getMemoryExport(OTHER, exp.id)).rejects.toThrow(/memory_export_not_found/);
    await expect(exportMemoryGraph(USER, { components: [] })).rejects.toThrow(/knowledge component/);
    await expect(exportMemoryGraph(USER, { components: [{ kind: 'tweets', count: 1 }] })).rejects.toThrow(/not a portable knowledge component/);
    await expect(exportMemoryGraph(USER, { components: [{ kind: 'dna', count: -1 }] })).rejects.toThrow(/non-negative/);
  });
});