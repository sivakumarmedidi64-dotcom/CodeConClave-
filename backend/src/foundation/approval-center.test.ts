/**
 * CodeConClave â€” PHASE 4C approval-center tests.
 * Server-authoritative human-gate execution: the server decides whether an
 * approval is needed, who may decide, and whether the approval still holds at
 * execution time. "Approved" is never a client claim â€” every execution
 * revalidates status, expiry, action/resource coverage, the policy engine,
 * capabilities and device authorization before any tool runs.
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
    return { rows: rows ?? state.rows, rowCount: rows ? rows.length : state.rows.length };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { agentWs } from '../modules/agent/ws.js';
import {
  proposeApproval,
  decideApproval,
  executeApprovedAction,
  getApproval,
  listApprovals,
  expireStaleApprovals,
} from '../modules/execution/approvals.js';
import { registerTool } from '../modules/execution/toolcalls.js';
import { registerGrants, revokeGrants } from '../modules/execution/policy.js';
import { Timeouts } from '../modules/execution/policy-shared.js';
import { AuditAction } from '@codeconclave/shared';

const USER_ID = 'usr_4c';
const OTHER_USER = 'usr_other';
const DEVICE_ID = 'dev_4c';

type HubInternals = { clients: Map<string, { readyState: number; send: (raw: string) => void }> };

function hub(): HubInternals {
  return agentWs() as unknown as HubInternals;
}

function attachAgentSocket(): void {
  hub().clients.set(`${USER_ID}:${DEVICE_ID}`, { readyState: 1, send: () => {} });
}

function approvalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'app_4c1',
    task_id: null,
    owner_id: USER_ID,
    detail: {},
    risk_level: 'HIGH',
    status: 'PENDING',
    decision: null,
    decided_by: null,
    decided_at: null,
    expires_at: new Date(Date.now() + 30 * 60 * 1000),
    created_at: new Date(),
    action_type: 'file_write',
    coworker: 'tester',
    model: 'deepseek-v4',
    justification: 'apply reviewed patch',
    affected_resources: [{ type: 'file', ref: 'src/app.ts' }],
    proposed_action: { tool: 'file_write', input: { path: 'src/app.ts' } },
    execution_status: null,
    execution_started_at: null,
    execution_completed_at: null,
    execution_result: null,
    audit_reference: null,
    batch_group: null,
    ...overrides,
  };
}

function pairedDeviceRow(state = 'PAIRED'): Record<string, unknown> {
  return { id: DEVICE_ID, name: 'laptop', state, capabilities: ['file_read', 'file_write', 'terminal_exec'] };
}

function remoteSessionRow(): Record<string, unknown> {
  return { id: 'rms_1', state: 'ACTIVE', expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null };
}

/** Pending-dedupe query â†’ `pending` rows; post-write getApproval â†’ the created row. */
function resolveApprovals(pending: Record<string, unknown>[] = [], after: Record<string, unknown> = approvalRow()): void {
  db.state.resolve = (text) => {
    if (text.includes('UPDATE approvals') && (text.includes('decided_by') || text.includes('execution_started_at'))) {
      // Conditional writes (decide / execution claim) succeed when the row
      // still carries the expected state — the mock models the won race.
      // Race-lost tests override resolve to return [] for these statements.
      return [after];
    }
    if (!text.includes('FROM approvals')) return null;
    if (text.includes('action_type =')) return pending;
    return [after];
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  hub().clients.clear();
  registerGrants([
    { id: 'g-r', userId: USER_ID, capability: 'READ_WORKSPACE', scope: '*', expiresAt: Date.now() + 60_000 },
    { id: 'g-w', userId: USER_ID, capability: 'WRITE_WORKSPACE', scope: '*', expiresAt: Date.now() + 60_000 },
    { id: 'g-x', userId: USER_ID, capability: 'EXECUTE_COMMAND', scope: '*', expiresAt: Date.now() + 60_000 },
  ]);
});

