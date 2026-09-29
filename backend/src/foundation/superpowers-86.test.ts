/**
 * CodeConClave — Stage 86 SUPERPOWERS Tranche H: self-governance & quality.
 *
 *   RED CELL                (#30) — static vulnerability scan that confirms
 *                                   which findings are actually exploitable and
 *                                   ranks them by confirmed risk.
 *   COVERAGE SENTINEL       (#31) — generates tests for uncovered branches and
 *                                   rejects its own hollow tests before any
 *                                   padding can ship.
 *   DIPLOMAT                (#32) — dependencies kept current and CVE-patched;
 *                                   upgrades that pass are surfaced, upgrades
 *                                   that break are rolled back with a report.
 *   CONTRACT WARDEN         (#37) — published API contracts verified against
 *                                   implementation at proposal time and
 *                                   consumers checked for compatibility.
 *   DEPENDENCY CARTOGRAPHER (#47) — the social tree of every dependency:
 *                                   maintainers, cadence, funding, alternatives.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  const tables = {
    red_cell_findings: [] as Array<Record<string, unknown>>,
    coverage_scans: [] as Array<Record<string, unknown>>,
    diplomat_dependencies: [] as Array<Record<string, unknown>>,
    diplomat_upgrades: [] as Array<Record<string, unknown>>,
    api_contracts: [] as Array<Record<string, unknown>>,
    contract_checks: [] as Array<Record<string, unknown>>,
    dependency_insights: [] as Array<Record<string, unknown>>,
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
    red_cell_findings: { project_id: null, code_snippet: null, suggestion: null },
    coverage_scans: { project_id: null },
    diplomat_dependencies: {},
    diplomat_upgrades: { breakage_report: null },
    api_contracts: {},
    contract_checks: {},
    dependency_insights: {},
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
    RED_CELL_FINDING: 'rcf',
    COVERAGE_SCAN: 'cvs',
    DIPLOMAT_DEPENDENCY: 'dip',
    DIPLOMAT_UPGRADE: 'dup',
    API_CONTRACT: 'ctr',
    CONTRACT_CHECK: 'ctc',
    DEPENDENCY_INSIGHT: 'dci',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { runRedCellScan, listFindings, confirmFinding, clearFinding, rankFindings } from '../modules/superpowers/redCell.js';
import { runCoverageScan, listCoverageScans, getCoverageScan, analyzeTestQuality } from '../modules/superpowers/coverageSentinel.js';
import { upsertDependency, runUpgrade, listDependencies, listUpgrades, dependencyHealth, versionCompare } from '../modules/superpowers/diplomat.js';
import { publishContract, verifyImplementation, checkConsumer, listContracts, listChecks } from '../modules/superpowers/contractWarden.js';
import { assessDependency, getInsight, listInsights, dependencySociety } from '../modules/superpowers/cartographer.js';
import { AppError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

// ── RED CELL (#30) ─────────────────────────────────────────────────────────

describe('RED CELL — confirm, don\u2019t guess (#30)', () => {
  beforeEach(cleartables);

  it('scans a scope, confirms real exploits and ranks by confirmed risk', async () => {
    const report = await runRedCellScan(USER, {
      scope: [
        { path: 'src/auth.ts', content: 'const api_key = "Abcdefghij";' },
        { path: 'src/db.ts', content: 'db.query(`SELECT * FROM users WHERE id = ${input}`);' },
        { path: 'src/shell.ts', content: 'child.exec(`ls -la ${dir}`);' },
        { path: 'src/pay.ts', content: 'const out = eval(userInput);' },
      ],
    });
    expect(report.total).toBe(4);
    expect(report.confirmed).toBe(4);
    expect(report.by_severity.CRITICAL).toBe(2);
    expect(report.by_severity.HIGH).toBe(2);
    expect(report.findings[0]!.category).toBe('SQL_INJECTION');
    expect(report.findings[0]!.confirmed).toBe(true);
    expect(report.findings[1]!.category).toBe('COMMAND_INJECTION');
    expect(report.findings[3]!.category).toBe('HARDCODED_SECRET');
    expect(report.findings[0]!.suggestion).toContain('parameterized');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'security.red_cell_scanned' }));
  });

  it('flags placeholder secrets as potential, not confirmed', async () => {
    const report = await runRedCellScan(USER, {
      scope: [{ path: 'a.ts', content: 'const password = "exampleSecret";' }],
    });
    expect(report.total).toBe(1);
    expect(report.confirmed).toBe(0);
    expect(report.unconfirmed_potential).toBe(1);
    expect(report.findings[0]!.confirmed).toBe(false);
  });

  it('submits to explanation-free filters: category, severity, status, confirmed', async () => {
    await runRedCellScan(USER, {
      scope: [
        { path: 'db.ts', content: 'db.query(`SELECT * FROM t WHERE id = ${id}`);' },
        { path: 'ui.ts', content: 'el.innerHTML = data;' },
        { path: 'key.ts', content: 'const api_key = "Abcdefghij";' },
      ],
    });
    expect((await listFindings(USER, { category: 'XSS' })).length).toBe(1);
    expect((await listFindings(USER, { severity: 'CRITICAL' })).length).toBe(1);
    expect((await listFindings(USER, { confirmed: true })).length).toBe(3);
    expect((await listFindings(USER, { status: 'OPEN' })).length).toBe(3);
    expect((await listFindings(OTHER)).length).toBe(0);
  });

  it('confirms a potential finding on demand and records the audit', async () => {
    const report = await runRedCellScan(USER, { scope: [{ path: 'a.ts', content: 'const password = "exampleSecret";' }] });
    const finding = report.findings[0]!;
    expect(finding.confirmed).toBe(false);
    const confirmed = await confirmFinding(USER, finding.id);
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.status).toBe('ACKNOWLEDGED');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'security.red_cell_finding_confirmed' }));
    await expect(confirmFinding(OTHER, finding.id)).rejects.toThrow(AppError);
  });

  it('clears a finding idempotently and ranks confirmed-first', async () => {
    await runRedCellScan(USER, {
      scope: [
        { path: 'db.ts', content: 'db.query(`SELECT * FROM t WHERE id = ${id}`);' },
        { path: 'a.ts', content: 'const password = "exampleSecret";' },
      ],
    });
    const potential = (await listFindings(USER, { confirmed: false }))[0]!;
    const cleared = await clearFinding(USER, potential.id, 'example value');
    expect(cleared.status).toBe('CLEARED');
    const again = await clearFinding(USER, potential.id);
    expect(again.status).toBe('CLEARED');
    const confirmAudits = recordAuditMock.mock.calls.filter((c) => c[0]!.action === 'security.red_cell_finding_cleared');
    expect(confirmAudits.length).toBe(1);

    const ranked = await rankFindings(USER);
    expect(ranked.summary.total).toBe(2);
    expect(ranked.findings[0]!.category).toBe('SQL_INJECTION');
    expect(ranked.findings[1]!.confirmed).toBe(false);
  });

  it('rejects an empty scope', async () => {
    await expect(runRedCellScan(USER, { scope: [] })).rejects.toThrow(AppError);
  });
});

// ── COVERAGE SENTINEL (#31) ────────────────────────────────────────────────

describe('COVERAGE SENTINEL — target the gap, reject the hollow (#31)', () => {
  beforeEach(cleartables);

  it('generates test targets only for uncovered branches', async () => {
    const scan = await runCoverageScan(USER, {
      report: [
        { file: 'src/utils.ts', location: 'parseTotal', function_name: 'parseTotal', uncovered_branches: 2, total_branches: 4 },
        { file: 'src/nav.ts', location: 'buildLink', function_name: 'buildLink', uncovered_branches: 0, total_branches: 3 },
      ],
    });
    expect(scan.files_scanned).toBe(2);
    expect(scan.gap_count).toBe(1);
    expect(scan.generated_targets.length).toBe(1);
    expect(scan.generated_targets[0]).toContain('parseTotal');
    expect(scan.generated_targets[0]).toContain('expect(out).toBeDefined()');
    expect(scan.hollow_rejected).toBe(0);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'quality.coverage_scan' }));
  });

  it('rejects hollow candidate tests and keeps only the sound ones', async () => {
    const scan = await runCoverageScan(USER, {
      report: [{ file: 'src/utils.ts', location: 'parseTotal', function_name: 'parseTotal', uncovered_branches: 2 }],
      candidateTests: [
        { function_name: 'parseTotal', body: 'it("x", () => { const out = parseTotal(); });' },
        { function_name: 'parseTotal', body: 'expect(true).toBe(true);' },
        { function_name: 'parseTotal', body: 'it("TODO", () => { expect(finalize()).toBeDefined(); });' },
        { function_name: 'parseTotal', body: 'it("covers", () => { expect(parseTotal()).toBe(2); });' },
      ],
    });
    expect(scan.hollow_rejected).toBe(3);
    expect(scan.accepted_tests.length).toBe(1);
    expect(scan.accepted_tests[0]!.body).toContain('parseTotal');
    const rejectAudits = recordAuditMock.mock.calls.filter((c) => c[0]!.action === 'quality.hollow_test_rejected');
    expect(rejectAudits.length).toBe(3);
    expect(rejectAudits[0]![0]!.detail.reasons).toContain('contains no assertion');
  });

  it('critiques a test body deterministically', () => {
    const sound = analyzeTestQuality("it('covers', () => { expect(parseTotal()).toBe(2); });", 'parseTotal');
    expect(sound.verdict).toBe('SOUND');
    expect(analyzeTestQuality('', 'parseTotal').verdict).toBe('HOLLOW');
    expect(analyzeTestQuality("it('x', () => { const out = parseTotal(); });", 'parseTotal').reasons).toContain('contains no assertion');
    expect(analyzeTestQuality('expect(true).toBe(true);', 'parseTotal').reasons).toContain('does not exercise the target function');
    expect(analyzeTestQuality('it("y", () => { /* TODO */ expect(finalize()).toBeDefined(); });', 'finalize').reasons).toContain('contains a placeholder');
  });

  it('persists scans and stays owner-scoped', async () => {
    const scan = await runCoverageScan(USER, {
      report: [{ file: 'src/utils.ts', location: 'parseTotal', function_name: 'parseTotal', uncovered_branches: 1 }],
    });
    await runCoverageScan(OTHER, {
      report: [{ file: 'src/other.ts', location: 'z', function_name: 'z', uncovered_branches: 1 }],
    });
    expect((await listCoverageScans(USER)).length).toBe(1);
    expect((await listCoverageScans(OTHER)).length).toBe(1);
    expect((await listCoverageScans(USER, { status: 'GENERATED' })).length).toBe(1);
    expect((await listCoverageScans(USER, { status: 'ACCEPTED' })).length).toBe(0);
    const got = await getCoverageScan(USER, scan.id);
    expect(got.id).toMatch(/^cvs-/);
    expect(got.gap_count).toBe(1);
    await expect(getCoverageScan(OTHER, scan.id)).rejects.toThrow(AppError);
  });

  it('rejects an empty coverage report', async () => {
    await expect(runCoverageScan(USER, { report: [] })).rejects.toThrow(AppError);
  });
});

