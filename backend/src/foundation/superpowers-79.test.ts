/**
 * CodeConClave â€” Stage 79 SUPERPOWERS: service layer suite.
 *
 * Covers the five foundation laws as genuine, server-authoritative logic:
 *   PROOF-OF-RUN  (#34): no evidence -> UNVERIFIED; only TEST_RUN + ref is
 *                   VERIFIED; coverage/benchmark/log/screenshot is PARTIAL.
 *   PROOF BADGE   (#70): task-level trust aggregate.
 *   WHY-BUTTON    (#71): append-only evidence trace.
 *   ECHO MEMORY   (#33): labeled lessons bound to module scope, retrieved
 *                   before future tasks (GLOBAL fallback), applied_count tracks
 *                   real compounding use.
 *   WARDEN        (#29): forbidden/required import policy graph; change diffs
 *                   are checked deterministically (added lines only).
 *   SPEC LINTER   (#13): ENV_VAR / ENDPOINT (live route registry) / SLA specs
 *                   pinned OK vs DRIFT with evidence.
 *   CHECKPOINT T.M.(#68): immutable manifests, restore = rewind target, fork =
 *                   branch clone. Capture reads the real files table.
 *
 * DB (pool/queryMany/queryOne) + audit are mocked; ALL service logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// hoisted in-memory store + db mock (self-contained, references nothing above)
// ---------------------------------------------------------------------------
const store = vi.hoisted(() => {
  const tables = {
    proof_claims: [] as Array<Record<string, unknown>>,
    echo_lessons: [] as Array<Record<string, unknown>>,
    warden_policies: [] as Array<Record<string, unknown>>,
    spec_entries: [] as Array<Record<string, unknown>>,
    task_checkpoint_manifests: [] as Array<Record<string, unknown>>,
    files: [] as Array<Record<string, unknown>>,
  };
  const now = () => new Date().toISOString();
  return { tables, now };
});

const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn(async () => {}) }));

const dbMock = vi.hoisted(() => {
  function jsonbCols(col: string): boolean {
    return ['why_trace', 'forbidden_imports', 'required_imports', 'manifest', 'evidence'].includes(col);
  }
  function cleanCol(col: string): string {
    return col.trim().replace(/::jsonb.*$/i, '').replace(/[`"']/g, '');
  }
  function now(): string {
    return new Date().toISOString();
  }
  function normalizeParams(params: unknown[]): unknown[] {
    return params.map((p) => p);
  }
  async function queryImpl(text: string, rawParams: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const q = text;
    const lq = q.toLowerCase().trim();
    const params = normalizeParams(rawParams);

    // ------------------------------------------------------------ INSERT
    const ins = /insert into (\w+)\s*\(([^\\)]+)\)\s*values\s*\((.*)\)/is.exec(q);
    if (ins) {
      const table = ins[1]!.replace(/"/g, '').toLowerCase();
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const valueTokens = ins[3]!.split(',').map((t) => t.trim());
      const storeRows = store.tables[table as keyof typeof store.tables];
      const row: Record<string, unknown> = { created_at: now(), updated_at: now() };
      valueTokens.forEach((tok, i) => {
        const col = cleanCol(cols[i] ?? '');
        if (!col) return;
        const dollar = /\$(\d+)/.exec(tok);
        if (dollar) {
          const val = params[Number(dollar[1])! - 1];
          row[col] = jsonbCols(col) && typeof val === 'string' ? JSON.parse(val) : val;
        } else if (tok.toUpperCase() === 'NULL') {
          row[col] = null;
        } else if (tok.startsWith("'") && tok.endsWith("'")) {
          row[col] = tok.slice(1, -1);
        }
      });
      if (table === 'proof_claims') { if (row.why_trace === undefined) row.why_trace = []; if (row.verdict === undefined) row.verdict = 'UNVERIFIED'; }
      if (table === 'echo_lessons') { if (row.applied_count === undefined) row.applied_count = 0; if (row.source === undefined) row.source = 'CORRECTION'; }
      if (table === 'warden_policies') { if (row.forbidden_imports === undefined) row.forbidden_imports = []; if (row.required_imports === undefined) row.required_imports = []; if (row.enabled === undefined) row.enabled = true; }
      if (table === 'spec_entries') { if (row.evidence === undefined) row.evidence = {}; }
      if (table === 'task_checkpoint_manifests') { if (row.manifest === undefined) row.manifest = {}; if (row.forked_from === undefined) row.forked_from = null; }
      storeRows.push(row);
      return { rows: [], rowCount: 1 };
    }

    // ------------------------------------------------------------ DELETE
    if (/^delete from \w+/.test(lq)) {
      const table = /^delete from (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables];
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(q);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(q);
      const idVal = idRef ? String(params[Number(idRef[1])! - 1]) : null;
      const target = idVal === null ? null : rows.find((r) => r.id === idVal) ?? null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1])! - 1])) {
        return { rows: [], rowCount: 0 };
      }
      if (target) { const idx = rows.indexOf(target); rows.splice(idx, 1); }
      return { rows: [], rowCount: target ? 1 : 0 };
    }

    // ------------------------------------------------------------ UPDATE (RETURNING included)
    if (/^update \w+/.test(lq)) {
      const table = /^update (\w+)/.exec(lq)![1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      const setMatch = /set\s+(.+?)\s+where/is.exec(q);
      const whereMatch = /where\s+(.+)/is.exec(q);
      if (!setMatch || !whereMatch) return { rows: [], rowCount: 0 };
      // identify target by id=$N + optional owner check
      const idRef = /\bid\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(whereMatch[1]!);
      const target = idRef ? rows.find((r) => r.id === String(params[Number(idRef[1])! - 1])) : null;
      if (target && ownerRef && String(target.owner_id) !== String(params[Number(ownerRef[1])! - 1])) {
        return { rows: [], rowCount: 0 };
      }
      const pairs = setMatch[1]!.split(',').map((s) => s.trim());
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        const col = cleanCol(pair.slice(0, eq));
        const ref = pair.slice(eq + 1).trim();
        const dollar = /\$(\d+)/.exec(ref);
        if (col === 'updated_at' || col === 'last_checked_at') { target![col] = now(); continue; }
        if (dollar) {
          const val = params[Number(dollar[1])! - 1];
          target![col] = jsonbCols(col) && typeof val === 'string' ? JSON.parse(val) : val;
          continue;
        }
        if (/^[a-z_]+\s*\+\s*1$/.test(ref)) { target![col] = Number(target![col]) + 1; continue; }
        if (ref.toLowerCase() === 'now()') { target![col] = now(); continue; }
        if (ref.startsWith("'") && ref.endsWith("'")) { target![col] = ref.slice(1, -1); continue; }
        if (ref.toUpperCase() === 'NULL') { target![col] = null; continue; }
      }
      const returning = /returning \*/i.test(q);
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    }

    // ------------------------------------------------------------ files snapshot (checkpoints)
    if (/from files\b/.test(lq) && /deleted_at is null/.test(lq)) {
      const projectId = String(params[0]);
      const ownerId = String(params[1]);
      return {
        rows: store.tables.files
          .filter((f) => f.project_id === projectId && f.owner_id === ownerId)
          .map((f) => ({ path: f.path, sha256: f.sha256, sizeBytes: f.size_bytes ?? 0 })),
        rowCount: 1,
      };
    }

    // ------------------------------------------------------------ proof badge aggregate
    if (/group by verdict/.test(lq) && /proof_claims/.test(lq)) {
      const by: Record<string, number> = {};
      store.tables.proof_claims
        .filter((r) => r.owner_id === String(params[0]) && r.task_id === String(params[1]))
        .forEach((r) => { by[String(r.verdict)] = (by[String(r.verdict)] ?? 0) + 1; });
      return { rows: Object.entries(by).map(([verdict, n]) => ({ verdict, n })), rowCount: Object.keys(by).length };
    }

    // ------------------------------------------------------------ generic select *
    if (/select \*/.test(lq)) {
      const tableMatch = /from (\w+)/i.exec(q);
      if (!tableMatch) return { rows: [], rowCount: 0 };
      const table = tableMatch[1]!.toLowerCase();
      const rows = store.tables[table as keyof typeof store.tables] as Array<Record<string, unknown>>;
      // single-id lookup (word boundary so `owner_id = $1` never matches)
      const idMatch = /\bid\s*=\s*\$(\d+)/i.exec(q);
      if (idMatch && !/owner_id/.test(idMatch[0])) {
        const ownerRef = /owner_id\s*=\s*\$(\d+)/i.exec(q);
        const hit = rows.filter((r) => {
          if (String(r.id) !== String(params[Number(idMatch[1])! - 1])) return false;
          if (ownerRef && String(r.owner_id ?? '') !== String(params[Number(ownerRef[1])! - 1])) return false;
          return true;
        });
        return { rows: hit, rowCount: hit.length };
      }
      // build generic filter from WHERE
      let filtered = [...rows];
      const hasGlobalFallback = /module_scope = 'global'/i.test(q);
      const whereMatch = /where\s+(.+?)(?:\s+group by|\s+order by|$)/is.exec(q);
      if (whereMatch) {
        const where = whereMatch[1]!;
        const clauses = [...where.matchAll(/(\w+)\s*=\s*\$\d+/gi)];
        for (const cl of clauses) {
          const col = cleanCol(cl[1]!);
          const dollarN = Number(/= \$(\d+)/i.exec(cl[0]!)![1]!);
          const val = params[dollarN - 1];
          filtered = filtered.filter((r) => {
            if (col === 'module_scope' && r.module_scope === 'GLOBAL' && hasGlobalFallback) return true;
            return String(r[col] ?? '') === String(val ?? '');
          });
        }
      }
      // limit
      const limitMatch = /limit \$(\d+)/i.exec(q);
      if (limitMatch) {
        const lim = Number(params[Number(limitMatch[1])! - 1]) || 0;
        filtered = filtered.slice(0, lim);
      }
      const orderMatch = /order by\s+(.*?)(?:\s+limit|$)/is.exec(q);
      if (orderMatch) {
        const dir = /desc/i.test(orderMatch[1]!) ? -1 : 1;
        const col = cleanCol(orderMatch[1]!.split(/\s+/)[0]!);
        filtered.sort((a, b) => dir * String(a[col] ?? '').localeCompare(String(b[col] ?? '')));
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
  PREFIX: { PROOF_CLAIM: 'pcl', ECHO_LESSON: 'ecl', WARDEN_POLICY: 'wrd', SPEC_ENTRY: 'spe', TASK_CHECKPOINT: 'tcp' },
  newId: (p: string) => `${p}-mock-${Math.random().toString(36).slice(2, 8)}`,
}));