afterEach(() => {
  hub().clients.clear();
  revokeGrants(USER_ID);
  db.state.resolve = null;
});

describe('proposeApproval â€” server-classified risk tiers', () => {
  const base = (actionType: string, resources: { type: string; ref: string }[]) => ({
    actionType,
    coworker: 'tester',
    model: 'deepseek-v4',
    justification: 'apply reviewed patch',
    affectedResources: resources,
    proposedAction: { tool: 'file_write', input: { path: resources[0]?.ref } },
  });

  it('HIGH file_delete gets a 30-minute default window (spec default)', async () => {
    resolveApprovals([]);
    await proposeApproval(USER_ID, base('file_delete', [{ type: 'file', ref: 'src/old.ts' }]));
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[4]).toBe('HIGH');
    expect(insert.params[5]).toBe(Timeouts.APPROVAL_DEFAULT_EXPIRY_MS);
    expect(insert.params[6]).toBe('file_delete');
    expect(insert.text).toContain("'PENDING'");
  });

  it('LOW file_read is classified LOW by the server', async () => {
    resolveApprovals([]);
    await proposeApproval(USER_ID, base('file_read', [{ type: 'file', ref: 'src/app.ts' }]));
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[4]).toBe('LOW');
  });

  it('MEDIUM file_write is classified MEDIUM by the server', async () => {
    resolveApprovals([]);
    await proposeApproval(USER_ID, base('file_write', [{ type: 'file', ref: 'src/app.ts' }]));
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[4]).toBe('MEDIUM');
  });

  it('CRITICAL actions (secret_access) are classified CRITICAL', async () => {
    resolveApprovals([]);
    await proposeApproval(USER_ID, base('secret_access', [{ type: 'secret', ref: 'secrets/prod' }]));
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[4]).toBe('CRITICAL');
  });

  it('an explicit riskLevel from the client is honored', async () => {
    resolveApprovals([]);
    await proposeApproval(USER_ID, { ...base('file_write', [{ type: 'file', ref: 'src/app.ts' }]), riskLevel: 'HIGH' });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(insert.params[4]).toBe('HIGH');
  });

  it('unknown action types are refused before anything is written', async () => {
    await expect(proposeApproval(USER_ID, base('rm_rf', [{ type: 'file', ref: 'x' }]))).rejects.toMatchObject({
      errorCode: 'unknown_action_type',
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO approvals'))).toBe(false);
  });

  it('a batch proposal stores one approval covering many resources (4 edits + 3 tests + 1 formatter)', async () => {
    resolveApprovals([]);
    const resources = [
      { type: 'file', ref: 'src/app.ts' },
      { type: 'file', ref: 'src/api.ts' },
      { type: 'file', ref: 'src/types.ts' },
      { type: 'file', ref: 'src/util.ts' },
      { type: 'test', ref: 'test/app.test.ts' },
      { type: 'test', ref: 'test/api.test.ts' },
      { type: 'test', ref: 'test/util.test.ts' },
      { type: 'formatter', ref: 'prettier' },
    ];
    const result = await proposeApproval(
      USER_ID,
      { ...base('batch', resources), proposedAction: { tool: 'file_write' } },
    );
    expect(result.approval).not.toBeNull();
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO approvals'))!;
    expect(JSON.parse(String(insert.params[10]))).toHaveLength(8);
    const resourcesInsert = db.state.calls.find((c) => c.text.includes('INSERT INTO approval_resources'))!;
    expect(resourcesInsert.text.match(/\$/g)!.length).toBe(32); // 8 tuples Ã— 4 params
  });
});

