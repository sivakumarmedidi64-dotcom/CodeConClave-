/**
 * CodeConClave Local Agent — cloud hub client (Section 6.1/6.6).
 * Outbound WebSocket to the backend /agent endpoint, authenticated by the
 * device token issued during pairing. Heartbeats every 30s; commands are
 * dispatched to local handlers and results streamed back with correlation ids.
 */
import WebSocket from 'ws';
import type { AgentConfig } from './config.js';

export interface HubHandlers {
  handleCommand: (corrId: string, cmd: Record<string, unknown>) => Promise<void>;
  /** Optional: handle a local task assignment frame pushed by the cloud hub. */
  handleTask?: (frame: Record<string, unknown>) => void;
  /** Optional: route a task_ack back to the awaiting local task executor. */
  handleTaskAck?: (msg: Record<string, unknown>) => void;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private onState?: (online: boolean) => void;

  constructor(
    private config: AgentConfig,
    private handlers: HubHandlers,
    private capabilities: string[] = [],
  ) {}

  setStateListener(cb: (online: boolean) => void): void {
    this.onState = cb;
  }

  connect(): void {
    const url = `${(this.config.backendUrl ?? 'http://localhost:4000').replace(/^http/, 'ws')}/agent`;
    this.stopped = false;
    this.open(url);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }

  private open(url: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      this.backoffMs = 1000;
      ws.send(
        JSON.stringify({
          type: 'register',
          token: this.config.token ?? '',
          deviceId: this.config.deviceId,
          ...(this.capabilities.length > 0 ? { capabilities: this.capabilities } : {}),
        }),
      );
    });
    ws.on('message', (data) => void this.onMessage(String(data)));
    ws.on('close', () => {
      this.onState?.(false);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.open(url), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      }
    });
    ws.on('error', () => ws.close());
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: { type?: string; corrId?: string; cmd?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready': {
        this.onState?.(true);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          this.ws?.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
        }, 30_000);
        this.ws?.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
        return;
      }
      case 'heartbeat_ack':
        return;
      case 'cmd': {
        if (!msg.corrId || !msg.cmd) return;
        void this.handlers
          .handleCommand(msg.corrId, msg.cmd)
          .then(() => undefined)
          .catch((err) => {
            this.send({ type: 'cmd_result', corrId: msg.corrId, ok: false, error: err instanceof Error ? err.message : 'handler_failed' });
          });
        return;
      }
      case 'task_assign': {
        if (!this.handlers.handleTask) return;
        this.handlers.handleTask(msg);
        return;
      }
      case 'task_ack': {
        this.handlers.handleTaskAck?.(msg);
        return;
      }
      default:
        return;
    }
  }

  send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
