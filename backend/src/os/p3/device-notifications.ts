/**
 * CodeConClave AI OS — P3.3 Mobile / Device Notifications.
 *
 * A delivery abstraction for device push on top of the existing P2
 * Notifications module (no separate notification engine). Maps cowork
 * lifecycle events into device-shaped, redacted notifications:
 *   - cowork completed
 *   - agent failed
 *   - approval required
 *   - scheduled task
 *   - background task completed
 *
 * Everything is workspace-scoped and secrets are stripped (the shared
 * sanitizer masks values while keeping keys). Delivery is durable via the same
 * outbox-slot semantics; devices resync by Last-Event-ID.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { IpcBus, IpcEvent } from '../ipc.js';
import type { P3Feature } from './flags.js';

export type DeviceEventKind =
  | 'cowork.completed'
  | 'agent.failed'
  | 'approval.required'
  | 'scheduled.completed'
  | 'background.completed';

export interface DeviceNotification {
  id: string;
  kind: DeviceEventKind;
  workspaceId: string | null;
  title: string;
  body: string;
  data: Record<string, unknown>;
  at: number;
}

export interface DeviceTransport {
  deliver(deviceId: string, n: DeviceNotification): void | Promise<void>;
}

export class DeviceNotifications {
  private devices = new Map<string, DeviceTransport>();
  private outbox: DeviceNotification[] = [];
  private seq = 0;
  private byWorkspace = new Map<string, Set<string>>();

  constructor(
    private feature: () => P3Feature | null,
    private ipc?: IpcBus,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'notifications';
  }

  /** Register a device transport (optionally scoped to a workspace). */
  registerDevice(deviceId: string, transport: DeviceTransport, workspaceId: string | null): () => void {
    this.ensure();
    this.devices.set(deviceId, transport);
    if (workspaceId !== null) {
      if (!this.byWorkspace.has(workspaceId)) this.byWorkspace.set(workspaceId, new Set());
      this.byWorkspace.get(workspaceId)!.add(deviceId);
    }
    return () => {
      this.devices.delete(deviceId);
      for (const set of this.byWorkspace.values()) set.delete(deviceId);
    };
  }

  /** Emit a device notification for a kind. Always redacted. */
  emit(kind: DeviceEventKind, ws: string | null, title: string, body: string, data: Record<string, unknown> = {}): DeviceNotification {
    this.ensure();
    this.seq += 1;
    const n: DeviceNotification = {
      id: `${this.seq}_${randomUUID().slice(0, 8)}`,
      kind,
      workspaceId: ws,
      title,
      body,
      data: sanitizeFields(data),
      at: Date.now(),
    };
    this.outbox.push(n);
    if (this.outbox.length > 2000) this.outbox.shift();
    for (const deviceId of this.deliverableDevices(ws)) {
      const t = this.devices.get(deviceId);
      if (t) void t.deliver(deviceId, n);
    }
    return n;
  }

  /** Consume an OS bus event and translate it to a device notification (no secrets). */
  feed(ev: IpcEvent): DeviceNotification | null {
    if (!this.isEnabled()) return null;
    const topic = ev.topic;
    let kind: DeviceEventKind | null = null;
    let title = topic;
    if (topic.includes('cowork') && topic.includes('complete')) { kind = 'cowork.completed'; title = 'Cowork completed'; }
    else if (topic.includes('agent') && topic.includes('fail')) { kind = 'agent.failed'; title = 'Agent failed'; }
    else if (topic.includes('approval') && topic.includes('request')) { kind = 'approval.required'; title = 'Approval required'; }
    else if (topic.includes('schedule') && topic.includes('complete')) { kind = 'scheduled.completed'; title = 'Scheduled task completed'; }
    else if (topic.includes('background') && topic.includes('complete')) { kind = 'background.completed'; title = 'Background task completed'; }
    if (!kind) return null;
    return this.emit(kind, ev.workspaceId, title, title, ev.payload as Record<string, unknown>);
  }

  /** Re-sync a device from a last-delivered id (Last-Event-ID semantics). */
  replayDevice(deviceId: string, ws: string | null, afterId = 0): DeviceNotification[] {
    this.ensure();
    const out: DeviceNotification[] = [];
    for (const n of this.outbox) {
      const idNum = Number(n.id.split('_')[0]);
      if (idNum > afterId && this.watches(deviceId, n.workspaceId, ws)) out.push(n);
    }
    return out;
  }

  private deliverableDevices(ws: string | null): string[] {
    if (ws === null) return [...this.devices.keys()];
    const set = this.byWorkspace.get(ws);
    if (!set) return [];
    return [...set];
  }

  private watches(deviceId: string, notifyWs: string | null, requestedWs: string | null): boolean {
    if (notifyWs === null || requestedWs === null) return true;
    return notifyWs === requestedWs;
  }

  /** Forward a P2-style notification into device delivery (composition, no re-implementation). */
  fromNotification(n: { workspaceId: string | null; kind: string; title: string; body: string; data?: Record<string, unknown> }): DeviceNotification | null {
    if (!this.isEnabled()) return null;
    const map: Record<string, DeviceEventKind> = {
      'cowork.completed': 'cowork.completed',
      'agent.failed': 'agent.failed',
      'approval.required': 'approval.required',
      'scheduled.completed': 'scheduled.completed',
      'background.completed': 'background.completed',
    };
    const kind = map[n.kind];
    if (!kind) return null;
    return this.emit(kind, n.workspaceId, n.title, n.body, n.data ?? {});
  }

  private ensure(): void {
    if (this.feature() !== 'notifications') throw AppError.conflict('aios_p3_notifications_disabled', 'device notifications feature is off');
  }

  deviceCount(): number {
    return this.devices.size;
  }
}
