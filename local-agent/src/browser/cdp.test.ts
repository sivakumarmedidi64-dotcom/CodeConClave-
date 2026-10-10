/**
 * CodeConClave Local Agent — CDP transport tests.
 *
 * A mock JSON-RPC WebSocket server stands in for the browser's debugging
 * endpoint. Proves: connect handshake enables Page/Runtime domains, `send`
 * correlates ids, CDP `error` messages reject with CdpError, events dispatch to
 * listeners, and close() rejects in-flight sends and marks the session closed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { connectCdp } from './cdp.js';

const servers: WebSocketServer[] = [];

async function mockServer(onMessage: (msg: { id?: number; method?: string; params?: unknown }, sock: WebSocket) => void): Promise<{
  url: string;
  received: { id?: number; method?: string; params?: unknown }[];
  close: () => Promise<void>;
}> {
  const received: { id?: number; method?: string; params?: unknown }[] = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  const url = await new Promise<string>((resolve) => {
    wss.on('listening', () => {
      const a = wss.address() as AddressInfo;
      resolve(`ws://127.0.0.1:${a.port}`);
    });
  });
  wss.on('connection', (sock) => {
    sock.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: number; method?: string; params?: unknown };
      received.push(msg);
      onMessage(msg, sock);
    });
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    });
  return { url, received, close };
}

afterEach(async () => {
  // make server.close() idempotent-safe by clearing the list
  servers.splice(0, servers.length);
});

describe('CDP transport', () => {
  it('connects, auto-enables Page and Runtime domains', async () => {
    const srv = await mockServer(() => {});
    const session = await connectCdp(srv.url);
    await new Promise((r) => setTimeout(r, 50));
    const methods = srv.received.map((m) => m.method ?? '');
    expect(methods).toContain('Page.enable');
    expect(methods).toContain('Runtime.enable');
    session.close();
    await srv.close();
  });

  it('correlates a send with the matching id and resolves the result', async () => {
    const srv = await mockServer((msg, sock) => {
      if (typeof msg.id === 'number') sock.send(JSON.stringify({ id: msg.id, result: { echo: msg.params } }));
    });
    const session = await connectCdp(srv.url);
    await new Promise((r) => setTimeout(r, 20));
    const out = await session.send('Page.navigate', { url: 'https://example.com/' });
    expect(out).toEqual({ echo: { url: 'https://example.com/' } });
    session.close();
    await srv.close();
  });

  it('rejects a send when the browser answers with a CDP error', async () => {
    const srv = await mockServer((msg, sock) => {
      if (typeof msg.id === 'number') sock.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Method not found' } }));
    });
    const session = await connectCdp(srv.url);
    await new Promise((r) => setTimeout(r, 20));
    await expect(session.send('No.SuchMethod')).rejects.toMatchObject({ code: -32601, name: 'CdpError' });
    session.close();
    await srv.close();
  });

  it('dispatches events to registered listeners and supports unsubscribe', async () => {
    let sockRef: WebSocket | null = null;
    const srv = await mockServer((msg, sock) => {
      sockRef = sock;
    });
    const session = await connectCdp(srv.url);
    const seen: unknown[] = [];
    const off = session.on('Runtime.consoleAPICalled', (p) => seen.push(p.type));
    // The mock stores the socket on first received message (the client's
    // automatic Page.enable/Runtime.enable) — wait for that before firing.
    const start = Date.now();
    while (!sockRef && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 5));
    const fire = () => sockRef?.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }));
    fire();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain('log');
    off();
    fire();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.length).toBe(1);
    session.close();
    await srv.close();
  });

  it('close() rejects pending sends and marks the session closed', async () => {
    let sockRef: WebSocket | null = null;
    const srv = await mockServer((msg, sock) => {
      sockRef = sock;
      // never reply — the send stays pending until close() rejects it
    });
    const session = await connectCdp(srv.url);
    await new Promise((r) => setTimeout(r, 20));
    const pending = session.send('Page.navigate', { url: 'x' });
    session.close();
    await expect(pending).rejects.toThrow('cdp_session_closed');
    expect(session.closed).toBe(true);
  });
});