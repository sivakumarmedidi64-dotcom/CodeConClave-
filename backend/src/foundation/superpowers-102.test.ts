/**
 * CodeConClave — Stage 102 SUPERPOWERS Tranche X: Incident Orchestrator, Network
 * Policy Enforcer, Framework Bridge, Language Ferry, Monolith Surgeon.
 *
 *   INCIDENT ORCHESTRATOR (#97)  — log spike → agent investigates → postmortem drafted → candidate fix PR.
 *   NETWORK POLICY ENFORCER (#98)— every network call from agents runs against a policy.
 *   FRAMEWORK BRIDGE (#99)      — incremental framework migration while keeping app shippable.
 *   LANGUAGE FERRY (#100)       — cross-language rewrite with behavioral test harnesses.
 *   MONOLITH SURGEON (#101)     — extracts services from monoliths, identifies cleanest cut line.
 *
 * DB/audit/ids are mocked; all logic runs real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => {
  let tick = Date.now();
  const tables = {
    incident_orch_runs: [] as Array<Record<string, unknown>>,
    network_policies: [] as Array<Record<string, unknown>>,
    framework_bridges: [] as Array<Record<string, unknown>>,
    language_ferries: [] as Array<Record<string, unknown>>,
    monolith_surgeries: [] as Array<Record<string, unknown>>,
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
    INCIDENT_ORCH_RUN: 'ior',
    NETWORK_POLICY: 'npe',
    FRAMEWORK_BRIDGE: 'fbk',
    LANGUAGE_FERRY: 'lfy',
    MONOLITH_SURGEON: 'msn',
  },
  newId: (p: string) => `${p}-${mark.next()}`,
}));

import { triggerIncident, draftPostmortem, proposeFix, getIncidentOrchRun, listIncidentOrchRuns, incidentOrchReport } from '../modules/superpowers/incidentOrchestrator.js';
import { createNetworkPolicy, auditNetworkCall, getNetworkPolicy, listNetworkPolicies, networkPolicyReport } from '../modules/superpowers/networkPolicyEnforcer.js';
import { planBridge, applyStep, verifyBridge, getFrameworkBridge, listFrameworkBridges, frameworkBridgeReport } from '../modules/superpowers/frameworkBridge.js';
import { planFerry, verifyFerryRun, getLanguageFerry, listLanguageFerries, languageFerryReport } from '../modules/superpowers/languageFerry.js';
import { planCut, extractService, getMonolithSurgeon, listMonolithSurgeries, monolithSurgeonReport } from '../modules/superpowers/monolithSurgeon.js';

const USER = 'user-1';
const OTHER = 'user-2';

const cleartables = () => {
  for (const t of Object.values(store.tables)) t.length = 0;
  recordAuditMock.mockClear();
};

const AUDIT_ACTIONS = () => recordAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action);

describe('INCIDENT ORCHESTRATOR (#97)', () => {
  beforeEach(() => { cleartables(); });

  it('triggers an incident, drafts postmortem, and proposes a fix', async () => {
    const run = await triggerIncident(USER, { incident: 'database connection pool exhaustion', log_spike: 'ERROR pool exhausted at 14:03:22' });
    expect(run.id).toMatch(/^ior-/);
    expect(run.incident).toBe('database connection pool exhaustion');
    expect(run.status).toBe('INVESTIGATING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.incident_orch_triggered');

    const postmortem = await draftPostmortem(USER, run.id, { findings: 'Connection leak in billing worker after deploy #421' });
    expect(postmortem.status).toBe('POSTMORTEM_DRAFTED');
    expect(postmortem.postmortem_draft).toContain('Connection leak');
    expect(AUDIT_ACTIONS()).toContain('autonomy.incident_postmortem_drafted');

    const fixed = await proposeFix(USER, run.id, { fix_pr_url: 'https://github.com/acme/app/pull/422' });
    expect(fixed.status).toBe('FIX_PROPOSED');
    expect(fixed.fix_pr_url).toContain('pull/422');
    expect(AUDIT_ACTIONS()).toContain('autonomy.incident_fix_proposed');
  });

  it('reports incident run totals', async () => {
    await triggerIncident(USER, { incident: 'OOM crash', log_spike: 'SIGKILL at 02:00' });
    const r2 = await triggerIncident(USER, { incident: 'disk full', log_spike: 'No space left on device' });
    await draftPostmortem(USER, r2.id, { findings: 'Logs filled disk' });

    const report = await incidentOrchReport(USER);
    expect(report.runs).toBe(2);
    expect(report.investigating).toBe(1);
    expect(report.postmortem_drafted).toBe(1);
    expect(report.fix_proposed).toBe(0);
  });

  it('validates and stays owner-scoped', async () => {
    const run = await triggerIncident(USER, { incident: 'crash', log_spike: 'segfault' });
    await expect(getIncidentOrchRun(OTHER, run.id)).rejects.toThrow(/incident_orch_run_not_found/);
    await expect(listIncidentOrchRuns(OTHER)).resolves.toHaveLength(0);
    await expect(triggerIncident(USER, { incident: '', log_spike: 'spike' })).rejects.toThrow(/incident name is required/);
    await expect(triggerIncident(USER, { incident: 'crash', log_spike: '' })).rejects.toThrow(/log spike data is required/);
  });
});

describe('NETWORK POLICY ENFORCER (#98)', () => {
  beforeEach(() => { cleartables(); });

  it('creates a policy and audits network calls against the allowlist', async () => {
    const policy = await createNetworkPolicy(USER, { agent_name: 'data-fetcher', allowed_domains: ['api.example.com', 'cdn.example.com'], rate_limit: 5 });
    expect(policy.id).toMatch(/^npe-/);
    expect(policy.agent_name).toBe('data-fetcher');
    expect(policy.allowed_domains).toEqual(['api.example.com', 'cdn.example.com']);
    expect(policy.rate_limit).toBe(5);
    expect(policy.calls_made).toBe(0);
    expect(policy.status).toBe('ACTIVE');
    expect(AUDIT_ACTIONS()).toContain('autonomy.network_policy_created');

    const after = await auditNetworkCall(USER, policy.id, { domain: 'api.example.com' });
    expect(after.calls_made).toBe(1);
    expect(AUDIT_ACTIONS()).toContain('autonomy.network_call_audited');

    await auditNetworkCall(USER, policy.id, { domain: 'cdn.example.com' });
    await auditNetworkCall(USER, policy.id, { domain: 'api.example.com' });
    await auditNetworkCall(USER, policy.id, { domain: 'cdn.example.com' });
    const full = await auditNetworkCall(USER, policy.id, { domain: 'api.example.com' });
    expect(full.calls_made).toBe(5);
    expect(full.status).toBe('EXHAUSTED');
    await expect(auditNetworkCall(USER, policy.id, { domain: 'api.example.com' })).rejects.toThrow(/rate limit/);
  });

  it('blocks calls to disallowed domains', async () => {
    const policy = await createNetworkPolicy(USER, { agent_name: 'webhook', allowed_domains: ['hooks.slack.com'], rate_limit: 10 });
    await expect(auditNetworkCall(USER, policy.id, { domain: 'evil.com' })).rejects.toThrow(/not in the allowlist/);
  });

  it('reports network policy totals', async () => {
    await createNetworkPolicy(USER, { agent_name: 'a', allowed_domains: ['x.com'], rate_limit: 3 });
    const b = await createNetworkPolicy(USER, { agent_name: 'b', allowed_domains: ['y.com'], rate_limit: 2 });
    await auditNetworkCall(USER, b.id, { domain: 'y.com' });
    await auditNetworkCall(USER, b.id, { domain: 'y.com' });

    const report = await networkPolicyReport(USER);
    expect(report.policies).toBe(2);
    expect(report.active).toBe(1);
    expect(report.exhausted).toBe(1);
    expect(report.total_calls).toBe(2);
  });

  it('validates and stays owner-scoped', async () => {
    const p = await createNetworkPolicy(USER, { agent_name: 'a', allowed_domains: ['x.com'], rate_limit: 10 });
    await expect(getNetworkPolicy(OTHER, p.id)).rejects.toThrow(/network_policy_not_found/);
    await expect(listNetworkPolicies(OTHER)).resolves.toHaveLength(0);
    await expect(createNetworkPolicy(USER, { agent_name: '', allowed_domains: ['x.com'], rate_limit: 10 })).rejects.toThrow(/agent name is required/);
    await expect(createNetworkPolicy(USER, { agent_name: 'a', allowed_domains: [], rate_limit: 10 })).rejects.toThrow(/at least one allowed domain/);
    await expect(createNetworkPolicy(USER, { agent_name: 'a', allowed_domains: ['x.com'], rate_limit: 0 })).rejects.toThrow(/rate limit must be a positive number/);
  });
});

describe('FRAMEWORK BRIDGE (#99)', () => {
  beforeEach(() => { cleartables(); });

  it('plans a bridge, applies steps one by one, and verifies', async () => {
    const bridge = await planBridge(USER, { source_framework: 'AngularJS', target_framework: 'React', steps: ['wrap directives', 'port routing', 'remove angular'] });
    expect(bridge.id).toMatch(/^fbk-/);
    expect(bridge.steps).toHaveLength(3);
    expect(bridge.steps_applied).toBe(0);
    expect(bridge.status).toBe('PLANNED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.bridge_planned');

    const s1 = await applyStep(USER, bridge.id);
    expect(s1.steps_applied).toBe(1);
    expect(s1.status).toBe('APPLYING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.bridge_step_applied');

    const s2 = await applyStep(USER, bridge.id);
    expect(s2.steps_applied).toBe(2);
    const s3 = await applyStep(USER, bridge.id);
    expect(s3.steps_applied).toBe(3);
    expect(s3.status).toBe('READY');

    const verified = await verifyBridge(USER, bridge.id);
    expect(verified.status).toBe('VERIFIED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.bridge_verified');
    await expect(verifyBridge(USER, bridge.id)).rejects.toThrow(/already verified/);
  });

  it('reports bridge totals', async () => {
    const b1 = await planBridge(USER, { source_framework: 'Vue', target_framework: 'Svelte', steps: ['migrate components'] });
    await applyStep(USER, b1.id);
    await verifyBridge(USER, b1.id);
    const b2 = await planBridge(USER, { source_framework: 'jQuery', target_framework: 'React', steps: ['replace dom', 'add routing'] });

    const report = await frameworkBridgeReport(USER);
    expect(report.bridges).toBe(2);
    expect(report.planned).toBe(1);
    expect(report.verified).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const b = await planBridge(USER, { source_framework: 'A', target_framework: 'B', steps: ['s1'] });
    await expect(getFrameworkBridge(OTHER, b.id)).rejects.toThrow(/framework_bridge_not_found/);
    await expect(listFrameworkBridges(OTHER)).resolves.toHaveLength(0);
    await expect(planBridge(USER, { source_framework: '', target_framework: 'B', steps: ['s1'] })).rejects.toThrow(/source framework is required/);
    await expect(planBridge(USER, { source_framework: 'A', target_framework: '', steps: ['s1'] })).rejects.toThrow(/target framework is required/);
    await expect(planBridge(USER, { source_framework: 'A', target_framework: 'B', steps: [] })).rejects.toThrow(/at least one migration step/);
  });
});

describe('LANGUAGE FERRY (#100)', () => {
  beforeEach(() => { cleartables(); });

  it('plans a ferry, verifies with all tests passing', async () => {
    const ferry = await planFerry(USER, {
      source_language: 'Python', target_language: 'Rust',
      source_code: 'def add(a,b): return a+b',
      test_harness: [{ name: 'add positive', input: '1,2', expected: '3' }, { name: 'add zero', input: '0,0', expected: '0' }],
    });
    expect(ferry.id).toMatch(/^lfy-/);
    expect(ferry.source_language).toBe('Python');
    expect(ferry.target_language).toBe('Rust');
    expect(ferry.total_tests).toBe(2);
    expect(ferry.tests_passed).toBe(0);
    expect(ferry.status).toBe('PLANNED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.ferry_planned');

    const verified = await verifyFerryRun(USER, ferry.id, { tests_passed: 2, target_code: 'fn add(a: i32, b: i32) -> i32 { a + b }' });
    expect(verified.status).toBe('VERIFIED');
    expect(verified.tests_passed).toBe(2);
    expect(verified.target_code).toContain('fn add');
    expect(AUDIT_ACTIONS()).toContain('autonomy.ferry_run_verified');
  });

  it('reports ferry totals', async () => {
    const f1 = await planFerry(USER, { source_language: 'JS', target_language: 'TS', source_code: 'x', test_harness: [{ name: 't1', input: '', expected: '' }] });
    const f2 = await planFerry(USER, { source_language: 'Ruby', target_language: 'Go', source_code: 'y', test_harness: [{ name: 'a', input: '', expected: '' }, { name: 'b', input: '', expected: '' }] });
    await verifyFerryRun(USER, f1.id, { tests_passed: 1, target_code: 'ok' });

    const report = await languageFerryReport(USER);
    expect(report.ferries).toBe(2);
    expect(report.verified).toBe(1);
    expect(report.total_tests).toBe(3);
  });

  it('validates and stays owner-scoped', async () => {
    const f = await planFerry(USER, { source_language: 'Python', target_language: 'Rust', source_code: 'x', test_harness: [{ name: 't', input: '', expected: '' }] });
    await expect(getLanguageFerry(OTHER, f.id)).rejects.toThrow(/language_ferry_not_found/);
    await expect(listLanguageFerries(OTHER)).resolves.toHaveLength(0);
    await expect(planFerry(USER, { source_language: '', target_language: 'Rust', source_code: 'x', test_harness: [{ name: 't', input: '', expected: '' }] })).rejects.toThrow(/source language is required/);
    await expect(planFerry(USER, { source_language: 'Python', target_language: '', source_code: 'x', test_harness: [{ name: 't', input: '', expected: '' }] })).rejects.toThrow(/target language is required/);
    await expect(planFerry(USER, { source_language: 'Python', target_language: 'Rust', source_code: '', test_harness: [{ name: 't', input: '', expected: '' }] })).rejects.toThrow(/source code is required/);
  });
});

describe('MONOLITH SURGEON (#101)', () => {
  beforeEach(() => { cleartables(); });

  it('plans a cut, extracts services one by one, and finishes', async () => {
    const surgery = await planCut(USER, { monolith_name: 'legacy-app', cut_line: 'auth boundary', services: ['auth-service', 'user-service', 'billing-service'] });
    expect(surgery.id).toMatch(/^msn-/);
    expect(surgery.monolith_name).toBe('legacy-app');
    expect(surgery.cut_line).toBe('auth boundary');
    expect(surgery.services).toEqual(['auth-service', 'user-service', 'billing-service']);
    expect(surgery.services_extracted).toBe(0);
    expect(surgery.status).toBe('PLANNED');
    expect(AUDIT_ACTIONS()).toContain('autonomy.surgeon_cut_planned');

    const e1 = await extractService(USER, surgery.id, { service_name: 'auth-service' });
    expect(e1.services_extracted).toBe(1);
    expect(e1.status).toBe('EXTRACTING');
    expect(AUDIT_ACTIONS()).toContain('autonomy.surgeon_service_extracted');

    const e2 = await extractService(USER, surgery.id, { service_name: 'user-service' });
    expect(e2.services_extracted).toBe(2);
    const e3 = await extractService(USER, surgery.id, { service_name: 'billing-service' });
    expect(e3.services_extracted).toBe(3);
    expect(e3.status).toBe('DONE');
    await expect(extractService(USER, surgery.id, { service_name: 'x' })).rejects.toThrow(/all services have already been extracted/);
  });

  it('reports surgery totals', async () => {
    const s1 = await planCut(USER, { monolith_name: 'app', cut_line: 'db', services: ['svc-a'] });
    const s2 = await planCut(USER, { monolith_name: 'app2', cut_line: 'api', services: ['svc-b', 'svc-c'] });
    await extractService(USER, s1.id, { service_name: 'svc-a' });

    const report = await monolithSurgeonReport(USER);
    expect(report.surgeries).toBe(2);
    expect(report.done).toBe(1);
    expect(report.extracting).toBe(0);
    expect(report.planned).toBe(1);
  });

  it('validates and stays owner-scoped', async () => {
    const s = await planCut(USER, { monolith_name: 'app', cut_line: 'line', services: ['svc'] });
    await expect(getMonolithSurgeon(OTHER, s.id)).rejects.toThrow(/monolith_surgeon_not_found/);
    await expect(listMonolithSurgeries(OTHER)).resolves.toHaveLength(0);
    await expect(planCut(USER, { monolith_name: '', cut_line: 'line', services: ['svc'] })).rejects.toThrow(/monolith name is required/);
    await expect(planCut(USER, { monolith_name: 'app', cut_line: '', services: ['svc'] })).rejects.toThrow(/cut line description is required/);
    await expect(planCut(USER, { monolith_name: 'app', cut_line: 'line', services: [] })).rejects.toThrow(/at least one service/);
  });
});
