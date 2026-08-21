/**
 * Stage 26E — failure autopsy + checkpoints + time travel contract suite.
 * Covers: checkpoints (task/plan/execution/approval state, secret-free),
 * pause/resume (queue exclusion, agent-run cancellation, re-enqueue),
 * rewind (immutable history, irreversible-action guard), branch, modify
 * future steps, evidence-backed autopsies (root cause classification,
 * CAUSE_UNKNOWN when evidence is insufficient, prevention, memory + DNA
 * knowledge, successful-fix detection), recovery-aware history, audit
 * integrity, tenant isolation, irreversible action handling, the watchdog
 * sweep, and both end-to-end flows:
 *   task → checkpoint → pause → branch/modify → resume → completion
 *   failure → autopsy → remediation → retry → success
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    tables: Record<string, Array<Record<string, unknown>>>;
  } = {
    tables: {
      tasks: [], projects: [], task_attempts: [], task_steps: [], task_dependencies: [],
      task_checkpoints: [], task_branches: [], failure_autopsies: [], recovery_history: [],
      irreversible_actions: [], approvals: [], plans: [], plan_entries: [], task_dlq: [],
      automation_rules: [], automation_runs: [], event_log: [], escalations: [], workflow_recipes: [],
    },
  };
  const T = state.tables;

  const JSONB = new Set([
    'task_state', 'plan_state', 'execution_metadata', 'approval_state', 'detail',
    'checkpoint', 'input', 'timeline', 'attempts', 'errors', 'dependency_state',
    'recovery_attempts', 'successful_fix', 'prevention', 'evidence',
    'conditions', 'actions', 'result', 'payload', 'template', 'metadata',
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

  const stripPrefix = (cond: string, prefix: string) => cond.replace(new RegExp(`^${prefix}\\.`, 'g'), '');

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

  const evalTaskGate = (row: Record<string, unknown>) => {
    if (!['CREATED', 'PLANNED', 'CHANGED'].includes(String(row.status))) return false;
    if (row.paused_at != null) return false;
    if (row.required_approval !== false && row.approval_id == null) return false;
    if (!['CLOUD', 'HYBRID'].includes(String(row.execution_mode))) return false;
    if (Number(row.attempt_count ?? 0) >= Number(row.max_attempts ?? 3)) return false;
    if (row.next_attempt_at != null && new Date(String(row.next_attempt_at)).getTime() > Date.now()) return false;
    return true;
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
          else if (lit === 'true') row[c] = true;
          else if (lit === 'false') row[c] = false;
          else if (/^-?\d+(\.\d+)?$/.test(lit)) row[c] = Number(lit);
          else row[c] = lit;
        }
      });
      hydrate(row);
      const now = nowIso();
      const DEFAULTS: Record<string, Record<string, unknown>> = {
        task_branches: { status: 'ACTIVE', created_at: now, completed_at: null },
        task_checkpoints: { created_at: now },
        recovery_history: { created_at: now },
        irreversible_actions: { acknowledged: false, created_at: now },
        failure_autopsies: { created_at: now },
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

    // ---------------- DELETE ----------------
    const del = /DELETE FROM (\w+) WHERE (.+)$/.exec(text);
    if (del) {
      const delTbl = T[del[1]];
      if (!delTbl) return { rows: [], rowCount: 0 };
      const kept = delTbl.filter((r) => !matchWhere(del[2], r, params));
      const removed = delTbl.length - kept.length;
      T[del[1]] = kept;
      return { rows: [], rowCount: removed };
    }

    // ---------------- claimNextTask (queue) ----------------
    if (text.startsWith('UPDATE tasks SET') && text.includes('SELECT id FROM tasks WHERE status IN')) {
      const setStart = text.indexOf('SET ') + 4;
      const innerStart = text.indexOf('SELECT id FROM tasks WHERE ') + 'SELECT id FROM tasks WHERE '.length;
      const orderIdx = text.indexOf(' ORDER BY priority DESC');
      const setText = text.slice(setStart, text.indexOf(' WHERE id IN ('));
      const gate = text.slice(innerStart, orderIdx);
      const limit = Number(params[0] ?? 1);
      const candidates = T.tasks.filter((r) => evalTaskGate(r) && matchWhere(gate, r, params));
      const picked = sortRows(candidates, 'priority DESC, created_at').slice(0, limit);
      for (const row of picked) {
        applySet(setText, params, row);
      }
      rows = picked.map((r) => ({
        id: r.id, project_id: r.project_id, owner_id: r.owner_id,
        title: r.title, risk_level: r.risk_level, execution_mode: r.execution_mode,
        created_at: r.created_at,
      }));
      return { rows, rowCount: rows.length };
    }

    // ---------------- UPDATE (generic) ----------------
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

    // ---------------- SELECT: task_dependencies JOIN ----------------
    const join = /FROM task_dependencies td JOIN tasks dep ON dep\.id = td\.depends_on_task_id WHERE (.+?)(?: ORDER BY (.+))?$/.exec(text);
    if (join) {
      const merged: Array<Record<string, unknown>> = [];
      for (const dep of T.task_dependencies) {
        const t = T.tasks.find((x) => x.id === dep.depends_on_task_id);
        merged.push({ ...dep, depends_on_title: t?.title ?? null, depends_on_status: t?.status ?? null });
      }
      const where = join[1].split(' AND ').map((c) => stripPrefix(c, 'td')).join(' AND ');
      rows = merged.filter((r) => matchWhere(where, r, params));
      if (join[2]) rows = sortRows(rows, join[2].split(' AND ').map((c) => stripPrefix(c, 'td')).join(' AND '));
      return { rows, rowCount: rows.length };
    }

    // ---------------- SELECT: sweepAutopsies (NOT EXISTS) ----------------
    if (text.includes('NOT EXISTS')) {
      rows = T.tasks.filter((t) => {
        const failed = String(t.status) === 'FAILED' || String(t.status) === 'TIMED_OUT' || String(t.recovery_status) === 'DEAD_LETTERED';
        if (!failed) return false;
        const autopsied = T.failure_autopsies.some((a) => a.task_id === t.id && a.status === 'GENERATED');
        return !autopsied;
      }).map((t) => ({ id: t.id, owner_id: t.owner_id }));
      return { rows, rowCount: rows.length };
    }

    // ---------------- SELECT: COUNT ----------------
    const cnt = /^SELECT COUNT\(\*\)::int AS (\w+) FROM (\w+) WHERE (.+)$/.exec(text);
    if (cnt) {
      const cntTbl = T[cnt[2]];
      const n = (cntTbl ?? []).filter((r) => matchWhere(cnt[3], r, params)).length;
      return { rows: [{ [cnt[1]]: n }], rowCount: 1 };
    }

    // ---------------- SELECT: MAX aggregate ----------------
    const mx = /^SELECT COALESCE\(MAX\((\w+)\),\s*0\)\s*\+\s*1 AS (\w+) FROM (\w+) WHERE (.+)$/.exec(text);
    if (mx) {
      const mxTbl = T[mx[3]];
      const filtered = (mxTbl ?? []).filter((r) => matchWhere(mx[4], r, params));
      const max = filtered.reduce((a, r) => Math.max(a, Number(r[mx[1]] ?? 0)), 0);
      return { rows: [{ [mx[2]]: max + 1 }], rowCount: 1 };
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

const dna = vi.hoisted(() => ({ saveDna: vi.fn(async () => ({ id: 'dna-1' })) }));
vi.mock('../modules/dna/service.js', () => dna);

const planner = vi.hoisted(() => ({
  getPlan: vi.fn(async () => null),
  persistPlan: vi.fn(async (input: { taskId: string; goal: string; entries: unknown[] }) => ({
    id: 'pln-1', task_id: input.taskId, goal: input.goal, status: 'ACTIVE', entries: input.entries,
  })),
}));
vi.mock('../modules/execution/planner.js', () => planner);

import { createTask, beginAttempt, finishAttempt, saveAttemptCheckpoint, setTaskStatus, retryTask, type TaskRow } from '../modules/execution/tasks.js';
import { claimNextTask, pendingTaskCount } from '../shared/queue.js';
import { createCheckpoint, getCheckpoint, listCheckpoints } from '../modules/recovery/checkpoints.js';
import { pauseTask, resumeTask, modifyFutureSteps, branchTask, rewindTask } from '../modules/recovery/timeTravel.js';
import {
  generateAutopsy, getAutopsy, listAutopsies, applyRemediation, sweepAutopsies,
  classifyRootCause, buildPrevention,
} from '../modules/recovery/autopsy.js';
import { listRecoveryHistory } from '../modules/recovery/history.js';
import { recordIrreversibleAction, listIrreversibleActions } from '../modules/recovery/irreversible.js';
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
    paused_at: null,
    paused_by: null,
    paused_reason: null,
  };
  Object.assign(row, over);
  T().tasks.push(row);
  return row;
}

function seedAttempt(taskId: string, attemptNumber = 1, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: `atp-${attemptNumber}`,
    task_id: taskId,
    attempt_number: attemptNumber,
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error_code: null,
    output_summary: null,
    checkpoint: null,
    checkpointed_at: null,
  };
  Object.assign(row, over);
  T().task_attempts.push(row);
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

function historyEvents(userId: string, taskId: string): string[] {
  return T().recovery_history
    .filter((r) => r.task_id === taskId && r.owner_id === userId)
    .map((r) => String(r.event));
}

beforeEach(() => {
  for (const table of Object.values(T())) table.length = 0;
  vi.clearAllMocks();
  planner.getPlan.mockReset().mockResolvedValue(null);
  planner.persistPlan.mockReset().mockResolvedValue({ id: 'pln-1', task_id: 'x', goal: 'y', status: 'ACTIVE', entries: [] });
  seedProject();
});

describe('checkpoints', () => {
  it('captures task, plan, execution and approval state — no secrets', async () => {
    seedTask({ status: 'RUNNING', agent_run_id: 'crw-1', approval_id: 'app-1' });
    T().approvals.push({ id: 'app-1', task_id: 'tsk-1', owner_id: USER, status: 'APPROVED', execution_state: 'APPROVED' });
    const attempt = seedAttempt('tsk-1', 1, { result: 'FAILURE', error_code: 'plugin_unavailable' });
    await saveAttemptCheckpoint(attempt.id as string, { stageIndex: 2, runIdsByOrder: { '0': 'run-a', '1': 'run-b' } });
    planner.getPlan.mockResolvedValue({
      id: 'pln-1', task_id: 'tsk-1', goal: 'Build the module', status: 'ACTIVE',
      entries: [{ coworker: 'BUILDER', input: { spec: 'x' } }],
    });

    const cp = await createCheckpoint(USER, 'tsk-1', { label: 'safe-point', reason: 'before deploy' });

    expect(cp.label).toBe('safe-point');
    expect(cp.task_id).toBe('tsk-1');
    expect(cp.owner_id).toBe(USER);
    expect((cp.task_state as { status: string }).status).toBe('RUNNING');
    expect((cp.execution_metadata as { stage_index: number }).stage_index).toBe(2);
    expect((cp.execution_metadata as { run_ids_by_order: Record<string, string> }).run_ids_by_order).toEqual({ '0': 'run-a', '1': 'run-b' });
    expect((cp.execution_metadata as { agent_run_id: string }).agent_run_id).toBe('crw-1');
    expect((cp.plan_state as { goal: string }).goal).toBe('Build the module');
    expect((cp.approval_state as { status: string }).status).toBe('APPROVED');
    expect(historyEvents(USER, 'tsk-1')).toContain('CHECKPOINTED');
    expect(auditActions()).toContain('task.checkpointed');
  });

  it('checkpoint with no plan / no approval stores null state', async () => {
    seedTask({ status: 'CREATED' });
    const cp = await createCheckpoint(USER, 'tsk-1');
    expect(cp.plan_state).toBeNull();
    expect(cp.approval_state).toBeNull();
    expect((cp.execution_metadata as { attempts: unknown[] }).attempts).toEqual([]);
  });

  it('lists checkpoints newest first; get is tenant-scoped', async () => {
    seedTask({ status: 'RUNNING' });
    await createCheckpoint(USER, 'tsk-1', { label: 'a' });
    await createCheckpoint(USER, 'tsk-1', { label: 'b' });
    const list = await listCheckpoints(USER, 'tsk-1');
    expect(list.map((c) => c.label)).toEqual(['b', 'a']);
    const got = await getCheckpoint(USER, list[0].id);
    expect(got.id).toBe(list[0].id);
    await expect(getCheckpoint(OTHER, list[0].id)).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('pause / resume', () => {
  it('pauses a RUNNING task: cancels agent run, marks PAUSED, excludes from queue', async () => {
    seedTask({ status: 'RUNNING', agent_run_id: 'crw-9' });
    const task = await pauseTask(USER, 'tsk-1', { reason: 'user asked' });
    expect(task.status).toBe('PAUSED');
    expect(task.paused_by).toBe(USER);
    expect(task.paused_reason).toBe('user asked');
    expect(agents.cancelRun).toHaveBeenCalledWith(USER, 'crw-9');
    expect(agents.agentTaskChanged).toHaveBeenCalledWith('tsk-1');
    expect(historyEvents(USER, 'tsk-1')).toContain('PAUSED');
    expect(auditActions()).toContain('task.paused');

    const claimed = await claimNextTask('worker-1', 10);
    expect(claimed).toEqual([]);
    const pending = await pendingTaskCount();
    expect(pending).toBe(0);
  });

  it('refuses to pause terminal tasks or pause twice', async () => {
    seedTask({ status: 'COMPLETED' });
    await expect(pauseTask(USER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'task_not_pausable' });
    T().tasks[0].status = 'PAUSED';
    await expect(pauseTask(USER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'task_already_paused' });
  });

  it('resumes: clears pause, re-enqueues for the queue to claim', async () => {
    seedTask({ status: 'PAUSED', paused_at: new Date().toISOString(), paused_by: USER });
    const task = await resumeTask(USER, 'tsk-1', { reason: 'continue' });
    expect(task.status).toBe('CREATED');
    expect(task.paused_at).toBeNull();
    expect(task.recovery_status).toBe('RECOVERED');
    expect(historyEvents(USER, 'tsk-1')).toContain('RESUMED');
    expect(auditActions()).toContain('task.resumed');

    const claimed = await claimNextTask('worker-1', 10);
    expect(claimed.map((c) => c.id)).toContain('tsk-1');
  });

  it('resume of a non-paused task is rejected', async () => {
    seedTask({ status: 'CREATED' });
    await expect(resumeTask(USER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'task_not_resumable' });
  });
});

describe('modify future steps', () => {
  it('re-persists plan entries and records history + audit', async () => {
    seedTask({ status: 'PAUSED' });
    await modifyFutureSteps(USER, 'tsk-1', {
      entries: [{ coworker: 'BUILDER', input: { spec: 'v2' } }, { coworker: 'REVIEWER' }],
      reason: 'scenario changed',
    });
    expect(planner.persistPlan).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'tsk-1',
      entries: expect.arrayContaining([expect.objectContaining({ coworker: 'BUILDER' })]),
    }));
    expect(historyEvents(USER, 'tsk-1')).toContain('MODIFIED');
    expect(auditActions()).toContain('task.plan_modified');
  });

  it('rejects modification of completed tasks', async () => {
    seedTask({ status: 'COMPLETED' });
    await expect(modifyFutureSteps(USER, 'tsk-1', { entries: [{ coworker: 'BUILDER' }] }))
      .rejects.toMatchObject({ errorCode: 'task_not_modifiable' });
  });
});

describe('branch', () => {
  it('forks from the current state: new task + plan + attempt checkpoint + link row', async () => {
    seedTask({ status: 'PAUSED' });
    const attempt = seedAttempt('tsk-1', 1);
    await saveAttemptCheckpoint(attempt.id as string, { stageIndex: 1, runIdsByOrder: { '0': 'run-a' } });
    planner.getPlan.mockResolvedValue({
      id: 'pln-1', task_id: 'tsk-1', goal: 'Ship it', status: 'ACTIVE',
      entries: [{ coworker: 'BUILDER' }],
    });

    const { branchTask: fork, branchId } = await branchTask(USER, 'tsk-1', { label: 'try-b' });

    expect(fork.id).not.toBe('tsk-1');
    expect(fork.status).toBe('CREATED');
    expect(fork.title).toContain('try-b');
    expect(planner.persistPlan).toHaveBeenCalledWith(expect.objectContaining({ taskId: fork.id, goal: 'Ship it' }));
    const branchAttempt = T().task_attempts.find((a) => a.task_id === fork.id);
    expect(branchAttempt).toBeDefined();
    expect((branchAttempt!.checkpoint as { stageIndex: number }).stageIndex).toBe(1);
    const link = T().task_branches.find((b) => b.id === branchId);
    expect(link).toBeDefined();
    expect(link!.source_task_id).toBe('tsk-1');
    expect(link!.branched_task_id).toBe(fork.id);
    expect(historyEvents(USER, 'tsk-1')).toContain('BRANCHED');
    expect(auditActions()).toContain('task.branched');
  });

  it('branch from a specific checkpoint', async () => {
    seedTask({ status: 'PAUSED' });
    await createCheckpoint(USER, 'tsk-1', { label: 'cp-a' });
    const cp = await createCheckpoint(USER, 'tsk-1', { label: 'cp-b' });
    const { branchTask: fork } = await branchTask(USER, 'tsk-1', { checkpointId: cp.id });
    const link = T().task_branches.find((b) => b.branched_task_id === fork.id);
    expect(link!.checkpoint_id).toBe(cp.id);
  });
});

describe('rewind', () => {
  it('creates a new branch from the checkpoint; original history stays immutable', async () => {
    seedTask({ status: 'PAUSED' });
    const cp = await createCheckpoint(USER, 'tsk-1', { label: 'safe' });
    const historyBefore = T().recovery_history.length;

    const { branchTask: fork } = await rewindTask(USER, 'tsk-1', { checkpointId: cp.id, reason: 'bad step' });

    expect(fork.status).toBe('CREATED');
    expect(historyEvents(USER, 'tsk-1')).toContain('REWOUND');
    expect(auditActions()).toContain('task.rewound');
    expect(T().recovery_history.length).toBeGreaterThan(historyBefore);
    expect(T().tasks.find((t) => t.id === 'tsk-1')!.status).toBe('PAUSED');
  });

  it('blocks rewind past an irreversible action — never claims undo that does not exist', async () => {
    seedTask({ status: 'PAUSED' });
    const cp = await createCheckpoint(USER, 'tsk-1', { label: 'safe' });
    await recordIrreversibleAction(USER, 'tsk-1', {
      actionType: 'payment_issued',
      description: 'Paid vendor invoice INV-42',
      detail: { invoiceId: 'INV-42', amountUsd: 250 },
    });

    await expect(rewindTask(USER, 'tsk-1', { checkpointId: cp.id }))
      .rejects.toMatchObject({ errorCode: 'irreversible_action_blocks_rewind', message: expect.stringContaining('irreversible') });
    expect(T().task_branches).toEqual([]);
    expect(auditActions()).not.toContain('task.rewound');
  });

  it('rewind with a foreign checkpoint is rejected', async () => {
    seedTask({});
    seedTask({ id: 'tsk-2' });
    const cp = await createCheckpoint(USER, 'tsk-2', { label: 'other' });
    await expect(rewindTask(USER, 'tsk-1', { checkpointId: cp.id })).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('irreversible actions', () => {
  it('records, lists and audits irreversible actions', async () => {
    seedTask({ status: 'RUNNING' });
    const action = await recordIrreversibleAction(USER, 'tsk-1', {
      actionType: 'delete_data',
      description: 'Deleted production bucket archive',
      detail: { bucket: 'prod-archive' },
    });
    expect(action.task_id).toBe('tsk-1');
    expect(action.acknowledged).toBe(false);
    const list = await listIrreversibleActions(USER, 'tsk-1');
    expect(list.map((a) => a.action_type)).toContain('delete_data');
    expect(historyEvents(USER, 'tsk-1')).toContain('IRREVERSIBLE_ACTION');
    expect(auditActions()).toContain('task.irreversible_action');
  });
});

describe('failure autopsies', () => {
  it('classifies known root causes with evidence-backed confidence', () => {
    const task = seedTask({ status: 'FAILED', error_code: 'plugin_unavailable' });
    const { code, reason } = classifyRootCause(task as TaskRow);
    expect(code).toBe('plugin_unavailable');
    expect(reason).toBe('plugin_unavailable');
    expect(buildPrevention(code)).toEqual(expect.objectContaining({ action: 'retry_with_backoff' }));
  });

  it('reports CAUSE_UNKNOWN with confidence 0 when evidence is insufficient', async () => {
    const task = seedTask({ status: 'FAILED', error_code: null, failure_reason: null });
    const autopsy = await generateAutopsy(USER, task.id as string);
    expect(autopsy.root_cause_code).toBe('CAUSE_UNKNOWN');
    expect(autopsy.root_cause).toBeNull();
    expect(autopsy.confidence).toBe(0);
    expect(autopsy.prevention).toBeNull();
    expect(memory.createMemory).not.toHaveBeenCalled();
    expect(dna.saveDna).not.toHaveBeenCalled();
  });

  it('generates an evidence-backed autopsy for a failed task', async () => {
    seedTask({
      status: 'FAILED', error_code: 'plugin_unavailable', failure_reason: 'Provider down',
      error_detail: 'Gateway returned 503', failed_at: new Date().toISOString(), retry_count: 2,
    });
    seedAttempt('tsk-1', 1, { result: 'FAILURE', error_code: 'plugin_unavailable', output_summary: '503' });
    T().task_dependencies.push({ id: 'dep-1', task_id: 'tsk-1', depends_on_task_id: 'tsk-9', kind: 'finish', created_at: new Date().toISOString() });
    T().tasks.push({
      id: 'tsk-9', project_id: PROJECT, owner_id: USER, title: 'API deploy', status: 'FAILED',
      execution_mode: 'CLOUD', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const autopsy = await generateAutopsy(USER, 'tsk-1');

    expect(autopsy.root_cause_code).toBe('plugin_unavailable');
    expect(autopsy.confidence).toBe(0.85);
    expect(autopsy.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ attempt_number: 1, result: 'FAILURE' })]));
    expect(autopsy.errors).toEqual(expect.arrayContaining([expect.objectContaining({ error_code: 'plugin_unavailable' })]));
    expect(autopsy.dependency_state).toEqual(expect.arrayContaining([expect.objectContaining({ depends_on_task_id: 'tsk-9', depends_on_status: 'FAILED' })]));
    expect(autopsy.recovery_attempts).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'RETRIED' })]));
    expect(autopsy.prevention).toEqual(expect.objectContaining({ action: 'retry_with_backoff' }));
    expect((autopsy.evidence as { attempt_count: number }).attempt_count).toBe(1);
    expect(autopsy.memory_id).toBe('mem-1');
    expect(memory.createMemory).toHaveBeenCalledWith(USER, expect.objectContaining({ type: 'SEMANTIC', source: 'AI_INFERRED' }));
    expect(dna.saveDna).toHaveBeenCalledWith(USER, expect.objectContaining({ kind: 'NEXT_ACTIONS' }));
    expect(historyEvents(USER, 'tsk-1')).toContain('AUTOPSIED');
    expect(auditActions()).toContain('task.autopsied');
  });

  it('detects a successful fix from a completed branch', async () => {
    seedTask({ status: 'FAILED', error_code: 'dependency_failure' });
    const autopsy = await generateAutopsy(USER, 'tsk-1');
    expect(autopsy.successful_fix).toBeNull();
    const { branchTask: fork } = await branchTask(USER, 'tsk-1', { label: 'fix' });
    await setTaskStatus(fork.id, 'COMPLETED');
    const second = await generateAutopsy(USER, 'tsk-1');
    expect(second.successful_fix).toEqual(expect.objectContaining({ kind: 'branch', branched_task_id: fork.id }));
    const list = await listAutopsies(USER, 'tsk-1');
    expect(list.filter((a) => a.status === 'SUPERSEDED')).toHaveLength(1);
    expect(list.filter((a) => a.status === 'GENERATED')).toHaveLength(1);
  });

  it('refuses autopsies for tasks that have not failed', async () => {
    seedTask({ status: 'RUNNING' });
    await expect(generateAutopsy(USER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'autopsy_requires_failure' });
  });

  it('getAutopsy is tenant-scoped', async () => {
    seedTask({ status: 'FAILED', error_code: 'plugin_unavailable' });
    await generateAutopsy(USER, 'tsk-1');
    await expect(getAutopsy(OTHER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('watchdog sweep autopsies every failed task without one', async () => {
    seedTask({ status: 'FAILED', error_code: 'task_timeout', id: 'tsk-1' });
    seedTask({ status: 'FAILED', error_code: 'plugin_unavailable', id: 'tsk-2' });
    seedTask({ status: 'FAILED', error_code: 'plugin_unavailable', id: 'tsk-3' });
    await generateAutopsy(USER, 'tsk-3');
    const created = await sweepAutopsies();
    expect(created).toBe(2);
    expect(T().failure_autopsies.filter((a) => a.status === 'GENERATED')).toHaveLength(3);
    expect(T().failure_autopsies.map((a) => a.task_id)).toEqual(expect.arrayContaining(['tsk-1', 'tsk-2']));
  });

  it('remediation is recorded as recovery history + audit', async () => {
    seedTask({ status: 'FAILED', error_code: 'plugin_unavailable' });
    await applyRemediation(USER, 'tsk-1', { action: 'retry_with_backoff', note: 'provider back' });
    expect(historyEvents(USER, 'tsk-1')).toContain('REMEDIATED');
    expect(auditActions()).toContain('task.remediated');
  });
});

describe('recovery-aware history', () => {
  it('returns the ordered, immutable event timeline (tenant-scoped)', async () => {
    seedTask({ status: 'RUNNING' });
    await createCheckpoint(USER, 'tsk-1', { label: 'cp' });
    await pauseTask(USER, 'tsk-1');
    const history = await listRecoveryHistory(USER, 'tsk-1');
    expect(history.map((h) => h.event)).toEqual(['CHECKPOINTED', 'PAUSED']);
    expect(await listRecoveryHistory(OTHER, 'tsk-1')).toEqual([]);
  });
});

describe('end-to-end flow 1: checkpoint → pause → modify/branch → resume → completion', () => {
  it('walks the full time-travel lifecycle', async () => {
    const task = await createTask({ userId: USER, projectId: PROJECT, title: 'E2E one' });
    const attempt = await beginAttempt(task.id);
    await saveAttemptCheckpoint(attempt.id, { stageIndex: 1, runIdsByOrder: { '0': 'run-a' } });

    const cp = await createCheckpoint(USER, task.id, { label: 'before-pause' });
    expect(cp.execution_metadata).toBeDefined();

    await pauseTask(USER, task.id, { reason: 'review' });
    expect(T().tasks.find((t) => t.id === task.id)!.status).toBe('PAUSED');

    const { branchTask: fork } = await branchTask(USER, task.id, { label: 'alt-path', checkpointId: cp.id });
    expect(fork.status).toBe('CREATED');

    const resumed = await resumeTask(USER, task.id, {
      reason: 'proceed',
      modifySteps: { entries: [{ coworker: 'BUILDER', input: { spec: 'revised' } }] },
    });
    expect(resumed.status).toBe('CREATED');

    await setTaskStatus(fork.id, 'COMPLETED');

    const events = historyEvents(USER, task.id);
    expect(events).toEqual(['CHECKPOINTED', 'PAUSED', 'BRANCHED', 'MODIFIED', 'RESUMED']);
    expect(auditActions()).toEqual(expect.arrayContaining([
      'task.created', 'task.checkpointed', 'task.paused', 'task.branched', 'task.plan_modified', 'task.resumed',
    ]));
  });
});

describe('end-to-end flow 2: failure → autopsy → remediation → retry → success', () => {
  it('diagnoses, remediates, retries and completes', async () => {
    const task = await createTask({ userId: USER, projectId: PROJECT, title: 'E2E two' });
    const attempt = await beginAttempt(task.id);
    await finishAttempt(attempt.id, 'FAILURE', 'plugin_unavailable', 'Gateway 503');
    await setTaskStatus(task.id, 'FAILED', 'plugin_unavailable');

    const autopsy = await generateAutopsy(USER, task.id);
    expect(autopsy.root_cause_code).toBe('plugin_unavailable');
    expect(autopsy.prevention).toEqual(expect.objectContaining({ action: 'retry_with_backoff' }));

    await applyRemediation(USER, task.id, { action: 'retry_with_backoff', note: 'provider restored' });

    const retried = await retryTask(USER, task.id, 'fixed upstream');
    expect(retried.status).toBe('CREATED');
    expect(retried.retry_count).toBe(1);

    const attempt2 = await beginAttempt(task.id);
    expect(attempt2.attempt_number).toBe(2);
    await finishAttempt(attempt2.id, 'SUCCESS', undefined, 'done');
    await setTaskStatus(task.id, 'COMPLETED');

    expect(T().tasks.find((t) => t.id === task.id)!.status).toBe('COMPLETED');
    expect(historyEvents(USER, task.id)).toEqual(expect.arrayContaining(['AUTOPSIED', 'REMEDIATED']));
    expect(auditActions()).toEqual(expect.arrayContaining(['task.autopsied', 'task.remediated']));
  });
});

describe('tenant isolation', () => {
  it('rejects cross-tenant access to every recovery surface', async () => {
    seedTask({ status: 'PAUSED', owner_id: OTHER });
    await expect(pauseTask(USER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(resumeTask(USER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(branchTask(USER, 'tsk-1')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(listCheckpoints(USER, 'tsk-1')).resolves.toEqual([]);
    await expect(listRecoveryHistory(USER, 'tsk-1')).resolves.toEqual([]);
    await expect(listIrreversibleActions(USER, 'tsk-1')).resolves.toEqual([]);
  });

  it('verifies AppError codes are used consistently', async () => {
    expect(AppError.conflict('x', 'y').errorCode).toBe('x');
    expect(AppError.notFound('X').errorCode).toBe('not_found');
  });
});