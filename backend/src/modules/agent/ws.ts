/**
 * CodeConClave — Local Agent WebSocket hub (/agent).
 * Authenticated by a per-device token (pairing code + device secret), NOT
 * browser cookies. Handles: register → capabilities, jobs (tool calls scoped
 * to the workspace), status heartbeats. Presence is honest: when no agent is
 * connected, LOCAL tasks remain WAITING_FOR_LOCAL_AGENT.
 */
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { sha256Hex } from '../../shared/crypto.js';
import { pool } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { AppError } from '../../shared/errors.js';
import { incMetric } from '../../observability/metrics.js';
import { evaluateToolCall } from '../execution/policy.js';
import { registerGrants, revokeGrants } from '../execution/policy.js';
import type { TerminalState } from '@codeconclave/shared';
import { updateTerminalStatus, appendTerminalHistory } from '../terminal/store.js';

const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL_STATES = new Set(['PLANNED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'KILLED', 'TIMED_OUT']);
/** Keepalive cadence: ping every 25s; a socket missing two pongs is dead. */
const KEEPALIVE_MS = 25_000;

export class AgentHub {
  private wss = new WebSocketServer({ noServer: true });
  private clients = new Map<string, WebSocket>();
  /** corrId → browser WebSocket waiting for the agent's response stream. */
  private pending = new Map<string, WebSocket>();
  /** corrId → server-side resolver (chat agent loop; not streamed to any browser). */
  private serverPending = new Map<
    string,
    { resolve: (result: CommandExecResult) => void; output: string[] }
  >();
  /** connectionKey → last keepalive round observed a pong (heartbeat liveness). */
  private alive = new Map<string, boolean>();

  constructor() {
    this.wss.on('connection', (ws) => this.onConnection(ws));
    setInterval(() => this.keepaliveSweep(), KEEPALIVE_MS).unref();
  }

  handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer): void {
    this.wss.handleUpgrade(req, socket as never, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private async onConnection(ws: WebSocket): Promise<void> {
    const hello = await waitForMessage(ws, 10_000);
    if (!hello) {
      ws.close(4001, 'timeout waiting for auth');
      return;
    }
    let helloMsg: { type: string; token?: string; deviceId?: string };
    try {
      helloMsg = JSON.parse(hello.toString());
    } catch {
      ws.close(4000, 'invalid hello');
      return;
    }
    if (helloMsg.type !== 'register' || !helloMsg.token || !helloMsg.deviceId) {
      ws.close(4000, 'expected register with token and deviceId');
      return;
    }

    const device = await authenticateAgent(helloMsg.deviceId, helloMsg.token);
    if (!device) {
      logger.warn('agent auth rejected', { deviceId: helloMsg.deviceId });
      ws.close(4003, 'invalid credentials');
      return;
    }

    const connectionKey = `${device.user_id}:${device.id}`;
    const grantIds = grantIdsForDevice(device.id);
    // Reconnect with an already-live socket: replace it honestly (the old
    // socket is closed with a distinct code; grants are re-registered below).
    const previous = this.clients.get(connectionKey);
    if (previous && previous.readyState === WebSocket.OPEN) {
      this.clients.delete(connectionKey);
      this.alive.delete(connectionKey);
      revokeGrants(device.user_id, Object.values(grantIds));
      previous.close(4002, 'replaced by new connection');
      incMetric('agent.reconnect');
    }
    registerGrants([
      { id: grantIds.read, userId: device.user_id, capability: 'READ_WORKSPACE', scope: '*', expiresAt: Date.now() + GRANT_TTL_MS },
      { id: grantIds.write, userId: device.user_id, capability: 'WRITE_WORKSPACE', scope: '*', expiresAt: Date.now() + GRANT_TTL_MS },
      { id: grantIds.exec, userId: device.user_id, capability: 'EXECUTE_COMMAND', scope: '*', expiresAt: Date.now() + GRANT_TTL_MS, allowedCommands: device.capabilities },
    ]);
    this.clients.set(connectionKey, ws);
    this.alive.set(connectionKey, true);
    ws.on('pong', () => this.alive.set(connectionKey, true));
    logger.info('agent connected', { userId: device.user_id, deviceId: device.id });
    await recordAgentAudit('AGENT_CONNECTED', device.user_id, device.id);

    ws.on('message', (data) => void this.onMessage(connectionKey, device, data.toString()));
    ws.on('close', () => {
      this.clients.delete(connectionKey);
      this.alive.delete(connectionKey);
      revokeGrants(device.user_id, Object.values(grantIds));
      void recordAgentAudit('AGENT_DISCONNECTED', device.user_id, device.id);
      logger.info('agent disconnected', { connectionKey });
    });
    ws.on('error', (err) => logger.warn('agent socket error', { err: err.message }));

    this.send(ws, { type: 'ready', workspace: device.user_id, capabilities: device.capabilities });
  }

  private async onMessage(
    connectionKey: string,
    device: AgentDevice,
    raw: string,
  ): Promise<void> {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const ws = this.clients.get(connectionKey);
    if (!ws) return;

    switch (msg.type) {
      case 'heartbeat': {
        // Presence only: last_seen_at. The devices.state CHECK constraint is
        // PENDING_PAIRING/PAIRED/REVOKED — never set a non-enum state here.
        await pool.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id]);
        this.send(ws, { type: 'heartbeat_ack', at: Date.now(), seq: typeof msg.seq === 'number' ? msg.seq : null });
        return;
      }
      case 'tool_result': {
        const jobId = String(msg.jobId ?? '');
        const output = msg.output as Record<string, unknown>;
        await this.recordLocalToolResult(jobId, output);
        this.send(ws, { type: 'job_ack', jobId });
        return;
      }
      case 'tool_error': {
        const jobId = String(msg.jobId ?? '');
        await this.recordLocalToolResult(jobId, { error: String(msg.error ?? 'unknown error') }, true);
        this.send(ws, { type: 'job_ack', jobId });
        return;
      }
      case 'cmd_stream': {
        const corrId = String(msg.corrId ?? '');
        const channel = String(msg.channel ?? 'stdout');
        const text = String(msg.text ?? '');
        const tabId = typeof msg.tabId === 'string' ? msg.tabId : '';
        const browser = this.pending.get(corrId);
        if (browser) {
          this.send(browser, { type: 'cmd_stream', corrId, channel, text });
        }
        const server = this.serverPending.get(corrId);
        if (server) {
          if (text) {
            server.output.push(text);
            if (server.output.length > 4096) server.output = server.output.slice(server.output.length - 4096);
          }
        }
        // Persist the REAL agent stream: status transitions update the session
        // (RUNNING only with the agent-reported pid); output lines append to
        // the searchable history. Never fabricated — mirrored verbatim.
        if (tabId) {
          if (channel === 'status') {
            try {
              const parsed = JSON.parse(text) as { status?: string; exitCode?: number | null; pid?: number | null };
              if (parsed.status && TERMINAL_STATES.has(parsed.status)) {
                await updateTerminalStatus(device.user_id, tabId, parsed.status as TerminalState, parsed.exitCode ?? null, parsed.pid ?? null);
              }
            } catch {
              /* malformed status payload — ignore, never crash the hub */
            }
          } else if (text) {
            await appendTerminalHistory(device.user_id, tabId, channel === 'stderr' ? 'stderr' : 'stdout', text).catch(() => undefined);
          }
        }
        return;
      }
      case 'cmd_result': {
        const corrId = String(msg.corrId ?? '');
        const browser = this.pending.get(corrId);
        this.pending.delete(corrId);
        if (browser) {
          this.send(browser, { type: 'cmd_result', corrId, ok: Boolean(msg.ok), payload: msg.payload ?? null, error: msg.error ?? null });
        }
        const server = this.serverPending.get(corrId);
        if (server) {
          this.serverPending.delete(corrId);
          server.resolve({
            ok: Boolean(msg.ok),
            output: server.output.join(''),
            payload: (msg.payload as Record<string, unknown> | null) ?? null,
            error: msg.error ? String(msg.error) : null,
          });
        }
        return;
      }
      default:
        this.send(ws, { type: 'error', reason: 'unknown_message_type' });
    }
  }

  private async recordLocalToolResult(jobId: string, output: Record<string, unknown>, isError = false): Promise<void> {
    await pool.query(
      `UPDATE tool_calls SET output = $2::jsonb, status = $3, completed_at = now()
       WHERE id = $1 AND status = 'PROPOSED'`,
      [jobId, JSON.stringify(output), isError ? 'FAILED' : 'EXECUTED'],
    );
  }

  send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  getClient(userId: string): { connectionKey: string; ws: WebSocket } | null {
    for (const [key, ws] of this.clients) {
      if (key.startsWith(`${userId}:`) && ws.readyState === WebSocket.OPEN) return { connectionKey: key, ws };
    }
    return null;
  }

  /** Connected device ids of a user (chat agent loop targets, never identities). */
  onlineDeviceIds(userId: string): string[] {
    const ids: string[] = [];
    for (const [key, ws] of this.clients) {
      if (key.startsWith(`${userId}:`) && ws.readyState === WebSocket.OPEN) {
        const deviceId = key.slice(userId.length + 1);
        if (deviceId) ids.push(deviceId);
      }
    }
    return ids;
  }

  /** Immediate revocation: drop the live agent socket so nothing keeps executing. */
  disconnectDevice(userId: string, deviceId: string): void {
    const key = `${userId}:${deviceId}`;
    const ws = this.clients.get(key);
    if (ws) {
      this.clients.delete(key);
      revokeGrants(userId, Object.values(grantIdsForDevice(deviceId)));
      ws.close(4403, 'device revoked');
    }
  }

  /** True when a PAIRED device of this user is currently connected. */
  isOnline(userId: string, deviceId: string): boolean {
    const ws = this.clients.get(`${userId}:${deviceId}`);
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  /** Shutdown: close every live socket with a server-going-away frame. */
  close(): void {
    for (const ws of this.wss.clients) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        /* already closed */
      }
    }
  }

  /** Presence snapshot for health checks (counts only — never identities). */
  stats(): { connected: number; pending: number } {
    let connected = 0;
    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) connected += 1;
    }
    return { connected, pending: this.pending.size };
  }

  /**
   * Route a browser-originated command to the agent and stream replies back
   * to the browser socket. Fails honestly when the agent is offline.
   */
  requestToDevice(
    userId: string,
    deviceId: string,
    cmd: Record<string, unknown>,
    browser: WebSocket | null,
    timeoutMs = 60_000,
  ): string {
    const ws = this.clients.get(`${userId}:${deviceId}`);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw AppError.unavailable('local_agent_offline', 'Local Agent is offline — task stays WAITING_FOR_LOCAL_AGENT');
    }
    const corrId = `corr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    if (browser) {
      this.pending.set(corrId, browser);
      setTimeout(() => {
        if (this.pending.delete(corrId) && browser.readyState === WebSocket.OPEN) {
          this.send(browser, { type: 'cmd_result', corrId, ok: false, error: 'command timed out (no agent reply)' });
        }
      }, timeoutMs).unref();
    }
    this.send(ws, { type: 'cmd', corrId, cmd });
    return corrId;
  }

  sendToDevice(userId: string, deviceId: string, msg: unknown): boolean {
    const ws = this.clients.get(`${userId}:${deviceId}`);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    this.send(ws, msg);
    return true;
  }

  /**
   * Server-side awaitable command execution (chat agent loop). Sends a cmd to
   * the device, collects cmd_stream output into a bounded buffer, and resolves
   * on the agent's cmd_result. No browser socket involved. Fails honestly when
   * the agent is offline or the agent never replies within the timeout.
   */
  executeCommandResult(
    userId: string,
    deviceId: string,
    cmd: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<CommandExecResult> {
    const ws = this.clients.get(`${userId}:${deviceId}`);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        AppError.unavailable('local_agent_offline', 'Local Agent is offline — start it and retry the message.'),
      );
    }
    const corrId = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<CommandExecResult>((resolve) => {
      this.serverPending.set(corrId, { resolve: (r) => resolve(r), output: [] });
      const timer = setTimeout(() => {
        if (this.serverPending.delete(corrId)) {
          resolve({ ok: false, output: '', payload: null, error: 'command timed out (no agent reply)' });
        }
      }, timeoutMs);
      timer.unref?.();
      this.send(ws, { type: 'cmd', corrId, cmd });
    });
  }

  /**
   * One keepalive round: ping every tracked socket; sockets that missed the
   * previous round are dead — terminate, revoke grants, audit, count the
   * timeout metric. Never kills sockets we did not attach liveness to.
   */
  keepaliveSweep(): void {
    for (const [key, ws] of [...this.clients.entries()]) {
      if (!this.alive.has(key)) continue;
      if (this.alive.get(key) === false) {
        this.clients.delete(key);
        this.alive.delete(key);
        const [userId, deviceId] = key.split(':');
        if (userId && deviceId) {
          revokeGrants(userId, Object.values(grantIdsForDevice(deviceId)));
          void recordAgentAudit('AGENT_DISCONNECTED', userId, deviceId).catch(() => undefined);
        }
        incMetric('agent.heartbeat_timeout');
        logger.warn('agent socket terminated (heartbeat timeout)', { connectionKey: key });
        try {
          ws.terminate();
        } catch {
          /* already closed */
        }
        continue;
      }
      this.alive.set(key, false);
      try {
        ws.ping();
      } catch {
        /* not ready — next round will terminate */
      }
    }
  }
}

function grantIdsForDevice(deviceId: string): { read: string; write: string; exec: string } {
  return {
    read: `devgr_${deviceId}_r`,
    write: `devgr_${deviceId}_w`,
    exec: `devgr_${deviceId}_x`,
  };
}

async function recordAgentAudit(action: 'AGENT_CONNECTED' | 'AGENT_DISCONNECTED', userId: string, deviceId: string): Promise<void> {
  const { recordAudit } = await import('../audit/service.js');
  const { AuditAction } = await import('@codeconclave/shared');
  await recordAudit({
    action: AuditAction[action],
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'device',
    resourceId: deviceId,
  }).catch(() => undefined);
}

/** Resolved server-side command result (aggregated from cmd_stream + cmd_result). */
export interface CommandExecResult {
  ok: boolean;
  output: string;
  payload: Record<string, unknown> | null;
  error: string | null;
}

interface AgentDevice {
  id: string;
  user_id: string;
  capabilities: string[];
}

async function authenticateAgent(deviceId: string, token: string): Promise<AgentDevice | null> {
  const rows = await pool.query<{ id: string; user_id: string; token_hash: string | null; state: string; capabilities: unknown }>(
    'SELECT id, user_id, token_hash, state, capabilities FROM devices WHERE id = $1',
    [deviceId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  if (row.token_hash !== sha256Hex(token)) return null;
  if (row.state !== 'PAIRED') return null;
  const caps = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
  return {
    id: row.id,
    user_id: row.user_id,
    capabilities:
      caps.length > 0
        ? caps
        : ['file_read', 'file_write', 'terminal_exec', 'dev_server', 'git_op'],
  };
}

function waitForMessage(ws: WebSocket, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onMsg = (data: unknown) => {
      cleanup();
      resolve(Buffer.from(data as Buffer));
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMsg);
      ws.off('close', onClose);
    };
    ws.once('message', onMsg);
    ws.once('close', onClose);
  });
}

let hubInstance: AgentHub | null = null;
export function agentWs(): AgentHub {
  hubInstance ??= new AgentHub();
  return hubInstance;
}

/** True once the hub has been attached (health reporting). */
export function hubAttached(): boolean {
  return hubInstance !== null;
}

export { AppError as _agentAppError, evaluateToolCall as _agentPolicy };