// ---------------------------------------------------------------------------
import {
  registerClaim, attachEvidence, listClaims, taskBadge, whyTrace, computeVerdict,
} from '../modules/superpowers/proof.js';
import {
  recordEchoLesson, retrieveEchoLessons, markEchoLessonApplied, listEchoLessons,
} from '../modules/superpowers/echo.js';
import {
  createWardenPolicy, checkChangeAgainstPolicies, extractImports, bareSpecifier, addedLines, matchesPattern, deleteWardenPolicy,
} from '../modules/superpowers/warden.js';
import {
  upsertSpecEntry, listSpecEntries, runSpecChecks, registerKnownRoutes, isRouteKnown,
} from '../modules/superpowers/specs.js';
import {
  createCheckpoint, listCheckpoints, restoreCheckpoint, forkCheckpoint,
} from '../modules/superpowers/checkpoints.js';

const USER = 'user-1';
const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

describe('PROOF-OF-RUN (#34) + PROOF BADGE (#70) + WHY BUTTON (#71)', () => {
  beforeEach(cleartables);

  it('assigns UNVERIFIED when a claim carries no evidence ref (fail closed)', async () => {
    const c = await registerClaim(USER, { claim: 'implemented feature X' });
    expect(c.verdict).toBe('UNVERIFIED');
    expect(c.why_trace).toEqual([]);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'proof_claim.registered', resourceId: c.id }));
  });

  it('serves VERIFIED ONLY for a TEST_RUN with a ref; other evidence kinds are PARTIAL', async () => {
    const noRef = await registerClaim(USER, { claim: 'c', evidenceKind: 'TEST_RUN' });
    expect(noRef.verdict).toBe('UNVERIFIED');

    const testRun = await registerClaim(USER, { claim: 'c', evidenceKind: 'TEST_RUN', evidenceRef: 'https://ci/run/42' });
    expect(testRun.verdict).toBe('VERIFIED');

    for (const kind of ['BENCHMARK', 'LOG', 'ARTIFACT', 'SCREENSHOT']) {
      const c = await registerClaim(USER, { claim: `c-${kind}`, evidenceKind: kind as never, evidenceRef: 'ref' });
      expect(c.verdict).toBe('PARTIAL');
    }
  });

  it('the caller cannot self-certify: verdict derives from evidence, not input', () => {
    expect(computeVerdict('TEST_RUN', null)).toBe('UNVERIFIED');
    expect(computeVerdict('TEST_RUN', undefined)).toBe('UNVERIFIED');
    expect(computeVerdict('NONE', 'anything')).toBe('UNVERIFIED');
    expect(computeVerdict('LOG', 'x')).toBe('PARTIAL');
    expect(computeVerdict('TEST_RUN', 'x')).toBe('VERIFIED');
  });

  it('attaching a real test-run ref later flips UNVERIFIED -> VERIFIED and appends to the WHY trace', async () => {
    const c = await registerClaim(USER, { claim: 'deploy pipeline', whyTrace: ['based on plan P-9'] });
    expect(c.verdict).toBe('UNVERIFIED');
    const upgraded = await attachEvidence(USER, c.id, {
      evidenceKind: 'TEST_RUN', evidenceRef: 'https://ci/run/7', whyTrace: ['green build 7'],
    });
    expect(upgraded.verdict).toBe('VERIFIED');
    expect(upgraded.evidence_ref).toBe('https://ci/run/7');
    expect(upgraded.why_trace).toEqual(['based on plan P-9', 'green build 7']);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'proof_claim.evidence_attached' }));
  });

  it('is tenant-scoped: another user cannot read or mutate the claim', async () => {
    const c = await registerClaim(USER, { claim: 'mine' });
    await expect(attachEvidence('user-2', c.id, { evidenceKind: 'TEST_RUN', evidenceRef: 'r' })).rejects.toThrow(/not found/i);
    await expect(restoreCheckpoint('user-2', c.id)).rejects.toThrow();
  });

  it('filters claims by project / task / verdict via listClaims', async () => {
    await registerClaim(USER, { claim: 'ok', taskId: 'task-1', projectId: 'p-1', evidenceKind: 'TEST_RUN', evidenceRef: 'r1' });
    await registerClaim(USER, { claim: 'no-evidence', taskId: 'task-2', projectId: 'p-1' });
    await registerClaim(USER, { claim: 'partial', taskId: 'task-1', projectId: 'p-2', evidenceKind: 'ARTIFACT', evidenceRef: 'r2' });
    const taskOnly = await listClaims(USER, { taskId: 'task-1' });
    expect(taskOnly.map((c) => c.claim).sort()).toEqual(['ok', 'partial']);
    const verified = await listClaims(USER, { verdict: 'VERIFIED' });
    expect(verified).toHaveLength(1);
    expect(verified[0]!.claim).toBe('ok');
  });

  it('badge: VERIFIED when all task claims are proven, PARTIAL when any are proven, UNVERIFIED when none', async () => {
    await registerClaim(USER, { claim: 'a', taskId: 'task-b', evidenceKind: 'TEST_RUN', evidenceRef: 'r' });
    await registerClaim(USER, { claim: 'b', taskId: 'task-b', evidenceKind: 'TEST_RUN', evidenceRef: 'r2' });
    expect(await taskBadge(USER, 'task-b')).toMatchObject({ total: 2, verified: 2, partial: 0, unverified: 0, verdict: 'VERIFIED' });

    await registerClaim(USER, { claim: 'c', taskId: 'task-m', evidenceKind: 'TEST_RUN', evidenceRef: 'r' });
    await registerClaim(USER, { claim: 'd', taskId: 'task-m' });
    const bad = await taskBadge(USER, 'task-m');
    expect(bad.unverified).toBe(1);
    expect(bad.verdict).toBe('PARTIAL');

    await registerClaim(USER, { claim: 'e', taskId: 'task-none' });
    const none = await taskBadge(USER, 'task-none');
    expect(none.verified).toBe(0);
    expect(none.verdict).toBe('UNVERIFIED');
  });

  it('why button returns the appended reasoning trace', async () => {
    const c = await registerClaim(USER, { claim: 'search', whyTrace: ['w1', 'w2'] });
    const w = await whyTrace(USER, c.id);
    expect(w.claim).toBe('search');
    expect(w.trace).toEqual(['w1', 'w2']);
  });
});

