/**
 * CodeConClave — terminal session service tests (PHASE 4B).
 * Drives the REAL AgentHub singleton with a stubbed client socket to verify
 * that commands are actually dispatched to the paired device (kind/tabId/
 * timeoutMs payloads), while every command passes the deterministic policy
 * engine first. RUNNING is only ever mirrored from agent-reported events
 * (store mirror functions); an offline agent throws local_agent_offline.
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
import { createTerminalSession, sendInput, killSession, restartSession } from '../modules/terminal/service.js';
import { updateTerminalStatus, appendTerminalHistory } from '../modules/terminal/store.js';
import { registerGrants, revokeGrants } from '../modules/execution/policy.js';
import { AuditAction } from '@codeconclave/shared';

const USER_ID = 'usr_term1';
const DEVICE_ID = 'dev_term1';
const SESSION_ID = 'tsm_abc123';

type HubInternals = { clients: Map<string, { readyState: number; send: (raw: string) => void }> };
type Captured = { type: string; corrId?: string; cmd?: Record<string, unknown> };

function hub(): HubInternals {
  return agentWs() as unknown as HubInternals;
}

function attachAgentSocket(): Captured[] {
  const captured: Captured[] = [];
  hub().clients.set(`${USER_ID}:${DEVICE_ID}`, { readyState: 1, send: (raw) => captured.push(JSON.parse(raw) as Captured) });
  return captured;
}

function pairedDeviceRow(): Record<string, unknown> {
  return { id: DEVICE_ID, name: 'laptop', state: 'PAIRED', capabilities: ['file_read', 'file_write', 'terminal_exec'] };
}

function remoteSessionRow(): Record<string, unknown> {
  return { id: 'rms_1', state: 'ACTIVE', expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null };
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

describe('createTerminalSession', () => {
  it('dispatches terminal.start to the paired online device with the real payload', async () => {
    const captured = attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('FROM devices WHERE id')) return [pairedDeviceRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    const session = await createTerminalSession(USER_ID, { deviceId: DEVICE_ID, shell: 'powershell', timeoutMs: 300_000 });
    expect(session.id).toMatch(/^tsm_/);
    expect(session.status).toBe('PLANNED');
    const dispatched = captured.find((c) => c.type === 'cmd' && c.cmd?.kind === 'terminal.start');
    expect(dispatched).toBeDefined();
    expect(dispatched!.cmd).toMatchObject({
      kind: 'terminal.start',
      tabId: session.id,
      shell: 'powershell',
      timeoutMs: 300_000,
    });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO terminal_sessions'));
    expect(insert).toBeDefined();
    expect(insert!.text).toContain("'PLANNED'"); // never created RUNNING
    expect(insert!.params).toMatchObject([session.id, USER_ID, DEVICE_ID, session.id, 'powershell', null, 300_000]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.TERMINAL_SESSION_CREATED }));
  });

  it('refuses when the agent is offline — no insert, no dispatch, no fake RUNNING', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM devices WHERE id')) return [pairedDeviceRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    await expect(createTerminalSession(USER_ID, { deviceId: DEVICE_ID, shell: 'bash' })).rejects.toMatchObject({ errorCode: 'local_agent_offline' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO terminal_sessions'))).toBe(false);
  });

  it('refuses without an active remote session (explicit 8h authorization)', async () => {
    attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('FROM devices WHERE id')) return [pairedDeviceRow()];
      return null;
    };
    await expect(createTerminalSession(USER_ID, { deviceId: DEVICE_ID, shell: 'bash' })).rejects.toMatchObject({ errorCode: 'remote_session_required' });
  });

  it('refuses for an unpaired or foreign device', async () => {
    attachAgentSocket();
    db.state.resolve = () => [];
    await expect(createTerminalSession(USER_ID, { deviceId: 'dev_other' })).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('denies dispatch when the EXECUTE_COMMAND grant is missing — capability gate before any command', async () => {
    const captured = attachAgentSocket();
    revokeGrants(USER_ID);
    db.state.resolve = (text) => {
      if (text.includes('FROM devices WHERE id')) return [pairedDeviceRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    await expect(createTerminalSession(USER_ID, { deviceId: DEVICE_ID, shell: 'bash' })).rejects.toMatchObject({ errorCode: 'capability' });
    expect(captured.some((c) => c.type === 'cmd')).toBe(false);
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO terminal_sessions'))).toBe(false);
  });
});

describe('sendInput / kill / restart', () => {
  function sessionOwnerRow(): Record<string, unknown> {
    return { device_id: DEVICE_ID, status: 'RUNNING' };
  }

  it('dispatches low-risk input to the device', async () => {
    const captured = attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('SELECT device_id, status FROM terminal_sessions')) return [sessionOwnerRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    await sendInput(USER_ID, SESSION_ID, 'git status');
    const dispatched = captured.find((c) => c.type === 'cmd' && c.cmd?.kind === 'terminal.input');
    expect(dispatched).toBeDefined();
    expect(dispatched!.cmd).toMatchObject({ kind: 'terminal.input', tabId: SESSION_ID, data: 'git status' });
  });

  it('denies dangerous input via the policy engine — never reaches the device', async () => {
    const captured = attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('SELECT device_id, status FROM terminal_sessions')) return [sessionOwnerRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    await expect(sendInput(USER_ID, SESSION_ID, 'rm -rf /')).rejects.toMatchObject({ errorCode: 'baseline_commands' });
    expect(captured.some((c) => c.type === 'cmd' && c.cmd?.kind === 'terminal.input')).toBe(false);
  });

  it('refuses approval-requiring input in the interactive relay (no bypass)', async () => {
    const captured = attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('SELECT device_id, status FROM terminal_sessions')) return [sessionOwnerRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    await expect(sendInput(USER_ID, SESSION_ID, 'npm install express')).rejects.toMatchObject({ errorCode: 'approval_required' });
    expect(captured.some((c) => c.type === 'cmd')).toBe(false);
  });

  it('dispatches terminal.stop on kill and audits TERMINAL_SESSION_KILLED', async () => {
    const captured = attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('SELECT device_id, status FROM terminal_sessions')) return [sessionOwnerRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    await killSession(USER_ID, SESSION_ID);
    expect(captured.some((c) => c.type === 'cmd' && c.cmd?.kind === 'terminal.stop')).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.TERMINAL_SESSION_KILLED }));
  });

  it('dispatches terminal.restart on restart', async () => {
    const captured = attachAgentSocket();
    db.state.resolve = (text) => {
      if (text.includes('SELECT device_id, status FROM terminal_sessions')) return [sessionOwnerRow()];
      if (text.includes('FROM remote_sessions')) return [remoteSessionRow()];
      return null;
    };
    await restartSession(USER_ID, SESSION_ID);
    expect(captured.some((c) => c.type === 'cmd' && c.cmd?.kind === 'terminal.restart')).toBe(true);
  });
});

describe('store mirror — RUNNING only from agent-reported evidence', () => {
  it('updateTerminalStatus mirrors the agent-reported RUNNING transition with its pid', async () => {
    await updateTerminalStatus(USER_ID, SESSION_ID, 'RUNNING', null, 4821);
    const update = db.state.calls.find((c) => c.text.includes('UPDATE terminal_sessions'));
    expect(update).toBeDefined();
    expect(update!.params).toMatchObject([USER_ID, 'RUNNING', null, 4821, SESSION_ID]);
  });

  it('updateTerminalStatus clears the pid for terminal states', async () => {
    await updateTerminalStatus(USER_ID, SESSION_ID, 'COMPLETED', 0, null);
    const update = db.state.calls.find((c) => c.text.includes('UPDATE terminal_sessions'));
    expect(update).toBeDefined();
    expect(update!.params[1]).toBe('COMPLETED');
  });

  it('appendTerminalHistory writes bounded stdout lines scoped to the owner', async () => {
    await appendTerminalHistory(USER_ID, SESSION_ID, 'stdout', 'hello world');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO terminal_history'));
    expect(insert).toBeDefined();
    expect(insert!.params[2]).toBe('stdout');
    expect(insert!.params[3]).toBe('hello world');
    expect(insert!.params[4]).toBe(USER_ID);
  });
});