// ── DIPLOMAT (#32) ─────────────────────────────────────────────────────────

describe('DIPLOMAT — keep dependencies current, patched, honest (#32)', () => {
  beforeEach(cleartables);

  it('monitors dependencies and tracks freshness honestly', async () => {
    const a = await upsertDependency(USER, { packageName: 'lodash', currentVersion: '4.17.20', latestVersion: '4.17.21', cves: ['CVE-2021-23337'] });
    expect(a.id).toMatch(/^dip-/);
    expect(a.freshness).toBe('OUTDATED');
    expect(a.cves).toEqual(['CVE-2021-23337']);

    const b = await upsertDependency(USER, { packageName: 'lodash', currentVersion: '4.17.21', latestVersion: '4.17.21' });
    expect(b.id).toBe(a.id);
    expect(b.freshness).toBe('CURRENT');
    expect(b.cves).toEqual([]);

    const c = await upsertDependency(USER, { packageName: 'edge', currentVersion: '2.0.0', latestVersion: '1.0.9' });
    expect(c.freshness).toBe('AHEAD');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'deps.monitored' }));
  });

  it('compares versions semantically', () => {
    expect(versionCompare('1.10.0', '1.9.2')).toBeGreaterThan(0);
    expect(versionCompare('1.2.0', '1.2.0')).toBe(0);
    expect(versionCompare('1.0.9', '1.1.0')).toBeLessThan(0);
  });

  it('surfaces a passing upgrade and clears its CVEs', async () => {
    await upsertDependency(USER, { packageName: 'lodash', currentVersion: '4.17.20', latestVersion: '4.17.21', cves: ['CVE-2021-23337'] });
    const { upgrade, dependency } = await runUpgrade(USER, { packageName: 'lodash', testOutcome: 'PASS' });
    expect(upgrade.status).toBe('SURFACED');
    expect(upgrade.test_outcome).toBe('PASS');
    expect(upgrade.from_version).toBe('4.17.20');
    expect(upgrade.to_version).toBe('4.17.21');
    expect(upgrade.cve_count).toBe(1);
    expect(dependency.current_version).toBe('4.17.21');
    expect(dependency.cves).toEqual([]);
    expect(dependency.freshness).toBe('CURRENT');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'deps.upgrade_surfaced' }));
  });

  it('rolls back a breaking upgrade with a report and keeps the version', async () => {
    await upsertDependency(USER, { packageName: 'axios', currentVersion: '1.0.0', latestVersion: '1.2.0' });
    const { upgrade, dependency } = await runUpgrade(USER, {
      packageName: 'axios',
      testOutcome: 'FAIL',
      breakage: '13 auth tests failed: header signature changed',
    });
    expect(upgrade.status).toBe('ROLLED_BACK');
    expect(upgrade.breakage_report).toContain('signature changed');
    expect(dependency.current_version).toBe('1.0.0');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'deps.upgrade_rolled_back' }));
  });

  it('refuses unknown packages and invalid outcomes', async () => {
    await expect(runUpgrade(USER, { packageName: 'ghost', testOutcome: 'PASS' })).rejects.toThrow(AppError);
    await upsertDependency(USER, { packageName: 'axios', currentVersion: '1.0.0', latestVersion: '1.2.0' });
    await expect(runUpgrade(USER, { packageName: 'axios', testOutcome: 'MAYBE' })).rejects.toThrow(AppError);
  });

  it('lists with filters and reports dependency health', async () => {
    await upsertDependency(USER, { packageName: 'lodash', currentVersion: '4.17.20', latestVersion: '4.17.21', cves: ['CVE-2021-23337'] });
    await upsertDependency(USER, { packageName: 'axios', currentVersion: '1.0.0', latestVersion: '1.2.0' });
    await runUpgrade(USER, { packageName: 'lodash', testOutcome: 'PASS' });
    await runUpgrade(USER, { packageName: 'axios', testOutcome: 'FAIL', breakage: 'auth broke' });

    expect((await listDependencies(USER, { freshness: 'CURRENT' })).length).toBe(1);
    expect((await listDependencies(USER, { freshness: 'OUTDATED' })).length).toBe(1);
    expect((await listUpgrades(USER, { status: 'SURFACED' })).length).toBe(1);
    expect((await listUpgrades(USER, { status: 'ROLLED_BACK' })).length).toBe(1);
    const health = await dependencyHealth(USER);
    expect(health.dependencies).toBe(2);
    expect(health.current).toBe(1);
    expect(health.outdated).toBe(1);
    expect(health.open_cves).toBe(0);
    expect(health.rolled_back).toBe(1);
    expect(health.upgrades).toBe(2);
  });
});

