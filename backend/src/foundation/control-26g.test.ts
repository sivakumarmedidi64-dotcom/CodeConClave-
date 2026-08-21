/**
 * Stage 26G — Control Plane + Preview Workspace + Plugin Sandbox + Secret
 * Guard + Usage Analytics contract suite.
 * Covers: preview commenting (click element -> real task), preview snapshots
 * + honest visual diff, proof-of-work reports assembled from real state,
 * kill switch gates (tasks/agents/schedules/autonomy + GLOBAL override),
 * risk policies (block / require-approval escalation, plugin engine gate),
 * undo for genuinely reversible ops only, secret guard (findings never
 * contain values), plugin sandbox (clearly fake output, never live calls),
 * usage cost-per-feature / cost-per-task / ROI / transparency / heatmap /
 * rollups, and tenant isolation throughout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    tables: Record<string, Array<Record<string, unknown>>>;
  } = {
    tables: {
      tasks: [], projects: [], preview_sessions: [], preview_comments: [], preview_snapshots: [],
      proof_of_work_reports: [], plans: [], plan_entries: [], files: [], task_steps: [],
      task_attempts: [], artifacts: [], approvals: [], model_usage_logs: [], file_activity: [],
      kill_switch: [], control_policies: [], undo_log: [], secret_guard_scans: [],
      plugin_sandbox_runs: [], plugin_connections: [], plugin_scopes: [], usage_rollups: [],
    },
  };
  const T = state.tables;

  const JSONB = new Set([
    'build_log', 'report', 'findings', 'input', 'output', 'undo_payload', 'detail',
    'scopes', 'config', 'coworker_pipeline', 'plan',
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
      if (m) { row[k!] = params[Number(m[1]) - 1]; continue; }
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
        const items = m[2].split(',').map((s) => s.trim());
        const list = items.every((s) => /^\$\d+$/.test(s))
          ? items.map((s) => String(params[Number(s.slice(1)) - 1] ?? ''))
          : items.map((s) => s.replace(/^'|'$/g, ''));
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

    // ---------------- INSERT (with upsert support) ----------------
    const ins = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.*)\)(?:\s+ON CONFLICT.*)?$/.exec(text);
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

      const conflict = /ON CONFLICT\s*\(([\s\S]*?)\)\s+DO UPDATE SET\s+([\s\S]+)$/.exec(text);
      if (conflict) {
        const conflictCols = [...conflict[1].matchAll(/COALESCE\((\w+),'__none__'\)|\b(\w+)\b/g)].map((m) => m[1] ?? m[2]);
        const existing = T[ins[1]].find((r) =>
          conflictCols.every((c) => String(r[c] ?? '') === String(row[c] ?? '')),
        );
        if (existing) {
          for (const [, k, expr] of [...conflict[2].matchAll(/(\w+)\s*=\s*([^,]+)/g)]) {
            const m = /\$(\d+)/.exec(expr ?? '');
            if (m) { existing[k!] = params[Number(m[1]) - 1]; continue; }
            const flat = (expr ?? '').replace(/\s+/g, ' ');
            if (flat === 'now()') existing[k!] = nowIso();
            else if (flat.includes('EXCLUDED.')) {
              const src = /EXCLUDED\.(\w+)/.exec(flat)?.[1] ?? '';
              if (flat.includes(' + ')) existing[k!] = Number(existing[k!] ?? 0) + Number(row[src] ?? 0);
              else existing[k!] = row[src];
            } else existing[k!] = row[k!];
          }
          hydrate(existing);
          return { rows: [existing], rowCount: 1 };
        }
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

    // ---------------- DELETE ----------------
    const del = /^DELETE FROM (\w+) WHERE (.+)$/.exec(text);
    if (del) {
      const delTbl = T[del[1]];
      if (!delTbl) return { rows: [], rowCount: 0 };
      const kept = delTbl.filter((r) => !matchWhere(del[2], r, params));
      const removed = delTbl.length - kept.length;
      T[del[1]] = kept;
      return { rows: [], rowCount: removed };
    }

    // ---------------- SELECT: heatmap JOIN (file_activity + files) ----------------
    if (text.includes('FROM file_activity fa JOIN files f ON f.id = fa.file_id')) {
      const merged: Array<Record<string, unknown>> = [];
      for (const fa of T.file_activity) {
        const f = T.files.find((x) => x.id === fa.file_id);
        merged.push({
          ...fa,
          path: f?.path ?? '',
          day: String(fa.created_at ?? nowIso()).slice(0, 10),
        });
      }
      rows = merged.filter((r) => matchWhere(`project_id = $1 AND actor_user_id = $2`, r, [params[0], params[1]]));
      return { rows, rowCount: rows.length };
    }

    // ---------------- SELECT: plans via task subquery ----------------
    if (text.includes('WHERE id = (SELECT plan_id FROM tasks WHERE id =')) {
      const task = T.tasks.find((t) => t.id === String(params[0] ?? ''));
      const plan = task ? T.plans.find((p) => p.id === task.plan_id) : undefined;
      return { rows: plan ? [plan] : [], rowCount: plan ? 1 : 0 };
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
    text: '{}', modelId: 'm-test', providerId: 'p-test', inputTokens: 0, outputTokens: 0,
    estimatedCostUsd: 0, durationMs: 1, usedFallback: false, fallbackReason: null,
  })),
}));
vi.mock('../modules/ai/gateway.js', () => gateway);

import '../modules/plugins/index.js';
import { registerPlugins } from '../modules/plugins/index.js';
import { createTask } from '../modules/execution/tasks.js';
import { addPreviewComment, resolvePreviewComment, listPreviewComments } from '../modules/preview/comments.js';
import { capturePreviewSnapshot, previewVisualDiff, snapshotOnTransition } from '../modules/preview/snapshots.js';
import { generateProofOfWork, getProofOfWork } from '../modules/proofOfWork.js';
import { setKillSwitch, killSwitchStatus, killSwitchActive, assertAutonomyEnabled } from '../modules/control/killSwitch.js';
import { upsertControlPolicy, evaluatePolicy, listControlPolicies, deleteControlPolicy } from '../modules/control/policies.js';
import { recordUndoable, undoAction, listUndoable } from '../modules/control/undo.js';
import { scanContent, listSecretGuardScans, redactSecrets, scanContentForSecrets } from '../modules/secretGuard/service.js';
import { runPluginSandbox, listPluginSandboxRuns } from '../modules/plugins/sandbox.js';
import {
  costPerFeature, costPerTask, roiEstimate, transparencyLog, changeHeatmap,
  refreshUsageRollups, listUsageRollups, featureForSession,
} from '../modules/usage/analytics.js';
import { executePluginAction } from '../modules/plugins/engine.js';
import { updateConnectionScopes } from '../modules/plugins/health.js';
import { createRule } from '../modules/automations/rules.js';
import { AppError } from '../shared/errors.js';
import { AuditAction, NotificationType, KillSwitchScope, ControlPolicyRequirement, SecretGuardTarget } from '@codeconclave/shared';

const T = () => db.state.tables;
const USER = 'u-1';
const OTHER = 'u-2';
const PROJECT = 'prj-1';

const nowIso = () => new Date().toISOString();

function seedProject(id = PROJECT, owner = USER): Record<string, unknown> {
  const row = { id, owner_id: owner, team_id: null, name: 'P', deleted_at: null, created_at: nowIso() };
  T().projects.push(row);
  return row;
}

function seedTask(over: Partial<Record<string, unknown>> = {}, owner = USER): Record<string, unknown> {
  const now = nowIso();
  const row: Record<string, unknown> = {
    id: `tsk-${T().tasks.length + 1}`,
    project_id: PROJECT,
    conversation_id: null,
    owner_id: owner,
    title: 'Task',
    description: null,
    plan_id: null,
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

function seedSession(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: 'pvw-1',
    owner_id: USER,
    project_id: PROJECT,
    state: 'READY',
    build_log: ['built'],
    error: null,
    task_id: null,
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  Object.assign(row, over);
  T().preview_sessions.push(row);
  return row;
}

function seedLedger(over: Partial<Record<string, unknown>> = {}, owner = USER): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: `mu-${T().model_usage_logs.length + 1}`,
    user_id: owner,
    tenant_id: owner,
    session_id: 'chat:abc',
    coworker_type: 'CHAT',
    task_id: null,
    conversation_id: null,
    provider_id: 'p-test',
    model_id: 'm-test',
    plan_id: 'pro',
    compute_class: 'standard',
    input_tokens: 100,
    output_tokens: 50,
    estimated_cost_usd: 0.01,
    duration_ms: 100,
    used_fallback: false,
    fallback_reason: null,
    error_code: null,
    created_at: nowIso(),
  };
  Object.assign(row, over);
  T().model_usage_logs.push(row);
  return row;
}

function resetAll(): void {
  for (const k of Object.keys(T())) T()[k] = [];
  audit.recordAudit.mockClear();
  notify.notify.mockClear();
  seedProject();
}

beforeEach(() => {
  registerPlugins();
  resetAll();
});

function rejectWith(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ errorCode: code });
}

describe('PREVIEW COMMENTING — click element -> real task', () => {
  it('creates a comment + a REAL task with the selector and comment', async () => {
    seedSession();
    const comment = await addPreviewComment(USER, { projectId: PROJECT, selector: '#submit-btn', comment: 'The button overlaps the footer' });
    expect(comment.status).toBe('OPEN');
    expect(comment.preview_version).toBe(1);
    expect(comment.task_id).toBeTruthy();
    const task = T().tasks.find((t) => t.id === comment.task_id);
    expect(task).toBeTruthy();
    expect(task!.status).toBe('CREATED');
    expect(task!.risk_level).toBe('MEDIUM');
    expect(String(task!.description)).toContain('#submit-btn');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.PREVIEW_COMMENT_CREATED }));
    expect(notify.notify).toHaveBeenCalledWith(USER, NotificationType.PREVIEW_COMMENT_TASK_CREATED, expect.any(String), expect.anything());
  });

  it('rejects missing selector or comment', async () => {
    seedSession();
    await rejectWith(addPreviewComment(USER, { projectId: PROJECT, selector: ' ', comment: 'x' }), 'comment_invalid_input');
    await rejectWith(addPreviewComment(USER, { projectId: PROJECT, selector: 'x', comment: '' }), 'comment_invalid_input');
  });

  it('rejects comments on projects the user does not own', async () => {
    seedSession();
    await rejectWith(addPreviewComment(OTHER, { projectId: PROJECT, selector: 'x', comment: 'y' }), 'not_found');
  });

  it('resolve only once; resolve after resolve conflicts; list is tenant-scoped', async () => {
    seedSession();
    const comment = await addPreviewComment(USER, { projectId: PROJECT, selector: '#a', comment: 'fix this' });
    const resolved = await resolvePreviewComment(USER, comment.id);
    expect(resolved.status).toBe('RESOLVED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.PREVIEW_COMMENT_RESOLVED }));
    await rejectWith(resolvePreviewComment(USER, comment.id), 'comment_not_open');
    await rejectWith(resolvePreviewComment(OTHER, comment.id), 'not_found');
    expect(await listPreviewComments(OTHER, PROJECT)).toHaveLength(0);
    expect(await listPreviewComments(USER, PROJECT)).toHaveLength(1);
  });
});

describe('PREVIEW SNAPSHOTS + VISUAL DIFF', () => {
  it('captures a snapshot of the real session and dedupes by version', async () => {
    seedSession({ version: 3 });
    const snap1 = await capturePreviewSnapshot(USER, PROJECT);
    const snap2 = await capturePreviewSnapshot(USER, PROJECT);
    expect(snap1!.id).toBe(snap2!.id);
    expect(snap1!.version).toBe(3);
    expect(T().preview_snapshots).toHaveLength(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.PREVIEW_SNAPSHOT_CAPTURED }));
  });

  it('visual diff is honest: unavailable until two versions exist', async () => {
    seedSession({ version: 1 });
    const none = await previewVisualDiff(USER, PROJECT);
    expect(none.available).toBe(false);
    expect(none.before).toBeNull();
    T().preview_snapshots.push({
      id: 'pvw-1.v1', owner_id: USER, project_id: PROJECT, version: 1,
      state: 'READY', build_log: null, created_at: nowIso(),
    });
    T().preview_snapshots.push({
      id: 'pvw-1.v2', owner_id: USER, project_id: PROJECT, version: 2,
      state: 'BUILDING', build_log: null, created_at: nowIso(),
    });
    const diff = await previewVisualDiff(USER, PROJECT);
    expect(diff.available).toBe(true);
    expect(diff.after!.version).toBe(2);
    expect(diff.before!.version).toBe(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.PREVIEW_DIFF_VIEWED }));
  });

  it('snapshotOnTransition never throws, even without a project', async () => {
    await expect(snapshotOnTransition(USER, 'missing')).resolves.toBeUndefined();
  });
});

describe('PROOF OF WORK — assembled from real state only', () => {
  it('regenerates one report per task and records audit', async () => {
    const task = seedTask({ title: 'Build checkout', status: 'COMPLETED', completed_at: nowIso(), attempt_count: 2, plan_id: 'pln-1' });
    T().plans.push({ id: 'pln-1', task_id: task.id, status: 'COMPLETED' });
    T().plan_entries.push({ id: 'pne-1', plan_id: 'pln-1', position: 1, title: 'Design', status: 'DONE' });
    T().files.push({ id: 'fil-1', project_id: PROJECT, owner_id: USER, path: 'src/checkout.ts', size_bytes: 1200, deleted_at: null });
    T().task_steps.push({ id: 'tsp-1', task_id: task.id, step: 'run tests', output: '3 passed', created_at: nowIso() });
    T().task_attempts.push({ id: 'tat-1', task_id: task.id, error_code: 'build_failed', error_detail: 'x', created_at: nowIso() });
    T().artifacts.push({ id: 'art-1', task_id: task.id, kind: 'bundle', title: 'main.js', created_at: nowIso() });
    T().approvals.push({ id: 'apr-1', task_id: task.id, status: 'APPROVED', risk_level: 'HIGH', decision: 'APPROVE' });
    seedLedger({ task_id: task.id, session_id: 'task:x', input_tokens: 200, output_tokens: 100, estimated_cost_usd: 0.05 });
    seedSession({ state: 'READY', version: 4 });

    const report = await generateProofOfWork(USER, task.id);
    expect(report.report.request.title).toBe('Build checkout');
    expect(report.report.plan!.entries).toHaveLength(1);
    expect(report.report.files.map((f) => f.path)).toEqual(['src/checkout.ts']);
    expect(report.report.tests).toHaveLength(1);
    expect(report.report.evidence.attempts).toBe(2);
    expect(report.report.evidence.errors[0].error_code).toBe('build_failed');
    expect(report.report.evidence.artifacts[0].kind).toBe('bundle');
    expect(report.report.preview!.state).toBe('READY');
    expect(report.report.approvals[0].status).toBe('APPROVED');
    expect(report.report.ai.costUsd).toBeCloseTo(0.05, 5);
    expect(T().proof_of_work_reports).toHaveLength(1);

    const again = await generateProofOfWork(USER, task.id);
    expect(T().proof_of_work_reports).toHaveLength(1);
    expect(again.id).toBe(report.id);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.PROOF_OF_WORK_GENERATED }));

    await rejectWith(getProofOfWork(OTHER, task.id), 'not_found');
  });

  it('missing task -> not found; missing sources omitted honestly', async () => {
    await rejectWith(generateProofOfWork(USER, 'nope'), 'not_found');
    const task = seedTask();
    const report = await generateProofOfWork(USER, task.id);
    expect(report.report.plan).toBeNull();
    expect(report.report.preview).toBeNull();
    expect(report.report.ai.calls).toBe(0);
  });
});

describe('KILL SWITCH — stops new work, never lies', () => {
  it('rejects unknown scopes', async () => {
    await rejectWith(setKillSwitch(USER, 'DATABASE', true), 'invalid_kill_switch_scope');
  });

  it('TASKS kill switch blocks task creation; untoggling restores', async () => {
    await setKillSwitch(USER, KillSwitchScope.TASKS, true, 'ship freeze');
    await rejectWith(createTask({ userId: USER, projectId: PROJECT, title: 'T' }), 'autonomy_suspended');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.KILL_SWITCH_TOGGLED }));
    expect(notify.notify).toHaveBeenCalledWith(USER, NotificationType.KILL_SWITCH_ACTIVATED, expect.any(String), expect.anything());
    await setKillSwitch(USER, KillSwitchScope.TASKS, false);
    const task = await createTask({ userId: USER, projectId: PROJECT, title: 'T' });
    expect(task.status).toBe('CREATED');
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });

  it('AGENTS kill does not block tasks; GLOBAL blocks everything', async () => {
    await setKillSwitch(USER, KillSwitchScope.AGENTS, true);
    expect(await createTask({ userId: USER, projectId: PROJECT, title: 'T' })).toBeTruthy();
    await setKillSwitch(USER, KillSwitchScope.GLOBAL, true, 'incident');
    await rejectWith(createTask({ userId: USER, projectId: PROJECT, title: 'T' }), 'autonomy_suspended');
    expect(await killSwitchActive(USER, KillSwitchScope.TASKS)).toBe(true);
  });

  it('AUTONOMY kill blocks automation rule creation before validation', async () => {
    await setKillSwitch(USER, KillSwitchScope.AUTONOMY, true);
    await rejectWith(
      createRule(USER, { name: '', eventSource: 'github', eventType: 'push', actions: [{ type: 'create_task' }] } as never),
      'autonomy_suspended',
    );
  });

  it('status lists every scope with GLOBAL override', async () => {
    await setKillSwitch(USER, KillSwitchScope.TASKS, true);
    const status = await killSwitchStatus(USER);
    expect(status).toHaveLength(Object.values(KillSwitchScope).length);
    expect(status.find((s) => s.scope === 'TASKS')!.suspended).toBe(true);
    expect(status.find((s) => s.scope === 'AGENTS')!.suspended).toBe(false);
    await setKillSwitch(USER, KillSwitchScope.GLOBAL, true);
    const all = await killSwitchStatus(USER);
    expect(all.every((s) => s.suspended)).toBe(true);
  });

  it('assertAutonomyEnabled passes when nothing is active', async () => {
    await expect(assertAutonomyEnabled(USER, 'AGENTS')).resolves.toBeUndefined();
  });
});

describe('CONTROL POLICIES — block / require-approval', () => {
  it('validates scope, risk and requirement', async () => {
    await rejectWith(upsertControlPolicy(USER, { scope: 'nope', action: 'create', riskLevel: 'HIGH' }), 'invalid_policy_scope');
    await rejectWith(upsertControlPolicy(USER, { scope: 'task', action: '', riskLevel: 'HIGH' }), 'invalid_policy_action');
    await rejectWith(upsertControlPolicy(USER, { scope: 'task', action: 'create', riskLevel: 'MEGA' }), 'invalid_policy_risk');
    await rejectWith(upsertControlPolicy(USER, { scope: 'task', action: 'create', riskLevel: 'HIGH', requirement: 'yell' }), 'invalid_policy_requirement');
  });

  it('no policies -> default allowed', async () => {
    const d = await evaluatePolicy(USER, 'task', 'create', 'HIGH');
    expect(d.allowed).toBe(true);
    expect(d.requireApproval).toBe(false);
  });

  it('BLOCK at HIGH blocks HIGH tasks but not MEDIUM', async () => {
    await upsertControlPolicy(USER, { scope: 'task', action: 'create', riskLevel: 'HIGH', requirement: ControlPolicyRequirement.BLOCK });
    await rejectWith(createTask({ userId: USER, projectId: PROJECT, title: 'T', riskLevel: 'HIGH' }), 'policy_blocked');
    expect(await createTask({ userId: USER, projectId: PROJECT, title: 'T', riskLevel: 'MEDIUM' })).toBeTruthy();
  });

  it('require_approval escalates MEDIUM to HIGH (real approval gate)', async () => {
    await upsertControlPolicy(USER, { scope: 'task', action: 'create', riskLevel: 'MEDIUM', requirement: ControlPolicyRequirement.REQUIRE_APPROVAL });
    const task = await createTask({ userId: USER, projectId: PROJECT, title: 'T', riskLevel: 'MEDIUM' });
    expect(task.risk_level).toBe('HIGH');
    expect(task.required_approval).toBe(true);
  });

  it('wildcard action applies; disabled policies are inert', async () => {
    await upsertControlPolicy(USER, { scope: 'task', action: '*', riskLevel: 'MEDIUM', requirement: ControlPolicyRequirement.REQUIRE_APPROVAL });
    const task = await createTask({ userId: USER, projectId: PROJECT, title: 'T' });
    expect(task.required_approval).toBe(true);
    const list = await listControlPolicies(USER);
    expect(list[0].action).toBe('*');
    await deleteControlPolicy(USER, list[0].id);
    expect(await listControlPolicies(USER)).toHaveLength(0);
    await upsertControlPolicy(USER, { scope: 'task', action: 'create', riskLevel: 'MEDIUM', requirement: ControlPolicyRequirement.BLOCK, enabled: false });
    expect(await createTask({ userId: USER, projectId: PROJECT, title: 'T' })).toBeTruthy();
  });

  it('plugin engine honours a plugin-scope BLOCK policy', async () => {
    T().plugin_connections.push({
      id: 'plc-1', owner_id: USER, plugin_type: 'github', state: 'CONNECTED',
      scopes: ['repositories:read'], last_error: null, created_at: nowIso(), updated_at: nowIso(),
    });
    await upsertControlPolicy(USER, { scope: 'plugin', action: 'read', riskLevel: 'MEDIUM', requirement: ControlPolicyRequirement.BLOCK });
    await rejectWith(
      executePluginAction({ userId: USER, connectionId: 'plc-1', action: 'repositories.list', input: {} }),
      'policy_blocked',
    );
  });
});

describe('UNDO — only genuinely reversible operations', () => {
  it('refuses non-reversible action types', async () => {
    await rejectWith(
      recordUndoable(USER, { actionType: 'task_deletion', description: 'd', payload: {} }),
      'undo_not_reversible',
    );
  });

  it('undo restores a kill switch toggle', async () => {
    await setKillSwitch(USER, KillSwitchScope.TASKS, true);
    const entry = await recordUndoable(USER, {
      actionType: 'kill_switch_toggle',
      description: 'Temporarily suspended tasks',
      payload: { scope: KillSwitchScope.TASKS, prevActive: false, reason: null },
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.UNDO_RECORDED }));
    const undone = await undoAction(USER, entry.id);
    expect(undone.status).toBe('UNDONE');
    expect(await killSwitchActive(USER, KillSwitchScope.TASKS)).toBe(false);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.UNDO_PERFORMED }));
    await rejectWith(undoAction(USER, entry.id), 'undo_not_available');
    expect(await listUndoable(OTHER)).toHaveLength(0);
  });

  it('undo restores a policy enabled flag', async () => {
    const policy = await upsertControlPolicy(USER, { scope: 'task', action: 'create', riskLevel: 'MEDIUM', requirement: ControlPolicyRequirement.BLOCK });
    const entry = await recordUndoable(USER, {
      actionType: 'policy_toggle',
      description: 'Roll back the task block',
      payload: { scope: 'task', action: 'create', riskLevel: 'MEDIUM', requirement: 'block', prevEnabled: false },
    });
    await undoAction(USER, entry.id);
    const policies = await listControlPolicies(USER);
    expect(policies[0].id).toBe(policy.id);
    expect(policies[0].enabled).toBe(false);
    expect(await createTask({ userId: USER, projectId: PROJECT, title: 'T' })).toBeTruthy();
  });

  it('undo restores plugin scopes', async () => {
    T().plugin_connections.push({
      id: 'plc-2', owner_id: USER, plugin_type: 'github', state: 'CONNECTED',
      scopes: ['read'], last_error: null, created_at: nowIso(), updated_at: nowIso(),
    });
    T().plugin_scopes.push({ id: 'psc-1', connection_id: 'plc-2', scope: 'read', granted_at: nowIso(), revoked_at: null });
    const entry = await recordUndoable(USER, {
      actionType: 'plugin_scope_change',
      description: 'Temporarily narrowed plugin scopes',
      payload: { connectionId: 'plc-2', prevScopes: ['read'] },
    });
    await undoAction(USER, entry.id);
    const row = T().plugin_connections.find((c) => c.id === 'plc-2')!;
    expect(JSON.parse(JSON.stringify(row.scopes))).toEqual(['read']);
  });
});

describe('SECRET GUARD — findings never contain values', () => {
  it('clean content -> CLEAN result and no alert', async () => {
    const scan = await scanContent(USER, { targetType: SecretGuardTarget.AGENT_OUTPUT, content: 'all good here' });
    expect(scan.result).toBe('CLEAN');
    expect(scan.findings).toHaveLength(0);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.SECRET_GUARD_SCANNED }));
    expect(notify.notify).not.toHaveBeenCalled();
  });

  it('detects secrets without persisting their values', async () => {
    const leaked = 'creds: AKIAIOSFODNN7EXAMPLE and token=sk_live_1234567890abcdefghijklmnop';
    const scan = await scanContent(USER, { targetType: SecretGuardTarget.COMMIT, targetRef: 'main:env', content: leaked });
    expect(scan.result).toBe('FINDINGS');
    expect(scan.findings.length).toBeGreaterThan(0);
    expect(scan.findings.map((f) => f.kind)).toContain('aws_access_key_id');
    expect(JSON.stringify(scan.findings)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(scan.findings)).not.toContain('sk_live_');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.SECRET_GUARD_FINDINGS }));
    expect(notify.notify).toHaveBeenCalledWith(USER, NotificationType.SECRET_GUARD_ALERT, expect.any(String), expect.anything());
    expect(await listSecretGuardScans(USER)).toHaveLength(1);
  });

  it('redactSecrets masks values and replaces them with placeholders', () => {
    const out = redactSecrets('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz012345');
    expect(out).not.toContain('ghp_');
    expect(out).toContain('[REDACTED');
  });

  it('rejects unknown scan targets', async () => {
    await rejectWith(scanContent(USER, { targetType: 'disk', content: 'x' }), 'invalid_scan_target');
  });
});

describe('PLUGIN SANDBOX — clearly fake, never a live call', () => {
  it('runs a fake action against a real adapter contract', async () => {
    const result = await runPluginSandbox(USER, { pluginType: 'github', action: 'repositories.list', input: { perPage: 5 } });
    expect(result.fake).toBe(true);
    expect(result.sandbox).toBe(true);
    expect(result.output.fake).toBe(true);
    expect(result.warning).toContain('never a live provider call');
    expect(T().plugin_sandbox_runs).toHaveLength(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.PLUGIN_SANDBOX_RUN }));
    expect(await listPluginSandboxRuns(OTHER)).toHaveLength(0);
    expect((await listPluginSandboxRuns(USER))[0].ok).toBe(true);
  });

  it('refuses unknown adapters and actions', async () => {
    await rejectWith(runPluginSandbox(USER, { pluginType: 'nope', action: 'x' }), 'sandbox_action_unknown');
    await rejectWith(runPluginSandbox(USER, { pluginType: 'github', action: 'delete.everything' }), 'sandbox_action_unknown');
  });
});

describe('USAGE ANALYTICS — real ledger, honest numbers', () => {
  it('maps sessions to features', () => {
    expect(featureForSession('chat:1', null)).toBe('chat');
    expect(featureForSession('task:1', null)).toBe('tasks');
    expect(featureForSession('agent:1', null)).toBe('agents');
    expect(featureForSession('zzz:1', 'CODER')).toBe('tasks');
    expect(featureForSession('zzz:1', 'CHAT')).toBe('general');
  });

  it('costPerFeature aggregates the ledger per feature', async () => {
    seedLedger({ session_id: 'chat:1', estimated_cost_usd: 0.01 });
    seedLedger({ session_id: 'chat:2', estimated_cost_usd: 0.02 });
    seedLedger({ session_id: 'task:1', task_id: 'tsk-9', estimated_cost_usd: 0.04 });
    seedLedger({ session_id: 'pr-review:1', estimated_cost_usd: 0.03 });
    seedLedger({ session_id: 'weird:1', coworker_type: 'CHAT', estimated_cost_usd: 0.005 });
    const features = await costPerFeature(USER, 30);
    const chat = features.find((f) => f.feature === 'chat')!;
    expect(chat.calls).toBe(2);
    expect(chat.costUsd).toBeCloseTo(0.03, 6);
    expect(features.find((f) => f.feature === 'engineering')!.costUsd).toBeCloseTo(0.03, 6);
    expect(features.find((f) => f.feature === 'general')!.costUsd).toBeCloseTo(0.005, 6);
    expect(await costPerFeature(OTHER, 30)).toHaveLength(0);
  });

  it('costPerTask is scoped to one task', async () => {
    seedLedger({ session_id: 'task:1', task_id: 'tsk-9', estimated_cost_usd: 0.04 });
    seedLedger({ session_id: 'task:2', task_id: 'tsk-10', estimated_cost_usd: 0.08 });
    const cost = await costPerTask(USER, 'tsk-9');
    expect(cost.calls).toBe(1);
    expect(cost.costUsd).toBeCloseTo(0.04, 6);
  });

  it('ROI is an estimate with a clear label', async () => {
    seedLedger({ session_id: 'task:1', task_id: 'tsk-9', estimated_cost_usd: 0.1 });
    seedLedger({ session_id: 'task:1', task_id: 'tsk-9', estimated_cost_usd: 0.1 });
    const { rows, label } = await roiEstimate(USER, 30);
    const tasks = rows.find((r) => r.feature === 'tasks')!;
    expect(tasks.tasksCompleted).toBe(1);
    expect(tasks.valueUsd).toBe(5);
    expect(tasks.roi).toBeCloseTo(25, 6);
    expect(label).toContain('estimate');
  });

  it('transparency log exposes provider/model/agent/task/usage/fallback/outcome', async () => {
    seedLedger({ session_id: 'task:1', task_id: 'tsk-9', coworker_type: 'ARCHITECT', used_fallback: true, fallback_reason: 'latency', error_code: 'timeout' });
    const calls = await transparencyLog(USER, 7);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('ARCHITECT');
    expect(calls[0].providerId).toBe('p-test');
    expect(calls[0].usedFallback).toBe(true);
    expect(calls[0].fallbackReason).toBe('latency');
    expect(calls[0].outcome).toBe('timeout');
  });

  it('heatmap aggregates real file activity by day', async () => {
    T().files.push({ id: 'fil-1', project_id: PROJECT, owner_id: USER, path: 'src/a.ts', size_bytes: 1, deleted_at: null });
    T().files.push({ id: 'fil-2', project_id: PROJECT, owner_id: USER, path: 'src/b.ts', size_bytes: 1, deleted_at: null });
    T().file_activity.push({ id: 'fa-1', file_id: 'fil-1', project_id: PROJECT, actor_user_id: USER, action: 'edit', detail: null, created_at: '2026-08-18T10:00:00.000Z' });
    T().file_activity.push({ id: 'fa-2', file_id: 'fil-1', project_id: PROJECT, actor_user_id: USER, action: 'create', detail: null, created_at: '2026-08-18T11:00:00.000Z' });
    T().file_activity.push({ id: 'fa-3', file_id: 'fil-2', project_id: PROJECT, actor_user_id: USER, action: 'edit', detail: null, created_at: '2026-08-19T09:00:00.000Z' });
    const cells = await changeHeatmap(USER, PROJECT, 14);
    expect(cells).toHaveLength(2);
    const top = cells.find((c) => c.path === 'src/a.ts' && c.count === 2)!;
    expect(top.intensity).toBe(1);
    expect(top.actions.sort()).toEqual(['create', 'edit']);
    expect(await changeHeatmap(OTHER, PROJECT, 14)).toHaveLength(0);
  });

  it('rollup refresh writes usage_rollups and is additive on repeat', async () => {
    seedLedger({ session_id: 'task:1', task_id: 'tsk-9', estimated_cost_usd: 0.01 });
    const rolled = await refreshUsageRollups(USER, 7);
    expect(rolled).toBeGreaterThanOrEqual(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.USAGE_ROLLUP_GENERATED }));
    const rollups = await listUsageRollups(USER, 7);
    const taskRow = rollups.find((r) => r.task_id === 'tsk-9')!;
    expect(taskRow.calls).toBe(1);
    await refreshUsageRollups(USER, 7);
    const after = await listUsageRollups(USER, 7);
    const taskRow2 = after.find((r) => r.task_id === 'tsk-9')!;
    expect(taskRow2.calls).toBe(2);
  });
});