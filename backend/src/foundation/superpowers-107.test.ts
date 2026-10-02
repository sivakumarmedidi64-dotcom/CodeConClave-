/**
 * CodeConClave — Stage 107 SUPERPOWERS Tranche AC: Component Catalogue, Query Whisperer,
 * Data Doctor, Schema Time Machine, Pipeline Watcher.
 *
 *   COMPONENT CATALOGUE (#122)  — auto-generated living component library.
 *   QUERY WHISPERER (#123)      — SQL/ORM query explanation and rewriting.
 *   DATA DOCTOR (#124)          — data integrity validation.
 *   SCHEMA TIME MACHINE (#125)  — point-in-time schema + data reconstruction.
 *   PIPELINE WATCHER (#126)     — ETL/data job monitoring.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    component_catalogue_entries: [] as Array<Record<string, unknown>>,
    query_whisperer_plans: [] as Array<Record<string, unknown>>,
    data_doctor_scans: [] as Array<Record<string, unknown>>,
    schema_time_machine_snapshots: [] as Array<Record<string, unknown>>,
    pipeline_watcher_runs: [] as Array<Record<string, unknown>>,
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
    COMPONENT_CATALOGUE: 'cct',
    QUERY_WHISPERER: 'qws',
    DATA_DOCTOR: 'ddc',
    SCHEMA_TIME_MACHINE: 'stm',
    PIPELINE_WATCHER: 'plw',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { createCatalogueEntry, parseCatalogueEntry, publishCatalogueEntry, getCatalogueEntry, listCatalogueEntries, componentCatalogueReport } from '../modules/superpowers/componentCatalogue.js';
import { createQueryPlan, explainQuery, rewriteQuery, getQueryWhisperer, listQueryWhisperers, queryWhispererReport } from '../modules/superpowers/queryWhisperer.js';
import { createDataDoctorScan, runDataDoctorScan, flagDataIssue, getDataDoctorScan, listDataDoctorScans, dataDoctorReport } from '../modules/superpowers/dataDoctor.js';
import { createSchemaSnapshot, captureSchemaSnapshot, restoreSchemaPoint, getSchemaTimeMachine, listSchemaTimeMachineSnapshots, schemaTimeMachineReport } from '../modules/superpowers/schemaTimeMachine.js';
import { createPipelineWatcherRun, detectPipelineAnomaly, flagSlaViolation, getPipelineWatcherRun, listPipelineWatcherRuns, pipelineWatcherReport } from '../modules/superpowers/pipelineWatcher.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('COMPONENT CATALOGUE (#122)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a catalogue entry, parses and publishes it', async () => {
    const entry = await createCatalogueEntry(USER, { component_name: 'Button', description: 'A clickable button', props: ['label', 'onClick'], states: ['enabled', 'disabled'], accessibility_notes: 'Has role=button' });
    expect(entry.id).toMatch(/^cct-/);
    expect(entry.component_name).toBe('Button');
    expect(entry.status).toBe('PARSED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.catalogue_parsed');

    const parsed = await parseCatalogueEntry(USER, entry.id, { props: ['label', 'onClick', 'variant'], states: ['enabled', 'disabled', 'loading'], accessibility_notes: 'Has role=button, aria-label supported' });
    expect(parsed.props).toEqual(['label', 'onClick', 'variant']);
    expect(AUDIT_ACTIONS()).toContain('autonomy.catalogue_parsed');

    const published = await publishCatalogueEntry(USER, entry.id);
    expect(published.status).toBe('PUBLISHED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.catalogue_published');
  });

  it('reports catalogue totals', async () => {
    await createCatalogueEntry(USER, { component_name: 'Input', description: 'text input', props: ['value'], states: ['empty'], accessibility_notes: '' });
    const e2 = await createCatalogueEntry(USER, { component_name: 'Card', description: 'card', props: ['title'], states: ['open'], accessibility_notes: '' });
    await publishCatalogueEntry(USER, e2.id);

    const report = await componentCatalogueReport(USER);
    expect(report.entries).toBe(2);
    expect(report.parsed).toBe(1);
    expect(report.published).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const e = await createCatalogueEntry(USER, { component_name: 'X', description: 'd', props: [], states: [], accessibility_notes: '' });
    await expect(getCatalogueEntry(OTHER, e.id)).rejects.toThrow(/not_found/);
    await expect(listCatalogueEntries(OTHER)).resolves.toHaveLength(0);
    await expect(createCatalogueEntry(USER, { component_name: '', description: 'd', props: [], states: [], accessibility_notes: '' })).rejects.toThrow(/component name is required/);
  });
});

describe('QUERY WHISPERER (#123)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a query plan, explains and rewrites it', async () => {
    const plan = await createQueryPlan(USER, { query_text: 'SELECT * FROM users WHERE active = true' });
    expect(plan.id).toMatch(/^qws-/);
    expect(plan.query_text).toBe('SELECT * FROM users WHERE active = true');
    expect(plan.status).toBe('EXPLAINED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.query_explained');

    const explained = await explainQuery(USER, plan.id, { execution_plan: 'Seq Scan on users, filter: active = true', improvement_pct: 15 });
    expect(explained.execution_plan).toContain('Seq Scan');
    expect(explained.improvement_pct).toBe(15);
    expect(AUDIT_ACTIONS()).toContain('autonomy.query_explained');

    const rewritten = await rewriteQuery(USER, plan.id, { rewritten_query: 'SELECT * FROM users WHERE active = true USING INDEX idx_users_active', improvement_pct: 42 });
    expect(rewritten.rewritten_query).toContain('USING INDEX');
    expect(rewritten.status).toBe('REWRITTEN');
    expect(AUDIT_ACTIONS()).toContain('autonomy.query_rewritten');
  });

  it('reports query whisperer totals', async () => {
    const p1 = await createQueryPlan(USER, { query_text: 'SELECT * FROM orders' });
    const p2 = await createQueryPlan(USER, { query_text: 'SELECT * FROM products' });
    await rewriteQuery(USER, p1.id, { rewritten_query: 'SELECT * FROM orders USE INDEX idx1', improvement_pct: 30 });

    const report = await queryWhispererReport(USER);
    expect(report.plans).toBe(2);
    expect(report.explained).toBe(1);
    expect(report.rewritten).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const p = await createQueryPlan(USER, { query_text: 'SELECT 1' });
    await expect(getQueryWhisperer(OTHER, p.id)).rejects.toThrow(/not_found/);
    await expect(listQueryWhisperers(OTHER)).resolves.toHaveLength(0);
    await expect(createQueryPlan(USER, { query_text: '' })).rejects.toThrow(/query text is required/);
  });
});

describe('DATA DOCTOR (#124)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a scan, runs it and flags issues', async () => {
    const scan = await createDataDoctorScan(USER, { scan_name: 'orphan-check', target_table: 'orders' });
    expect(scan.id).toMatch(/^ddc-/);
    expect(scan.scan_name).toBe('orphan-check');
    expect(scan.status).toBe('SCAN_RUN');
    expect(AUDIT_ACTIONS()).toContain('autonomy.data_doctor_scan_run');

    const ran = await runDataDoctorScan(USER, scan.id, { issues_found: ['orphaned rows in line_items'] });
    expect(ran.issues_found).toEqual(['orphaned rows in line_items']);
    expect(ran.status).toBe('ISSUES_FLAGGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.data_doctor_scan_run');

    const flagged = await flagDataIssue(USER, scan.id, { issues: ['constraint drift on user_id', 'null email in users'] });
    expect(flagged.issues_found).toEqual(['constraint drift on user_id', 'null email in users']);
    expect(flagged.status).toBe('ISSUES_FLAGGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.data_issue_flagged');
  });

  it('reports data doctor totals', async () => {
    await createDataDoctorScan(USER, { scan_name: 's1', target_table: 't1' });
    const s2 = await createDataDoctorScan(USER, { scan_name: 's2', target_table: 't2' });
    await flagDataIssue(USER, s2.id, { issues: ['broken fk'] });

    const report = await dataDoctorReport(USER);
    expect(report.scans).toBe(2);
    expect(report.scan_run).toBe(1);
    expect(report.issues_flagged).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const s = await createDataDoctorScan(USER, { scan_name: 'check', target_table: 'users' });
    await expect(getDataDoctorScan(OTHER, s.id)).rejects.toThrow(/not_found/);
    await expect(listDataDoctorScans(OTHER)).resolves.toHaveLength(0);
    await expect(createDataDoctorScan(USER, { scan_name: '', target_table: 'users' })).rejects.toThrow(/scan name is required/);
  });
});

describe('SCHEMA TIME MACHINE (#125)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a snapshot, captures new definition and restores a point', async () => {
    const snap = await createSchemaSnapshot(USER, { schema_name: 'users', schema_definition: 'CREATE TABLE users (id INT)', snapshot_label: 'v1' });
    expect(snap.id).toMatch(/^stm-/);
    expect(snap.schema_name).toBe('users');
    expect(snap.status).toBe('CAPTURED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.schema_snapshot_captured');

    const captured = await captureSchemaSnapshot(USER, snap.id, { schema_definition: 'CREATE TABLE users (id INT, email TEXT)' });
    expect(captured.schema_definition).toContain('email TEXT');
    expect(AUDIT_ACTIONS()).toContain('autonomy.schema_snapshot_captured');

    const restored = await restoreSchemaPoint(USER, snap.id, { restored_from: '2025-01-01T00:00:00Z' });
    expect(restored.restored_from).toBe('2025-01-01T00:00:00Z');
    expect(restored.status).toBe('RESTORED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.schema_point_restored');
  });

  it('reports schema time machine totals', async () => {
    await createSchemaSnapshot(USER, { schema_name: 'a', schema_definition: 'CREATE TABLE a (id INT)', snapshot_label: 'v1' });
    const s2 = await createSchemaSnapshot(USER, { schema_name: 'b', schema_definition: 'CREATE TABLE b (id INT)', snapshot_label: 'v2' });
    await restoreSchemaPoint(USER, s2.id, { restored_from: '2025-06-01T00:00:00Z' });

    const report = await schemaTimeMachineReport(USER);
    expect(report.snapshots).toBe(2);
    expect(report.captured).toBe(1);
    expect(report.restored).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const s = await createSchemaSnapshot(USER, { schema_name: 'x', schema_definition: 'CREATE TABLE x (id INT)', snapshot_label: 'v1' });
    await expect(getSchemaTimeMachine(OTHER, s.id)).rejects.toThrow(/not_found/);
    await expect(listSchemaTimeMachineSnapshots(OTHER)).resolves.toHaveLength(0);
    await expect(createSchemaSnapshot(USER, { schema_name: '', schema_definition: 'CREATE TABLE x (id INT)', snapshot_label: 'v1' })).rejects.toThrow(/schema name is required/);
  });
});

describe('PIPELINE WATCHER (#126)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a pipeline run, detects anomalies and flags SLA violations', async () => {
    const run = await createPipelineWatcherRun(USER, { pipeline_name: 'etl-users', sla_minutes: 30 });
    expect(run.id).toMatch(/^plw-/);
    expect(run.pipeline_name).toBe('etl-users');
    expect(run.status).toBe('RUNNING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.pipeline_anomaly_detected');

    const anomaly = await detectPipelineAnomaly(USER, run.id, { anomalies: ['volume spike: 3x normal'] });
    expect(anomaly.anomalies).toEqual(['volume spike: 3x normal']);
    expect(anomaly.status).toBe('ANOMALY_DETECTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.pipeline_anomaly_detected');

    const sla = await flagSlaViolation(USER, run.id, { anomalies: ['freshness exceeded 30min SLA'] });
    expect(sla.anomalies).toEqual(['freshness exceeded 30min SLA']);
    expect(sla.status).toBe('SLA_FLAGGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.pipeline_sla_flagged');
  });

  it('reports pipeline watcher totals', async () => {
    await createPipelineWatcherRun(USER, { pipeline_name: 'p1', sla_minutes: 10 });
    const r2 = await createPipelineWatcherRun(USER, { pipeline_name: 'p2', sla_minutes: 20 });
    await flagSlaViolation(USER, r2.id, { anomalies: ['stale data'] });

    const report = await pipelineWatcherReport(USER);
    expect(report.runs).toBe(2);
    expect(report.running).toBe(1);
    expect(report.anomaly_detected).toBe(0);
    expect(report.sla_flagged).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const r = await createPipelineWatcherRun(USER, { pipeline_name: 'test', sla_minutes: 5 });
    await expect(getPipelineWatcherRun(OTHER, r.id)).rejects.toThrow(/not_found/);
    await expect(listPipelineWatcherRuns(OTHER)).resolves.toHaveLength(0);
    await expect(createPipelineWatcherRun(USER, { pipeline_name: '', sla_minutes: 5 })).rejects.toThrow(/pipeline name is required/);
  });
});
