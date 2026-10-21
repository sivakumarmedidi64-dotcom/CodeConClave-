/**
 * Regression: a Postgres outage (pg-pool "timeout exceeded when trying to
 * connect") must degrade honestly, never kill the process.
 *
 * Observed crash: under CPU load Neon connects timed out; a DB call inside a
 * WebSocket event callback rejected with nobody to catch it, and the process
 * died with an uncaught pg-pool error. Alongside it: "worker pump error"
 * logged as {} and MaxListenersExceededWarning from a per-checkout
 * client.on('error') listener that was never removed.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue.js')>()),
  claimNextTask: vi.fn(),
}));

import { pool, withTenant } from './db.js';
import { logger } from './logger.js';
import { claimNextTask } from './queue.js';
import { handleUnhandledRejection } from './process-guards.js';
import { metricSnapshot } from '../observability/metrics.js';
import { SESSION_COOKIE } from '../middleware/auth.js';
import { AgentHub } from '../modules/agent/ws.js';
import { BrowserRelay } from '../modules/agent/browser.js';
import { startWorker, _resetWorker } from '../workers/task-worker.js';

const CONNECT_TIMEOUT = 'timeout exceeded when trying to connect';

class FakeSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  ping = vi.fn();
  terminate = vi.fn();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('DB outage does not escape as an unhandled rejection', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    vi.spyOn(pool, 'query').mockRejectedValue(new Error(CONNECT_TIMEOUT) as never);
    vi.spyOn(pool, 'connect').mockRejectedValue(new Error(CONNECT_TIMEOUT) as never);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
  });

  it('agent hub: register during an outage closes the socket (1011) and logs', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const hub = new AgentHub();
    const ws = new FakeSocket();
    (hub as unknown as { wss: EventEmitter }).wss.emit('connection', ws);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'register', token: 't', deviceId: 'dev_1' })));
    await flush();

    expect(unhandled).toEqual([]);
    expect(ws.close).toHaveBeenCalledWith(1011, 'server unavailable');
    expect(warn).toHaveBeenCalledWith('agent connection setup failed', { err: CONNECT_TIMEOUT });
  });

  it('browser relay: session lookup during an outage closes the socket (1011) and logs', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const relay = new BrowserRelay();
    const ws = new FakeSocket();
    const req = { headers: { cookie: `${SESSION_COOKIE}=abc` } } as unknown as IncomingMessage;
    (relay as unknown as { wss: EventEmitter }).wss.emit('connection', ws, req);
    await flush();

    expect(unhandled).toEqual([]);
    expect(ws.close).toHaveBeenCalledWith(1011, 'server unavailable');
    expect(warn).toHaveBeenCalledWith('browser relay connection setup failed', { err: CONNECT_TIMEOUT });
  });

  it('worker pump logs the error message, not {}', async () => {
    _resetWorker();
    vi.mocked(claimNextTask).mockRejectedValue(new Error(CONNECT_TIMEOUT));
    const error = vi.spyOn(logger, 'error');
    const stop = startWorker();
    await flush();
    await stop();

    expect(unhandled).toEqual([]);
    expect(error).toHaveBeenCalledWith('worker pump error', { err: CONNECT_TIMEOUT });
  });
});

describe('pg client error listener', () => {
  it('is attached once per physical connection, not once per checkout', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    // The pool fires 'connect' once when it opens a physical connection.
    pool.emit('connect', client as never);
    const fakePool = { connect: vi.fn().mockResolvedValue(client) };
    for (let i = 0; i < 15; i += 1) {
      await withTenant(null, async () => undefined, fakePool as never);
    }
    expect(client.listenerCount('error')).toBe(1);
    // A socket error on an idle/checked-out client is logged, never thrown.
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  });
});

describe('process guard', () => {
  it('logs and counts an unhandled rejection instead of swallowing it', () => {
    const error = vi.spyOn(logger, 'error');
    const before = metricSnapshot()['process.unhandled_rejection'] ?? 0;
    handleUnhandledRejection(new Error(CONNECT_TIMEOUT));
    expect(metricSnapshot()['process.unhandled_rejection']).toBe(before + 1);
    expect(error).toHaveBeenCalledWith(
      'unhandled promise rejection',
      expect.objectContaining({ error: CONNECT_TIMEOUT }),
    );
    error.mockRestore();
  });
});
