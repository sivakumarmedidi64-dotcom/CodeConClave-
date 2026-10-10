/**
 * CodeConClave Local Agent — minimal CDP transport.
 *
 * A thin JSON-RPC client over the WebSocket the browser exposes for a page
 * target. Only the methods the browser controller needs are used; nothing here
 * trusts page content. Every `send` correlates a monotonic id and rejects on a
 * CDP `error` field; events dispatch to registered listeners by method name.
 */
import WebSocket from 'ws';

export class CdpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CdpError';
  }
}

export interface CdpSession {
  /** Send a CDP method and resolve with its `result` (rejects on `error`). */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Subscribe to a CDP event (returns an unsubscribe). */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

export function connectCdp(wsUrl: string, timeoutMs = 10_000): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let seq = 0;
    const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
    let closed = false;
    const timer = setTimeout(() => {
      close();
      reject(new Error('cdp_connect_timeout'));
    }, timeoutMs);

    const session: CdpSession = {
      send: (method, params = {}) =>
        new Promise<Record<string, unknown>>((res, rej) => {
          if (closed) {
            rej(new Error('cdp_session_closed'));
            return;
          }
          const id = ++seq;
          pending.set(id, { resolve: res, reject: rej });
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, method, params }));
          else rej(new Error('cdp_not_connected'));
        }),
      on: (method, cb) => {
        let set = listeners.get(method);
        if (!set) {
          set = new Set();
          listeners.set(method, set);
        }
        set.add(cb);
        return () => {
          set.delete(cb);
        };
      },
      close,
      get closed() {
        return closed;
      },
    };

    function close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const { reject } of pending.values()) reject(new Error('cdp_session_closed'));
      pending.clear();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }

    ws.on('open', () => {
      clearTimeout(timer);
      void session.send('Page.enable').catch(() => undefined);
      void session.send('Runtime.enable').catch(() => undefined);
      resolve(session);
    });
    ws.on('message', (data) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new CdpError(msg.error.code, msg.error.message));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (typeof msg.method === 'string') {
        const set = listeners.get(msg.method);
        if (set) {
          for (const cb of [...set]) {
            try {
              cb(msg.params ?? {});
            } catch {
              /* listener errors never break the transport */
            }
          }
        }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      for (const { reject } of pending.values()) reject(err instanceof Error ? err : new Error('cdp_socket_error'));
      pending.clear();
      close();
    });
    ws.on('close', () => close());
  });
}