describe('ECHO MEMORY (#33)', () => {
  beforeEach(cleartables);

  it('records labeled lessons bound to a module scope with a source', async () => {
    const l = await recordEchoLesson(USER, {
      moduleScope: 'ui', label: 'use kebab-case for IDs', lesson: 'always kebab-case', source: 'CORRECTION',
    });
    expect(l.module_scope).toBe('ui');
    expect(l.source).toBe('CORRECTION');
    expect(l.applied_count).toBe(0);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'echo.lesson_recorded' }));
  });

  it('defaults scope to GLOBAL and source to CORRECTION when omitted', async () => {
    const l = await recordEchoLesson(USER, { label: 'l', lesson: 'x' });
    expect(l.module_scope).toBe('GLOBAL');
    expect(l.source).toBe('CORRECTION');
  });

  it('retrieves scoped lessons plus GLOBAL fallback (never other scopes)', async () => {
    await recordEchoLesson(USER, { moduleScope: 'ui', label: 'ui-1', lesson: 'specific-ui' });
    await recordEchoLesson(USER, { moduleScope: 'global', label: 'g', lesson: 'global-lesson' });
    await recordEchoLesson(USER, { moduleScope: 'db', label: 'db-1', lesson: 'wrong-scope' });
    const got = await retrieveEchoLessons(USER, 'ui');
    expect(got.map((s) => s.split(':')[1]).join('|')).toContain('specific-ui');
    expect(got.map((s) => s.split(':')[1]).join('|')).toContain('global-lesson');
    expect(got.map((s) => s.split(':')[1]).join('|')).not.toContain('wrong-scope');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'echo.lesson_retrieved' }));
  });

  it('apply() increments the compounding counter', async () => {
    const l = await recordEchoLesson(USER, { moduleScope: 'ui', label: 'l', lesson: 'x' });
    const applied = await markEchoLessonApplied(USER, l.id);
    expect(applied.applied_count).toBe(1);
    expect((await markEchoLessonApplied(USER, l.id)).applied_count).toBe(2);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'echo.lesson_applied' }));
  });

  it('list filters by module scope and is tenant-scoped', async () => {
    await recordEchoLesson(USER, { moduleScope: 'ui', label: 'a', lesson: 'x' });
    await recordEchoLesson(USER, { moduleScope: 'db', label: 'b', lesson: 'y' });
    expect((await listEchoLessons(USER, { moduleScope: 'ui' }))).toHaveLength(1);
    expect((await listEchoLessons('user-2'))).toHaveLength(0);
  });
});

