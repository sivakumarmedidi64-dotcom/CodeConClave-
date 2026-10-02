/**
 * Stage 26F — Engineering Agent Swarm contract suite.
 * Covers: PR Review Swarm (multi-agent independent findings, verified
 * file/line locations, partial agent failure, honest review_unavailable
 * fallback, finding decisions), Dependency Upgrade Agent (one dependency at
 * a time, ordered step machine, rollback with reason, accept/fail),
 * Flaky Test Hunter (deterministic classification, investigation tasks that
 * never delete/skip tests, resolve lifecycle), Self-Healing CI (failure
 * intake + log diagnosis, fix proposal, approval gate for HIGH-risk fixes,
 * approval/rejection, retest, destructive-merge refusal), tenant isolation
 * and audit integrity throughout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    tables: Record<string, Array<Record<string, unknown>>>;
  } = {
    tables: {
      tasks: [], projects: [], task_attempts: [], task_steps: [], task_dependencies: [],
      approvals: [], plans: [], plan_entries: [], task_dlq: [],
      automation_rules: [], automation_runs: [], event_log: [], escalations: [], workflow_recipes: [],
      review_swarms: [], review_findings: [], dependency_upgrades: [], flake_records: [], ci_runs: [],
    },
  };
  const T = state.tables;

  const JSONB = new Set([
    'coworker_pipeline', 'plan', 'detail', 'checkpoint', 'input', 'timeline', 'attempts',
    'errors', 'dependency_state', 'recovery_attempts', 'successful_fix', 'prevention',
    'evidence', 'conditions', 'actions', 'result', 'payload', 'template', 'metadata',
    'roles', 'files', 'verdict', 'diff', 'analysis', 'diagnosis', 'fix_proposal',
    'proposed_action', 'justification', 'affected_resources', 'execution_state',
  ]);

  let clock = 0;
  const nowIso = () => new Date(Date.now() + ++clock).toISOString();

  const hydrate = (row: Record<string, unknown>) => {
    for (const k of Object.keys(row)) {
      if (JSONB.has(k) && typeof row[k] === 'string') {
        try { row[k] = JSON.parse(row[k]); } catch { row[k] = {}; }
      }
    }
    return row;
  };

  const applySet = (setText: string, params: unknown[], row: Record<string, unknown>) => {
    const set = setText.replace(/COALESCE\(\$(\d+),\s*\w+\)/g, (_, n: string) => `$${n}`);
    for (const [, k, expr] of [...set.matchAll(/(\w+)\s*=\s*([^,]+)/g)]) {
      const m = /\$(\d+)/.exec(expr ?? '');
      if (m) {
        row[k!] = params[Number(m[1]) - 1];
        continue;
      }
      const flat = (expr ?? '').replace(/\s+/g, ' ');
      if (flat.startsWith('now()')) row[k!] = nowIso();
      else if (flat.includes('+ 1')) row[k!] = Number(row[k!] ?? 0) + 1;
      else if (flat.includes('||')) {
        const bm = /\$(\d+)/.exec(expr ?? '');
        row[k!] = bm ? new Date(Date.now() + Number(params[Number(bm[1]) - 1])).toISOString() : row[k!];
      } else if (flat.startsWith('COALESCE')) row[k!] = row[k!];
      else {
        const lit = flat.replace(/^'|'$/g, '');
        if (lit === 'NULL') row[k!] = null;
        else if (lit === 'true') row[k!] = true;
        else if (lit === 'false') row[k!] = false;
        else if (/^-?\d+(\.\d+)?$/.test(lit)) row[k!] = Number(lit);
        else row[k!] = lit;
      }
    }
    hydrate(row);
  };

  const matchWhere = (where: string, row: Record<string, unknown>, params: unknown[]) => {
    for (let raw of where.split(' AND ')) {
      raw = raw.trim();
      let m = /^(\w+)\s*=\s*\$(\d+)$/.exec(raw);
      if (m) { if (String(row[m[1]] ?? '') !== String(params[Number(m[2]) - 1] ?? '')) return false; continue; }
      m = /^(\w+)\s*<>\s*\$(\d+)$/.exec(raw);
      if (m) { if (String(row[m[1]] ?? '') === String(params[Number(m[2]) - 1] ?? '')) return false; continue; }
      m = /^(\w+)\s*=\s*'([^']*)'$/.exec(raw);
      if (m) { if (String(row[m[1]] ?? '') !== m[2]) return false; continue; }
      m = /^(\w+)\s*IS NOT DISTINCT FROM\s*\$(\d+)$/.exec(raw);
      if (m) {
        const a = row[m[1]] == null ? null : String(row[m[1]]);
        const b = params[Number(m[2]) - 1] == null ? null : String(params[Number(m[2]) - 1]);
        if (a !== b) return false;
        continue;
      }
      m = /^(\w+)\s*IS NOT NULL$/.exec(raw);
      if (m) { if (row[m[1]] == null) return false; continue; }
      m = /^(\w+)\s*IS NULL$/.exec(raw);
      if (m) { if (row[m[1]] != null) return false; continue; }
      m = /^(\w+)\s*=\s*ANY\(\$(\d+)::text\[\]\)$/.exec(raw);
      if (m) {
        const list = params[Number(m[2]) - 1];
        if (!Array.isArray(list) || !list.includes(String(row[m[1]] ?? ''))) return false;
        continue;
      }
      m = /^(\w+)\s*IN\s*\(([^)]*)\)$/.exec(raw);
      if (m) {
        const list = m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
        if (!list.includes(String(row[m[1]] ?? ''))) return false;
        continue;
      }
      // unknown condition: ignored (lenient)
    }
    return true;
  };

  const sortRows = (rows: Array<Record<string, unknown>>, orderBy: string) => {
    const parts = orderBy.split(',').map((p) => p.trim());
    return [...rows].sort((a, b) => {
      for (const part of parts) {
        const [col, dir] = part.split(/\s+/);
        const av = a[col];
        const bv = b[col];
        let cmp = 0;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  };

  const query = async (rawText: string, params: unknown[] = []) => {
    const text = rawText.replace(/\s+/g, ' ').trim();
    let rows: Array<Record<string, unknown>> = [];

    // ---------------- INSERT ----------------
    const ins = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)$/.exec(text);
    if (ins) {
      if (!T[ins[1]]) return { rows: [], rowCount: 0 };
      const cols = ins[2].split(',').map((s) => s.trim());
      const vals = ins[3].split(',').map((s) => s.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const v = vals[i] ?? '';
        const m = /^\$(\d+)/.exec(v);
        if (m) row[c] = params[Number(m[1]) - 1];
        else {
const lit = v.replace(/^'|'$/g, '');
        if (lit === 'now()') row[c] = nowIso();
        else if (lit.startsWith('now() +')) row[c] = new Date(Date.now() + 3_600_000);
        else if (lit === 'true') row[c] = true;
          else if (lit === 'false') row[c] = false;
          else if (/^-?\d+(\.\d+)?$/.test(lit)) row[c] = Number(lit);
          else row[c] = lit;
        }
      });
      hydrate(row);
      const now = nowIso();
      const DEFAULTS: Record<string, Record<string, unknown>> = {
        review_swarms: { created_at: now, updated_at: now },
        review_findings: { created_at: now, status: 'OPEN' },
        dependency_upgrades: { created_at: now, updated_at: now },
        flake_records: { created_at: now, updated_at: now },
        ci_runs: { created_at: now, updated_at: now },
      };
      for (const [k, v] of Object.entries(DEFAULTS[ins[1]] ?? {})) {
        if (row[k] === undefined) row[k] = v;
      }
      if (text.includes('ON CONFLICT DO NOTHING')) {
        const dup = T[ins[1]].some((r) =>
          Object.entries(row).every(([k, v]) => r[k] === v),
        );
        if (dup) rows = [];
        else { T[ins[1]].push(row); rows = [row]; }
      } else {
        T[ins[1]].push(row);
        rows = [row];
      }
      return { rows, rowCount: rows.length };
    }

    // ---------------- UPDATE ----------------
    if (text.startsWith('UPDATE ')) {
const table = /^UPDATE (\w+)/.exec(text)![1];
      const whereIdx = text.indexOf(' WHERE ');
      const setStart = text.indexOf('SET ') + 4;
      const setText = text.slice(setStart, whereIdx >= 0 ? whereIdx : undefined);
      const where = whereIdx >= 0 ? text.slice(whereIdx + 7) : '';
      const tbl = T[table];
      if (!tbl) return { rows: [], rowCount: 0 };
      const matches = tbl.filter((r) => matchWhere(where, r, params));
      for (const row of matches) applySet(setText, params, row);
      return { rows: matches, rowCount: matches.length };
    }

    // ---------------- SELECT: COUNT ----------------
    const cnt = /^SELECT COUNT\(\*\)::int AS (\w+) FROM (\w+) WHERE (.+)$/.exec(text);
    if (cnt) {
      const cntTbl = T[cnt[2]];
      const n = (cntTbl ?? []).filter((r) => matchWhere(cnt[3], r, params)).length;
      return { rows: [{ [cnt[1]]: n }], rowCount: 1 };
    }

    // ---------------- SELECT (generic) ----------------
    let rest = text;
    let limit: number | null = null;
    const limitM = / LIMIT (\d+)$/.exec(rest);
    if (limitM) { rest = rest.slice(0, limitM.index); limit = Number(limitM[1]); }
    let orderBy: string | null = null;
    const orderM = / ORDER BY (.+)$/.exec(rest);
    if (orderM) { rest = rest.slice(0, orderM.index); orderBy = orderM[1]; }
    const sel = /^SELECT .+? FROM (\w+) WHERE (.+)$/.exec(rest);
    if (sel) {
      const selTbl = T[sel[1]];
      rows = (selTbl ?? []).filter((r) => matchWhere(sel[2], r, params));
    } else {
      const selAll = /^SELECT .+? FROM (\w+)$/.exec(rest);
      if (selAll) { const allTbl = T[selAll[1]]; rows = allTbl ? [...allTbl] : []; }
    }
    if (orderBy) rows = sortRows(rows, orderBy);
    if (limit != null) rows = rows.slice(0, limit);
    return { rows, rowCount: rows.length };
  };

  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withTenant: async (_u: string, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

const notify = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));
vi.mock('../modules/notifications/service.js', () => notify);

const agents = vi.hoisted(() => ({
  cancelRun: vi.fn(async () => {}),
  agentTaskChanged: vi.fn(async () => {}),
}));
vi.mock('../modules/agents/service.js', () => agents);

const teams = vi.hoisted(() => ({ notifyTeamMembersAbout: vi.fn(async () => {}) }));
vi.mock('../modules/teams/service.js', () => teams);

const memory = vi.hoisted(() => ({ createMemory: vi.fn(async () => ({ id: 'mem-1' })) }));
vi.mock('../modules/memory/service.js', () => memory);

const dna = vi.hoisted(() => ({ saveDna: vi.fn(async () => ({ id: 'dna-1' })), autoSaveTaskDna: vi.fn(async () => {}) }));
vi.mock('../modules/dna/service.js', () => dna);

const entitlements = vi.hoisted(() => ({ effectivePlan: vi.fn(async () => 'free') }));
vi.mock('../modules/entitlements/service.js', () => entitlements);

const gateway = vi.hoisted(() => ({
  completeWithFallback: vi.fn(async () => ({
    text: '{"findings":[]}',
    modelId: 'm-test',
    providerId: 'p-test',
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 1,
    usedFallback: false,
    fallbackReason: null,
  })),
}));
vi.mock('../modules/ai/gateway.js', () => gateway);

import { createTask, type TaskRow } from '../modules/execution/tasks.js';
import { startPrReview, runPrReview, getSwarm, listSwarms, listSwarmFindings, decideFinding } from '../modules/engineering/prReview.js';
import { startUpgrade, stepUpgrade, acceptUpgrade, rollbackUpgrade, failUpgrade, getUpgrade, listUpgrades } from '../modules/engineering/dependencyUpgrade.js';
import { analyzeTestRuns, createInvestigationTask, markFlakeResolved, getFlake, listFlakes } from '../modules/engineering/flakeHunter.js';
import { recordCiFailure, proposeCiFix, applyCiFix, decideCiFixApproval, recordRetest, getCiRun, listCiRuns } from '../modules/engineering/selfHealingCi.js';
import { AppError } from '../shared/errors.js';

const T = () => db.state.tables;
const USER = 'user-1';
const OTHER = 'user-2';
const PROJECT = 'prj-1';

function seedTask(over: Partial<Record<string, unknown>> = {}, owner = USER): Record<string, unknown> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    id: `tsk-${T().tasks.length + 1}`,
    project_id: PROJECT,
    conversation_id: null,
    owner_id: owner,
    title: 'Task',
    description: null,
    plan: null,
    status: 'CREATED',
    risk_level: 'MEDIUM',
    required_approval: false,
    approval_id: null,
    coworker_pipeline: null,
    execution_mode: 'CLOUD',
    timeout_ms: 900000,
    started_at: null,
    completed_at: null,
    failed_at: null,
    error_code: null,
    error_detail: null,
    attempt_count: 0,
    max_attempts: 3,
    last_heartbeat_at: null,
    watchdog_checked_at: null,
    priority: 0,
    failure_reason: null,
    recovery_status: 'NONE',
    retry_count: 0,
    next_attempt_at: null,
    dead_letter_at: null,
    requires_review_reason: null,
    agent_run_id: null,
    created_at: now,
    updated_at: now,
  };
  Object.assign(row, over);
  T().tasks.push(row);
  return row;
}

function seedProject(): void {
  if (!T().projects.some((p) => p.id === PROJECT)) {
    T().projects.push({ id: PROJECT, owner_id: USER, team_id: null, deleted_at: null });
  }
}

function auditActions(): string[] {
  return audit.recordAudit.mock.calls.map((c) => String((c[0] as { action: string }).action));
}

function notifyTypes(): string[] {
  return notify.notify.mock.calls.map((c) => String(c[1]));
}

function gatewayText(text: string): void {
  gateway.completeWithFallback.mockResolvedValue({
    text,
    modelId: 'm-test',
    providerId: 'p-test',
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 1,
    usedFallback: false,
    fallbackReason: null,
  });
}

function gatewayMessages(): string[] {
  return gateway.completeWithFallback.mock.calls.map((c) => {
    const messages = (c[0] as { messages?: Array<{ content?: string }> }).messages ?? [];
    return String(messages[0]?.content ?? '');
  });
}

beforeEach(() => {
  for (const table of Object.values(T())) table.length = 0;
  vi.clearAllMocks();
  entitlements.effectivePlan.mockReset().mockResolvedValue('free');
  seedProject();
});

async function rejectsWith(p: Promise<unknown>, code: string, part?: string): Promise<void> {
  try {
    await p;
    throw new Error('expected rejection');
  } catch (e) {
    const err = e as { errorCode?: string; message: string };
    expect(err.errorCode ?? err.message).toBe(code);
    if (part) expect(err.message).toContain(part);
  }
}

function findingJson(role: string, findings: unknown[]): string {
  return JSON.stringify({ findings });
}

describe('PR Review Swarm', () => {
  const files = [
    { path: 'src/api.ts', content: 'export async function handle(req) {\n  const sql = `SELECT * FROM users WHERE id = ${req.query.id}`;\n  return db.query(sql);\n}\n' },
    { path: 'src/util.ts', content: 'export function parse(x) {\n  return JSON.parse(x);\n}\n' },
  ];

  function roleFromCall(opts: unknown): string {
    const content = String((opts as { messages?: Array<{ content?: string }> }).messages?.[0]?.content ?? '');
    return ['ARCHITECT', 'REVIEWER', 'SECURITY', 'TESTER'].find((r) => content.includes(`You are the ${r} reviewer`)) ?? 'ARCHITECT';
  }

  function mockPerRole(findingsFor: (role: string) => unknown[]): void {
    gateway.completeWithFallback.mockImplementation(async (opts) => {
      const role = roleFromCall(opts);
      return {
        text: findingJson(role, findingsFor(role)),
        modelId: 'm-test', providerId: 'p-test', inputTokens: 0, outputTokens: 0,
        estimatedCostUsd: 0, durationMs: 1, usedFallback: false, fallbackReason: null,
      };
    });
  }

  it('runs a full multi-agent review: four independent roles, verified locations, verdict, audit, notify, memory', async () => {
    mockPerRole((role) => [
      {
        role,
        severity: role === 'SECURITY' ? 'HIGH' : 'MEDIUM',
        category: 'security', title: `${role} finding`, description: `${role} found an issue`,
        file_path: 'src/api.ts', line_start: 2, line_end: 2,
        evidence: ['evidence-a'], confidence: 0.9,
        recommendation: 'fix it',
      },
      { role, severity: 'INFO', category: 'style', title: 'nit', description: 'minor nit', file_path: null, line_start: null, line_end: null, evidence: [], confidence: 0.3, recommendation: null },
    ]);

    const swarm = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-1', title: 'Add endpoint', files });
    expect(swarm.status).toBe('PENDING');
    expect(swarm.roles).toEqual(['ARCHITECT', 'REVIEWER', 'SECURITY', 'TESTER']);
    expect(swarm.files).toHaveLength(2);
    expect(T().tasks.length).toBe(1);
    expect(auditActions()).toContain('pr_review.started');

    const done = await runPrReview(USER, swarm.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.verdict).toMatchObject({ rolesDone: 4, rolesFailed: 0, findings: 8 });

    const findings = await listSwarmFindings(USER, swarm.id);
    expect(findings).toHaveLength(8);
    expect(new Set(findings.map((f) => f.role))).toEqual(new Set(['ARCHITECT', 'REVIEWER', 'SECURITY', 'TESTER']));
    expect(findings.every((f) => f.status === 'OPEN')).toBe(true);
    const security = findings.find((f) => f.role === 'SECURITY' && f.severity === 'HIGH');
    expect(security?.file_path).toBe('src/api.ts');
    expect(security?.line_start).toBe(2);
    expect(security?.evidence).toEqual(['evidence-a']);

    expect(gateway.completeWithFallback).toHaveBeenCalledTimes(4);
    const ctxs = gateway.completeWithFallback.mock.calls.map((c) => (c[0] as { ctx: Record<string, unknown> }).ctx);
    expect(ctxs.every((c) => c.planId === 'free')).toBe(true);
    expect(auditActions()).toEqual(expect.arrayContaining(['pr_review.started', 'pr_review.completed']));
    expect(notifyTypes()).toContain('pr_review.completed');
    expect(memory.createMemory).toHaveBeenCalledTimes(1);
    expect(String((memory.createMemory.mock.calls[0][1] as { content: string }).content)).toContain('PR-1');
  });

  it('records a failing role without hiding the others (PARTIAL + role_failed finding + audit)', async () => {
    gateway.completeWithFallback.mockImplementation(async (opts) => {
      const role = roleFromCall(opts);
      if (role === 'SECURITY') throw new Error('provider 503');
      return { text: findingJson(role, [{ role, severity: 'LOW', category: 'perf', title: `${role} note`, description: 'note', file_path: null, line_start: null, line_end: null, evidence: [], confidence: 0.5, recommendation: null }]), modelId: 'm', providerId: 'p', inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, durationMs: 1, usedFallback: false, fallbackReason: null };
    });
    const swarm = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-2', files });
    const done = await runPrReview(USER, swarm.id);
    expect(done.status).toBe('PARTIAL');
    expect(done.verdict).toMatchObject({ rolesDone: 3, rolesFailed: 1, findings: 4 });
    const findings = await listSwarmFindings(USER, swarm.id);
    const failed = findings.find((f) => f.category === 'review_failed');
    expect(failed?.role).toBe('SECURITY');
    expect(failed?.severity).toBe('INFO');
    expect(findings.filter((f) => f.role === 'ARCHITECT').length).toBe(1);
    expect(auditActions()).toContain('pr_review.role_failed');
  });

  it('marks the swarm FAILED when every role fails', async () => {
    gateway.completeWithFallback.mockRejectedValue(new Error('all providers down'));
    const swarm = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-3', files });
    const done = await runPrReview(USER, swarm.id);
    expect(done.status).toBe('FAILED');
    expect(done.verdict).toMatchObject({ rolesDone: 0, rolesFailed: 4, findings: 4 });
  });

  it('drops unverifiable file/line locations; keeps verified ones', async () => {
    gatewayText(findingJson('ARCHITECT', [
      { role: 'ARCHITECT', severity: 'MEDIUM', category: 'x', title: 'ghost location', description: 'points at missing file', file_path: 'missing.ts', line_start: 999, line_end: 999, evidence: [], confidence: 0.9, recommendation: null },
      { role: 'ARCHITECT', severity: 'LOW', category: 'y', title: 'real location', description: 'verified', file_path: 'src/api.ts', line_start: 1, line_end: 3, evidence: [], confidence: 0.7, recommendation: null },
    ]));
const swarm = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-4', files });
    await runPrReview(USER, swarm.id);
    const findings = await listSwarmFindings(USER, swarm.id);
    expect(findings).toHaveLength(8);
    const ghost = findings.find((f) => f.title === 'ghost location');
    expect(ghost?.file_path).toBeNull();
    expect(ghost?.line_start).toBeNull();
    const real = findings.find((f) => f.title === 'real location');
    expect(real?.file_path).toBe('src/api.ts');
    expect(real?.line_start).toBe(1);
    expect(real?.line_end).toBe(3);
  });

  it('produces honest review_unavailable findings when the provider returns no parseable findings', async () => {
    gatewayText('Sorry, I could not process this pull request.');
    const swarm = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-5', files });
    const done = await runPrReview(USER, swarm.id);
    expect(done.status).toBe('COMPLETED');
    const findings = await listSwarmFindings(USER, swarm.id);
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.category === 'review_unavailable' && f.confidence === 0 && f.severity === 'INFO')).toBe(true);
  });

  it('validates input and guards re-runs', async () => {
    await rejectsWith(startPrReview(USER, { projectId: PROJECT, prRef: 'PR-6', files: [] }), 'pr_review_invalid_input');
    const manyFiles = Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.ts`, content: 'x' }));
    await rejectsWith(startPrReview(USER, { projectId: PROJECT, prRef: 'PR-7', files: manyFiles }), 'pr_review_too_many_files');
    gatewayText(findingJson('ARCHITECT', []));
    const swarm = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-8', files });
    await runPrReview(USER, swarm.id);
    await rejectsWith(runPrReview(USER, swarm.id), 'pr_review_not_runnable');
  });

  it('accepts or dismisses OPEN findings once; other tenants cannot see swarms or findings', async () => {
    gatewayText(findingJson('ARCHITECT', [{ role: 'ARCHITECT', severity: 'HIGH', category: 'c', title: 'the finding', description: 'd', file_path: null, line_start: null, line_end: null, evidence: [], confidence: 0.8, recommendation: null }]));
    const swarm = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-9', files });
    await runPrReview(USER, swarm.id);
    const [f] = await listSwarmFindings(USER, swarm.id);

const accepted = await decideFinding(USER, f.id, 'ACCEPTED');
    expect(accepted.status).toBe('ACCEPTED');
    expect(auditActions()).toContain('finding.accepted');
    await rejectsWith(decideFinding(USER, f.id, 'DISMISSED'), 'finding_not_open');

    const swarm2 = await startPrReview(USER, { projectId: PROJECT, prRef: 'PR-10', files });
    await runPrReview(USER, swarm2.id);
    const [f2] = await listSwarmFindings(USER, swarm2.id);
    const dismissed = await decideFinding(USER, f2.id, 'DISMISSED');
    expect(dismissed.status).toBe('DISMISSED');
    expect(auditActions()).toContain('finding.dismissed');

    await rejectsWith(getSwarm(OTHER, swarm.id), 'not_found');
    await rejectsWith(listSwarmFindings(OTHER, swarm.id), 'not_found');
    await rejectsWith(decideFinding(OTHER, f2.id, 'ACCEPTED'), 'not_found');
    expect(await listSwarms(OTHER)).toEqual([]);
    expect(await listSwarms(USER, PROJECT)).toHaveLength(2);
  });
});

describe('Dependency Upgrade Agent', () => {
  async function start(name: string, user = USER) {
    return startUpgrade(user, {
      projectId: PROJECT, packageName: name, fromVersion: '1.0.0', toVersion: '2.0.0', manifestPath: 'package.json',
    });
  }

  it('walks the ordered state machine and accepts after analysis', async () => {
    const u = await start('lodash');
    expect(u.status).toBe('INSPECTING');
    expect(u.task_id).toBeTruthy();
    const task = T().tasks.find((t) => t.id === u.task_id);
    expect(task?.risk_level).toBe('HIGH');
    expect(task?.required_approval).toBe(true);
    expect(notifyTypes()).toContain('upgrade.approval_required');

    const m = await stepUpgrade(USER, u.id, { step: 'MODIFYING', ok: true, diff: { package_json: 'bump', lockfile: 'new' } });
    expect(m.status).toBe('MODIFYING');
    expect(m.diff).toMatchObject({ package_json: 'bump' });

    const i = await stepUpgrade(USER, u.id, { step: 'INSTALLING', ok: true, output: 'installed 42 packages in 3s' });
    expect(i.status).toBe('INSTALLING');
    expect(i.install_output).toContain('installed 42 packages');

    const t = await stepUpgrade(USER, u.id, { step: 'TESTING', ok: true, output: '312 passed, 0 failed' });
    expect(t.status).toBe('TESTING');
    expect(t.test_summary).toBe('312 passed, 0 failed');

    const b = await stepUpgrade(USER, u.id, { step: 'BUILDING', ok: true, output: 'build ok' });
    expect(b.status).toBe('BUILDING');
    expect(b.build_summary).toBe('build ok');

    const a = await stepUpgrade(USER, u.id, { step: 'ANALYZING', ok: true, output: 'no breaking changes', diff: { verdict: 'safe' } });
    expect(a.status).toBe('ANALYZING');
    expect(a.analysis).toMatchObject({ verdict: 'safe' });

    const acc = await acceptUpgrade(USER, u.id);
    expect(acc.status).toBe('ACCEPTED');
    expect(auditActions()).toEqual(expect.arrayContaining([
      'upgrade.started', 'upgrade.step', 'upgrade.accepted',
    ]));
    expect(auditActions().filter((x) => x === 'upgrade.step')).toHaveLength(5);
  });

  it('refuses a second dependency while one is in flight; rollback frees the slot', async () => {
    const a = await start('react');
    await rejectsWith(start('vue'), 'upgrade_in_flight', 'react');
const rolled = await rollbackUpgrade(USER, a.id, 'breaking peer dependency');
    expect(rolled.status).toBe('ROLLED_BACK');
    expect(rolled.rollback_reason).toBe('breaking peer dependency');
    expect(auditActions()).toContain('upgrade.rolled_back');
    const b = await start('vue');
    expect(b.status).toBe('INSPECTING');
  });

  it('requires a reason to roll back and only rolls back in-flight upgrades', async () => {
    const a = await start('axios');
    await rejectsWith(rollbackUpgrade(USER, a.id, '   '), 'rollback_reason_required');
    await stepUpgrade(USER, a.id, { step: 'MODIFYING', ok: true, diff: {} });
    await stepUpgrade(USER, a.id, { step: 'INSTALLING', ok: true, output: 'ok' });
    await stepUpgrade(USER, a.id, { step: 'TESTING', ok: true, output: 'all pass' });
    await stepUpgrade(USER, a.id, { step: 'BUILDING', ok: true, output: 'ok' });
    await stepUpgrade(USER, a.id, { step: 'ANALYZING', ok: true, output: 'fine' });
    await acceptUpgrade(USER, a.id);
    await rejectsWith(rollbackUpgrade(USER, a.id, 'too late'), 'upgrade_not_rollbackable');
  });

  it('rejects out-of-order steps and fails the upgrade honestly when a step fails', async () => {
    const a = await start('express');
    await rejectsWith(stepUpgrade(USER, a.id, { step: 'TESTING', ok: true }), 'invalid_upgrade_step');
    await stepUpgrade(USER, a.id, { step: 'MODIFYING', ok: true, diff: {} });
    const failed = await stepUpgrade(USER, a.id, { step: 'INSTALLING', ok: false, output: 'npm ERR! ETARGET' });
    expect(failed.status).toBe('FAILED');
    expect(auditActions()).toContain('upgrade.failed');
    await rejectsWith(failUpgrade(USER, a.id, 'again'), 'upgrade_not_failable');
  });

  it('accepts only from ANALYZING', async () => {
    const a = await start('next');
    await rejectsWith(acceptUpgrade(USER, a.id), 'upgrade_not_analyzable');
    await stepUpgrade(USER, a.id, { step: 'MODIFYING', ok: true, diff: {} });
    await stepUpgrade(USER, a.id, { step: 'INSTALLING', ok: true, output: 'ok' });
    await stepUpgrade(USER, a.id, { step: 'TESTING', ok: true, output: 'ok' });
    await stepUpgrade(USER, a.id, { step: 'BUILDING', ok: true, output: 'ok' });
    await stepUpgrade(USER, a.id, { step: 'ANALYZING', ok: true, output: 'ok' });
    expect((await acceptUpgrade(USER, a.id)).status).toBe('ACCEPTED');
  });

  it('is tenant-scoped', async () => {
    const a = await start('zod');
    await rejectsWith(getUpgrade(OTHER, a.id), 'not_found');
    await rejectsWith(stepUpgrade(OTHER, a.id, { step: 'MODIFYING', ok: true, diff: {} }), 'not_found');
    await rejectsWith(rollbackUpgrade(OTHER, a.id, 'nope'), 'not_found');
    expect(await listUpgrades(OTHER)).toEqual([]);
    expect(await listUpgrades(USER, PROJECT)).toHaveLength(1);
  });
});

describe('Flaky Test Hunter', () => {
  function run(status: 'PASSED' | 'FAILED', durationMs: number, over: Partial<Record<string, unknown>> = {}) {
    return { status, durationMs, timestamp: '2026-01-01T00:00:00.000Z', ...over };
  }

  it('classifies deterministically: INTERMITTENT, TIMING, ENVIRONMENT, UNCLASSIFIED', async () => {
    const interm = await analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't1', testName: 'cart.test.ts', runs: [
        run('PASSED', 300), run('FAILED', 900), run('PASSED', 300),
      ],
    });
    expect(interm.classification).toBe('INTERMITTENT');
    expect(interm.confidence).toBe(0.33);
    expect(interm.pattern).toContain('passes 2/3');

    const timing = await analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't2', testName: 'slow.test.ts', runs: [
        run('FAILED', 500), run('FAILED', 2000), run('FAILED', 600),
      ],
    });
    expect(timing.classification).toBe('TIMING');
    expect(timing.pattern).toContain('500ms .. 2000ms');

    const env = await analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't3', testName: 'net.test.ts', runs: [
        run('FAILED', 100, { environment: 'ci-a' }), run('FAILED', 100, { environment: 'ci-a' }), run('FAILED', 100, { environment: 'ci-b' }),
      ],
    });
    expect(env.classification).toBe('ENVIRONMENT');
    expect(env.pattern).toContain('ci-a');

    const unk = await analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't4', testName: 'flat.test.ts', runs: [
        run('FAILED', 1000), run('FAILED', 1000),
      ],
    });
    expect(unk.classification).toBe('UNCLASSIFIED');
    expect(unk.confidence).toBe(0);
    expect(unk.status).toBe('REPORTED');
    expect(unk.evidence).toHaveLength(2);
    expect(auditActions().filter((x) => x === 'flake.recorded')).toHaveLength(4);
  });

  it('refuses tests with zero failures and invalid input', async () => {
    await rejectsWith(analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't5', testName: 'green.test.ts', runs: [run('PASSED', 100), run('PASSED', 100)],
    }), 'flake_no_failures');
    await rejectsWith(analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't6', testName: 'short.test.ts', runs: [run('FAILED', 100)],
    }), 'flake_invalid_input');
  });

  it('creates an investigation task that never deletes or skips the test', async () => {
    const flake = await analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't7', testName: 'cart.test.ts', runs: [run('PASSED', 300), run('FAILED', 900), run('PASSED', 300)],
    });
    const inv = await createInvestigationTask(USER, flake.id);
    expect(inv.status).toBe('INVESTIGATING');
    expect(inv.investigation_task_id).toBeTruthy();
    const task = T().tasks.find((t) => t.id === inv.investigation_task_id);
    expect(task?.title).toContain('Investigate flaky test: cart.test.ts');
    expect(String(task?.description ?? '')).toContain('Do NOT delete or skip the test');
    expect(task?.risk_level).toBe('LOW');
    expect(auditActions()).toContain('flake.investigation_created');
    expect(notifyTypes()).toContain('flake.investigation_created');
    await rejectsWith(createInvestigationTask(USER, flake.id), 'flake_already_investigating');
  });

  it('marks flakes resolved once', async () => {
    const flake = await analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't8', testName: 'timer.test.ts', runs: [run('PASSED', 400), run('FAILED', 2000), run('PASSED', 400)],
    });
    const done = await markFlakeResolved(USER, flake.id);
    expect(done.status).toBe('RESOLVED');
    expect(auditActions()).toContain('flake.resolved');
    await rejectsWith(markFlakeResolved(USER, flake.id), 'flake_already_resolved');
  });

  it('is tenant-scoped', async () => {
    const flake = await analyzeTestRuns(USER, {
      projectId: PROJECT, testId: 't9', testName: 'auth.test.ts', runs: [run('PASSED', 300), run('FAILED', 300), run('PASSED', 300)],
    });
    await rejectsWith(getFlake(OTHER, flake.id), 'not_found');
    await rejectsWith(createInvestigationTask(OTHER, flake.id), 'not_found');
    await rejectsWith(markFlakeResolved(OTHER, flake.id), 'not_found');
    expect(await listFlakes(OTHER)).toEqual([]);
    expect(await listFlakes(USER, PROJECT)).toHaveLength(1);
  });
});

describe('Self-Healing CI', () => {
  const timeoutLogs = 'error: the job exceeded the maximum time limit\nTimeout of 3600 seconds was reached';
  const unknownLogs = 'something weird happened in stage 3\nno matching pattern here';

  async function failingRun(logs: string) {
    return recordCiFailure(USER, { projectId: PROJECT, pipeline: 'ci', commitRef: 'abc123def456', logRef: 'logs/1', logs });
  }

  it('intakes a failure, diagnoses from the logs, and opens a repair task', async () => {
    const run = await failingRun(timeoutLogs);
    expect(run.status).toBe('FAILED');
    expect(run.diagnosis).toMatchObject({ rootCause: 'timeout', severity: 'HIGH', action: 'increase_timeout' });
    expect(run.log_summary).toBe(timeoutLogs);
    const task = T().tasks.find((t) => t.id === run.task_id);
    expect(task?.risk_level).toBe('HIGH');
    expect(task?.title).toContain('Repair CI: ci @ abc123def456');
    expect(auditActions()).toContain('ci.failure_recorded');
  });

  it('proposes a fix from the recorded diagnosis (once)', async () => {
    const run = await failingRun(timeoutLogs);
    const p = await proposeCiFix(USER, run.id);
    expect(p.status).toBe('FIX_PROPOSED');
    expect(p.fix_proposal).toMatchObject({ action: 'increase_timeout', severity: 'HIGH' });
    expect(auditActions()).toContain('ci.fix_proposed');
    await rejectsWith(proposeCiFix(USER, run.id), 'ci_fix_not_proposable');
  });

  it('applies LOW-risk fixes directly (unknown logs ? manual investigation)', async () => {
    const run = await failingRun(unknownLogs);
    expect(run.diagnosis).toMatchObject({ rootCause: 'unknown', severity: 'LOW', action: 'manual_investigation' });
    await proposeCiFix(USER, run.id);
    const applied = await applyCiFix(USER, run.id);
    expect(applied.status).toBe('FIX_APPLIED');
    expect(T().approvals).toHaveLength(0);
    expect(auditActions()).toContain('ci.fix_applied');
    expect(notifyTypes()).toContain('ci.fix_applied');
  });

  it('gates HIGH-risk fixes behind approval; approval applies the fix, retest passes', async () => {
    const run = await failingRun(timeoutLogs);
    await proposeCiFix(USER, run.id);
    const waiting = await applyCiFix(USER, run.id);
    expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
    expect(waiting.approval_id).toBeTruthy();
    const approval = T().approvals.find((a) => a.id === waiting.approval_id);
    expect(approval?.status).toBe('PENDING');
    expect((approval?.detail as { action_type: string }).action_type).toBe('ci_fix');
    expect(auditActions()).toContain('ci.fix_approval_requested');
    expect(notifyTypes()).toContain('ci.fix_approval_required');

    const approved = await decideCiFixApproval(USER, run.id, 'APPROVE');
    expect(approved.status).toBe('FIX_APPLIED');
    expect(T().approvals.find((a) => a.id === waiting.approval_id)?.status).toBe('APPROVED');
    expect(T().tasks.find((t) => t.id === run.task_id)?.status).toBe('PLANNED');
    expect(auditActions()).toContain('ci.fix_approved');

    const retest = await recordRetest(USER, run.id, { ok: true, summary: 'all green in 4m 12s' });
    expect(retest.status).toBe('RETEST_PASSED');
    expect(retest.retest_summary).toBe('all green in 4m 12s');
    expect(auditActions()).toContain('ci.retest_recorded');
    await rejectsWith(recordRetest(USER, run.id, { ok: true, summary: 'again' }), 'ci_retest_not_allowed');
  });

  it('rejected fixes stay rejected and cancel the repair task', async () => {
    const run = await failingRun(timeoutLogs);
    await proposeCiFix(USER, run.id);
    await applyCiFix(USER, run.id);
    const rejected = await decideCiFixApproval(USER, run.id, 'REJECT', 'do it manually');
    expect(rejected.status).toBe('FIX_REJECTED');
    expect(T().approvals[0].status).toBe('REJECTED');
    expect(T().tasks.find((t) => t.id === run.task_id)?.status).toBe('CANCELLED');
    expect(auditActions()).toEqual(expect.arrayContaining(['ci.fix_rejected', 'approval.rejected']));
    await rejectsWith(applyCiFix(USER, run.id), 'ci_fix_not_applicable');
  });

  it('never performs destructive actions automatically', async () => {
    const run = await failingRun(unknownLogs);
    await proposeCiFix(USER, run.id);
    await rejectsWith(applyCiFix(USER, run.id, 'git merge feature-branch'), 'destructive_merge_rejected');
    expect(auditActions()).toContain('ci.merge_rejected');
    const after = await getCiRun(USER, run.id);
    expect(after.status).toBe('FIX_PROPOSED');
    expect(T().approvals).toHaveLength(0);
  });

  it('records failed retests and allows a follow-up retest', async () => {
    const run = await failingRun(unknownLogs);
    await proposeCiFix(USER, run.id);
    await applyCiFix(USER, run.id);
    const failed = await recordRetest(USER, run.id, { ok: false, summary: 'still red' });
    expect(failed.status).toBe('RETEST_FAILED');
    const passed = await recordRetest(USER, run.id, { ok: true, summary: 'green now' });
    expect(passed.status).toBe('RETEST_PASSED');
  });

  it('is tenant-scoped', async () => {
    const run = await failingRun(timeoutLogs);
    await rejectsWith(getCiRun(OTHER, run.id), 'not_found');
    await rejectsWith(proposeCiFix(OTHER, run.id), 'not_found');
    await rejectsWith(recordRetest(OTHER, run.id, { ok: true, summary: 'x' }), 'not_found');
    expect(await listCiRuns(OTHER)).toEqual([]);
    expect(await listCiRuns(USER, PROJECT)).toHaveLength(1);
  });
});
