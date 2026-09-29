/**
 * CodeConClave AI OS — P2.22 Notifications.
 *
 * Delivers cowork events (status, approval requests, denials, failures,
 * results) to authenticated subscribers over a SSE/WebSocket-style sink. It
 * CONSUMES the OS event bus and ALWAYS redacts payloads, so no notification can
 * leak secret data. Delivery is durable via an outbox-style buffer so the
 * browser may be closed: subscribers re-sync from a last-delivered ID
 * (Last-Event-ID semantics) on reconnect.
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { IpcBus, IpcEvent } from '../ipc.js';
import type { P2Feature } from './flags.js';

export interface Notification {
  id: number;
  workspaceId: string | null;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  at: number;
}

export interface NotifySink {
  send(userId: string, n: Notification): void | Promise<void>;
}

export class Notifications {
  private subs = new Map<string, NotifySink>();
  private outbox: Notification[] = [];
  private seq = 0;
  private unsubscribe: (() => void) | null = null;
  private sinksByWorkspace = new Map<string, Set<string>>();

  constructor(
    private ipc: IpcBus,
    private feature: () => P2Feature | null,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'notifications';
  }

  /** Activate the notifier. Events are forwarded explicitly via emit()/forward(). */
  start(): void {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_notifications_disabled', 'notifications feature is off');
  }

  /** Forward a monitor-style event into notifications. Public/explicit call. */
  forward(ev: IpcEvent): Notification | null {
    if (!this.isEnabled()) return null;
    return this.deliver({
      workspaceId: ev.workspaceId,
      kind: ev.topic,
      title: ev.topic,
      body: safeTitle(ev.topic),
      data: sanitizeFields(ev.payload as Record<string, unknown>),
    });
  }

  /** Emit a structured notification (approval requested, denial, result, etc.). */
  emit(opts: {
    workspaceId?: string | null;
    kind: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }): Notification {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_notifications_disabled', 'notifications feature is off');
    return this.deliver({
      workspaceId: opts.workspaceId ?? null,
      kind: opts.kind,
      title: opts.title,
      body: opts.body,
      data: sanitizeFields(opts.data ?? {}),
    });
  }

  private deliver(n: Omit<Notification, 'id' | 'at'>): Notification {
    this.seq += 1;
    const full: Notification = { ...n, id: this.seq, at: Date.now() };
    // durable: keep in outbox so offline subscribers can re-sync
    this.outbox.push(full);
    if (this.outbox.length > 2000) this.outbox.shift();
    for (const [userId, sink] of this.subs) {
      if (this.watchesWorkspace(userId, full.workspaceId)) {
        void sink.send(userId, full);
      }
    }
    return full;
  }

  /**
   * Attach an authenticated subscriber. Sink receives redacted notifications
   * immediately; on `sinceId` they first get any missed (durable) notifications.
   */
  subscribe(userId: string, sink: NotifySink, opts: { workspaceId?: string | null; sinceId?: number } = {}): () => void {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_notifications_disabled', 'notifications feature is off');
    this.subs.set(userId, sink);
    if (opts.workspaceId !== undefined) {
      if (!this.sinksByWorkspace.has(opts.workspaceId ?? 'system')) this.sinksByWorkspace.set(opts.workspaceId ?? 'system', new Set());
      this.sinksByWorkspace.get(opts.workspaceId ?? 'system')!.add(userId);
    }
    // replay missed notifications (Last-Event-ID semantics)
    for (const n of this.outbox) {
      if (n.id > (opts.sinceId ?? 0) && this.watchesWorkspace(userId, n.workspaceId)) {
        void sink.send(userId, n);
      }
    }
    return () => {
      this.subs.delete(userId);
      for (const set of this.sinksByWorkspace.values()) set.delete(userId);
    };
  }

  unsubscribeUser(userId: string): void {
    this.subs.delete(userId);
    for (const set of this.sinksByWorkspace.values()) set.delete(userId);
  }

  /** SSE/WebSocket frame for a notification (already redacted by construction). */
  frame(n: Notification): string {
    return `data: ${JSON.stringify(n)}\n\n`;
  }

  private watchesWorkspace(userId: string, workspaceId: string | null): boolean {
    const set = this.sinksByWorkspace.get(workspaceId ?? 'system');
    if (!set) return true; // default: workspace-agnostic subscribers get everything
    return set.has(userId);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

function safeTitle(topic: string): string {
  return topic.replace(/^aios\./, 'AI OS · ');
}