describe('WARDEN (#29)', () => {
  beforeEach(cleartables);

  it('extracts ESM import, CJS require and dynamic import specifiers', () => {
    expect(extractImports(`import path from 'node:path';\nconst x = require('@app/db');\nimport('@app/ui')`).sort())
      .toEqual(['@app/db', '@app/ui', 'node:path']);
  });

  it('matches exact, subpath and glob patterns', () => {
    expect(matchesPattern('@app/db', '@app/db')).toBe(true);
    expect(matchesPattern('@app/db/client', '@app/db')).toBe(true);
    expect(matchesPattern('@app/ui-cards', '@app/ui')).toBe(false);
    expect(matchesPattern('@app/db/core', '@app/*')).toBe(true);
    expect(matchesPattern('@internal/shared/x', '@internal/**')).toBe(true);
  });

  it('parses unified diffs into added lines only', () => {
    const diff = [
      '--- a/a.ts', '+++ b/a.ts',
      '@@ -1,3 +1,4 @@', ' context', '+import x from "y"', '+ const z = 1', '-removed line', ' context',
    ].join('\n');
    expect(addedLines(diff).map((l) => l.trim())).toEqual(['import x from "y"', 'const z = 1']);
  });

  it('blocks a change that imports a forbidden module boundary', async () => {
    await createWardenPolicy(USER, { name: 'ui-never-db', forbiddenImports: ['@app/db'] });
    const bad = await checkChangeAgainstPolicies(USER, ['+++', '+import { pool } from "@app/db"', '+export const x = 1', ''.toString()].join('\n'));
    expect(bad.passed).toBe(false);
    expect(bad.violations[0]).toMatchObject({ rule: 'forbidden', pattern: '@app/db', importSpecifier: '@app/db' });

    const good = await checkChangeAgainstPolicies(USER, ['+++', "+import { Button } from '@app/ui'", '+export const x = 1'].join('\n'));
    expect(good.passed).toBe(true);
    expect(good.violations).toEqual([]);
  });

  it('requires mandated imports when the policy demands them', async () => {
    await createWardenPolicy(USER, { name: 'routes-must-auth', requiredImports: ['@app/middleware/auth'] });
    const missing = await checkChangeAgainstPolicies(USER, ['+++', "+import { Router } from 'express'", ''].join('\n'));
    expect(missing.passed).toBe(false);
    expect(missing.violations[0]).toMatchObject({ rule: 'required', pattern: '@app/middleware/auth' });

    const present = await checkChangeAgainstPolicies(USER, ['+++', "+import { requireAuth } from '@app/middleware/auth'", ''].join('\n'));
    expect(present.passed).toBe(true);
  });

  it('disabled policies do not block', async () => {
    await createWardenPolicy(USER, { name: 'off', forbiddenImports: ['@app/db'], enabled: false });
    const r = await checkChangeAgainstPolicies(USER, ['+++', '+import "@app/db"'].join('\n'));
    expect(r.passed).toBe(true);
  });

  it('is tenant-scoped on check and CRUD', async () => {
    const p = await createWardenPolicy(USER, { name: 'mine', forbiddenImports: ['@app/db'] });
    await expect(deleteWardenPolicy('user-2', p.id)).rejects.toThrow(/not found/i);
  });
});

