/**
 * CodeConClave — browser relay for the Local Agent (/agent-browser).
 * A browser-authenticated WebSocket that brokers terminal/file commands to the
 * paired agent and streams live output back. Authentication is the session
 * cookie (same-origin), never a device token.
 */
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { sha256Hex } from '../../shared/crypto.js';
import { pool } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { incMetric } from '../../observability/metrics.js';
import { agentWs } from './ws.js';
import { evaluateToolCall, policyDeniedError } from '../execution/policy.js';
import { requireRemoteSession } from './service.js';

const SESSION_COOKIE = 'cc_session';
const KEEPALIVE_MS = 25_000;

/** Interactive remote control never bypasses policy: only LOW-risk passes. */
function policyCheckOrError(tool: string, input: Record<string, unknown>, userId: string): { error: string } | null {
  const decision = evaluateToolCall({ tool, input, userId });
  if (!decision.allowed) {
    const err = policyDeniedError(decision);
    return { error: `${err.name}: ${err.message}` };
  }
  if (decision.requiresApproval) {
    return {
      error:
        'approval_required: this action requires approval and the interactive relay cannot bypass it — use the task approval flow',
    };
  }
  return null;
}

export class BrowserRelay {
  private wss = new WebSocketServer({ noServer: true });
  private alive = new Map<WebSocket, boolean>();

  constructor() {
    this.wss.on('connection', (ws, req) => void this.onConnection(ws, req));
    setInterval(() => this.keepaliveSweep(), KEEPALIVE_MS).unref();
  }

  handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer): void {
    this.wss.handleUpgrade(req, socket as never, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
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

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const userId = await sessionUser(req);
    if (!userId) {
      ws.close(4401, 'unauthenticated');
      return;
    }
    ws.on('message', (data) => void this.onMessage(userId, ws, data.toString()));
    ws.on('close', () => {
      this.alive.delete(ws);
    });
    ws.on('error', () => undefined);
    ws.on('pong', () => this.alive.set(ws, true));
    this.alive.set(ws, true);
    ws.send(JSON.stringify({ type: 'connected', userId }));
  }

  private async onMessage(userId: string, ws: WebSocket, raw: string): Promise<void> {
    let msg: { type?: string; corrId?: string; deviceId?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg.type || typeof msg.type !== 'string') return;
    const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : '';
    if (deviceId && !(await ownsDevice(userId, deviceId))) {
      ws.send(JSON.stringify({ type: 'error', corrId: msg.corrId ?? null, error: 'device_not_owned' }));
      return;
    }

    const hub = agentWs();
    try {
      switch (msg.type) {
        case 'terminal.start': {
          await requireRemoteSession(userId, deviceId);
          const gate = policyCheckOrError('terminal_exec', { command: String(msg.shell ?? 'bash') }, userId);
          if (gate) return this.replyError(ws, msg.corrId ?? null, gate.error);
          const corrId = hub.requestToDevice(userId, deviceId, {
            kind: 'terminal.start',
            tabId: String(msg.tabId ?? 'tab_1'),
            shell: String(msg.shell ?? 'bash'),
            cwd: typeof msg.cwd === 'string' ? msg.cwd : '',
            timeoutMs: Number(msg.timeoutMs ?? 0) || null,
          }, ws, 30_000);
          ws.send(JSON.stringify({ type: 'ack', corrId, command: 'terminal.start' }));
          return;
        }
        case 'terminal.input': {
          await requireRemoteSession(userId, deviceId);
          const data = String(msg.data ?? '');
          const gate = policyCheckOrError('terminal_exec', { command: data }, userId);
          if (gate) return this.replyError(ws, msg.corrId ?? null, gate.error);
          hub.requestToDevice(userId, deviceId, {
            kind: 'terminal.input',
            tabId: String(msg.tabId ?? ''),
            data,
          }, null, 10_000);
          return;
        }
        case 'terminal.stop':
        case 'terminal.restart': {
          await requireRemoteSession(userId, deviceId);
          const corrId = hub.requestToDevice(userId, deviceId, {
            kind: msg.type === 'terminal.stop' ? 'terminal.stop' : 'terminal.restart',
            tabId: String(msg.tabId ?? ''),
          }, ws, 15_000);
          ws.send(JSON.stringify({ type: 'ack', corrId, command: msg.type }));
          return;
        }
        case 'file.list':
        case 'file.metadata': {
          await requireRemoteSession(userId, deviceId);
          const gate = policyCheckOrError('file_read', { path: String(msg.path ?? '') }, userId);
          if (gate) return this.replyError(ws, msg.corrId ?? null, gate.error);
          const corrId = hub.requestToDevice(userId, deviceId, {
            kind: msg.type,
            path: String(msg.path ?? '/'),
            limit: Number(msg.limit ?? 200),
          }, ws, 20_000);
          ws.send(JSON.stringify({ type: 'ack', corrId, command: msg.type }));
          return;
        }
        case 'file.read': {
          await requireRemoteSession(userId, deviceId);
          const gate = policyCheckOrError('file_read', { path: String(msg.path ?? '') }, userId);
          if (gate) return this.replyError(ws, msg.corrId ?? null, gate.error);
          const corrId = hub.requestToDevice(userId, deviceId, {
            kind: 'file.read',
            path: String(msg.path ?? ''),
          }, ws, 20_000);
          ws.send(JSON.stringify({ type: 'ack', corrId, command: 'file.read' }));
          return;
        }
        case 'file.diff': {
          // Preview only (no mutation): policy must allow the write class, but
          // approval is not required for a diff that changes nothing.
          await requireRemoteSession(userId, deviceId);
          const decision = evaluateToolCall({ tool: 'file_write', input: { path: String(msg.path ?? '') }, userId });
          if (!decision.allowed) return this.replyError(ws, msg.corrId ?? null, policyDeniedError(decision).message);
          const corrId = hub.requestToDevice(userId, deviceId, {
            kind: 'file.diff',
            path: String(msg.path ?? ''),
            content: typeof msg.content === 'string' ? msg.content : '',
            taskId: typeof msg.taskId === 'string' ? msg.taskId : null,
            coworkerName: typeof msg.coworkerName === 'string' ? msg.coworkerName : null,
          }, ws, 30_000);
          ws.send(JSON.stringify({ type: 'ack', corrId, command: 'file.diff' }));
          return;
        }
        case 'file.write': {
          // Mutation: policy must allow AND approve; the interactive relay
          // cannot fabricate an approval, so this surfaces approval_required.
          await requireRemoteSession(userId, deviceId);
          const gate = policyCheckOrError('file_write', { path: String(msg.path ?? '') }, userId);
          if (gate) return this.replyError(ws, msg.corrId ?? null, gate.error);
          const corrId = hub.requestToDevice(userId, deviceId, {
            kind: 'file.write',
            path: String(msg.path ?? ''),
            content: typeof msg.content === 'string' ? msg.content : '',
            taskId: typeof msg.taskId === 'string' ? msg.taskId : null,
            coworkerName: typeof msg.coworkerName === 'string' ? msg.coworkerName : null,
          }, ws, 30_000);
          ws.send(JSON.stringify({ type: 'ack', corrId, command: 'file.write' }));
          return;
        }
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
          return;
        default:
          ws.send(JSON.stringify({ type: 'error', corrId: msg.corrId ?? null, error: 'unknown_command' }));
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: 'cmd_result',
          corrId: msg.corrId ?? null,
          ok: false,
          error: err instanceof Error ? err.message : 'command_failed',
        }),
      );
    }
  }

  private replyError(ws: WebSocket, corrId: string | null, error: string): void {
    ws.send(JSON.stringify({ type: 'cmd_result', corrId, ok: false, error }));
  }

  /** One keepalive round: ping tracked sockets; missed pong → terminate. */
  keepaliveSweep(): void {
    for (const [ws, alive] of [...this.alive.entries()]) {
      if (!alive) {
        this.alive.delete(ws);
        incMetric('relay.heartbeat_timeout');
        try {
          ws.terminate();
        } catch {
          /* already closed */
        }
        continue;
      }
      this.alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* next round will terminate */
      }
    }
  }
}

async function sessionUser(req: IncomingMessage): Promise<string | null> {
  const cookies = parseCookies(req.headers.cookie ?? '');
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const rows = await pool.query<{ user_id: string }>(
    `SELECT s.user_id FROM sessions s
     WHERE s.token_hash = $1 AND s.state = 'ACTIVE' AND s.expires_at > now()`,
    [sha256Hex(raw)],
  );
  return rows.rows[0]?.user_id ?? null;
}

async function ownsDevice(userId: string, deviceId: string): Promise<boolean> {
  const rows = await pool.query(
    `SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND state = 'PAIRED'`,
    [deviceId, userId],
  );
  return rows.rowCount === 1;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

let relayInstance: BrowserRelay | null = null;
export function browserRelay(): BrowserRelay {
  relayInstance ??= new BrowserRelay();
  return relayInstance;
}

export { logger as _browserRelayLogger };
