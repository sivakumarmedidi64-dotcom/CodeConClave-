/**
 * CodeConClave AI OS — P2.3 Session Replay.
 *
 * Records a deterministic, replayable timeline of a cowork session by
 * consuming P1 observability events (prompts, process lifecycle, tool calls,
 * file changes, approvals, checkpoints, failures, results). Each recorded event
 * carries a monotonic sequence and the trace id, so replay is deterministic and
 * orderable. Sensitive values are redacted before storage via the same
 * sanitizer used by the tracer (never logs credentials).
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { IpcBus, IpcEvent } from '../ipc.js';
import type { P2Feature } from './flags.js';

export type ReplayEventType =
  | 'prompt'
  | 'process'
  | 'tool'
  | 'file_change'
  | 'approval'
  | 'checkpoint'
  | 'failure'
  | 'result';

export interface ReplayEvent {
  seq: number;
  type: ReplayEventType;
  traceId: string;
  workspaceId: string | null;
  data: Record<string, unknown>;
  at: number;
}

export class SessionReplay {
  private streams = new Map<string, ReplayEvent[]>();
  private seq = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private ipc: IpcBus,
    private feature: () => P2Feature | null,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'replay';
  }

  /** Create/activate a timeline for a workspace. Recording happens via record()/feed(). */
  start(workspaceId: string | null): void {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_replay_disabled', 'replay feature is off');
    if (!this.streams.has(workspaceId ?? 'system')) this.streams.set(workspaceId ?? 'system', []);
  }

  /** Record one replay event (called by the command/bus bridge). */
  record(opts: {
    workspaceId?: string | null;
    traceId?: string;
    type: ReplayEventType;
    data: Record<string, unknown>;
    topics?: string[];
  }): ReplayEvent {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_replay_disabled', 'replay feature is off');
    this.seq += 1;
    const ev: ReplayEvent = {
      seq: this.seq,
      type: opts.type,
      traceId: opts.traceId ?? randomUUID(),
      workspaceId: opts.workspaceId ?? null,
      data: sanitizeFields(opts.data),
      at: Date.now(),
    };
    const key = opts.workspaceId ?? 'system';
    if (!this.streams.has(key)) this.streams.set(key, []);
    const stream = this.streams.get(key)!;
    stream.push(ev);
    // bound the in-memory timeline
    if (stream.length > 5000) stream.shift();
    return ev;
  }

  /** Bridge: consume an IpcEvent published on the OS bus into the timeline. */
  feed(ev: IpcEvent): ReplayEvent | null {
    if (!this.isEnabled()) return null;
    const topic = ev.topic;
    let type: ReplayEventType | null = null;
    if (topic.startsWith('aios.process')) type = 'process';
    else if (topic.startsWith('aios.tool')) type = 'tool';
    else if (topic.startsWith('aios.fs') || topic.startsWith('aios.diff')) type = 'file_change';
    else if (topic.startsWith('aios.approval')) type = 'approval';
    else if (topic.startsWith('aios.checkpoint')) type = 'checkpoint';
    else if (topic.startsWith('aios.failure')) type = 'failure';
    else if (topic.startsWith('aios.result')) type = 'result';
    else if (topic.startsWith('aios.prompt')) type = 'prompt';
    if (!type) return null;
    return this.record({
      workspaceId: ev.workspaceId,
      traceId: (ev.payload as Record<string, unknown>)?.['traceId'] as string,
      type,
      data: ev.payload as Record<string, unknown>,
    });
  }

  /** Deterministic replay: return all events in sequence for a workspace. */
  replay(workspaceId: string | null, fromSeq = 0): ReplayEvent[] {
    if (!this.isEnabled()) return [];
    const key = workspaceId ?? 'system';
    return (this.streams.get(key) ?? []).filter((e) => e.seq > fromSeq);
  }

  /** Deterministic replay metadata: first/last seq, count, duration. */
  metadata(workspaceId: string | null): {
    eventCount: number;
    firstSeq: number;
    lastSeq: number;
    firstAt: number | null;
    lastAt: number | null;
  } {
    const events = this.replay(workspaceId);
    if (events.length === 0) {
      return { eventCount: 0, firstSeq: 0, lastSeq: 0, firstAt: null, lastAt: null };
    }
    return {
      eventCount: events.length,
      firstSeq: events[0]!.seq,
      lastSeq: events[events.length - 1]!.seq,
      firstAt: events[0]!.at,
      lastAt: events[events.length - 1]!.at,
    };
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
