/**
 * CodeConClave — Stage 104 SUPERPOWERS Tranche Z: Schema Migration Wizard, API
 * Version Bridge, Data Migration Orchestrator, Configuration Migration, Design Police.
 *
 *   SCHEMA MIGRATION WIZARD (#107) — expand/backfill/contract, all reversible.
 *   API VERSION BRIDGE (#108)     — multiple API versions concurrently, deprecation windows.
 *   DATA MIGRATION ORCHESTRATOR (#109) — large transforms with verification and rollback.
 *   CONFIGURATION MIGRATION (#110)     — env vars → secrets → config service, traffic splits.
 *   DESIGN POLICE (#111)               — screen vs design system, violations auto-fixed.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    schema_migration_plans: [] as Array<Record<string, unknown>>,
    api_version_bridges: [] as Array<Record<string, unknown>>,
    data_migrations: [] as Array<Record<string, unknown>>,
    config_migrations: [] as Array<Record<string, unknown>>,
    design_police_reports: [] as Array<Record<string, unknown>>,
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
    SCHEMA_MIGRATION: 'scm',
    API_VERSION_BRIDGE: 'avb',
    DATA_MIGRATION: 'dmg',
    CONFIG_MIGRATION: 'cfg',
    DESIGN_POLICE: 'dpol',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { createSchemaMigration, startExpansion, completeStep, rollbackMigration, getSchemaMigration, listSchemaMigrations, schemaMigrationReport } from '../modules/superpowers/schemaMigrationWizard.js';
import { createApiBridge, deprecateVersion, getApiBridge, listApiBridges, apiBridgeReport } from '../modules/superpowers/apiVersionBridge.js';
import { scheduleDataMigration, sampleMigration, runMigration, verifyMigration, getDataMigration, listDataMigrations, dataMigrationReport } from '../modules/superpowers/dataMigrationOrchestrator.js';
import { startConfigMigration, advanceTrafficSplit, completeConfigMigration, getConfigMigration, listConfigMigrations, configMigrationReport } from '../modules/superpowers/configurationMigration.js';
import { flagDesignViolation, fixViolation, ignoreViolation, getDesignReport, listDesignReports, designPoliceReport } from '../modules/superpowers/designPolice.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('SCHEMA MIGRATION WIZARD (#107)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('creates a migration, advances through expand/backfill/contract, and audits', async () => {
    const m = await createSchemaMigration(USER, { table_name: 'users', direction: 'expand', sql_up: 'ALTER TABLE users ADD COLUMN email TEXT', sql_down: 'ALTER TABLE users DROP COLUMN email' });
    expect(m.id).toMatch(/^scm-/);
    expect(m.table_name).toBe('users');
    expect(m.direction).toBe('expand');
    expect(m.status).toBe('PLANNED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.schema_migration_created');

    const expanding = await startExpansion(USER, m.id);
    expect(expanding.status).toBe('EXPANDING');

    const backfilling = await completeStep(USER, m.id);
    expect(backfilling.status).toBe('BACKFILLING');

    const contracting = await completeStep(USER, m.id);
    expect(contracting.status).toBe('CONTRACTING');

    const completed = await completeStep(USER, m.id);
    expect(completed.status).toBe('COMPLETED');

    const report = await schemaMigrationReport(USER);
    expect(report.migrations).toBe(1);
    expect(report.completed).toBe(1);
    expect(report.rolled_back).toBe(0);
  });

  it('rolls back a migration and records the audit', async () => {
    const m = await createSchemaMigration(USER, { table_name: 'orders', direction: 'backfill', sql_up: 'UPDATE orders SET total = 0', sql_down: 'UPDATE orders SET total = NULL' });
    const started = await startExpansion(USER, m.id);
    expect(started.status).toBe('EXPANDING');

    const rolled = await rollbackMigration(USER, m.id);
    expect(rolled.status).toBe('ROLLED_BACK');
    expect(rolled.rolled_back_at).not.toBeNull();
    expect(AUDIT_ACTIONS()).toContain('autonomy.schema_migration_rolled_back');

    const report = await schemaMigrationReport(USER);
    expect(report.rolled_back).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const m = await createSchemaMigration(USER, { table_name: 'users', direction: 'expand', sql_up: 'ALTER TABLE users ADD COLUMN name TEXT', sql_down: 'ALTER TABLE users DROP COLUMN name' });
    await expect(getSchemaMigration(OTHER, m.id)).rejects.toThrow(/schema_migration_not_found/);
    await expect(listSchemaMigrations(OTHER)).resolves.toHaveLength(0);
    await expect(createSchemaMigration(USER, { table_name: '', direction: 'expand', sql_up: 'x', sql_down: 'y' })).rejects.toThrow(/table name is required/);
    await expect(createSchemaMigration(USER, { table_name: 'x', direction: 'sideways', sql_up: 'x', sql_down: 'y' })).rejects.toThrow(/direction must be/);
    await expect(createSchemaMigration(USER, { table_name: 'x', direction: 'expand', sql_up: '', sql_down: 'y' })).rejects.toThrow(/sql_up is required/);
    await startExpansion(USER, m.id);
    await expect(startExpansion(USER, m.id)).rejects.toThrow(/only PLANNED migrations/);
    const done = await createSchemaMigration(USER, { table_name: 'logs', direction: 'expand', sql_up: 'CREATE TABLE logs (id TEXT)', sql_down: 'DROP TABLE logs' });
    await startExpansion(USER, done.id);
    await completeStep(USER, done.id);
    await completeStep(USER, done.id);
    await completeStep(USER, done.id);
    await expect(completeStep(USER, done.id)).rejects.toThrow(/already completed/);
    await expect(rollbackMigration(USER, done.id)).rejects.toThrow(/cannot be rolled back/);
  });
});

describe('API VERSION BRIDGE (#108)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('creates a bridge and deprecates the old version', async () => {
    const b = await createApiBridge(USER, { old_version: 'v1', new_version: 'v2', endpoint: '/api/users', mapping: ['getUser → fetchUser'] });
    expect(b.id).toMatch(/^avb-/);
    expect(b.old_version).toBe('v1');
    expect(b.new_version).toBe('v2');
    expect(b.endpoint).toBe('/api/users');
    expect(b.mapping).toEqual(['getUser → fetchUser']);
    expect(b.status).toBe('ACTIVE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.api_bridge_created');

    const deprecated = await deprecateVersion(USER, b.id);
    expect(deprecated.status).toBe('DEPRECATED');
    expect(deprecated.deprecation_date).not.toBeNull();
    expect(AUDIT_ACTIONS()).toContain('autonomy.api_version_deprecated');

    const report = await apiBridgeReport(USER);
    expect(report.bridges).toBe(1);
    expect(report.active).toBe(0);
    expect(report.deprecated).toBe(1);
  });

  it('rejects same-version bridges and double deprecation', async () => {
    const b = await createApiBridge(USER, { old_version: 'v1', new_version: 'v2', endpoint: '/api/orders' });
    await expect(createApiBridge(USER, { old_version: 'v1', new_version: 'v1', endpoint: '/api/orders' })).rejects.toThrow(/old and new versions must differ/);
    await deprecateVersion(USER, b.id);
    await expect(deprecateVersion(USER, b.id)).rejects.toThrow(/only ACTIVE bridges/);
  });

  it('validates and stays owner-scoped', async () => {
    const b = await createApiBridge(USER, { old_version: 'v1', new_version: 'v2', endpoint: '/api/users' });
    await expect(getApiBridge(OTHER, b.id)).rejects.toThrow(/api_bridge_not_found/);
    await expect(listApiBridges(OTHER)).resolves.toHaveLength(0);
    await expect(createApiBridge(USER, { old_version: '', new_version: 'v2', endpoint: '/api/users' })).rejects.toThrow(/old version is required/);
    await expect(createApiBridge(USER, { old_version: 'v1', new_version: '', endpoint: '/api/users' })).rejects.toThrow(/new version is required/);
    await expect(createApiBridge(USER, { old_version: 'v1', new_version: 'v2', endpoint: '' })).rejects.toThrow(/endpoint is required/);
  });
});

describe('DATA MIGRATION ORCHESTRATOR (#109)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('schedules, samples, runs, and verifies a data migration', async () => {
    const m = await scheduleDataMigration(USER, { source_table: 'legacy_users', target_table: 'users', transform_rule: 'hash_passwords', sample_size: 50 });
    expect(m.id).toMatch(/^dmg-/);
    expect(m.source_table).toBe('legacy_users');
    expect(m.target_table).toBe('users');
    expect(m.status).toBe('PLANNED');
    expect(m.sample_size).toBe(50);
    expect(AUDIT_ACTIONS()).toContain('autonomy.data_migration_scheduled');

    const sampled = await sampleMigration(USER, m.id);
    expect(sampled.status).toBe('SAMPLED');

    const running = await runMigration(USER, m.id, 1200);
    expect(running.status).toBe('RUNNING');
    expect(running.rows_affected).toBe(1200);

    const verified = await verifyMigration(USER, m.id);
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verified).toBe(true);
    expect(AUDIT_ACTIONS()).toContain('autonomy.data_migration_verified');

    const report = await dataMigrationReport(USER);
    expect(report.migrations).toBe(1);
    expect(report.verified).toBe(1);
    expect(report.total_rows).toBe(1200);
  });

  it('marks zero-row migrations as FAILED on verify', async () => {
    const m = await scheduleDataMigration(USER, { source_table: 'empty_table', target_table: 'target', transform_rule: 'copy' });
    await runMigration(USER, m.id, 0);
    const result = await verifyMigration(USER, m.id);
    expect(result.status).toBe('FAILED');
    expect(result.verified).toBe(false);
  });

  it('validates and stays owner-scoped', async () => {
    const m = await scheduleDataMigration(USER, { source_table: 'src', target_table: 'tgt', transform_rule: 'rule' });
    await expect(getDataMigration(OTHER, m.id)).rejects.toThrow(/data_migration_not_found/);
    await expect(listDataMigrations(OTHER)).resolves.toHaveLength(0);
    await expect(scheduleDataMigration(USER, { source_table: '', target_table: 'tgt', transform_rule: 'rule' })).rejects.toThrow(/source table is required/);
    await expect(scheduleDataMigration(USER, { source_table: 'src', target_table: '', transform_rule: 'rule' })).rejects.toThrow(/target table is required/);
    await expect(scheduleDataMigration(USER, { source_table: 'src', target_table: 'tgt', transform_rule: '' })).rejects.toThrow(/transform rule is required/);
    await expect(runMigration(USER, m.id, -5)).rejects.toThrow(/non-negative number/);
  });
});

describe('CONFIGURATION MIGRATION (#110)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('starts migration, advances traffic, completes at 100%', async () => {
    const m = await startConfigMigration(USER, { source_type: 'env_vars', target_type: 'secrets_manager', config_keys: ['DB_PASS', 'API_KEY'] });
    expect(m.id).toMatch(/^cfg-/);
    expect(m.source_type).toBe('env_vars');
    expect(m.target_type).toBe('secrets_manager');
    expect(m.config_keys).toEqual(['DB_PASS', 'API_KEY']);
    expect(m.traffic_split_pct).toBe(0);
    expect(m.status).toBe('MIGRATING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.config_migration_started');

    const mid = await advanceTrafficSplit(USER, m.id, 50);
    expect(mid.traffic_split_pct).toBe(50);

    const full = await advanceTrafficSplit(USER, m.id, 100);
    expect(full.traffic_split_pct).toBe(100);

    const completed = await completeConfigMigration(USER, m.id);
    expect(completed.status).toBe('COMPLETED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.config_migration_completed');

    const report = await configMigrationReport(USER);
    expect(report.migrations).toBe(1);
    expect(report.completed).toBe(1);
  });

  it('rejects same-type migration and completing before 100%', async () => {
    await expect(startConfigMigration(USER, { source_type: 'env', target_type: 'env', config_keys: ['X'] })).rejects.toThrow(/source and target types must differ/);
    const m2 = await startConfigMigration(USER, { source_type: 'a', target_type: 'b' });
    await advanceTrafficSplit(USER, m2.id, 50);
    await expect(completeConfigMigration(USER, m2.id)).rejects.toThrow(/traffic split must be 100%/);
  });

  it('validates and stays owner-scoped', async () => {
    const m = await startConfigMigration(USER, { source_type: 'env', target_type: 'vault' });
    await expect(getConfigMigration(OTHER, m.id)).rejects.toThrow(/config_migration_not_found/);
    await expect(listConfigMigrations(OTHER)).resolves.toHaveLength(0);
    await expect(startConfigMigration(USER, { source_type: '', target_type: 'vault' })).rejects.toThrow(/source type is required/);
    await expect(startConfigMigration(USER, { source_type: 'env', target_type: '' })).rejects.toThrow(/target type is required/);
    await expect(advanceTrafficSplit(USER, m.id, -10)).rejects.toThrow(/between 0 and 100/);
    await expect(advanceTrafficSplit(USER, m.id, 110)).rejects.toThrow(/between 0 and 100/);
  });
});

describe('DESIGN POLICE (#111)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('flags violations, fixes them, and audits both steps', async () => {
    const r = await flagDesignViolation(USER, { screen_path: '/dashboard', spacing_issues: ['header gap 8px should be 12px'], color_issues: ['bg should be #fff not #f5f5f5'] });
    expect(r.id).toMatch(/^dpol-/);
    expect(r.screen_path).toBe('/dashboard');
    expect(r.status).toBe('FLAGGED');
    expect(r.spacing_issues).toContain('header gap 8px should be 12px');
    expect(r.color_issues).toContain('bg should be #fff not #f5f5f5');
    expect(AUDIT_ACTIONS()).toContain('autonomy.design_violation_flagged');

    const fixed = await fixViolation(USER, r.id);
    expect(fixed.status).toBe('FIXED');
    expect(fixed.spacing_issues).toEqual([]);
    expect(fixed.color_issues).toEqual([]);
    expect(AUDIT_ACTIONS()).toContain('autonomy.design_violation_fixed');

    const report = await designPoliceReport(USER);
    expect(report.reports).toBe(1);
    expect(report.fixed).toBe(1);
    expect(report.flagged).toBe(0);
  });

  it('ignores a flagged violation', async () => {
    const r = await flagDesignViolation(USER, { screen_path: '/settings', violations: ['missing dark mode'] });
    expect(r.status).toBe('FLAGGED');
    const ignored = await ignoreViolation(USER, r.id);
    expect(ignored.status).toBe('IGNORED');
    await expect(fixViolation(USER, r.id)).rejects.toThrow(/only FLAGGED reports/);
  });

  it('validates and stays owner-scoped', async () => {
    const r = await flagDesignViolation(USER, { screen_path: '/login', component_misuse: ['Button used as Link'] });
    await expect(getDesignReport(OTHER, r.id)).rejects.toThrow(/design_report_not_found/);
    await expect(listDesignReports(OTHER)).resolves.toHaveLength(0);
    await expect(flagDesignViolation(USER, { screen_path: '' })).rejects.toThrow(/screen path is required/);
    await expect(flagDesignViolation(USER, { screen_path: '/x' })).rejects.toThrow(/at least one violation/);
  });
});
