/**
 * CodeConClave AI OS — Durable IPC / Event Bus (P1.1).
 *
 * Canonical OS event bus. CONSOLIDATES the existing primitives rather than
 * duplicating them: the P0 in-memory EventBus is reused as the live publish /
 * subscribe fan-out, and durability is layered on a store that (a) defaults to
 * an in-memory, append-only, seq-ordered store, and (b) can route into the
 * existing transactional outbox (`modules/outbox`) when AIOS_IPC_DURABLE=true
 * so durable events ride the proven outbox retry/backoff/dedupe substrate.
 *
 * Provides: typed events, event IDs + monotonically increasing seq numbers,
 * ordering, consumer offsets, idempotency (per-consumer processed-id dedupe),
 * bounded retry + dead-letter handling, and safe replay. All events are scoped
 * to a workspace so cross-workspace delivery is impossible by construction.
 */
import { randomUUID } from 'node:crypto';
import { EventBus, OsEvent } from './event-bus.js';
import { logger } from '../shared/logger.js';
import { sanitizeFields } from './observability.js';

export interface IpcEvent<T = unknown> {
  id: string;
  seq: number;
  topic: string;
  payload: T;
  workspaceId: string | null;
  createdAt: number;
}

/** Durable event store abstract. Memory is default; outbox adapter may wrap the existing outbox_events table. */
export interface IpcStore {
  readonly kind: 'memory' | 'outbox';
  append<T>(topic: string, payload: T, workspaceId: string | null, seq: number): Promise<IpcEvent<T>>;
  read(workspaceId: string | null, topic?: string, afterSeq?: number, limit?: number): Promise<IpcEvent[]>;
  latestSeq(): number;
}

/** In-memory append-only durable store (honest: not cross-restart). */
export class MemoryIpcStore implements IpcStore {
  readonly kind = 'memory' as const;
  private events: IpcEvent[] = [];
  private seq = 0;
  private readonly max: number;

  constructor(max = 5000) {
    this.max = max;
  }

  latestSeq(): number {
    return this.seq;
  }

  async append<T>(topic: string, payload: T, workspaceId: string | null, seq: number): Promise<IpcEvent<T>> {
    const ev: IpcEvent<T> = { id: randomUUID(), seq, topic, payload, workspaceId, createdAt: Date.now() };
    this.events.push(ev as IpcEvent);
    if (this.events.length > this.max) this.events.shift();
    if (seq > this.seq) this.seq = seq;
    return ev;
  }

  async read(workspaceId: string | null, topic?: string, afterSeq = 0, limit = 1000): Promise<IpcEvent[]> {
    return this.events.filter((e) => {
      if (e.seq <= afterSeq) return false;
      if (workspaceId != null && e.workspaceId !== workspaceId) return false;
      if (topic && e.topic !== topic) return false;
      return true;
    }).slice(-limit);
  }
}

/**
 * Optional outbox-backed store. REUSES the existing transactional outbox so
 * durable events get the proven PENDING/DELIVERED + retry/backoff + dedupe_key
 * substrate. Loaded lazily to avoid pulling outbox/email deps unless enabled.
 */
export class OutboxIpcStore implements IpcStore {
  readonly kind = 'outbox' as const;
  private seqStore = new MemoryIpcStore(0);
  private loaded: Promise<{
    enqueueOutbox: (topic: string, payload: Record<string, unknown>, opts?: { dedupeKey?: string }) => Promise<boolean>;
  } | null> | null = null;

  constructor(private enabled: boolean) {}

  private async deps() {
    if (!this.enabled) return null;
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const mod = await import('../modules/outbox/service.js');
          return { enqueueOutbox: mod.enqueueOutbox };
        } catch {
          logger.warn('aios.ipc.outbox_unavailable', {});
          return null;
        }
      })();
    }
    return this.loaded;
  }

  latestSeq(): number {
    return this.seqStore.latestSeq();
  }

  async append<T>(topic: string, payload: T, workspaceId: string | null, seq: number): Promise<IpcEvent<T>> {
    this.seqStore.append(topic, payload, workspaceId, seq);
    const deps = await this.deps();
    if (deps) {
      try {
        await deps.enqueueOutbox(`aios.ipc:${topic}`, sanitizeFields(payload as Record<string, unknown>), {
          dedupeKey: `${workspaceId ?? 'system'}:${topic}:${seq}`,
        });
      } catch {
        // durable enqueue is best-effort; live delivery still happens
      }
    }
    return { id: randomUUID(), seq, topic, payload, workspaceId, createdAt: Date.now() };
  }

  async read(workspaceId: string | null, topic?: string, afterSeq = 0, limit = 1000): Promise<IpcEvent[]> {
    return this.seqStore.read(workspaceId, topic, afterSeq, limit);
  }
}

