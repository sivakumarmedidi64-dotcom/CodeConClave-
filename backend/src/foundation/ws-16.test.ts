/**
 * CodeConClave — PHASE 16 WebSocket reliability tests.
 * Agent hub (/agent) and browser relay (/agent-browser): keepalive liveness
 * (missed pong → terminate + metric), reconnect revalidation (revoked device
 * rejected, live socket replaced with 4002, grants re-registered), heartbeat
 * seq ack. All liveness logic is exercised through the real hub with fake
 * sockets — no timers, no fakes of the behaviors under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: 0 };
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

const registerGrants = vi.hoisted(() => vi.fn());
const revokeGrants = vi.hoisted(() => vi.fn());
vi.mock('../modules/execution/policy.js', () => ({
  registerGrants,
  revokeGrants,
  evaluateToolCall: () => ({ allowed: true, requiresApproval: false }),
  policyDeniedError: (d: { reason?: string }) => ({ name: 'policy_denied', message: d.reason ?? 'denied' }),
}));

import { agentWs, agentWs as hubFactory } from '../modules/agent/ws.js';
import { browserRelay } from '../modules/agent/browser.js';
import { sha256Hex } from '../shared/crypto.js';
import { metricSnapshot, resetMetrics } from '../observability/metrics.js';

const USER_ID = 'usr_16';
const DEVICE_ID = 'dev_16';
const TOKEN = 'tok_16_agent';
const TOKEN_HASH = sha256Hex(TOKEN);

type Fn = (...args: unknown[]) => void;

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  closeCode: number | null = null;
  private handlers = new Map<string, Set<Fn>>();

  on(ev: string, fn: Fn): void {
    const set = this.handlers.get(ev) ?? new Set<Fn>();
    set.add(fn);
    this.handlers.set(ev, set);
  }

  once(ev: string, fn: Fn): void {
    const wrapper = (...args: unknown[]) => {
      this.off(ev, wrapper);
      fn(...args);
    };
    this.on(ev, wrapper);
  }

  off(ev: string, fn: Fn): void {
    this.handlers.get(ev)?.delete(fn);
  }

  emit(ev: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...args);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  ping = vi.fn();
  terminate = vi.fn();

  close(code?: number, _reason?: string): void {
    this.closeCode = code ?? 1000;
    this.readyState = 3;
    this.emit('close');
  }
}

type HubInternals = {
  clients: Map<string, FakeSocket>;
  alive: Map<string, boolean>;
  onConnection: (ws: FakeSocket) => Promise<void>;
  onMessage: (key: string, device: { id: string; user_id: string; capabilities: string[] }, raw: string) => Promise<void>;
  keepaliveSweep: () => void;
};

type RelayInternals = {
  alive: Map<FakeSocket, boolean>;
  keepaliveSweep: () => void;
};

function hub(): HubInternals {
  return agentWs() as unknown as HubInternals;
}

function relay(): RelayInternals {
  return browserRelay() as unknown as RelayInternals;
}

function deviceRow(state = 'PAIRED'): Record<string, unknown> {
  return { id: DEVICE_ID, user_id: USER_ID, token_hash: TOKEN_HASH, state, capabilities: ['file_read', 'terminal_exec'] };
}

/** Drive the real onConnection flow: fake socket sends the register hello. */
async function connectDevice(state = 'PAIRED'): Promise<FakeSocket> {
  db.state.resolve = (text) => (text.includes('FROM devices') ? [deviceRow(state)] : null);
  const sock = new FakeSocket();
  const p = hub().onConnection(sock);
  sock.emit('message', Buffer.from(JSON.stringify({ type: 'register', token: TOKEN, deviceId: DEVICE_ID })));
  await p;
  return sock;
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  recordAudit.mockClear();
  registerGrants.mockClear();
  revokeGrants.mockClear();
  hub().clients.clear();
  hub().alive.clear();
  relay().alive.clear();
  resetMetrics();
});

afterEach(() => {
  hub().clients.clear();
  hub().alive.clear();
  relay().alive.clear();
});

