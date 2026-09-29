/**
 * CodeConClave — Stage 100 SUPERPOWERS Tranche V: Capacity Oracle, Environment
 * Cloner, Runbook Runner, Backup Reality Check, Network X-Ray.
 *
 *   CAPACITY ORACLE (#87)        — exhaustion predicted weeks out, fix sized/costed.
 *   ENVIRONMENT CLONER (#88)     — prod → dev copy with anonymized data.
 *   RUNBOOK RUNNER (#89)         — alerts auto-ran; human only when confidence drops.
 *   BACKUP REALITY CHECK (#90)   — restore and verify, not just "backup succeeded".
 *   NETWORK X-RAY (#91)          — live service map + instant blast radius.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    capacity_forecasts: [] as Array<Record<string, unknown>>,
    env_clones: [] as Array<Record<string, unknown>>,
    runbook_runs: [] as Array<Record<string, unknown>>,
    backup_checks: [] as Array<Record<string, unknown>>,
    network_edges: [] as Array<Record<string, unknown>>,
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
    CAPACITY_FORECAST: 'cpo',
    ENV_CLONE: 'enc',
    RUNBOOK_RUN: 'rbn',
    BACKUP_CHECK: 'bck',
    NETWORK_EDGE: 'nwe',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { forecastExhaustion, forecastVerdict, daysToExhaustion, getCapacityForecast, listCapacityForecasts, capacityReport } from '../modules/superpowers/capacityOracle.js';
import { cloneEnvironment, anonymizeCell, anonymizeRows, getEnvironmentClone, listEnvironmentClones, environmentCloneReport } from '../modules/superpowers/environmentCloner.js';
import { startRunbook, executeStep, resolveRunbook, confidenceFor, getRunbook, listRunbooks, runbookReport } from '../modules/superpowers/runbookRunner.js';
import { scheduleRestoreCheck, verifyRestore, getBackupCheck, listBackupChecks, backupRealityReport } from '../modules/superpowers/backupRealityCheck.js';
import { recordServiceCall, computeBlastRadius, getNetworkMap, blastRadius, getNetworkEdge, listNetworkEdges, networkXrayReport } from '../modules/superpowers/networkXRay.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('CAPACITY ORACLE (#87)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('predicts exhaustion weeks out with a sized, costed fix', async () => {
    expect(daysToExhaustion(200, 50, 10)).toBe(15);
    const f = await forecastExhaustion(USER, { component: 'coredb connections', capacity: 200, usage: 50, growth_per_day: 10 });
    expect(f.id).toMatch(/^cpo-/);
    expect(f.days_to_exhaustion).toBe(15);
    expect(f.fix_size).toBe(300);
    expect(f.monthly_cost).toBe(15);
    expect(f.status).toBe('OK');
    expect(forecastVerdict(f)).toContain('runs out in ~15 days');
    expect(forecastVerdict(f)).toContain('+300 capacity');
    expect(AUDIT_ACTIONS()).toContain('autonomy.capacity_forecast_issued');
  });

  it('flags critical and exhausted horizons', async () => {
    const critical = await forecastExhaustion(USER, { component: 'queued jobs', capacity: 100, usage: 90, growth_per_day: 5 });
    expect(critical.status).toBe('CRITICAL');
    expect(critical.days_to_exhaustion).toBe(2);

    const gone = await forecastExhaustion(USER, { component: 'pool workers', capacity: 100, usage: 150, growth_per_day: 5 });
    expect(gone.status).toBe('EXHAUSTED');
    expect(gone.days_to_exhaustion).toBe(0);
    expect(forecastVerdict(gone)).toContain('exhausted NOW');

    const report = await capacityReport(USER);
    expect(report.forecasts).toBe(2);
    expect(report.critical).toBe(1);
    expect(report.exhausted).toBe(1);
  });

  it('sees no exhaustion in sight when growth stalls', async () => {
    const stable = await forecastExhaustion(USER, { component: 'coredb connections', capacity: 200, usage: 50, growth_per_day: 0 });
    expect(stable.days_to_exhaustion).toBeNull();
    expect(forecastVerdict(stable)).toBe('"coredb connections" is stable — no exhaustion in sight');
    expect(stable.status).toBe('OK');
  });

  it('validates and stays owner-scoped', async () => {
    const a = await forecastExhaustion(USER, { component: 'coredb connections', capacity: 200, usage: 50, growth_per_day: 10 });
    await expect(getCapacityForecast(OTHER, a.id)).rejects.toThrow(/capacity_forecast_not_found/);
    await expect(listCapacityForecasts(OTHER)).resolves.toHaveLength(0);
    await expect(forecastExhaustion(USER, { component: '', capacity: 10, usage: 1, growth_per_day: 1 })).rejects.toThrow(/component is required/);
    await expect(forecastExhaustion(USER, { component: 'db', capacity: -1, usage: 1, growth_per_day: 1 })).rejects.toThrow(/non-negative/);
    await expect(forecastExhaustion(USER, { component: 'db', capacity: 10, usage: 1, growth_per_day: 'x' as never })).rejects.toThrow(/growth per day/);
  });
});

describe('ENVIRONMENT CLONER (#88)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('clones prod into dev in minutes with audits flowing', async () => {
    const c = await cloneEnvironment(USER, { source: 'production', target: 'dev-isaac', rows: 1200, anonymize: true });
    expect(c.id).toMatch(/^enc-/);
    expect(c.source).toBe('production');
    expect(c.target).toBe('dev-isaac');
    expect(c.rows_cloned).toBe(1200);
    expect(c.elapsed_minutes).toBe(3);
    expect(c.anonymized).toBe(true);
    expect(c.status).toBe('READY');
    expect(AUDIT_ACTIONS()).toEqual(expect.arrayContaining([
      'autonomy.env_clone_started',
      'autonomy.env_clone_anonymized',
      'autonomy.env_clone_ready',
    ]));
  });

  it('anonymizes PII cells so nobody ships real data', async () => {
    expect(anonymizeCell('founder@acme.io')).toBe('user@anon.example');
    expect(anonymizeCell('4111111111111111')).toBe('4111 1111 1111 1111');
    expect(anonymizeCell('+14155551234')).toBe('+1 000 000 0000');
    expect(anonymizeCell('plain note')).toBe('plain note');

    const { anonymized, changed } = anonymizeRows(['ada@acme.io', 'grace@acme.io', 'plain', 42]);
    expect(anonymized[0]).toBe('user0@anon.example');
    expect(anonymized[1]).toBe('user1@anon.example');
    expect(anonymized[2]).toBe('plain');
    expect(changed).toBe(2);
  });

  it('skips anonymization when not requested and stays scoped', async () => {
    const c = await cloneEnvironment(USER, { source: 'production', target: 'dev-isaac', rows: 900 });
    expect(c.anonymized).toBe(false);
    expect(c.anonymized_rows).toBe(0);
    await expect(getEnvironmentClone(OTHER, c.id)).rejects.toThrow(/env_clone_not_found/);
    await expect(listEnvironmentClones(OTHER)).resolves.toHaveLength(0);
    await expect(cloneEnvironment(USER, { source: '', target: 'dev', rows: 10 })).rejects.toThrow(/source environment/);
    await expect(cloneEnvironment(USER, { source: 'prod', target: 'dev', rows: 0 })).rejects.toThrow(/positive number/);
  });

  it('reports clone totals', async () => {
    await cloneEnvironment(USER, { source: 'production', target: 'dev-isaac', rows: 1000, anonymize: true });
    await cloneEnvironment(USER, { source: 'staging', target: 'dev-ada', rows: 500 });
    const report = await environmentCloneReport(USER);
    expect(report.clones).toBe(2);
    expect(report.rows).toBe(1500);
    expect(report.anonymized).toBe(1);
  });
});

describe('RUNBOOK RUNNER (#89)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('runs the runbook automatically and resolves when every step succeeds', async () => {
    const run = await startRunbook(USER, { alert: 'queue depth spiked', steps: ['scale out workers', 'purge queue', 'restart consumer'] });
    expect(run.id).toMatch(/^rbn-/);
    expect(run.steps).toHaveLength(3);
    expect(run.confidence).toBe(confidenceFor(0));
    expect(run.status).toBe('EXECUTING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.runbook_executed');

    await executeStep(USER, run.id, {});
    await executeStep(USER, run.id, { ok: true });
    const done = await executeStep(USER, run.id, { ok: true });
    expect(done.completed).toBe(3);
    expect(done.status).toBe('RESOLVED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.runbook_step_run');
    expect(AUDIT_ACTIONS()).toContain('autonomy.runbook_resolved');
    await expect(executeStep(USER, run.id, { ok: true })).rejects.toThrow(/closed/);
  });

  it('escalates to a human only when confidence drops', async () => {
    const run = await startRunbook(USER, { alert: 'node flapping', steps: ['drain node', 'restart kubelet'] });
    await executeStep(USER, run.id, { ok: false });
    const mid = await getRunbook(USER, run.id);
    expect(mid.blocked).toBe(1);
    expect(mid.confidence).toBe(0.7);
    expect(mid.status).toBe('EXECUTING');

    const escalated = await executeStep(USER, run.id, { ok: false });
    expect(escalated.blocked).toBe(2);
    expect(escalated.confidence).toBe(0.45);
    expect(escalated.status).toBe('ESCALATED');
    expect(escalated.note).toContain('human attention');
    expect(escalated.note).toContain('node flapping');
    expect(AUDIT_ACTIONS()).toContain('autonomy.runbook_escalated');
    await expect(resolveRunbook(USER, run.id)).rejects.toThrow(/still needs a human/);
  });

  it('resolveRunbook closes an executing runbook on behalf of a human', async () => {
    const run = await startRunbook(USER, { alert: 'queue depth spiked', steps: ['scale out workers', 'purge queue'] });
    await executeStep(USER, run.id, { ok: true });
    const resolved = await resolveRunbook(USER, run.id);
    expect(resolved.status).toBe('RESOLVED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.runbook_resolved');
    await expect(resolveRunbook(USER, run.id)).rejects.toThrow(/already resolved/);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await startRunbook(USER, { alert: 'queue depth spiked', steps: ['scale out workers'] });
    await expect(getRunbook(OTHER, a.id)).rejects.toThrow(/runbook_run_not_found/);
    await expect(listRunbooks(OTHER)).resolves.toHaveLength(0);
    await expect(startRunbook(USER, { alert: '', steps: ['x'] })).rejects.toThrow(/alert condition/);
    await expect(startRunbook(USER, { alert: 'a', steps: [] })).rejects.toThrow(/at least one step/);
  });
});

describe('BACKUP REALITY CHECK (#90)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('schedules a restore check and proves the backup works', async () => {
    const check = await scheduleRestoreCheck(USER, { target: 'postgres-prod', schedule: 'daily 0200' });
    expect(check.id).toMatch(/^bck-/);
    expect(check.status).toBe('SCHEDULED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.backup_check_scheduled');

    const verified = await verifyRestore(USER, check.id, { expected_rows: 1000, extracted_rows: 1000 });
    expect(verified.status).toBe('VERIFIED');
    expect(verified.checks_passed).toBe(true);
    expect(verified.verdict).toContain('VERIFIED working');
    expect(verified.verdict).toContain('1000/1000');
    expect(AUDIT_ACTIONS()).toContain('autonomy.backup_check_performed');
    expect(AUDIT_ACTIONS()).toContain('autonomy.backup_verified');
  });

  it('calls a broken restore what it is', async () => {
    const check = await scheduleRestoreCheck(USER, { target: 'postgres-prod' });
    const broken = await verifyRestore(USER, check.id, { expected_rows: 1000, extracted_rows: 999 });
    expect(broken.status).toBe('BROKEN');
    expect(broken.checks_passed).toBe(false);
    expect(broken.verdict).toContain('BROKEN — restore failed');
    expect(AUDIT_ACTIONS()).toContain('autonomy.backup_broken');

    const report = await backupRealityReport(USER);
    expect(report.checks).toBe(1);
    expect(report.broken).toBe(1);
    expect(report.verified).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await scheduleRestoreCheck(USER, { target: 'postgres-prod' });
    await expect(getBackupCheck(OTHER, a.id)).rejects.toThrow(/backup_check_not_found/);
    await expect(listBackupChecks(OTHER)).resolves.toHaveLength(0);
    await expect(scheduleRestoreCheck(USER, { target: '' })).rejects.toThrow(/backup target/);
    await expect(verifyRestore(USER, a.id, { expected_rows: 0, extracted_rows: 0 })).rejects.toThrow(/positive number/);
  });
});

describe('NETWORK X-RAY (#91)', () => {
  beforeEach(() => {
    cleartables();
  });

  it('maps service-to-service calls, tallying traffic', async () => {
    const first = await recordServiceCall(USER, { from: 'gateway', to: 'billing', calls: 2 });
    expect(first.id).toMatch(/^nwe-/);
    expect(first.calls).toBe(2);
    await recordServiceCall(USER, { from: 'gateway', to: 'billing' });
    await recordServiceCall(USER, { from: 'billing', to: 'ledger' });
    await recordServiceCall(USER, { from: 'gateway', to: 'search' });

    const map = await getNetworkMap(USER);
    expect(map.services).toEqual(['billing', 'gateway', 'ledger', 'search']);
    expect(map.edges).toHaveLength(3);
    expect(map.edges.find((e) => e.from === 'gateway' && e.to === 'billing')!.calls).toBe(3);
    expect(AUDIT_ACTIONS()).toContain('autonomy.service_call_recorded');
  });

  it('computes the blast radius of any failure transitively', async () => {
    const edges = [
      { id: '1', owner_id: USER, src: 'gateway', dst: 'billing', calls: 1, created_at: new Date(), updated_at: new Date() },
      { id: '2', owner_id: USER, src: 'billing', dst: 'ledger', calls: 1, created_at: new Date(), updated_at: new Date() },
      { id: '3', owner_id: USER, src: 'gateway', dst: 'search', calls: 1, created_at: new Date(), updated_at: new Date() },
    ];
    expect(computeBlastRadius(edges as any, 'gateway')).toEqual(['billing', 'ledger', 'search']);
    expect(computeBlastRadius(edges as any, 'ledger')).toEqual([]);
  });

  it('reports blast radius live from the map', async () => {
    await recordServiceCall(USER, { from: 'gateway', to: 'billing' });
    await recordServiceCall(USER, { from: 'billing', to: 'ledger' });
    await recordServiceCall(USER, { from: 'gateway', to: 'search' });

    const blast = await blastRadius(USER, 'gateway');
    expect(blast.radius).toBe(3);
    expect(blast.services).toEqual(['billing', 'ledger', 'search']);
    await expect(blastRadius(USER, 'ghost')).rejects.toThrow(/not on the network map/);
    expect(AUDIT_ACTIONS()).toContain('autonomy.blast_radius_computed');

    const report = await networkXrayReport(USER);
    expect(report.services).toBe(4);
    expect(report.edges).toBe(3);
    expect(report.calls_total).toBe(3);
  });

  it('validates and stays owner-scoped', async () => {
    const a = await recordServiceCall(USER, { from: 'gateway', to: 'billing' });
    await expect(getNetworkEdge(OTHER, a.id)).rejects.toThrow(/network_edge_not_found/);
    await expect(listNetworkEdges(OTHER)).resolves.toHaveLength(0);
    await expect(recordServiceCall(USER, { from: '', to: 'billing' })).rejects.toThrow(/source service/);
    await expect(recordServiceCall(USER, { from: 'gateway', to: '' })).rejects.toThrow(/destination service/);
  });
});