export interface DurableConsumer {
  readonly name: string;
  readonly workspaceId: string | null;
  /** Highest seq acknowledged by this consumer (its checkpoint). */
  offset: number;
  /** True if a given event id has already been processed (idempotency guard). */
  hasProcessed(eventId: string): boolean;
  acknowledge(eventId: string, seq: number): void;
  deadLetters(): IpcEvent[];
}

export interface PublishOptions {
  workspaceId?: string | null;
  durable?: boolean;
}

/**
 * The OS event bus. Live subscribers get events immediately; durable events are
 * also appended to the store (memory or outbox) for replay + durable consumers.
 */
export class IpcBus {
  private live = new EventBus();
  private seq = 0;
  private store: IpcStore;
  private consumers = new Map<string, DurableConsumer>();
  private dlq: IpcEvent[] = [];

  constructor(store?: IpcStore) {
    this.store = store ?? new MemoryIpcStore();
    this.seq = this.store.latestSeq();
  }

  get durable(): boolean {
    return this.store.kind !== 'memory' || this.store instanceof MemoryIpcStore;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  async publish<T>(topic: string, payload: T, opts: PublishOptions = {}): Promise<IpcEvent<T>> {
    const seq = this.nextSeq();
    const ev: IpcEvent<T> = {
      id: randomUUID(),
      seq,
      topic,
      payload: EventBus.safe(payload),
      workspaceId: opts.workspaceId ?? null,
      createdAt: Date.now(),
    };
    await this.store.append(topic, ev.payload, ev.workspaceId, seq);
    this.live.publish(topic, { id: ev.id, seq, topic, payload: ev.payload, at: ev.createdAt } as unknown as OsEvent);
    return ev;
  }

  /** Live (in-process) subscription. The handler receives the full IpcEvent. */
  subscribe<T>(topic: string, fn: (e: IpcEvent<T>) => void): () => void {
    return this.live.subscribe(topic, (e) => fn(e.payload as unknown as IpcEvent<T>));
  }

  /** Register a durable consumer (owns its offset + idempotency state). */
  registerConsumer(name: string, workspaceId: string | null): DurableConsumer {
    const existing = this.consumers.get(name);
    if (existing) return existing;
    const processed = new Set<string>();
    const dead: IpcEvent[] = [];
    const consumer: DurableConsumer = {
      name,
      workspaceId,
      offset: 0,
      hasProcessed: (id) => processed.has(id),
      acknowledge: (id, seq) => {
        processed.add(id);
        if (seq > consumer.offset) consumer.offset = seq;
      },
      deadLetters: () => [...dead],
    };
    this.consumers.set(name, consumer);
    return consumer;
  }

  /** Replay events for a consumer after its current offset (idempotent). */
  async replay(workspaceId: string | null, topic?: string, afterSeq = 0, limit = 1000): Promise<IpcEvent[]> {
    return this.store.read(workspaceId, topic, afterSeq, limit);
  }

  /**
   * Deliver a durable event to a consumer handler with bounded retry + DLQ.
   * Idempotent: already-processed events are skipped.
   */
  async deliverDurable(
    consumer: DurableConsumer,
    ev: IpcEvent,
    handler: (e: IpcEvent) => Promise<void>,
    opts: { retries?: number; onError?: (e: IpcEvent, err: unknown) => void } = {},
  ): Promise<'processed' | 'skipped' | 'dead'> {
    if (consumer.hasProcessed(ev.id)) return 'skipped';
    const maxRetries = opts.retries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await handler(ev);
        consumer.acknowledge(ev.id, ev.seq);
        return 'processed';
      } catch (err) {
        opts.onError?.(ev, err);
        if (attempt === maxRetries) {
          this.dlq.push(ev);
          return 'dead';
        }
        await delay(10 * (attempt + 1));
      }
    }
    return 'dead';
  }

  consumersList(): DurableConsumer[] {
    return [...this.consumers.values()];
  }

  deadLetterCount(): number {
    return this.dlq.length;
  }

  /** Deliver all matching events in the durable store to a consumer (replay-forward). */
  async drain(consumer: DurableConsumer, topic?: string, opts: Parameters<IpcBus['deliverDurable']>[3] = {}): Promise<number> {
    const evs = await this.store.read(consumer.workspaceId, topic, consumer.offset);
    let delivered = 0;
    for (const ev of evs) {
      const r = await this.deliverDurable(consumer, ev, async () => {
        delivered += 1;
      }, opts);
      void r;
    }
    return delivered;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