describe('agent hub — registration & revalidation', () => {
  it('accepts a paired device and replies ready with its capabilities', async () => {
    const sock = await connectDevice();
    const ready = JSON.parse(sock.sent[0]!) as { type: string; workspace: string; capabilities: string[] };
    expect(ready.type).toBe('ready');
    expect(ready.workspace).toBe(USER_ID);
    expect(ready.capabilities).toEqual(['file_read', 'terminal_exec']);
    expect(hub().clients.has(`${USER_ID}:${DEVICE_ID}`)).toBe(true);
  });

  it('rejects a REVOKED device on reconnect (revalidation, never resumes blindly)', async () => {
    const sock = await connectDevice('REVOKED');
    expect(sock.closeCode).toBe(4003);
    expect(hub().clients.has(`${USER_ID}:${DEVICE_ID}`)).toBe(false);
    expect(registerGrants).not.toHaveBeenCalled();
  });

  it('replaces a live socket on reconnect: old closed 4002, grants re-registered', async () => {
    const first = await connectDevice();
    expect(first.sent.length).toBeGreaterThan(0);
    const second = await connectDevice();
    expect(first.closeCode).toBe(4002);
    expect(second.closeCode).toBeNull();
    expect(hub().clients.get(`${USER_ID}:${DEVICE_ID}`)).toBe(second);
    expect(registerGrants).toHaveBeenCalledTimes(2);
    expect(metricSnapshot()['agent.reconnect']).toBe(1);
  });

  it('revokes grants and audits on disconnect', async () => {
    const sock = await connectDevice();
    sock.emit('close');
    expect(hub().clients.has(`${USER_ID}:${DEVICE_ID}`)).toBe(false);
    expect(revokeGrants).toHaveBeenCalledWith(USER_ID, expect.arrayContaining([expect.stringContaining(DEVICE_ID)]));
  });
});

describe('agent hub — heartbeat', () => {
  it('acks heartbeats and echoes the client seq', async () => {
    const sock = await connectDevice();
    sock.sent = [];
    db.state.resolve = (text) => (text.includes('UPDATE devices') ? [] : null);
    await hub().onMessage(`${USER_ID}:${DEVICE_ID}`, { id: DEVICE_ID, user_id: USER_ID, capabilities: [] }, JSON.stringify({ type: 'heartbeat', seq: 42 }));
    const ack = JSON.parse(sock.sent[0]!) as { type: string; seq: number | null };
    expect(ack.type).toBe('heartbeat_ack');
    expect(ack.seq).toBe(42);
    expect(db.state.calls.some((c) => c.text.includes('UPDATE devices SET last_seen_at'))).toBe(true);
  });
});

describe('agent hub — keepalive liveness', () => {
  it('terminates sockets that miss a pong, revokes grants and counts the metric', async () => {
    const sock = await connectDevice();
    hub().clients.set(`${USER_ID}:${DEVICE_ID}`, sock);
    hub().alive.set(`${USER_ID}:${DEVICE_ID}`, true);
    hub().keepaliveSweep();
    expect(sock.ping).toHaveBeenCalledTimes(1);
    expect(hub().alive.get(`${USER_ID}:${DEVICE_ID}`)).toBe(false);
    hub().keepaliveSweep();
    expect(sock.terminate).toHaveBeenCalledTimes(1);
    expect(hub().clients.has(`${USER_ID}:${DEVICE_ID}`)).toBe(false);
    expect(revokeGrants).toHaveBeenCalledWith(USER_ID, expect.any(Array));
    expect(metricSnapshot()['agent.heartbeat_timeout']).toBe(1);
  });

  it('keeps alive sockets that answer pongs', async () => {
    const sock = await connectDevice();
    hub().clients.set(`${USER_ID}:${DEVICE_ID}`, sock);
    hub().alive.set(`${USER_ID}:${DEVICE_ID}`, true);
    hub().keepaliveSweep();
    hub().alive.set(`${USER_ID}:${DEVICE_ID}`, true); // pong arrived
    hub().keepaliveSweep();
    expect(sock.terminate).not.toHaveBeenCalled();
    expect(hub().clients.has(`${USER_ID}:${DEVICE_ID}`)).toBe(true);
  });

  it('never terminates sockets it did not attach liveness to', () => {
    const sock = new FakeSocket();
    hub().clients.set(`${USER_ID}:${DEVICE_ID}`, sock);
    hub().keepaliveSweep();
    hub().keepaliveSweep();
    expect(sock.terminate).not.toHaveBeenCalled();
  });
});

describe('browser relay — keepalive liveness', () => {
  it('pings tracked sockets and terminates on a missed pong', () => {
    const sock = new FakeSocket();
    relay().alive.set(sock, true);
    relay().keepaliveSweep();
    expect(sock.ping).toHaveBeenCalledTimes(1);
    expect(relay().alive.get(sock)).toBe(false);
    relay().keepaliveSweep();
    expect(sock.terminate).toHaveBeenCalledTimes(1);
    expect(relay().alive.has(sock)).toBe(false);
    expect(metricSnapshot()['relay.heartbeat_timeout']).toBe(1);
  });
});