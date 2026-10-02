/**
 * CodeConClave — Stage 81 FRESH-EYES REVIEW (feature #11): service suite.
 *
 * Zero-context outside review. The deterministic blind-spot analyzers are the
 * product (proven, reproducible, bias-free) — every rule is proven to fire on
 * real code and, crucially, to be silent on clean code. Reviews are owner-
 * scoped, verdicts are honest (CLEAN vs FLAGGED), proof claims can be linked,
 * and lifecycle closes (RESOLVED / DISMISSED).
 *
 * DB (pool/queryMany) + audit + ids are mocked; analysis logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
const store = vi.hoisted(() => {
  const tables = { fresh_eyes_reviews: [] as Array<Record<string, unknown>> };
  return { tables, now: () => new Date().toISOString() };
});

const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn(async () => {}) }));

const dbMock = vi.hoisted(() => {
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '').replace(/[`"']/g, '');
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const q = text;
    const lq = q.toLowerCase().trim();
    const params = rawParams.map((p) => p);

    const ins = /insert into (\w+)\s*\(([^\\)]+)\)\s*values\s*\((.*)\)/is.exec(q);
    if (ins) {
      const table = ins[1]!.replace(/"/g, '').toLowerCase();
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const valueTokens = ins[3]!.split(',').map((t) => t.trim());
      const storeRows = store.tables[table as keyof typeof store.tables];
      const row: Record<string, unknown> = { created_at: store.now(), updated_at: store.now() };
      valueTokens.forEach((tok, i) => {
        const col = cleanCol(cols[i] ?? '');
        if (!col) return;
        const dollar = /\$(\d+)/.exec(tok);
        if (dollar) {
          const val = params[Number(dollar[1])! - 1];
          row[col] = col === 'findings' && typeof val === 'string' ? JSON.parse(val) : val;
        } else if (tok.toUpperCase() === 'NULL') {
          row[col] = null;
        } else if (tok.startsWith("'") && tok.endsWith("'")) {
          row[col] = tok.slice(1, -1);
        }
      });
      if (table === 'fresh_eyes_reviews') { if (row.findings === undefined) row.findings = []; if (row.status === undefined) row.status = 'OPEN'; }
      storeRows.push(row);
      return { rows: [], rowCount: 1 };
    }

    if (/^update \w+/.test(lq)) {
      const table = /^update (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const whereMatch = /where\s+(.+)/is.exec(q);
      if (!whereMatch) return { rows: [], rowCount: 0 };
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1])! - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1])! - 1])) return { rows: [], rowCount: 0 };
      const setMatch = /set\s+(.+?)\s+where/is.exec(q);
      if (setMatch) {
        for (const pair of setMatch[1]!.split(',').map((s) => s.trim())) {
          const eq = pair.indexOf('=');
          const col = cleanCol(pair.slice(0, eq));
          const ref = pair.slice(eq + 1).trim();
          const dollar = /\$(\d+)/.exec(ref);
          if (col === 'updated_at') { target![col] = store.now(); continue; }
          if (dollar) target![col] = params[Number(dollar[1])! - 1];
          else if (ref.toLowerCase() === 'now()') target![col] = store.now();
        }
      }
      return { rows: [target!], rowCount: 1 };
    }

    if (/select \*/.test(lq)) {
      const tableMatch = /from (\w+)/i.exec(q);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const idMatch = /\bid\s*=\s*\$(\d+)/i.exec(q);
      if (idMatch && !/owner_id/i.test(idMatch[0])) {
        const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(q);
        const hit = rows.filter((r) => {
          if (String(r.id) !== String(params[Number(idMatch[1])! - 1])) return false;
          if (ownerRef && String(r.owner_id ?? '') !== String(params[Number(ownerRef[1])! - 1])) return false;
          return true;
        });
        return { rows: hit, rowCount: hit.length };
      }
      let filtered = [...rows];
      const whereMatch = /where\s+(.+?)(?:\s+order by|$)/is.exec(q);
      if (whereMatch) {
        for (const clause of whereMatch[1]!.split(/\s+and\s+/i)) {
          const m = /^(\w+)\s*=\s*\$(\d+)$/i.exec(clause.trim());
          if (!m) continue;
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
    queryMany: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows),
    queryOne: (text: string, params: unknown[] = []) => queryImpl(text, params).then((r) => r.rows[0] ?? null),
    withTenant: async (_u: string | null, fn: (q: { query: typeof queryImpl }) => Promise<unknown>) => fn({ query: queryImpl }),
    ping: async () => true,
  };
});

vi.mock('../shared/db.js', () => dbMock);
vi.mock('../modules/audit/service.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../shared/ids.js', () => ({
  PREFIX: { FRESH_EYES_REVIEW: 'fey' },
  newId: (p: string) => `id-${p}-${Math.random().toString(36).slice(2, 8)}`,
}));

// ---------------------------------------------------------------------------
import {
  runFreshEyesReview, getFreshEyesReview, listFreshEyesReviews, linkProofClaim, closeFreshEyesReview,
  analyzeFreshEyes, detectMagicNumbers, detectTodoMarks, detectSuspectedSecrets,
  detectSwallowedErrors, detectDuplicatedLiterals, detectLeftoverLogs, outsidePerspective,
} from '../modules/superpowers/freshEyes.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';
const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

