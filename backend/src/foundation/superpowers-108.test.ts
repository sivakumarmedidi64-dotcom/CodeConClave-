/**
 * CodeConClave — Stage 108 SUPERPOWERS Tranche AD: Feature Store Autopilot,
 * Denormalization Suggester, Relationship Mapper, Anomaly Detector, Compliance Checker.
 *
 *   FEATURE-STORE AUTOPILOT (#127)     — drift detection → retraining PR.
 *   DENORMALIZATION SUGGESTER (#128)   — query → materialized view suggestion.
 *   RELATIONSHIP MAPPER (#129)         — data relationship visualization.
 *   ANOMALY DETECTOR (#130)            — volume/distribution anomalies detected & alerted.
 *   COMPLIANCE CHECKER (#131)          — PII/retention/consent violations flagged.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    feature_store_runs: [] as Array<Record<string, unknown>>,
    denorm_suggestions: [] as Array<Record<string, unknown>>,
    relationship_maps: [] as Array<Record<string, unknown>>,
    anomaly_scans: [] as Array<Record<string, unknown>>,
    compliance_reports: [] as Array<Record<string, unknown>>,
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
    FEATURE_STORE: 'fst',
    DENORMALIZATION: 'dnz',
    RELATIONSHIP_MAP: 'rlm',
    ANOMALY_DETECTOR: 'and',
    COMPLIANCE_CHECK: 'cpl',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { createFeatureStore, draftRetrain, getFeatureStore, listFeatureStores, featureStoreReport } from '../modules/superpowers/featureStoreAutopilot.js';
import { createDenormSuggestion, applyDenormSuggestion, getDenormSuggestion, listDenormSuggestions, denormSuggestionReport } from '../modules/superpowers/denormalizationSuggester.js';
import { createRelationshipMap, verifyRelationshipMap, getRelationshipMap, listRelationshipMaps, relationshipMapReport } from '../modules/superpowers/relationshipMapper.js';
import { createAnomalyScan, alertAnomaly, getAnomalyScan, listAnomalyScans, anomalyScanReport } from '../modules/superpowers/anomalyDetector.js';
import { createComplianceReport, resolveComplianceReport, getComplianceReport, listComplianceReports, complianceReport } from '../modules/superpowers/complianceChecker.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('FEATURE-STORE AUTOPILOT (#127)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a feature store run, detects drift, and drafts retrain PR', async () => {
    const run = await createFeatureStore(USER, { model_name: 'churn-predictor', feature_set: ['session_length', 'page_views', 'referral_source'] });
    expect(run.id).toMatch(/^fst-/);
    expect(run.model_name).toBe('churn-predictor');
    expect(run.feature_set).toEqual(['session_length', 'page_views', 'referral_source']);
    expect(run.status).toBe('MONITORING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.feature_drift_detected');

    const retrained = await draftRetrain(USER, run.id, { drift_score: 0.37, retrain_pr_url: 'https://github.com/acme/ml/pull/88' });
    expect(retrained.status).toBe('RETRAINED');
    expect(retrained.drift_score).toBe(0.37);
    expect(retrained.retrain_pr_url).toContain('pull/88');
    expect(AUDIT_ACTIONS()).toContain('autonomy.model_retrain_drafted');
  });

  it('reports feature store totals', async () => {
    await createFeatureStore(USER, { model_name: 'm1', feature_set: ['f1'] });
    const r2 = await createFeatureStore(USER, { model_name: 'm2', feature_set: ['f2', 'f3'] });
    await draftRetrain(USER, r2.id, { drift_score: 0.5, retrain_pr_url: 'https://pr/1' });

    const report = await featureStoreReport(USER);
    expect(report.total).toBe(2);
    expect(report.monitoring).toBe(1);
    expect(report.retrained).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const run = await createFeatureStore(USER, { model_name: 'm', feature_set: ['f'] });
    await expect(getFeatureStore(OTHER, run.id)).rejects.toThrow(/feature_store_run_not_found/);
    await expect(listFeatureStores(OTHER)).resolves.toHaveLength(0);
    await expect(createFeatureStore(USER, { model_name: '', feature_set: ['f'] })).rejects.toThrow(/model name is required/);
    await expect(createFeatureStore(USER, { model_name: 'm', feature_set: [] })).rejects.toThrow(/at least one feature/);
  });
});

describe('DENORMALIZATION SUGGESTER (#128)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a denorm suggestion and applies it', async () => {
    const s = await createDenormSuggestion(USER, {
      query_text: 'SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.name',
      source_tables: ['users', 'orders'],
      suggested_view: 'user_order_summary',
    });
    expect(s.id).toMatch(/^dnz-/);
    expect(s.query_text).toContain('COUNT');
    expect(s.source_tables).toEqual(['users', 'orders']);
    expect(s.suggested_view).toBe('user_order_summary');
    expect(s.status).toBe('SUGGESTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.denormalization_suggested');

    const applied = await applyDenormSuggestion(USER, s.id, { estimated_improvement: 3.5 });
    expect(applied.status).toBe('APPLIED');
    expect(applied.estimated_improvement).toBe(3.5);
  });

  it('reports denorm suggestion totals', async () => {
    await createDenormSuggestion(USER, { query_text: 'q1', source_tables: ['t1'], suggested_view: 'v1' });
    const s2 = await createDenormSuggestion(USER, { query_text: 'q2', source_tables: ['t2', 't3'], suggested_view: 'v2' });
    await applyDenormSuggestion(USER, s2.id, { estimated_improvement: 2.0 });

    const report = await denormSuggestionReport(USER);
    expect(report.total).toBe(2);
    expect(report.suggested).toBe(1);
    expect(report.applied).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const s = await createDenormSuggestion(USER, { query_text: 'q', source_tables: ['t'], suggested_view: 'v' });
    await expect(getDenormSuggestion(OTHER, s.id)).rejects.toThrow(/denorm_suggestion_not_found/);
    await expect(listDenormSuggestions(OTHER)).resolves.toHaveLength(0);
    await expect(createDenormSuggestion(USER, { query_text: '', source_tables: ['t'], suggested_view: 'v' })).rejects.toThrow(/query text is required/);
    await expect(createDenormSuggestion(USER, { query_text: 'q', source_tables: [], suggested_view: 'v' })).rejects.toThrow(/at least one source table/);
    await expect(createDenormSuggestion(USER, { query_text: 'q', source_tables: ['t'], suggested_view: '' })).rejects.toThrow(/suggested view name is required/);
  });
});

describe('RELATIONSHIP MAPPER (#129)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a relationship map and verifies it', async () => {
    const m = await createRelationshipMap(USER, {
      source_table: 'orders',
      target_table: 'users',
      relationship_type: 'FOREIGN_KEY',
      column_mapping: ['orders.user_id = users.id'],
    });
    expect(m.id).toMatch(/^rlm-/);
    expect(m.source_table).toBe('orders');
    expect(m.target_table).toBe('users');
    expect(m.relationship_type).toBe('FOREIGN_KEY');
    expect(m.status).toBe('MAPPED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.relationship_map_rendered');

    const verified = await verifyRelationshipMap(USER, m.id);
    expect(verified.status).toBe('VERIFIED');
  });

  it('reports relationship map totals', async () => {
    await createRelationshipMap(USER, { source_table: 'a', target_table: 'b', relationship_type: 'FK', column_mapping: ['a.bid = b.id'] });
    const m2 = await createRelationshipMap(USER, { source_table: 'c', target_table: 'd', relationship_type: 'SOFT', column_mapping: ['c.did = d.id'] });
    await verifyRelationshipMap(USER, m2.id);

    const report = await relationshipMapReport(USER);
    expect(report.total).toBe(2);
    expect(report.mapped).toBe(1);
    expect(report.verified).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const m = await createRelationshipMap(USER, { source_table: 'a', target_table: 'b', relationship_type: 'FK', column_mapping: ['a.b = b.a'] });
    await expect(getRelationshipMap(OTHER, m.id)).rejects.toThrow(/relationship_map_not_found/);
    await expect(listRelationshipMaps(OTHER)).resolves.toHaveLength(0);
    await expect(createRelationshipMap(USER, { source_table: '', target_table: 'b', relationship_type: 'FK', column_mapping: ['x'] })).rejects.toThrow(/source table is required/);
    await expect(createRelationshipMap(USER, { source_table: 'a', target_table: '', relationship_type: 'FK', column_mapping: ['x'] })).rejects.toThrow(/target table is required/);
    await expect(createRelationshipMap(USER, { source_table: 'a', target_table: 'b', relationship_type: '', column_mapping: ['x'] })).rejects.toThrow(/relationship type is required/);
    await expect(createRelationshipMap(USER, { source_table: 'a', target_table: 'b', relationship_type: 'FK', column_mapping: [] })).rejects.toThrow(/at least one column mapping/);
  });
});

describe('ANOMALY DETECTOR (#130)', () => {
  beforeEach(() => { cleartables(); });

  it('creates an anomaly scan and alerts it', async () => {
    const scan = await createAnomalyScan(USER, {
      data_source: 'orders_table',
      anomaly_type: 'VOLUME_SPIKE',
      description: 'Order volume increased 500% in 1 hour',
      severity: 'HIGH',
    });
    expect(scan.id).toMatch(/^and-/);
    expect(scan.data_source).toBe('orders_table');
    expect(scan.anomaly_type).toBe('VOLUME_SPIKE');
    expect(scan.severity).toBe('HIGH');
    expect(scan.alerted).toBe(false);
    expect(scan.status).toBe('DETECTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.anomaly_detected');

    const alerted = await alertAnomaly(USER, scan.id);
    expect(alerted.alerted).toBe(true);
    expect(alerted.status).toBe('ALERTED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.anomaly_alerted');
  });

  it('reports anomaly scan totals', async () => {
    await createAnomalyScan(USER, { data_source: 's1', anomaly_type: 'MISSING_DATA', description: 'column X nulls', severity: 'LOW' });
    const s2 = await createAnomalyScan(USER, { data_source: 's2', anomaly_type: 'DISTRIBUTION_SHIFT', description: 'values shifted', severity: 'CRITICAL' });
    await alertAnomaly(USER, s2.id);

    const report = await anomalyScanReport(USER);
    expect(report.total).toBe(2);
    expect(report.detected).toBe(1);
    expect(report.alerted).toBe(1);
    expect(report.by_severity['LOW']).toBe(1);
    expect(report.by_severity['CRITICAL']).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const scan = await createAnomalyScan(USER, { data_source: 's', anomaly_type: 't', description: 'd', severity: 'MEDIUM' });
    await expect(getAnomalyScan(OTHER, scan.id)).rejects.toThrow(/anomaly_scan_not_found/);
    await expect(listAnomalyScans(OTHER)).resolves.toHaveLength(0);
    await expect(createAnomalyScan(USER, { data_source: '', anomaly_type: 't', description: 'd', severity: 'MEDIUM' })).rejects.toThrow(/data source is required/);
    await expect(createAnomalyScan(USER, { data_source: 's', anomaly_type: '', description: 'd', severity: 'MEDIUM' })).rejects.toThrow(/anomaly type is required/);
    await expect(createAnomalyScan(USER, { data_source: 's', anomaly_type: 't', description: '', severity: 'MEDIUM' })).rejects.toThrow(/description is required/);
    await expect(createAnomalyScan(USER, { data_source: 's', anomaly_type: 't', description: 'd', severity: 'INVALID' })).rejects.toThrow(/severity must be/);
  });
});

describe('COMPLIANCE CHECKER (#131)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a compliance report and resolves it', async () => {
    const report = await createComplianceReport(USER, {
      resource_type: 'users',
      violation_type: 'PII_EXPOSURE',
      evidence: 'email field returned in public API without masking',
      severity: 'HIGH',
    });
    expect(report.id).toMatch(/^cpl-/);
    expect(report.resource_type).toBe('users');
    expect(report.violation_type).toBe('PII_EXPOSURE');
    expect(report.severity).toBe('HIGH');
    expect(report.status).toBe('FLAGGED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.compliance_violation_flagged');

    const resolved = await resolveComplianceReport(USER, report.id);
    expect(resolved.status).toBe('RESOLVED');
  });

  it('reports compliance totals', async () => {
    await createComplianceReport(USER, { resource_type: 'orders', violation_type: 'RETENTION', evidence: 'records older than 7 years', severity: 'MEDIUM' });
    const r2 = await createComplianceReport(USER, { resource_type: 'users', violation_type: 'CONSENT', evidence: 'no consent record', severity: 'CRITICAL' });
    await resolveComplianceReport(USER, r2.id);

    const report = await complianceReport(USER);
    expect(report.total).toBe(2);
    expect(report.flagged).toBe(1);
    expect(report.resolved).toBe(1);
    expect(report.by_severity['MEDIUM']).toBe(1);
    expect(report.by_severity['CRITICAL']).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const r = await createComplianceReport(USER, { resource_type: 't', violation_type: 'v', evidence: 'e', severity: 'LOW' });
    await expect(getComplianceReport(OTHER, r.id)).rejects.toThrow(/compliance_report_not_found/);
    await expect(listComplianceReports(OTHER)).resolves.toHaveLength(0);
    await expect(createComplianceReport(USER, { resource_type: '', violation_type: 'v', evidence: 'e', severity: 'LOW' })).rejects.toThrow(/resource type is required/);
    await expect(createComplianceReport(USER, { resource_type: 't', violation_type: '', evidence: 'e', severity: 'LOW' })).rejects.toThrow(/violation type is required/);
    await expect(createComplianceReport(USER, { resource_type: 't', violation_type: 'v', evidence: '', severity: 'LOW' })).rejects.toThrow(/evidence is required/);
    await expect(createComplianceReport(USER, { resource_type: 't', violation_type: 'v', evidence: 'e', severity: 'INVALID' })).rejects.toThrow(/severity must be/);
  });
});