// ── CONTRACT WARDEN (#37) ──────────────────────────────────────────────────

describe('CONTRACT WARDEN — implementations must match the contract (#37)', () => {
  beforeEach(cleartables);

  const REQ = {
    name: 'billing-api',
    version: '1.0.0',
    endpoints: [
      { method: 'POST', path: '/invoices', status_codes: ['201', '400'], params: [{ name: 'amount', required: true, type: 'number' }] },
      { method: 'GET', path: '/invoices/{id}', status_codes: ['200'], params: [{ name: 'id', required: true, type: 'string' }] },
    ],
  };

  it('publishes a versioned contract and rejects duplicates', async () => {
    const c = await publishContract(USER, REQ);
    expect(c.id).toMatch(/^ctr-/);
    expect(c.endpoints.length).toBe(2);
    expect(c.endpoints[0]!.method).toBe('POST');
    expect(c.endpoints[1]!.status_codes).toEqual(['200']);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'contract.published' }));

    await expect(publishContract(USER, REQ)).rejects.toThrow(AppError);
    await expect(publishContract(USER, { name: 'x', version: '' })).rejects.toThrow(AppError);
  });

  it('hails a matching implementation as COMPLIANT', async () => {
    const c = await publishContract(USER, REQ);
    const check = await verifyImplementation(USER, { contractId: c.id, implementation: REQ.endpoints });
    expect(check.verdict).toBe('COMPLIANT');
    expect(check.breaking_issues).toEqual([]);
    expect(check.warning_issues).toEqual([]);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'contract.verified' }));
  });

  it('catches breaking changes at proposal time', async () => {
    const c = await publishContract(USER, REQ);
    const check = await verifyImplementation(USER, {
      contractId: c.id,
      implementation: [
        { method: 'POST', path: '/invoices', status_codes: ['201'], params: [{ name: 'userId', required: true, type: 'string' }] },
      ],
    });
    expect(check.verdict).toBe('BREAKING');
    const kinds = check.breaking_issues.map((i) => i.kind);
    expect(kinds).toContain('missing_endpoint');
    expect(kinds).toContain('missing_required_param');
    expect(kinds).toContain('added_required_param');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'contract.verified' }));
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'contract.breaking' }));
  });

  it('reports non-breaking drift for extra endpoints and status codes', async () => {
    const c = await publishContract(USER, REQ);
    const check = await verifyImplementation(USER, {
      contractId: c.id,
      implementation: [
        ...REQ.endpoints,
        { method: 'GET', path: '/health' },
      ],
    });
    expect(check.verdict).toBe('NON_BREAKING_DRIFT');
    expect(check.warning_issues.map((i) => i.kind)).toContain('extra_endpoint');
    expect(check.breaking_issues).toEqual([]);
  });

  it('lists contracts and checks', async () => {
    const c = await publishContract(USER, REQ);
    await verifyImplementation(USER, { contractId: c.id, implementation: REQ.endpoints });
    const v2 = await publishContract(USER, { name: 'billing-api', version: '2.0.0', endpoints: REQ.endpoints });
    expect((await listContracts(USER, { name: 'billing-api' })).length).toBe(2);
    expect((await listContracts(USER)).length).toBe(2);
    expect((await listChecks(USER, { contractId: c.id })).length).toBe(1);
    expect((await listChecks(USER, { contractId: v2.id })).length).toBe(0);
  });

  it('checks consumers for compatibility against the same contract', async () => {
    const c = await publishContract(USER, REQ);
    const ok = await checkConsumer(USER, {
      contractId: c.id,
      consumer: [{ method: 'GET', path: '/invoices/{id}', status_codes: ['200'], params: [{ name: 'id', required: true, type: 'string' }] }],
    });
    expect(ok.verdict).toBe('COMPATIBLE');

    const bad = await checkConsumer(USER, {
      contractId: c.id,
      consumer: [
        { method: 'GET', path: '/invoices/123', status_codes: ['200'] },
        { method: 'POST', path: '/invoices', params: [{ name: 'amount', required: true, type: 'string' }] },
      ],
    });
    expect(bad.verdict).toBe('INCOMPATIBLE');
    const kinds = bad.breaking_issues.map((i) => i.kind);
    expect(kinds).toContain('consumer_missing_producer_endpoint');
    expect(kinds).toContain('consumer_param_type_mismatch');

    const drift = await checkConsumer(USER, {
      contractId: c.id,
      consumer: [{ method: 'GET', path: '/invoices/{id}', status_codes: ['204'] }],
    });
    expect(drift.verdict).toBe('COMPATIBLE_WITH_DRIFT');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'contract.verified' }));
  });
});

