/**
 * CodeConClave — task engine foundation tests.
 * Covers: risk→approval mapping, attempt accounting, claim gating,
 * heartbeat watchdog transitions, approval TTLs. DB interaction is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/notifications/service.js', () => ({ notify, notifyUser: notify }));
const recordUsage = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/workspace/service.js', () => ({ recordUsage }));

import { createTask, beginAttempt, HEARTBEAT_TTL_MS, TASK_TIMEOUT_MS, touchTask, heartbeatRunningTasks } from '../modules/execution/tasks.js';
import { createApproval, decideApproval, expireStaleApprovals } from '../modules/execution/approvals.js';
import { claimNextTask, recoverStaleTasks, failTimedOutTasks, expireWaitingApprovals } from '../shared/queue.js';
import { Timeouts } from '../modules/execution/policy-shared.js';

function taskRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    conversation_id: null,
    owner_id: 'u1',
    title: 't',
    description: null,
    plan: null,
    status: 'CREATED',
    risk_level: 'MEDIUM',
    required_approval: false,
    approval_id: null,
    coworker_pipeline: null,
    execution_mode: 'CLOUD',
    timeout_ms: TASK_TIMEOUT_MS,
    started_at: null,
    completed_at: null,
    failed_at: null,
    error_code: null,
    error_detail: null,
    attempt_count: 0,
    max_attempts: 3,
    last_heartbeat_at: null,
    watchdog_checked_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function approvalRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    task_id: null,
    owner_id: 'u1',
    detail: {},
    risk_level: 'HIGH',
    status: 'PENDING',
    decision: null,
    decided_by: null,
    decided_at: null,
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  notify.mockClear();
  recordUsage.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTask — risk maps to required approval', () => {
  it('HIGH and CRITICAL risk always require approval', async () => {
    for (const risk of ['HIGH', 'CRITICAL']) {
      db.state.calls = [];
      db.state.resolve = (text, params) => {
        if (text.includes('FROM projects WHERE id = $1')) return [{ id: String(params[0]), owner_id: 'u1', team_id: null, deleted_at: null }];
        return text.includes('FROM tasks') ? [taskRow(String(params[0]))] : null;
      };
      const task = await createTask({ userId: 'u1', projectId: 'p1', title: 't', riskLevel: risk as 'HIGH' | 'CRITICAL' });
      const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO tasks'))!;
      expect(insert.params[6]).toBe(risk);
      expect(insert.params[7]).toBe(true);
      expect(task.status).toBe('CREATED');
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.created' }));
    }
  });

  it('LOW and MEDIUM risk do not require approval', async () => {
    for (const risk of ['LOW', 'MEDIUM']) {
      db.state.calls = [];
      db.state.resolve = (text, params) => {
        if (text.includes('FROM projects WHERE id = $1')) return [{ id: String(params[0]), owner_id: 'u1', team_id: null, deleted_at: null }];
        return text.includes('FROM tasks') ? [taskRow(String(params[0]), { risk_level: risk })] : null;
      };
      const task = await createTask({ userId: 'u1', projectId: 'p1', title: 't', riskLevel: risk as 'LOW' | 'MEDIUM' });
      const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO tasks'))!;
      expect(insert.params[7]).toBe(false);
      expect(task.risk_level).toBe(risk);
    }
  });

  it('refuses to file a task into a project the caller cannot access (no planting)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM projects WHERE id = $1')) return [];
      return null;
    };
    await expect(createTask({ userId: 'u1', projectId: 'p-victim', title: 't' })).rejects.toMatchObject({
      errorCode: 'not_found',
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO tasks'))).toBe(false);
  });

  it('refuses a task linked to a foreign conversation', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM projects WHERE id = $1')) {
        return [{ id: String(params[0]), owner_id: 'u1', team_id: null, deleted_at: null }];
      }
      if (text.includes('SELECT * FROM conversations')) return [];
      return null;
    };
    await expect(
      createTask({ userId: 'u1', projectId: 'p1', conversationId: 'c-victim', title: 't' }),
    ).rejects.toMatchObject({ errorCode: 'not_found' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO tasks'))).toBe(false);
  });

  it('defaults risk to MEDIUM and parameters to standard values', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM projects WHERE id = $1')) return [{ id: String(params[0]), owner_id: 'u1', team_id: null, deleted_at: null }];
      return text.includes('FROM tasks') ? [taskRow(String(params[0]))] : null;
    };
    await createTask({ userId: 'u1', projectId: 'p1', title: 't' });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO tasks'))!;
    expect(insert.params[6]).toBe('MEDIUM');
    expect(insert.params[7]).toBe(false);
    expect(insert.params[10]).toBe(TASK_TIMEOUT_MS);
    expect(insert.params[11]).toBe(3);
    expect(insert.text).toContain("'CREATED'");
  });
});

describe('attempt accounting', () => {
  it('beginAttempt computes next attempt number and bumps attempt_count', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('COALESCE(MAX(attempt_number)')) return [{ n: 2 }];
      if (text.includes('FROM task_attempts') && text.includes('WHERE id = $1')) {
        return [{ id: String(params[0]), task_id: 't1', attempt_number: 3, started_at: new Date() }];
      }
      return null;
    };
    const attempt = await beginAttempt('t1');
    expect(attempt.attempt_number).toBe(3);
    const bump = db.state.calls.find((c) => c.text.includes('attempt_count = attempt_count + 1'))!;
    expect(bump.params[0]).toBe('t1');
  });

  it('caps attempts in the claim gate (attempt_count < max_attempts)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('UPDATE tasks')) return [{ id: 't1', project_id: 'p1', owner_id: 'u1', title: 't', risk_level: 'LOW', execution_mode: 'CLOUD' }];
      return null;
    };
    const claimed = await claimNextTask('worker-1', 1);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe('t1');
    const claim = db.state.calls.find((c) => c.text.includes('FOR UPDATE SKIP LOCKED'))!;
    expect(claim.text).toContain('attempt_count < max_attempts');
    expect(claim.text).toContain("status IN ('CREATED','PLANNED','CHANGED')");
    expect(claim.text).toContain("'CLOUD','HYBRID'");
    expect(claim.text).toContain('required_approval = false OR approval_id IS NOT NULL');
    expect(claim.params[0]).toBe(1);
  });
});

describe('watchdog transitions — heartbeat, timeout, approvals', () => {
  it('recoverStaleTasks bounces stale RUNNING tasks with a heartbeat error code', async () => {
    db.state.rowCount = 1;
    const n = await recoverStaleTasks(HEARTBEAT_TTL_MS);
    expect(n).toBe(1);
    const call = db.state.calls.find((c) => c.text.includes('recovered_heartbeat_timeout'))!;
    expect(call.params[0]).toBe(HEARTBEAT_TTL_MS);
    expect(call.text).toContain("status = 'RUNNING'");
  });

  it('failTimedOutTasks marks over-budget tasks TIMED_OUT', async () => {
    db.state.rowCount = 4;
    expect(await failTimedOutTasks()).toBe(4);
    const call = db.state.calls.find((c) => c.text.includes("'TIMED_OUT'"))!;
    expect(call.text).toContain('task_timeout');
    expect(call.text).toContain('started_at + (timeout_ms ||');
  });

  it('expireWaitingApprovals cancels tasks left WAITING_APPROVAL beyond 2 hours', async () => {
    db.state.rowCount = 2;
    expect(await expireWaitingApprovals()).toBe(2);
    const call = db.state.calls.find((c) => c.text.includes('approval_not_answered'))!;
    expect(call.text).toContain("status = 'CANCELLED'");
    expect(call.text).toContain("interval '2 hours'");
  });

  it('touchTask refreshes the heartbeat without changing status', async () => {
    await touchTask('t1');
    const call = db.state.calls.find((c) => c.text.includes('last_heartbeat_at = now()'))!;
    expect(call.params[0]).toBe('t1');
    expect(call.text).not.toContain('status');
  });

  it('heartbeatRunningTasks refreshes only RUNNING tasks', async () => {
    db.state.rowCount = 3;
    expect(await heartbeatRunningTasks()).toBe(3);
    const call = db.state.calls.find((c) => c.text.includes('UPDATE tasks SET last_heartbeat_at'))!;
    expect(call.text).toContain("status = 'RUNNING'");
  });
});

describe('approvals — TTL by risk, decisions, expiry sweep', () => {
  it('HIGH/CRITICAL approvals get the max 30-minute window', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM approvals') ? [approvalRow(String(params[0]))] : null);
    await createApproval({ ownerId: 'u1', riskLevel: 'HIGH', detail: { command: 'deploy' } });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[5]).toBe(Timeouts.APPROVAL_MAX_TTL_MS);
    expect(insert.text).toContain("'PENDING'");
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'task.approval.requested' }));
  });

  it('LOW/MEDIUM approvals get the default 10-minute window', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM approvals') ? [approvalRow(String(params[0]))] : null);
    await createApproval({ ownerId: 'u1', riskLevel: 'MEDIUM', detail: {} });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[5]).toBe(Timeouts.APPROVAL_DEFAULT_TTL_MS);
  });

  it('an explicit longer window is capped at 30 minutes', async () => {
    db.state.resolve = (text, params) => (text.includes('FROM approvals') ? [approvalRow(String(params[0]))] : null);
    await createApproval({ ownerId: 'u1', riskLevel: 'HIGH', detail: {}, expiresInMs: 60 * 60 * 1000 });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[5]).toBe(Timeouts.APPROVAL_MAX_TTL_MS);
  });

  it('decideApproval approves and audits only a PENDING, unexpired approval', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM approvals')) return [approvalRow(String(params[0]))];
      // Conditional decide UPDATE wins the race in this test (this mock
      // reports rowCount from state.rowCount, not from rows).
      if (text.includes('UPDATE approvals')) {
        db.state.rowCount = 1;
        return [approvalRow(String(params[0]), { status: 'APPROVED' })];
      }
      return null;
    };
    const result = await decideApproval('u1', 'a1', 'APPROVE', 'looks good');
    expect(result.status).toBe('PENDING');
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE approvals'))!;
    expect(upd.params[1]).toBe('APPROVED');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.granted' }));
  });

  it('rejects a decision on an expired approval', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM approvals')) return [approvalRow(String(params[0]), { expires_at: new Date(Date.now() - 1000) })];
      return null;
    };
    await expect(decideApproval('u1', 'a1', 'APPROVE')).rejects.toMatchObject({ errorCode: 'approval_expired' });
    const sweep = db.state.calls.find((c) => c.text.includes('status = \'EXPIRED\''))!;
    expect(sweep).toBeDefined();
  });

  it('expireStaleApprovals returns the number of expirations', async () => {
    db.state.rowCount = 5;
    expect(await expireStaleApprovals()).toBe(5);
    const call = db.state.calls.find((c) => c.text.includes("SET status = 'EXPIRED'"))!;
    expect(call.text).toContain("status = 'PENDING' AND expires_at <= now()");
  });
});