describe('SPEC LINTER (#13)', () => {
  beforeEach(cleartables);

  it('pins ENV_VAR specs: present=OK, missing/empty=DRIFT', async () => {
    const old = process.env.SUPER_FOUND = '1';
    await upsertSpecEntry(USER, { kind: 'ENV_VAR', name: 'SUPER_FOUND', expectation: 'must be set' });
    await upsertSpecEntry(USER, { kind: 'ENV_VAR', name: 'SUPER_MISSING', expectation: 'must be set' });
    const report = await runSpecChecks(USER, {});
    expect(report.total).toBe(2);
    expect(report.ok).toBe(1);
    expect(report.drift).toBe(1);
    const missing = report.entries.find((e) => e.name === 'SUPER_MISSING')!;
    expect(missing.status).toBe('DRIFT');
    if (old) process.env.SUPER_FOUND = old; else delete process.env.SUPER_FOUND;
  });

  it('pins ENDPOINT specs against the LIVE route registry', async () => {
    registerKnownRoutes(['/api/v1/superpowers']);
    await upsertSpecEntry(USER, { kind: 'ENDPOINT', name: '/api/v1/superpowers' });
    await upsertSpecEntry(USER, { kind: 'ENDPOINT', name: '/api/v1/not-real' });
    const report = await runSpecChecks(USER, {});
    expect(isRouteKnown('/api/v1/superpowers')).toBe(true);
    expect(report.entries.find((e) => e.name === '/api/v1/superpowers')!.status).toBe('OK');
    expect(report.entries.find((e) => e.name === '/api/v1/not-real')!.status).toBe('DRIFT');
  });

  it('accepts a supplied probe for SLA specs', async () => {
    await upsertSpecEntry(USER, { kind: 'SLA', name: 'p95 < 300ms' });
    const ok = await runSpecChecks(USER, { slaProbe: () => ({ ok: true, detail: 'measured 250ms' }) });
    expect(ok.entries[0]!.status).toBe('OK');
    const bad = await runSpecChecks(USER, { slaProbe: () => ({ ok: false, detail: 'measured 900ms' }) });
    expect(bad.entries[0]!.status).toBe('DRIFT');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'spec.check_run' }));
  });

  it('lists by kind and persists last-check evidence', async () => {
    await upsertSpecEntry(USER, { kind: 'ENDPOINT', name: '/x' });
    await upsertSpecEntry(USER, { kind: 'ENV_VAR', name: 'NOPE' });
    await runSpecChecks(USER, {});
    const envs = await listSpecEntries(USER, { kind: 'ENV_VAR' });
    expect(envs).toHaveLength(1);
    expect(envs[0]!.status).toBe('DRIFT');
    expect(envs[0]!.last_checked_at).not.toBeNull();
  });
});