// ── DEPENDENCY CARTOGRAPHER (#47) ──────────────────────────────────────────

describe('DEPENDENCY CARTOGRAPHER — social tree before adoption (#47)', () => {
  beforeEach(cleartables);

  it('blesses a healthy, funded, maintained package as LOW risk', async () => {
    const i = await assessDependency(USER, {
      package_name: 'eslint',
      version: '8.57.0',
      maintainer_count: 12,
      last_commit_days_ago: 5,
      funding_status: 'SPONSORED',
      replacement_packages: [],
    });
    expect(i.id).toMatch(/^dci-/);
    expect(i.risk_score).toBe(0);
    expect(i.risk_level).toBe('LOW');
    expect(i.recommendations).toEqual([]);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'deps.cartography' }));
  });

  it('surfaces single-maintainer, stale, unfunded risk before you adopt', async () => {
    const i = await assessDependency(USER, {
      package_name: 'toy-color',
      maintainer_count: 1,
      last_commit_days_ago: 400,
      funding_status: 'UNFUNDED',
    });
    expect(i.risk_score).toBe(80);
    expect(i.risk_level).toBe('CRITICAL');
    expect(i.recommendations.some((r) => r.includes('Single maintainer'))).toBe(true);
    expect(i.recommendations.some((r) => r.includes('Stale releases'))).toBe(true);
    expect(i.recommendations.some((r) => r.includes('Unfunded'))).toBe(true);

    const i2 = await assessDependency(USER, {
      package_name: 'mid',
      maintainer_count: 2,
      last_commit_days_ago: 200,
      funding_status: 'UNKNOWN',
    });
    expect(i2.risk_score).toBe(45);
    expect(i2.risk_level).toBe('HIGH');
  });

  it('names alternatives when they exist', async () => {
    const i = await assessDependency(USER, {
      package_name: 'legacy-utils',
      maintainer_count: 0,
      last_commit_days_ago: 900,
      funding_status: 'UNFUNDED',
      replacement_packages: ['@lib/modern-utils'],
    });
    expect(i.recommendations.some((r) => r.includes('@lib/modern-utils'))).toBe(true);
    expect(i.recommendations.some((r) => r.includes('Wrap-and-isolate'))).toBe(true);
    expect(i.risk_level).toBe('CRITICAL');
  });

  it('updates in place, resolves by name, filters by risk level and scopes owners', async () => {
    const a = await assessDependency(USER, { package_name: 'eslint', maintainer_count: 12, last_commit_days_ago: 5, funding_status: 'SPONSORED' });
    const b = await assessDependency(USER, { package_name: 'eslint', maintainer_count: 1, last_commit_days_ago: 500, funding_status: 'UNFUNDED' });
    expect(b.id).toBe(a.id);
    expect(b.risk_level).toBe('CRITICAL');

    expect((await getInsight(USER, 'eslint')).risk_score).toBe(80);
    expect((await listInsights(USER)).length).toBe(1);
    expect((await listInsights(USER, { riskLevel: 'CRITICAL' })).length).toBe(1);
    expect((await listInsights(USER, { riskLevel: 'LOW' })).length).toBe(0);
    expect((await listInsights(OTHER)).length).toBe(0);
    await expect(getInsight(OTHER, 'eslint')).rejects.toThrow(AppError);
  });

  it('summarizes the dependency society with top risks', async () => {
    await assessDependency(USER, { package_name: 'eslint', maintainer_count: 12, last_commit_days_ago: 5, funding_status: 'SPONSORED' });
    await assessDependency(USER, { package_name: 'toy-color', maintainer_count: 1, last_commit_days_ago: 400, funding_status: 'UNFUNDED' });
    await assessDependency(USER, { package_name: 'mid', maintainer_count: 2, last_commit_days_ago: 200, funding_status: 'UNKNOWN' });
    const society = await dependencySociety(USER);
    expect(society.total).toBe(3);
    expect(society.by_level).toEqual({ CRITICAL: 1, HIGH: 1, MODERATE: 0, LOW: 1 });
    expect(society.top_risks[0]!.package_name).toBe('toy-color');
  });

  it('rejects malformed profiles', async () => {
    await expect(assessDependency(USER, { package_name: 'x', maintainer_count: -1 })).rejects.toThrow(AppError);
    await expect(assessDependency(USER, { package_name: 'x', maintainer_count: 1, last_commit_days_ago: 1, funding_status: 'FRAUD' })).rejects.toThrow(AppError);
  });
});