describe('proposeApproval â€” duplicates and audit', () => {
  it('a duplicate PENDING proposal returns the existing approval (idempotent retry)', async () => {
    const existing = approvalRow({ action_type: 'file_write', affected_resources: [{ type: 'file', ref: 'src/app.ts' }] });
    resolveApprovals([existing]);
    const first = await proposeApproval(USER_ID, {
      actionType: 'file_write',
      justification: 'apply reviewed patch',
      affectedResources: [{ type: 'file', ref: 'src/app.ts' }],
      proposedAction: {},
    });
    expect(first.approval!.id).toBe('app_4c1');
    const inserts = db.state.calls.filter((c) => c.text.includes('INSERT INTO approvals'));
    expect(inserts).toHaveLength(0);
  });

  it('a duplicate with different resources creates a new approval', async () => {
    resolveApprovals([approvalRow({ action_type: 'file_write', affected_resources: [{ type: 'file', ref: 'other.ts' }] })]);
    await proposeApproval(USER_ID, {
      actionType: 'file_write',
      justification: 'apply reviewed patch',
      affectedResources: [{ type: 'file', ref: 'src/app.ts' }],
      proposedAction: {},
    });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO approvals'))).toBe(true);
  });

  it('audits approval.created with the action type and resources', async () => {
    resolveApprovals([]);
    await proposeApproval(USER_ID, {
      actionType: 'file_write',
      justification: 'apply reviewed patch',
      affectedResources: [{ type: 'file', ref: 'src/app.ts' }],
      proposedAction: {},
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval.created',
        resourceType: 'approval',
        detail: expect.objectContaining({ actionType: 'file_write', resources: ['src/app.ts'] }),
      }),
    );
  });
});

