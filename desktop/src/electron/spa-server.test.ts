/**
 * CodeConClave Desktop — embedded SPA server (server.cjs) integration tests.
 * Covers the F8 port contract end-to-end with a real spawned server:
 *   1. preferred port free  -> binds it, reports it, serves the SPA
 *   2. preferred port taken -> falls forward, reports the fallback, stays usable
 *   3. /api HTTP + SSE are proxied to the backend origin, and WebSocket upgrades
 *      (the /agent hub) are forwarded intact to the backend
 * The machine-readable bound-port marker is what the Electron shell parses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function serverCjsPath(): string {
  const resources = resolve(__dirname, '../../resources/frontend/server.cjs');
  const frontend = resolve(__dirname, '../../../frontend/server.cjs');
  return resources;
}

const BOUND_PORT_RE = /__BOUND_PORT_START__(\d+)__BOUND_PORT_END__/;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolvePort(port));
    });
  });
}

function listenAll(
  srv: http.Server,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolvePort((srv.address() as net.AddressInfo).port);
    });
  });
}

const running: ChildProcess[] = [];
async function spawnFrontend(options: { port: number; proxyTarget?: string }): Promise<{
  child: ChildProcess;
  boundPort: () => Promise<number>;
}> {
  const child = spawn(process.execPath, [serverCjsPath()], {
    env: {
      ...process.env,
      PORT: String(options.port),
      ...(options.proxyTarget ? { FRONTEND_PROXY_TARGET: options.proxyTarget } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  const boundPort = () =>
    new Promise<number>((resolvePort, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('bound-port marker timeout')), 8000);
      const onData = (d: Buffer) => {
        out += d.toString();
        const m = BOUND_PORT_RE.exec(out);
        if (m) {
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          resolvePort(Number(m[1]));
        }
      };
      child.stdout?.on('data', onData);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`frontend exited early (code ${child.exitCode})`));
      });
    });
  return { child, boundPort };
}

function getJson(base: string, path: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  contentType: string;
  body: string;
}> {
  return new Promise((resolveRes, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: new URL(base).port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolveRes({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body,
        }),
      );
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('get timeout')));
  });
}

function wsUpgrade(base: string, path: string): Promise<{
  status: number;
  acceptHeader: string;
  frameHex: string;
}> {
  return new Promise((resolveRes, reject) => {
    const port = new URL(base).port;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'x3JJHMbDL1EzLkh9GBhXDw==',
      },
    });
    req.setTimeout(5000, () => req.destroy(new Error('upgrade timeout')));
    req.on('upgrade', (res, socket) => {
      socket.once('data', (buf) => {
        socket.destroy();
        resolveRes({
          status: res.statusCode ?? 0,
          acceptHeader: String(res.headers['sec-websocket-accept'] ?? ''),
          frameHex: buf.toString('hex'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null) return resolveStop();
    child.once('exit', () => resolveStop());
    child.kill();
  });
}

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((c) => stop(c)));
});

describe('spa-server — F8 port contract', () => {
  it('binds the preferred port when it is free and reports it on stdout', async () => {
    const preferred = await freePort();
    const { boundPort } = await spawnFrontend({ port: preferred });
    const actual = await boundPort();
    expect(actual).toBe(preferred);

    const res = await getJson(`http://127.0.0.1:${actual}`, '/');
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
  });

  it('falls forward to the next free port when the preferred port is occupied', async () => {
    const occ = http.createServer((_req, res) => {
      res.end('occupied');
    });
    const occupiedPort = await listenAll(occ);

    const { boundPort } = await spawnFrontend({ port: occupiedPort });
    const actual = await boundPort();
    expect(actual).toBe(occupiedPort + 1);

    const res = await getJson(`http://127.0.0.1:${actual}`, '/');
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);

    const stillOcc = await getJson(`http://127.0.0.1:${occupiedPort}`, '/');
    expect(stillOcc.body).toBe('occupied');

    occ.close();
  });
});

describe('spa-server — HTTP / SSE / WebSocket proxy to the backend', () => {
  it('proxies /api JSON, passes SSE streams through, and forwards WS upgrades unscathed', async () => {
    let backendUpgradePath = '';
    let backendUpgradeSawHost = '';
    const backend = http.createServer((req, res) => {
      if (req.url === '/api/v1/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pong: true }));
        return;
      }
      if (req.url === '/api/v1/preview/x/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: tick\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('missing');
    });
    backend.on('upgrade', (req, socket) => {
      backendUpgradePath = req.url ?? '';
      backendUpgradeSawHost = String(req.headers.host ?? '');
      // Complete real handshake with a backend-computed Sec-WebSocket-Accept
      // (derived from the client key), then a frame right behind the 101 so the
      // proxy must forward the buffered head, not just the piped socket.
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: accept-from-backend\r\n\r\n',
      );
      socket.write(Buffer.from([0x81, 0x01, 0x50]));
      socket.end();
    });
    const backendPort = await listenAll(backend);
    const proxyTarget = `http://127.0.0.1:${backendPort}`;

    const preferred = await freePort();
    const { boundPort } = await spawnFrontend({ port: preferred, proxyTarget });
    const frontendPort = await boundPort();
    const frontendBase = `http://127.0.0.1:${frontendPort}`;

    const ping = await getJson(frontendBase, '/api/v1/ping');
    expect(ping.status).toBe(200);
    expect(JSON.parse(ping.body)).toEqual({ pong: true });

    const sse = await getJson(frontendBase, '/api/v1/preview/x/stream', { Accept: 'text/event-stream' });
    expect(sse.status).toBe(200);
    expect(sse.contentType).toMatch(/text\/event-stream/);
    expect(sse.body).toBe('data: tick\n\n');

    const ws = await wsUpgrade(frontendBase, '/api/v1/agent');
    expect(ws.status).toBe(101);
    // The BACKEND's computed accept must flow through unchanged (a hardcoded
    // 101 would fail the browser handshake, since the accept derives from the
    // client's key).
    expect(ws.acceptHeader).toBe('accept-from-backend');
    // The frame sent right behind the 101 must arrive byte-exact (buffered head
    // forwarded to the client, not dropped or re-piped into the backend socket).
    expect(ws.frameHex).toBe('810150');
    // The backend is the one that answered the upgrade for the agent path, and
    // the proxy rewrote Host to the backend origin (not the frontend port).
    expect(backendUpgradePath).toBe('/api/v1/agent');
    expect(backendUpgradeSawHost).toContain(String(backendPort));

    backend.close();
  });
});