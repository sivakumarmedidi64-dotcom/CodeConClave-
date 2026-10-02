/**
 * CodeConClave AI OS — event bus (P0.7).
 *
 * In-process publish/subscribe with JSON serialization of payloads. This is the
 * lightweight, honest event bus for the OS foundation; a durable,
 * outbox-backed bus across processes is a P1 item. Event logs are append-only
 * in memory and bounded.
 */
import { randomUUID } from 'node:crypto';

export interface OsEvent<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  at: number;
}

type Subscriber<T> = (e: OsEvent<T>) => void;

const MAX_LOG = 1000;

export class EventBus {
  private subs = new Map<string, Set<Subscriber<unknown>>>();
  private log: OsEvent[] = [];

  publish<T>(topic: string, payload: T): OsEvent<T> {
    const event: OsEvent<T> = { id: randomUUID(), topic, payload, at: Date.now() };
    this.log.push(event as unknown as OsEvent);
    if (this.log.length > MAX_LOG) this.log.shift();
    const set = this.subs.get(topic);
    if (set) {
      for (const fn of set) {
        try {
          fn(event);
        } catch {
          /* subscriber errors never break the bus */
        }
      }
    }
    return event;
  }

  subscribe<T>(topic: string, fn: Subscriber<T>): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    const wrapped = fn as Subscriber<unknown>;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
      if (set.size === 0) this.subs.delete(topic);
    };
  }

  recent(topic?: string, limit = 100): OsEvent[] {
    const match = this.log.filter((e) => (topic ? e.topic === topic : true));
    return match.slice(-limit);
  }

  /** Serialization check used to guard payloads (JSON-safe only). */
  static safe<T>(payload: T): T {
    return JSON.parse(JSON.stringify(payload)) as T;
  }
}