describe('FRESH-EYES analyzers (#11) — deterministic blind-spot rules', () => {
  it('fires on magic numbers and stays silent on clean code', () => {
    expect(detectMagicNumbers('if (retries > 14400) return;')).toEqual([{ literal: '14400' }]);
    expect(detectMagicNumbers('const limit = 10;')).toEqual([]);
    expect(detectMagicNumbers('if (rating >= 4.5) accept();')).toEqual([{ literal: '4.5' }]);
  });

  it('flags TODO/FIXME/HACK debt markers', () => {
    const marks = detectTodoMarks('// TODO: refactor once payments ship\nconst done = true; // FIXME works but ugly');
    expect(marks).toContain('refactor once payments ship');
    expect(detectTodoMarks('const a = 1 + 1;')).toEqual([]);
  });

  it('catches suspected secrets (token literals and named key assignments)', () => {
    expect(detectSuspectedSecrets('const key = \'sk-proj-abcdefghijklmnopqrstuvwx\';').length).toBe(1);
    expect(detectSuspectedSecrets('apiKey: \'12345678901234567890\'').length).toBe(1);
    expect(detectSuspectedSecrets('const message = \'hello world\';')).toEqual([]);
  });

  it('catches swallowed errors — empty catch and pass-through exception handlers', () => {
    const hits = detectSwallowedErrors('try { run() } catch (err) {}');
    expect(hits.length).toBeGreaterThan(0);
    expect(detectSwallowedErrors('try { run() } catch (err) { report(err); }')).toEqual([]);
    expect(detectSwallowedErrors('except ValueError: pass')).toEqual(['exception handler passes silently']);
  });

  it('flags duplicated long literals but not incidental short strings', () => {
    const dup = 'const a = \'PAYMENT_VERIFIED_TOKEN\'; const b = \'PAYMENT_VERIFIED_TOKEN\'; const c = \'PAYMENT_VERIFIED_TOKEN\';';
    expect(detectDuplicatedLiterals(dup).length).toBe(1);
    expect(detectDuplicatedLiterals('const a = \'ok\'; const b = \'ok\'; const c = \'ok\';')).toEqual([]);
  });

  it('flags debug prints reaching production code', () => {
    expect(detectLeftoverLogs('function x() { console.log(user.email); }').length).toBe(1);
    expect(detectLeftoverLogs('const y = 2;')).toEqual([]);
  });

  it('verdicts clean code CLEAN and returns a cold outside perspective', () => {
    const clean = 'function add(a, b) { return a + b; }';
    const findings = analyzeFreshEyes(clean);
    expect(findings).toEqual([]);
    expect(outsidePerspective(findings)).toContain('nothing here violates plain-code sanity');
  });
});

describe('FRESH-EYES REVIEW service (#11)', () => {
  beforeEach(cleartables);

  it('runs a review, stores findings, grades FLAGGED and audits it', async () => {
    const r = await runFreshEyesReview(USER, {
      file: 'src/rates.ts',
      code: 'if (retries > 14400) return;\n// TODO: replace once payments ship\ncatch (err) {}',
      contextNote: 'this is our standard retry loop',
    });
    expect(r.verdict).toBe('FLAGGED');
    expect(r.findings.length).toBeGreaterThanOrEqual(2);
    expect(r.findings.some((f) => f.rule === 'MAGIC_NUMBERS')).toBe(true);
    expect(r.outside_perspective).toContain('outside contractor');
    expect(r.inside_perspective).toBe('this is our standard retry loop');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'fresh_eyes.reviewed', resourceId: r.id }));
  });

  it('grades clean code CLEAN and requires code input', async () => {
    const r = await runFreshEyesReview(USER, { code: 'export const sum = (a, b) => a + b;' });
    expect(r.verdict).toBe('CLEAN');
    expect(r.findings).toEqual([]);
    await expect(runFreshEyesReview(USER, { code: '   ' })).rejects.toThrow(AppError);
  });

  it('links a proof claim so the finding is provable', async () => {
    const r = await runFreshEyesReview(USER, { code: 'const x = 9001;' });
    const linked = await linkProofClaim(USER, r.id, 'pcl-77');
    expect(linked.proof_claim_id).toBe('pcl-77');
    await expect(linkProofClaim(USER, r.id, '')).rejects.toThrow(AppError);
  });

  it('closes only once and stays owner-scoped', async () => {
    const r = await runFreshEyesReview(USER, { code: 'console.log(\'x\');' });
    const resolved = await closeFreshEyesReview(USER, r.id, 'RESOLVED');
    expect(resolved.status).toBe('RESOLVED');
    const again = await closeFreshEyesReview(USER, r.id, 'DISMISSED');
    expect(again.status).toBe('RESOLVED'); // closed reviews are not reopened
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'fresh_eyes.closed' }));
    await expect(getFreshEyesReview(OTHER, r.id)).rejects.toThrow(AppError);
  });

  it('filters the review list by verdict/status', async () => {
    await runFreshEyesReview(USER, { code: 'clean code() {}' });
    await runFreshEyesReview(USER, { code: '// TODO: fix me later' });
    const flagged = await listFreshEyesReviews(USER, { verdict: 'FLAGGED' });
    expect(flagged.length).toBe(1);
    const open = await listFreshEyesReviews(USER, { status: 'OPEN', verdict: 'CLEAN' });
    expect(open.length).toBe(1);
  });
});