describe('decideApproval â€” server revalidation', () => {
  it('only the owner may decide (wrong user / wrong tenant â†’ 404)', async () => {
    db.state.resolve = (text) => (text.includes('FROM approvals') ? null : null);
    await expect(decideApproval(OTHER_USER, 'app_4c1', 'APPROVE')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(decideApproval(OTHER_USER, 'app_4c1', 'REJECT')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('an already-approved approval cannot be decided again', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED', decided_at: new Date() }));
    await expect(decideApproval(USER_ID, 'app_4c1', 'APPROVE')).rejects.toMatchObject({ errorCode: 'approval_not_pending' });
  });

  it('an already-rejected approval cannot be decided again', async () => {
    resolveApprovals([], approvalRow({ status: 'REJECTED', decided_at: new Date() }));
    await expect(decideApproval(USER_ID, 'app_4c1', 'APPROVE')).rejects.toMatchObject({ errorCode: 'approval_not_pending' });
  });

  it('an expired approval cannot be decided', async () => {
    resolveApprovals([], approvalRow({ expires_at: new Date(Date.now() - 1000) }));
    await expect(decideApproval(USER_ID, 'app_4c1', 'APPROVE')).rejects.toMatchObject({ errorCode: 'approval_expired' });
  });

  it('a concurrent decision wins exactly once: the loser gets approval_not_pending, no overwrite', async () => {
    // SELECT still sees PENDING, but the conditional UPDATE matches 0 rows —
    // another decide (e.g. REJECT) committed first.
    db.state.resolve = (text) => {
      if (text.includes('UPDATE approvals')) return [];
      if (text.includes('FROM approvals')) return [approvalRow({ status: 'PENDING' })];
      return null;
    };
    await expect(decideApproval(USER_ID, 'app_4c1', 'APPROVE')).rejects.toMatchObject({
      errorCode: 'approval_not_pending',
    });
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE approvals'))!;
    expect(upd.text).toContain("AND status = 'PENDING'");
  });
});

describe('executeApprovedAction â€” human-gate execution', () => {
  it('executes an approved file_write, records EXECUTED + SUCCEEDED + audit trail', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED' }));
    registerTool('file_write', async () => ({ ok: true, wrote: 'src/app.ts' }));
    const result = await executeApprovedAction(USER_ID, 'app_4c1', {
      tool: 'file_write',
      input: { path: 'src/app.ts', content: 'x' },
    });
    expect(result.status).toBe('APPROVED'); // row mock returns the pre-update row
    const success = db.state.calls.find((c) => c.text.includes("status = 'EXECUTED'"))!;
    expect(success.text).toContain("execution_status = 'SUCCEEDED'");
    expect(success.params[2]).toBe('tool:file_write');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.execution_started' }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.execution_succeeded' }));
  });

  it('refuses PENDING approvals â€” approval is not a client claim', async () => {
    resolveApprovals([], approvalRow({ status: 'PENDING' }));
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/app.ts' } }),
    ).rejects.toMatchObject({ errorCode: 'approval_not_approved' });
    expect(db.state.calls.some((c) => c.text.includes("execution_status = 'RUNNING'"))).toBe(false);
  });

  it('an APPROVED approval past its expiry can never execute', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED', expires_at: new Date(Date.now() - 1000) }));
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/app.ts' } }),
    ).rejects.toMatchObject({ errorCode: 'approval_expired' });
    const expire = db.state.calls.find((c) => c.text.includes("status = 'EXPIRED'"))!;
    expect(expire).toBeDefined();
  });

  it('an executed tool outside the approved action type is refused (action mismatch)', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED', action_type: 'file_delete' }));
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/app.ts' } }),
    ).rejects.toMatchObject({ errorCode: 'approval_action_mismatch' });
  });

  it('a touched resource outside the approved set is refused (resource mismatch)', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED' }));
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/other.ts' } }),
    ).rejects.toMatchObject({ errorCode: 'approval_resource_mismatch' });
  });

  it('approval never bypasses the policy engine (dangerous command denied)', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED', action_type: 'terminal_exec', affected_resources: [{ type: 'shell', ref: '*' }] }));
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', {
        tool: 'terminal_exec',
        input: { command: 'rm -rf /' },
        deviceId: DEVICE_ID,
      }),
    ).rejects.toMatchObject({ errorCode: 'baseline_commands' });
  });

  it('approval never bypasses capability revalidation (expired grant denied)', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED' }));
    revokeGrants(USER_ID);
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/app.ts' } }),
    ).rejects.toMatchObject({ errorCode: 'capability' });
  });

  it('terminal execution requires a device id', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED', action_type: 'terminal_exec', affected_resources: [{ type: 'shell', ref: '*' }] }));
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'terminal_exec', input: { command: 'git status' } }),
    ).rejects.toMatchObject({ errorCode: 'device_required' });
  });

  it('a revoked device blocks terminal execution', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED', action_type: 'terminal_exec', affected_resources: [{ type: 'shell', ref: '*' }] }));
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvalRow({ status: 'APPROVED', action_type: 'terminal_exec', affected_resources: [{ type: 'shell', ref: '*' }] })];
      if (text.includes('FROM devices')) return [pairedDeviceRow('REVOKED')];
      return null;
    };
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'terminal_exec', input: { command: 'git status' }, deviceId: DEVICE_ID }),
    ).rejects.toMatchObject({ errorCode: 'device_not_paired' });
  });

  it('an offline agent blocks terminal execution', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvalRow({ status: 'APPROVED', action_type: 'terminal_exec', affected_resources: [{ type: 'shell', ref: '*' }] })];
      if (text.includes('FROM devices')) return [pairedDeviceRow()];
      return null;
    };
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'terminal_exec', input: { command: 'git status' }, deviceId: DEVICE_ID }),
    ).rejects.toMatchObject({ errorCode: 'local_agent_offline' });
  });

  it('remote execution still requires an active remote session', async () => {
    attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvalRow({ status: 'APPROVED', action_type: 'remote_exec', affected_resources: [{ type: 'shell', ref: '*' }] })];
      if (text.includes('FROM devices')) return [pairedDeviceRow()];
      if (text.includes('FROM remote_sessions')) return [];
      return null;
    };
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'terminal_exec', input: { command: 'git status' }, deviceId: DEVICE_ID }),
    ).rejects.toMatchObject({ errorCode: 'remote_session_required' });
  });

  it('a terminal execution on an online paired device with a session succeeds', async () => {
    attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('FROM approvals')) return [approvalRow({ status: 'APPROVED', action_type: 'terminal_exec', affected_resources: [{ type: 'shell', ref: '*' }] })];
      if (text.includes('FROM devices')) return [pairedDeviceRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      // Atomic execution claim wins the race in this test.
      if (text.includes('UPDATE approvals') && text.includes('execution_started_at')) {
        return [approvalRow({ status: 'APPROVED', action_type: 'terminal_exec' })];
      }
      return null;
    };
    registerTool('terminal_exec', async () => ({ ok: true, command: 'git status' }));
    await executeApprovedAction(USER_ID, 'app_4c1', {
      tool: 'terminal_exec',
      input: { command: 'git status' },
      deviceId: DEVICE_ID,
    });
    const success = db.state.calls.find((c) => c.text.includes("execution_status = 'SUCCEEDED'"))!;
    expect(success).toBeDefined();
  });

  it('a failing tool records EXECUTED + FAILED and audits execution_failed', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED' }));
    registerTool('file_write', async () => {
      throw new Error('disk full');
    });
    await executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/app.ts' } });
    const failed = db.state.calls.find((c) => c.text.includes("execution_status = 'FAILED'"))!;
    expect(failed).toBeDefined();
    expect(failed.text).toContain("status = 'EXECUTED'");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approval.execution_failed', detail: expect.objectContaining({ error: 'disk full' }) }),
    );
  });

  it('a concurrent execute loses the atomic claim: conflict, tool never runs twice', async () => {
    let runs = 0;
    registerTool('file_write', async () => {
      runs += 1;
      return { ok: true };
    });
    // SELECT sees APPROVED, but the claim UPDATE matches 0 rows — another
    // executor already holds RUNNING.
    db.state.resolve = (text) => {
      if (text.includes('UPDATE approvals')) return [];
      if (text.includes('FROM approvals')) return [approvalRow({ status: 'APPROVED' })];
      return null;
    };
    await expect(
      executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/app.ts' } }),
    ).rejects.toMatchObject({ errorCode: 'approval_execution_conflict' });
    expect(runs).toBe(0);
    const claim = db.state.calls.find((c) => c.text.includes("execution_status = 'RUNNING'"))!;
    expect(claim.text).toContain("status = 'APPROVED'");
    expect(claim.text).toContain("execution_status <> 'RUNNING'");
  });

  it('execute after a FAILED run may retry (claim allows non-RUNNING states)', async () => {
    resolveApprovals([], approvalRow({ status: 'APPROVED', execution_status: 'FAILED' }));
    registerTool('file_write', async () => ({ ok: true, retried: true }));
    await executeApprovedAction(USER_ID, 'app_4c1', { tool: 'file_write', input: { path: 'src/app.ts' } });
    const success = db.state.calls.find((c) => c.text.includes("execution_status = 'SUCCEEDED'"))!;
    expect(success).toBeDefined();
  });
});

describe('expiry sweep and listing', () => {
  it('expireStaleApprovals audits every expiry', async () => {
    db.state.rows = [{ id: 'app_1' }, { id: 'app_2' }];
    expect(await expireStaleApprovals()).toBe(2);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.expired', resourceId: 'app_1' }));
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.expired', resourceId: 'app_2' }));
  });

  it('getApproval and listApprovals expose the phase 4c fields', async () => {
    resolveApprovals(
      [],
      approvalRow({
        action_type: 'file_delete',
        coworker: 'tester',
        justification: 'remove dead code',
        affected_resources: [{ type: 'file', ref: 'src/old.ts' }],
      }),
    );
    const row = await getApproval(USER_ID, 'app_4c1');
    expect(row.action_type).toBe('file_delete');
    expect(row.justification).toBe('remove dead code');
    expect((row.affected_resources as { ref: string }[])[0]!.ref).toBe('src/old.ts');
    const list = await listApprovals(USER_ID, 'PENDING');
    expect(list[0]!.coworker).toBe('tester');
  });
});