describe('CHECKPOINT TIME MACHINE (#68)', () => {
  beforeEach(() => {
    cleartables();
    store.tables.files.push(
      { id: 'f1', project_id: 'p-1', owner_id: USER, path: 'src/app.ts', sha256: 'abc', size_bytes: 100 },
      { id: 'f2', project_id: 'p-1', owner_id: USER, path: 'src/util.ts', sha256: 'def', size_bytes: 200 },
    );
  });

  it('captures the REAL file manifest of the project at creation', async () => {
    const cp = await createCheckpoint(USER, { taskId: 'task-1', projectId: 'p-1', label: 'before-refactor' });
    expect(cp.forked_from).toBeNull();
    const files = cp.manifest.files as Array<{ path: string; sha256: string; sizeBytes: number }>;
    expect(files).toHaveLength(2);
    expect(files.find((f) => f.path === 'src/app.ts')!.sha256).toBe('abc');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'checkpoint.created', resourceId: cp.id }));
  });

  it('lists checkpoints chronologically per task', async () => {
    await createCheckpoint(USER, { taskId: 'task-1', projectId: 'p-1', label: 'one' });
    await createCheckpoint(USER, { taskId: 'task-1', projectId: 'p-1', label: 'two' });
    await createCheckpoint(USER, { taskId: 'task-other', projectId: 'p-1' });
    const list = await listCheckpoints(USER, 'task-1');
    expect(list.map((c) => c.label)).toEqual(['one', 'two']);
  });

  it('immutability: restore returns the exact manifest as a rewind target', async () => {
    const cp = await createCheckpoint(USER, { taskId: 'task-1', projectId: 'p-1', label: 'base' });
    const restored = await restoreCheckpoint(USER, cp.id);
    expect(restored.manifest).toEqual(cp.manifest);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'checkpoint.restored' }));
  });

  it('fork clones the manifest into a NEW branch referencing its parent', async () => {
    const base = await createCheckpoint(USER, { taskId: 'task-1', projectId: 'p-1', label: 'day-1' });
    const fork = await forkCheckpoint(USER, base.id, { label: 'experiment' });
    expect(fork.id).not.toBe(base.id);
    expect(fork.forked_from).toBe(base.id);
    expect(fork.manifest).toEqual(base.manifest);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'checkpoint.forked' }));
  });

  it('rejects checkpoint access from other tenants', async () => {
    const cp = await createCheckpoint(USER, { taskId: 'task-1', projectId: 'p-1' });
    await expect(restoreCheckpoint('user-2', cp.id)).rejects.toThrow(/not found/i);
    await expect(forkCheckpoint('user-2', cp.id)).rejects.toThrow(/not found/i);
  });
});