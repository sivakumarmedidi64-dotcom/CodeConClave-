/**
 * CodeConClave — Stage 87 SUPERPOWERS Tranche I: self-governance & quality 2.
 *
 *   ADVERSARIAL SUITE       (#35) — a dedicated adversary attacks every change
 *                                   and blocks it with specific evidence when
 *                                   an issue is found.
 *   MUTATION-GRADE TESTS    (#36) — tests are graded against intentionally
 *                                   mutated code; hollow tests are rejected.
 *   SHADOW EXECUTION        (#39) — new build runs against mirrored production
 *                                   traffic; any mismatch blocks the release.
 *   PRIVILEGE SHRINKER      (#41) — over-permissioned grants flagged with the
 *                                   minimal-privilege rewrite ready to apply.
 *   AGENT SANDBOX ISOLATION (#44) — every agent action adjudicated against a
 *                                   sandbox policy and written to the audit
 *                                   trail.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    adversarial_runs: [] as Array<Record<string, unknown>>,
    mutation_sweeps: [] as Array<Record<string, unknown>>,
    shadow_runs: [] as Array<Record<string, unknown>>,
    privilege_flags: [] as Array<Record<string, unknown>>,
    sandbox_policies: [] as Array<Record<string, unknown>>,
    sandbox_actions: [] as Array<Record<string, unknown>>,
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
    adversarial_runs: { project_id: null },
    mutation_sweeps: { project_id: null },
    shadow_runs: { project_id: null },
    privilege_flags: { project_id: null },
    sandbox_policies: {},
    sandbox_actions: {},
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
    ADVERSARIAL_RUN: 'adv',
    MUTATION_SWEEP: 'mut',
    SHADOW_RUN: 'shw',
    PRIVILEGE_FLAG: 'pfg',
    SANDBOX_POLICY: 'sbp',
    SANDBOX_ACTION: 'sba',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { runAdversarialReview, getAdversarialRun, listAdversarialRuns, generateEdgeAttackPlan } from '../modules/superpowers/adversarial.js';
import { mutateSnippet, gradeTestForMutation, runMutationSweep, getMutationSweep, mutationReport } from '../modules/superpowers/mutationGrade.js';
import { runShadowComparison, getShadowRun, listShadowRuns, compareResponses, normalizeBody } from '../modules/superpowers/shadow.js';
import { auditPermissions, getPrivilegeFlag, shrinkPrivilege, listPrivilegeFlags, privilegeReport } from '../modules/superpowers/shrinker.js';
import { registerSandboxPolicy, enforceSandbox, listSandboxPolicies, listSandboxActions, sandboxReport } from '../modules/superpowers/sandboxIsolation.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

// ── ADVERSARIAL SUITE (#35) ────────────────────────────────────────────────

describe('ADVERSARIAL SUITE — a dedicated adversary blocks changes it can break (#35)', () => {
  beforeEach(cleartables);

  it('attacks the change, ranks findings by risk and BLOCKS it', async () => {
    const review = await runAdversarialReview(USER, {
      changeRef: 'pr-1337',
      scope: [
        { path: 'scripts/deploy.sh', content: 'chmod 777 /work\n' },
        { path: 'src/stream.ts', content: 'while (true) { items.push(x) }\n' },
        { path: 'src/cache.ts', content: 'setTimeout(flushCache, 0);\n' },
        { path: 'src/users.ts', content: 'const mapped = rows.map((r) => r.trim());\n' },
      ],
    });
    expect(review.verdict).toBe('BLOCKED');
    expect(review.change_ref).toBe('pr-1337');
    expect(review.id).toMatch(/^adv-/);
    expect(review.findings).toHaveLength(4);
    expect(review.findings[0]!.category).toBe('PERMISSION_ESCAPE');
    expect(review.findings[0]!.severity).toBe('CRITICAL');
    expect(review.findings[1]!.category).toBe('RESOURCE_EXHAUSTION');
    expect(review.findings[2]!.category).toBe('RACE_CONDITION');
    expect(review.findings[3]!.category).toBe('NULL_PATH');
    expect(review.findings[0]!.file).toBe('scripts/deploy.sh');
    expect(review.findings[1]!.evidence).toContain('while (true)');
    expect(review.findings[1]!.suggestion).toContain('Bound allocations');
    expect(review.generated_attacks.length).toBeGreaterThanOrEqual(7);
    expect(review.generated_attacks[0]).toContain('empty string');
    expect(AUDIT_ACTIONS()).toContain('quality.adversarial_run');
  });

  it('PASSES a change nothing in the rule book can break', async () => {
    const review = await runAdversarialReview(USER, {
      changeRef: 'pr-0001',
      scope: [{ path: 'src/calc.ts', content: 'const sum = (a, b) => a + b;\n' }],
    });
    expect(review.verdict).toBe('PASS');
    expect(review.findings).toHaveLength(0);
  });

  it('scopes the very attack: evidence names the exact permission escape', async () => {
    const review = await runAdversarialReview(USER, {
      changeRef: 'pr-perm',
      scope: [{ path: 'deploy/perms.sh', content: 'grant all privileges on database x;\n' }],
    });
    expect(review.verdict).toBe('BLOCKED');
    expect(review.findings[0]!.category).toBe('PERMISSION_ESCAPE');
    expect(review.findings[0]!.evidence).toMatch(/grant all privileges/i);
  });

  it('lists runs by verdict/reference and protects user isolation', async () => {
    const blocked = await runAdversarialReview(USER, { changeRef: 'pr-1', scope: [{ path: 'a.sh', content: 'chmod 777 x\n' }] });
    const passed = await runAdversarialReview(USER, { changeRef: 'pr-2', scope: [{ path: 'b.ts', content: 'const x = 1;\n' }] });
    expect(await listAdversarialRuns(USER, { verdict: 'BLOCKED' })).toHaveLength(1);
    expect((await listAdversarialRuns(USER, { verdict: 'BLOCKED' }))[0]!.id).toBe(blocked.id);
    expect(await listAdversarialRuns(USER, { changeRef: 'pr-2' })).toHaveLength(1);
    expect((await listAdversarialRuns(USER)).map((r) => r.id).sort()).toEqual([blocked.id, passed.id].sort());
    await expect(getAdversarialRun(USER, 'adv-nope')).rejects.toThrow(AppError);
    await expect(getAdversarialRun(OTHER, blocked.id)).rejects.toThrow(AppError);
  });

  it('refuses an empty scope and ships a ready-made edge attack plan', async () => {
    await expect(runAdversarialReview(USER, { changeRef: 'pr-0', scope: [] })).rejects.toThrow(AppError);
    expect(generateEdgeAttackPlan()).toHaveLength(7);
  });
});

// ── MUTATION-GRADE TESTS (#36) ─────────────────────────────────────────────

describe('MUTATION-GRADE TESTS — hollow tests are rejected (#36)', () => {
  beforeEach(cleartables);

  it('generates deterministic mutations of the target body', () => {
    const single = mutateSnippet({ functionName: 'isMatch', body: 'const ok = check(a) === b;' });
    expect(single.mutations).toHaveLength(1);
    expect(single.mutations[0]!.key).toBe('INVERT_EQUALITY');
    expect(single.mutations[0]!.code).toContain('!==');

    const combo = mutateSnippet({ functionName: 'poll', body: 'while (x >= limit) return a >= b && c !== null;' });
    const keys = combo.mutations.map((m) => m.key).sort();
    expect(keys).toContain('INVERT_INEQUALITY');
    expect(keys).toContain('FLIP_BOUND');
    expect(keys).toContain('SWAP_AND');
    expect(keys).toContain('BREAK_GUARD');
    expect(combo.mutations.some((m) => m.key === 'FLIP_BOUND' && m.code.includes('x > limit'))).toBe(true);
  });

  it('grades a test SENSITIVE only when it actually catches the mutation', () => {
    const good = gradeTestForMutation({
      testBody: "it('adds', () => { expect(isMatch(4)).toBe(false); });",
      targetFunction: 'isMatch',
      mutatedOutcome: 'FAIL',
    });
    expect(good.verdict).toBe('SENSITIVE');
    expect(good.reasons).toHaveLength(0);
  });

  it('rejects a test that still passes under mutation as HOLLOW', () => {
    const hollow = gradeTestForMutation({
      testBody: "it('adds', () => { expect(isMatch(4)).toBe(false); });",
      targetFunction: 'isMatch',
      mutatedOutcome: 'PASS',
    });
    expect(hollow.verdict).toBe('HOLLOW');
    expect(hollow.reasons[0]).toContain('passes under mutation');
  });

  it('rejects tests that never reference the target or carry no assertion', () => {
    const detached = gradeTestForMutation({ testBody: 'expect(1).toBe(1);', targetFunction: 'isMatch', mutatedOutcome: 'FAIL' });
    expect(detached.verdict).toBe('HOLLOW');
    expect(detached.reasons.some((r) => r.includes('never references'))).toBe(true);
    const noAssert = gradeTestForMutation({ testBody: 'isMatch(4);', targetFunction: 'isMatch', mutatedOutcome: 'FAIL' });
    expect(noAssert.verdict).toBe('HOLLOW');
    expect(noAssert.reasons.some((r) => r.includes('no assertion'))).toBe(true);
  });

  it('sweeps a suite: ships only sensitive tests, rejects the hollow ones with evidence', async () => {
    const sweep = await runMutationSweep(USER, {
      projectId: 'proj-9',
      cases: [
        { file: 'a.test.ts', function_name: 'isMatch', test_body: "it('a', () => { expect(isMatch(4)).toBe(false); });", mutated_outcome: 'FAIL' },
        { file: 'b.test.ts', function_name: 'isMatch', test_body: "it('b', () => { expect(isMatch(4)).toBe(false); });", mutated_outcome: 'PASS' },
        { file: 'c.test.ts', function_name: 'throttle', test_body: 'throttle();', mutated_outcome: 'FAIL' },
        { file: 'd.test.ts', function_name: 'oldLogic', test_body: '// TODO: rewrite\noldLogic();', mutated_outcome: 'FAIL' },
      ],
    });
    expect(sweep.verdict).toBe('REJECT_HOLLOW_TESTS');
    expect(sweep.targets).toBe(4);
    expect(sweep.sensitive).toBe(1);
    expect(sweep.hollow).toBe(3);
    expect(sweep.accepted).toEqual([{ file: 'a.test.ts', function_name: 'isMatch' }]);
    expect(sweep.rejected.map((r) => r.file).sort()).toEqual(['b.test.ts', 'c.test.ts', 'd.test.ts']);
    expect(sweep.rejected.find((r) => r.file === 'b.test.ts')!.reasons[0]).toContain('passes under mutation');
    expect(AUDIT_ACTIONS()).toContain('quality.mutation_sweep');
    expect(AUDIT_ACTIONS().filter((a) => a === 'quality.mutation_hollow_rejected')).toHaveLength(3);
    expect(sweep.id).toMatch(/^mut-/);
  });

  it('persists the sweep and rolls up a report', async () => {
    const sweep = await runMutationSweep(USER, { cases: [{ file: 'x.test.ts', function_name: 'fn', test_body: 'expect(fn(1)).toBe(1);', mutated_outcome: 'FAIL' }] });
    const rows = await getMutationSweep(USER, sweep.id);
    expect(rows.sensitive).toBe(1);
    expect(rows.rejected).toHaveLength(0);
    expect(rows.id).toMatch(/^mut-/);
    const report = await mutationReport(USER);
    expect(report.sweeps).toBe(1);
    expect(report.sensitive).toBe(1);
    expect(report.hollow).toBe(0);
    await expect(runMutationSweep(USER, { cases: [] })).rejects.toThrow(AppError);
  });
});

// ── SHADOW EXECUTION (#39) ─────────────────────────────────────────────────

describe('SHADOW EXECUTION — mismatches block the release (#39)', () => {
  beforeEach(cleartables);

  it('blocks a release when mirrored traffic diverges', async () => {
    const run = await runShadowComparison(USER, {
      releaseRef: 'rel-204',
      mirror: [
        { requestKey: 'GET /inventory', control: { status: 200, latencyMs: 80, body: { items: [1, 2] } }, candidate: { status: 200, latencyMs: 70, body: { items: [1, 2] } } },
        { requestKey: 'GET /orders', control: { status: 200, latencyMs: 90, body: { ok: true } }, candidate: { status: 500, latencyMs: 95, body: { ok: true } } },
        { requestKey: 'GET /profile', control: { status: 200, latencyMs: 50, body: { name: 'a' } }, candidate: { status: 200, latencyMs: 900, body: { name: 'a' } } },
        { requestKey: 'POST /pay', control: { status: 200, latencyMs: 60, body: { paid: true } }, candidate: { status: 200, latencyMs: 62, body: { paid: true }, error: 'timeout' } },
        { requestKey: 'GET /reports', control: { status: 200, latencyMs: 30, body: { rows: 10 } }, candidate: { status: 200, latencyMs: 30, body: { rows: 11 } } },
      ],
    });
    expect(run.verdict).toBe('BLOCKED');
    expect(run.mirrored).toBe(5);
    expect(run.mismatches).toBe(4);
    expect(run.mismatches_detail.map((m) => m.requestKey).sort()).toEqual(['GET /orders', 'GET /profile', 'GET /reports', 'POST /pay']);
    const orders = run.mismatches_detail.find((m) => m.requestKey === 'GET /orders')!;
    expect(orders.reasons[0]).toContain('status 200 -> 500');
    const profile = run.mismatches_detail.find((m) => m.requestKey === 'GET /profile')!;
    expect(profile.reasons[0]).toContain('latency +850ms');
    const pay = run.mismatches_detail.find((m) => m.requestKey === 'POST /pay')!;
    expect(pay.reasons[0]).toContain('error presence differs');
    const reports = run.mismatches_detail.find((m) => m.requestKey === 'GET /reports')!;
    expect(reports.reasons[0]).toContain('response body differs');
    expect(run.release_ref).toBe('rel-204');
    expect(run.id).toMatch(/^shw-/);
    expect(AUDIT_ACTIONS()).toContain('deploy.shadow_run');
    expect(AUDIT_ACTIONS().filter((a) => a === 'deploy.shadow_mismatch')).toHaveLength(4);
  });

  it('ignores benign differences: key order and latency under threshold', async () => {
    const result = compareResponses({ status: 200, latencyMs: 100, body: { a: 1, b: 2 } }, { status: 200, latencyMs: 240, body: { b: 2, a: 1 } });
    expect(result.mismatch).toBe(false);
    expect(result.latencyDelta).toBe(140);
    expect(normalizeBody({ b: 2, a: 1 })).toBe(normalizeBody({ a: 1, b: 2 }));
    const run = await runShadowComparison(USER, {
      releaseRef: 'rel-clean',
      mirror: [
        { requestKey: 'GET /a', control: { status: 200, latencyMs: 100, body: { a: 1, b: 2 } }, candidate: { status: 200, latencyMs: 240, body: { b: 2, a: 1 } } },
      ],
    });
    expect(run.verdict).toBe('PASS');
    expect(run.mismatches).toBe(0);
  });

  it('respects a custom latency threshold', () => {
    const tight = compareResponses({ status: 200, latencyMs: 100, body: 'ok' }, { status: 200, latencyMs: 160, body: 'ok' }, 50);
    expect(tight.mismatch).toBe(true);
    expect(compareResponses({ status: 200, latencyMs: 100, body: 'ok' }, { status: 200, latencyMs: 160, body: 'ok' }, 200).mismatch).toBe(false);
  });

  it('lists by verdict and keeps runs user-scoped', async () => {
    const blocked = await runShadowComparison(USER, {
      releaseRef: 'rel-1',
      mirror: [{ requestKey: 'k', control: { status: 200, latencyMs: 10, body: 'a' }, candidate: { status: 200, latencyMs: 10, body: 'b' } }],
    });
    await expect(getShadowRun(OTHER, blocked.id)).rejects.toThrow(/shadow_run_not_found/);
    expect(await listShadowRuns(USER, { verdict: 'BLOCKED' })).toHaveLength(1);
    expect(await listShadowRuns(USER, { releaseRef: 'rel-1' })).toHaveLength(1);
    await expect(runShadowComparison(USER, { releaseRef: 'r', mirror: [] })).rejects.toThrow(AppError);
  });
});

// ── PRIVILEGE SHRINKER (#41) ──────────────────────────────────────────────

describe('PRIVILEGE SHRINKER — over-permissioned grants get a minimal rewrite (#41)', () => {
  beforeEach(cleartables);

  it('flags wildcard scopes as CRITICAL with a least-privilege rewrite ready', async () => {
    const result = await auditPermissions(USER, {
      grants: [{ principal: 'deploy-svc', resource: 's3://prod-bucket', action: 'write', scope: 'ALL' }],
    });
    expect(result.grants).toBe(1);
    expect(result.flagged).toBe(1);
    const flag = result.findings[0]!;
    expect(flag.scope).toBe('ALL');
    expect(flag.severity).toBe('CRITICAL');
    expect(flag.minimal_rewrite).toContain('s3://prod-bucket');
    expect(flag.minimal_rewrite).toContain('narrowed');
    expect(flag.status).toBe('OPEN');
    expect(flag.id).toMatch(/^pfg-/);
    expect(AUDIT_ACTIONS()).toContain('security.privilege_flagged');
  });

  it('flags wildcard principals and admin-on-sensitive as HIGH', async () => {
    const result = await auditPermissions(USER, {
      grants: [
        { principal: '*', resource: 'web.console', action: 'read', scope: 'read' },
        { principal: 'bot', resource: 'payments-db', action: 'admin', scope: 'write' },
        { principal: 'viewer', resource: 'reports', action: 'read', scope: 'read' },
      ],
    });
    expect(result.flagged).toBe(2);
    const wildcard = result.findings.find((f) => f.principal === '*')!;
    expect(wildcard.severity).toBe('HIGH');
    expect(wildcard.minimal_rewrite).toContain('wildcard principal removed');
    const admin = result.findings.find((f) => f.resource === 'payments-db')!;
    expect(admin.severity).toBe('HIGH');
    expect(admin.minimal_rewrite).toContain('read-only');
  });

  it('shrinks a flag once, idempotently, and rolls up a report', async () => {
    const result = await auditPermissions(USER, {
      grants: [
        { principal: 'a', resource: 'r1', action: 'read', scope: 'ALL' },
        { principal: 'b', resource: 'r2', action: 'read', scope: 'ALL' },
        { principal: 'c', resource: 'r3', action: 'read', scope: 'ALL' },
      ],
    });
    const target = result.findings[1]!;
    const shrunk = await shrinkPrivilege(USER, target.id);
    expect(shrunk.status).toBe('SHRUNK');
    expect(await shrinkPrivilege(USER, target.id)).toEqual(expect.objectContaining({ status: 'SHRUNK' }));
    expect(AUDIT_ACTIONS().filter((a) => a === 'security.privilege_shrunk')).toHaveLength(1);

    const report = await privilegeReport(USER);
    expect(report.total).toBe(3);
    expect(report.open).toBe(2);
    expect(report.shrunk).toBe(1);
    expect(report.shrinkable).toBe(2);
    expect(report.by_severity.CRITICAL).toBe(3);

    expect((await listPrivilegeFlags(USER, { status: 'SHRUNK' }))[0]!.id).toBe(target.id);
    await expect(getPrivilegeFlag(OTHER, target.id)).rejects.toThrow(/privilege_flag_not_found/);
  });

  it('rejects invalid scopes and empty grant lists', async () => {
    await expect(auditPermissions(USER, { grants: [{ principal: 'x', resource: 'r', action: 'read', scope: 'everything' as never }] })).rejects.toThrow(AppError);
    await expect(auditPermissions(USER, { grants: [] })).rejects.toThrow(AppError);
    await expect(getPrivilegeFlag(USER, 'pfg-nope')).rejects.toThrow(AppError);
  });
});

// ── AGENT SANDBOX ISOLATION (#44) ─────────────────────────────────────────

describe('AGENT SANDBOX ISOLATION — every action adjudicated and audited (#44)', () => {
  beforeEach(cleartables);

  it('registers a jail + egress allowlist policy', async () => {
    const policy = await registerSandboxPolicy(USER, {
      agentName: 'helper',
      egressAllowlist: ['api.acme.com', '*.cdn.prod'],
      fsJailRoot: '/sandbox/agents/helper',
    });
    expect(policy.credentials_vault).toBe(true);
    expect(policy.syscall_logging).toBe(true);
    expect(policy.egress_allowlist).toEqual(['api.acme.com', '*.cdn.prod']);
    expect(policy.fs_jail_root).toBe('/sandbox/agents/helper');
    expect(policy.id).toMatch(/^sbp-/);
    expect(AUDIT_ACTIONS()).toContain('security.sandbox_policy_registered');
  });

  it('allowlists network egress exactly and by wildcard suffix', async () => {
    await registerSandboxPolicy(USER, { agentName: 'helper', egressAllowlist: ['api.acme.com', '*.cdn.prod'], fsJailRoot: '/sandbox/agents/helper' });
    const ok = await enforceSandbox(USER, { runRef: 'r-1', kind: 'NETWORK_CALL', target: 'https://api.acme.com/v1/items', agentName: 'helper' });
    expect(ok.decision).toBe('ALLOWED');
    expect(ok.reason).toContain('allowlisted');
    const wildcard = await enforceSandbox(USER, { runRef: 'r-1', kind: 'NETWORK_CALL', target: 'https://img.cdn.prod/a.png', agentName: 'helper' });
    expect(wildcard.decision).toBe('ALLOWED');
    const blocked = await enforceSandbox(USER, { runRef: 'r-1', kind: 'NETWORK_CALL', target: 'https://evil.org/steal', agentName: 'helper' });
    expect(blocked.decision).toBe('BLOCKED');
    expect(blocked.reason).toContain('not in the allowlist');
  });

  it('jails the filesystem and routes credentials through the vault only', async () => {
    await registerSandboxPolicy(USER, { agentName: 'helper', egressAllowlist: ['api.acme.com'], fsJailRoot: '/sandbox/agents/helper', credentialsVault: true });
    const inside = await enforceSandbox(USER, { runRef: 'r-2', kind: 'FILE_ACCESS', target: '/sandbox/agents/helper/tmp/a.txt', agentName: 'helper' });
    expect(inside.decision).toBe('ALLOWED');
    const escaping = await enforceSandbox(USER, { runRef: 'r-2', kind: 'FILE_ACCESS', target: 'C:\\Users\\owner\\secrets\\keys.txt', agentName: 'helper' });
    expect(escaping.decision).toBe('BLOCKED');
    expect(escaping.reason).toContain('escapes the jail');
    const cred = await enforceSandbox(USER, { runRef: 'r-2', kind: 'CREDENTIAL_READ', target: 'vault://db/password', agentName: 'helper' });
    expect(cred.decision).toBe('ALLOWED');
    const syscall = await enforceSandbox(USER, { runRef: 'r-2', kind: 'SYS_CALL', target: 'open', agentName: 'helper' });
    expect(syscall.decision).toBe('ALLOWED');
  });

  it('hard-blocks credential reads and syscalls when the policy forbids them', async () => {
    await registerSandboxPolicy(USER, { agentName: 'strict', egressAllowlist: ['api.acme.com'], fsJailRoot: '/sandbox/agents/strict', credentialsVault: false, syscallLogging: false });
    const cred = await enforceSandbox(USER, { runRef: 'r-3', kind: 'CREDENTIAL_READ', target: 'vault://db/password', agentName: 'strict' });
    expect(cred.decision).toBe('BLOCKED');
    expect(cred.reason).toContain('no secure vault');
    const sys = await enforceSandbox(USER, { runRef: 'r-3', kind: 'SYS_CALL', target: 'unlink', agentName: 'strict' });
    expect(sys.decision).toBe('BLOCKED');
    expect(sys.reason).toContain('syscall audit logging');
  });

  it('updates a policy in place and keeps a full audit trail of every decision', async () => {
    await registerSandboxPolicy(USER, { agentName: 'helper', egressAllowlist: ['api.acme.com'], fsJailRoot: '/sandbox/agents/helper', credentialsVault: true });
    await enforceSandbox(USER, { runRef: 'r-4', kind: 'NETWORK_CALL', target: 'https://api.acme.com/x', agentName: 'helper' });
    const blocked = await enforceSandbox(USER, { runRef: 'r-4', kind: 'NETWORK_CALL', target: 'https://evil.org/x', agentName: 'helper' });
    expect(blocked.decision).toBe('BLOCKED');
    await registerSandboxPolicy(USER, { agentName: 'helper', egressAllowlist: ['api.acme.com', 'logs.acme.com'], fsJailRoot: '/sandbox/agents/helper/v2', credentialsVault: false });
    const updated = (await listSandboxPolicies(USER)).find((p) => p.agent_name === 'helper')!;
    expect(updated.egress_allowlist).toContain('logs.acme.com');
    expect(updated.credentials_vault).toBe(false);
    expect(updated.fs_jail_root).toBe('/sandbox/agents/helper/v2');

    const actions = await listSandboxActions(USER, { runRef: 'r-4' });
    expect(actions).toHaveLength(2);
    expect(actions.some((a) => a.decision === 'ALLOWED' && a.kind === 'NETWORK_CALL')).toBe(true);
    expect(actions.some((a) => a.decision === 'BLOCKED')).toBe(true);
    expect(AUDIT_ACTIONS().filter((a) => a === 'security.sandbox_enforced')).toHaveLength(1);
    expect(AUDIT_ACTIONS().filter((a) => a === 'security.sandbox_blocked')).toHaveLength(1);

    const report = await sandboxReport(USER);
    expect(report.policies).toBe(1);
    expect(report.actions).toBe(2);
    expect(report.blocked).toBe(1);
    expect(report.allowed).toBe(1);
    expect(report.egress_rule_count).toBe(2);
    expect(report.jails_active).toBe(1);
  });

  it('rejects malformed input and resolves policies strictly', async () => {
    await expect(registerSandboxPolicy(USER, { agentName: '', egressAllowlist: ['a.com'], fsJailRoot: '/j' })).rejects.toThrow(AppError);
    await expect(registerSandboxPolicy(USER, { agentName: 'a', egressAllowlist: [], fsJailRoot: '/j' })).rejects.toThrow(AppError);
    await expect(registerSandboxPolicy(USER, { agentName: 'a', egressAllowlist: ['bad host'], fsJailRoot: '/j' })).rejects.toThrow(AppError);
    await expect(enforceSandbox(USER, { runRef: 'r', kind: 'NETWORK_CALL', target: 'https://x.com', agentName: 'ghost' })).rejects.toThrow(AppError);
    await expect(enforceSandbox(USER, { runRef: 'r', kind: 'DOS_CALL' as never, target: 'x', agentName: 'a' })).rejects.toThrow(AppError);
    await expect(enforceSandbox(USER, { runRef: 'r', kind: 'SYS_CALL', target: 'x' })).rejects.toThrow(AppError);
  });
});