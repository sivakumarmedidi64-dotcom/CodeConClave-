/**
 * CodeConClave frontend — vitest setup (jsdom).
 * Cleans DOM between tests and registers jest-dom matchers. This runtime has
 * no localStorage (Node 22 exposes an experimental file-backed global only
 * with a flag), so tests get a deterministic in-memory Storage instead —
 * the offline queue (Phase 16) persists through it like a real browser.
 * EventSource (SSE preview stream) is stubbed: components must degrade
 * gracefully when the stream never opens.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  } as Storage;
}

class EventSourceStub {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(_url: string, _opts?: { withCredentials?: boolean }) {
    /* never connects; components must degrade gracefully */
  }
  addEventListener(_type: string, _cb: EventListenerOrEventListenerObject): void {}
  removeEventListener(_type: string, _cb: EventListenerOrEventListenerObject): void {}
  close(): void {
    this.readyState = this.CLOSED;
  }
  dispatchEvent(_ev: Event): boolean {
    return true;
  }
}

beforeAll(() => {
  if (!(globalThis as { EventSource?: unknown }).EventSource) {
    Object.defineProperty(globalThis, 'EventSource', { value: EventSourceStub, configurable: true });
    try {
      Object.defineProperty(window, 'EventSource', { value: EventSourceStub, configurable: true });
    } catch {
      /* already defined */
    }
  }
  if (!(globalThis as { localStorage?: Storage }).localStorage) {
    const storage = memoryStorage();
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    try {
      Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
    } catch {
      /* window storage is already defined */
    }
  }
});

afterEach(() => {
  cleanup();
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.clear();
  } catch {
    /* localStorage unavailable in this runtime */
  }
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
});