/**
 * CodeConClave — Stage 103 SUPERPOWERS Tranche Y: DB Brain Surgeon, Test
 * Converter, Legacy Wrapper, Dependency Bridge, Performance Migration.
 *
 *   DB BRAIN SURGEON (#102)    — zero-downtime schema changes with expand/migrate/contract.
 *   TEST CONVERTER (#103)      — migrates tests between frameworks, proves coverage match.
 *   LEGACY WRAPPER (#104)      — modern interface on top of legacy systems.
 *   DEPENDENCY BRIDGE (#105)   — automated major dependency version migrations.
 *   PERFORMANCE MIGRATION (#106) — sync→async, CPU→distributed, with before/after proof.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    db_brain_surgeries: [] as Array<Record<string, unknown>>,
    test_conversions: [] as Array<Record<string, unknown>>,
    legacy_wrappers: [] as Array<Record<string, unknown>>,
    dependency_bridges: [] as Array<Record<string, unknown>>,
    perf_migrations: [] as Array<Record<string, unknown>>,
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
          const dollar = /^\$(\d+)$/.exec(ref);
          if (col === 'updated_at') { target[col] = store.now(); continue; }
          if (/^(\w+)\s*\+\s*\$(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*\$(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(params[Number(m[2]!) - 1]);
          } else if (/^(\w+)\s*\+\s*(\d+)$/.test(ref)) {
            const m = /^(\w+)\s*\+\s*(\d+)$/.exec(ref)!;
            target[col] = Number(target[m[1]!] ?? 0) + Number(m[2]!);
          } else if (dollar) {
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
    DB_BRAIN_SURGEON: 'dbs',
    TEST_CONVERTER: 'tcv',
    LEGACY_WRAPPER: 'lgw',
    DEPENDENCY_BRIDGE: 'dpb',
    PERF_MIGRATION: 'pfm',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { planCycle, startDualWrite, verifyBackfill, contract, getDbBrainSurgery, listDbBrainSurgeries, dbBrainSurgeonReport } from '../modules/superpowers/dbBrainSurgeon.js';
import { planConversion, verifyConversion, getTestConversion, listTestConversions, testConverterReport } from '../modules/superpowers/testConverter.js';
import { createLegacyWrapper, getLegacyWrapper, listLegacyWrappers, legacyWrapperReport } from '../modules/superpowers/legacyWrapper.js';
import { planBridge, verifyBridge, getDependencyBridge, listDependencyBridges, dependencyBridgeReport } from '../modules/superpowers/dependencyBridge.js';
import { planMigration, reportMigration, getPerformanceMigration, listPerformanceMigrations, performanceMigrationReport } from '../modules/superpowers/performanceMigration.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('DB BRAIN SURGEON (#102)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('plans a cycle and flows through dual-write to contract', async () => {
    const s = await planCycle(USER, { table_name: 'users', cycle: 'EXPAND', rollback_plan: 'revert migration 042' });
    expect(s.id).toMatch(/^dbs-/);
    expect(s.table_name).toBe('users');
    expect(s.cycle).toBe('EXPAND');
    expect(s.status).toBe('PLANNING');
    expect(s.dual_write_active).toBe(false);
    expect(AUDIT_ACTIONS()).toContain('autonomy.db_surgeon_cycle_planned');

    const dw = await startDualWrite(USER, s.id);
    expect(dw.dual_write_active).toBe(true);
    expect(dw.status).toBe('DUAL_WRITE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.db_surgeon_dual_write_started');

    await verifyBackfill(USER, s.id, { expected_rows: 1000, verified_rows: 1000 });
    const verified = await getDbBrainSurgery(USER, s.id);
    expect(verified.backfill_verified).toBe(true);

    const done = await contract(USER, s.id);
    expect(done.status).toBe('DONE');
    expect(done.dual_write_active).toBe(false);
    expect(AUDIT_ACTIONS()).toContain('autonomy.db_surgeon_contracted');
  });

  it('reports surgery totals', async () => {
    await planCycle(USER, { table_name: 'orders', cycle: 'MIGRATE' });
    await planCycle(USER, { table_name: 'payments', cycle: 'CONTRACT' });
    const s = await planCycle(USER, { table_name: 'sessions', cycle: 'EXPAND' });
    await startDualWrite(USER, s.id);
    const report = await dbBrainSurgeonReport(USER);
    expect(report.surgeries).toBe(3);
    expect(report.dual_writes).toBe(1);
    expect(report.completed).toBe(0);
    expect(report.rolled_back).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await planCycle(USER, { table_name: 'users', cycle: 'EXPAND' });
    await expect(getDbBrainSurgery(OTHER, a.id)).rejects.toThrow(/db_brain_surgeon_not_found/);
    await expect(listDbBrainSurgeries(OTHER)).resolves.toHaveLength(0);
    await expect(planCycle(USER, { table_name: '', cycle: 'EXPAND' })).rejects.toThrow(/table name is required/);
    await expect(planCycle(USER, { table_name: 'users', cycle: '' })).rejects.toThrow(/cycle must be/);
    await expect(planCycle(USER, { table_name: 'users', cycle: 'INVALID' })).rejects.toThrow(/cycle must be/);
  });
});

describe('TEST CONVERTER (#103)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('plans and verifies a conversion with coverage match', async () => {
    const c = await planConversion(USER, {
      source_framework: 'Jest',
      target_framework: 'Vitest',
      source_test_path: 'src/__tests__/api.test.ts',
    });
    expect(c.id).toMatch(/^tcv-/);
    expect(c.source_framework).toBe('Jest');
    expect(c.target_framework).toBe('Vitest');
    expect(c.coverage_match).toBe(false);
    expect(c.status).toBe('PLANNING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.test_convert_planned');

    const verified = await verifyConversion(USER, c.id, { coverage_match: true, tests_passed: 42, tests_failed: 0 });
    expect(verified.coverage_match).toBe(true);
    expect(verified.status).toBe('DONE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.test_convert_verified');
  });

  it('reports conversion totals', async () => {
    await planConversion(USER, { source_framework: 'Jest', target_framework: 'Vitest', source_test_path: 'a.test.ts' });
    const c = await planConversion(USER, { source_framework: 'unittest', target_framework: 'pytest', source_test_path: 'test_app.py' });
    await verifyConversion(USER, c.id, { coverage_match: true, tests_passed: 10, tests_failed: 0 });
    const report = await testConverterReport(USER);
    expect(report.conversions).toBe(2);
    expect(report.verified).toBe(1);
    expect(report.coverage_matches).toBe(1);
    expect(report.by_source['Jest']).toBe(1);
    expect(report.by_source['unittest']).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await planConversion(USER, { source_framework: 'Jest', target_framework: 'Vitest', source_test_path: 'a.test.ts' });
    await expect(getTestConversion(OTHER, a.id)).rejects.toThrow(/test_conversion_not_found/);
    await expect(listTestConversions(OTHER)).resolves.toHaveLength(0);
    await expect(planConversion(USER, { source_framework: '', target_framework: 'Vitest', source_test_path: 'a.test.ts' })).rejects.toThrow(/source framework is required/);
    await expect(planConversion(USER, { source_framework: 'Jest', target_framework: '', source_test_path: 'a.test.ts' })).rejects.toThrow(/target framework is required/);
    await expect(planConversion(USER, { source_framework: 'Jest', target_framework: 'Vitest', source_test_path: '' })).rejects.toThrow(/source test path is required/);
  });
});

describe('LEGACY WRAPPER (#104)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('creates a wrapper with audit flowing', async () => {
    const w = await createLegacyWrapper(USER, {
      legacy_system: 'COBOL Mainframe',
      interface_type: 'REST',
      endpoint: 'https://api.legacy.internal/v1',
    });
    expect(w.id).toMatch(/^lgw-/);
    expect(w.legacy_system).toBe('COBOL Mainframe');
    expect(w.interface_type).toBe('REST');
    expect(w.endpoint).toBe('https://api.legacy.internal/v1');
    expect(w.status).toBe('ACTIVE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.legacy_wrapper_created');
  });

  it('reports wrapper totals', async () => {
    await createLegacyWrapper(USER, { legacy_system: 'Mainframe', interface_type: 'REST', endpoint: 'http://a' });
    await createLegacyWrapper(USER, { legacy_system: 'Old API', interface_type: 'GraphQL', endpoint: 'http://b' });
    const report = await legacyWrapperReport(USER);
    expect(report.wrappers).toBe(2);
    expect(report.active).toBe(2);
    expect(report.by_interface['REST']).toBe(1);
    expect(report.by_interface['GraphQL']).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await createLegacyWrapper(USER, { legacy_system: 'Mainframe', interface_type: 'REST', endpoint: 'http://a' });
    await expect(getLegacyWrapper(OTHER, a.id)).rejects.toThrow(/legacy_wrapper_not_found/);
    await expect(listLegacyWrappers(OTHER)).resolves.toHaveLength(0);
    await expect(createLegacyWrapper(USER, { legacy_system: '', interface_type: 'REST', endpoint: 'http://a' })).rejects.toThrow(/legacy system name is required/);
    await expect(createLegacyWrapper(USER, { legacy_system: 'Mainframe', interface_type: '', endpoint: 'http://a' })).rejects.toThrow(/interface type is required/);
    await expect(createLegacyWrapper(USER, { legacy_system: 'Mainframe', interface_type: 'REST', endpoint: '' })).rejects.toThrow(/endpoint is required/);
  });
});

describe('DEPENDENCY BRIDGE (#105)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('plans a bridge and verifies safety', async () => {
    const b = await planBridge(USER, {
      package_name: 'react',
      from_version: '17.0.2',
      to_version: '18.2.0',
      breaking_changes: ['ReactDOM.render removed', 'createRoot API change'],
    });
    expect(b.id).toMatch(/^dpb-/);
    expect(b.package_name).toBe('react');
    expect(b.from_version).toBe('17.0.2');
    expect(b.to_version).toBe('18.2.0');
    expect(b.breaking_changes).toHaveLength(2);
    expect(b.safety_verified).toBe(false);
    expect(b.status).toBe('PLANNING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.dependency_bridge_planned');

    const verified = await verifyBridge(USER, b.id, { safety_verified: true, tests_passed: 85 });
    expect(verified.safety_verified).toBe(true);
    expect(verified.status).toBe('DONE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.dependency_bridge_verified');
  });

  it('reports bridge totals', async () => {
    await planBridge(USER, { package_name: 'react', from_version: '17.0.2', to_version: '18.2.0', breaking_changes: ['a', 'b'] });
    const b = await planBridge(USER, { package_name: 'vue', from_version: '2.6.14', to_version: '3.3.0', breaking_changes: ['c'] });
    await verifyBridge(USER, b.id, { safety_verified: true, tests_passed: 50 });
    const report = await dependencyBridgeReport(USER);
    expect(report.bridges).toBe(2);
    expect(report.verified).toBe(1);
    expect(report.total_breaking_changes).toBe(3);
    expect(report.by_package['react']).toBe(1);
    expect(report.by_package['vue']).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await planBridge(USER, { package_name: 'react', from_version: '17', to_version: '18' });
    await expect(getDependencyBridge(OTHER, a.id)).rejects.toThrow(/dependency_bridge_not_found/);
    await expect(listDependencyBridges(OTHER)).resolves.toHaveLength(0);
    await expect(planBridge(USER, { package_name: '', from_version: '17', to_version: '18' })).rejects.toThrow(/package name is required/);
    await expect(planBridge(USER, { package_name: 'react', from_version: '', to_version: '18' })).rejects.toThrow(/source version is required/);
    await expect(planBridge(USER, { package_name: 'react', from_version: '17', to_version: '' })).rejects.toThrow(/target version is required/);
  });
});

describe('PERFORMANCE MIGRATION (#106)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('plans a migration and reports with improvement proof', async () => {
    const m = await planMigration(USER, {
      source_pattern: 'sync DB queries',
      target_pattern: 'async with cache',
      before_score: 200,
    });
    expect(m.id).toMatch(/^pfm-/);
    expect(m.source_pattern).toBe('sync DB queries');
    expect(m.target_pattern).toBe('async with cache');
    expect(m.before_score).toBe(200);
    expect(m.after_score).toBeNull();
    expect(m.status).toBe('PLANNING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.perf_migration_planned');

    const reported = await reportMigration(USER, m.id, { after_score: 50 });
    expect(reported.after_score).toBe(50);
    expect(reported.status).toBe('DONE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.perf_migration_reported');
  });

  it('reports migration totals', async () => {
    const m1 = await planMigration(USER, { source_pattern: 'sync', target_pattern: 'async', before_score: 100 });
    await reportMigration(USER, m1.id, { after_score: 30 });
    await planMigration(USER, { source_pattern: 'CPU-bound', target_pattern: 'distributed', before_score: 500 });
    const report = await performanceMigrationReport(USER);
    expect(report.migrations).toBe(2);
    expect(report.reported).toBe(1);
    expect(report.avg_improvement_pct).toBe(70);
    expect(report.by_source['sync']).toBe(1);
    expect(report.by_source['CPU-bound']).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await planMigration(USER, { source_pattern: 'sync', target_pattern: 'async', before_score: 100 });
    await expect(getPerformanceMigration(OTHER, a.id)).rejects.toThrow(/perf_migration_not_found/);
    await expect(listPerformanceMigrations(OTHER)).resolves.toHaveLength(0);
    await expect(planMigration(USER, { source_pattern: '', target_pattern: 'async', before_score: 100 })).rejects.toThrow(/source pattern is required/);
    await expect(planMigration(USER, { source_pattern: 'sync', target_pattern: '', before_score: 100 })).rejects.toThrow(/target pattern is required/);
    await expect(planMigration(USER, { source_pattern: 'sync', target_pattern: 'async', before_score: -1 })).rejects.toThrow(/non-negative/);
  });
});
