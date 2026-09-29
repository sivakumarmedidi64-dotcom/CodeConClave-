/**
 * Cloud read paths: entitlement honesty (never invent state), reconnect
 * backoff, and idempotent cowork resume (never duplicate actions).
 */
import { describe, it, expect, vi } from 'vitest';
import { BackendClient } from './client.js';
import { EntitlementReader } from './entitlement.js';
import { ReconnectController } from './reconnect.js';
import { CoworkResumer } from './resume.js';

function clientWith(json: unknown, status = 200) {
  const fetchImpl = vi.fn(async () => ({ status, json: async () => json }));
  const client = new BackendClient('https://api.example', fetchImpl as never);
  return { client, fetchImpl };
}

describe('entitlement reader', () => {
  it('maps a 200 /auth/me to the server-authoritative state', async () => {
    const { client } = clientWith({ data: { user: { id: 'u1', planId: 'pro', entitlementState: 'PRO_VERIFIED' } } });
    const e = await new EntitlementReader(client).read();
    expect(e).toEqual({ online: true, authed: true, planId: 'pro', entitlementState: 'PRO_VERIFIED' });
  });

  it('maps 401 to anon/free', async () => {
    const { client } = clientWith({ error: { code: 'UNAUTHENTICATED' } }, 401);
    const e = await new EntitlementReader(client).read();
    expect(e).toEqual({ online: true, authed: false, planId: null, entitlementState: 'FREE' });
  });

  it('maps network failure to offline + UNKNOWN, never a fabricated state', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const client = new BackendClient('https://api.example', fetchImpl as never);
    const e = await new EntitlementReader(client).read();
    expect(e).toEqual({ online: false, authed: false, planId: null, entitlementState: 'UNKNOWN' });
  });

  it('normalizes unknown plan/state into UNKNOWN instead of guessing', async () => {
    const { client } = clientWith({ data: { user: { planId: 'mystery', entitlementState: 'EVIL_SCHEME' } } });
    const e = await new EntitlementReader(client).read();
    expect(e).toEqual({ online: true, authed: true, planId: null, entitlementState: 'UNKNOWN' });
  });
});

describe('reconnect controller', () => {
  it('goes offline, backs off, and reports recovery exactly once', async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onReconnected = vi.fn(async () => undefined);
    const statuses: string[] = [];
    const rc = new ReconnectController({
      probe,
      onStatus: (s) => void statuses.push(s.online ? 'online' : 'offline'),
      onReconnected,
    }, { baseMs: 1000, maxMs: 30_000 });

    await rc.tick();
    expect(rc.status.online).toBe(false);
    expect(rc.status.reconnecting).toBe(true);
    expect(statuses).toContain('offline');

    await vi.advanceTimersByTimeAsync(1000);
    expect(onReconnected).toHaveBeenCalledTimes(1);
    expect(rc.status.online).toBe(true);
    expect(rc.status.reconnecting).toBe(false);
    expect(statuses).toContain('online');

    rc.stop();
    vi.useRealTimers();
  });

  it('negligible backoff runs do not fire after disconnect()', async () => {
    vi.useFakeTimers();
    const onReconnected = vi.fn();
    const rc = new ReconnectController({
      probe: vi.fn(async () => false),
      onStatus: () => undefined,
      onReconnected,
    }, { baseMs: 10_000 });
    await rc.tick(); // schedules a 10s retry
    rc.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onReconnected).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('resets attempts to 0 on a manual reconnect success', async () => {
    const rc = new ReconnectController({
      probe: vi.fn(async () => true),
      onStatus: () => undefined,
    }, { baseMs: 1000 });
    const s = await rc.reconnect();
    expect(s.online).toBe(true);
    expect(s.attempts).toBe(0);
  });
});

describe('cowork resumer — exactly-once', () => {
  function make(cursor = null as number | null, online = true) {
    const cursors = new Map<string, number>();
    if (cursor !== null) cursors.set('c1', cursor);
    const setLastCursor = vi.fn();
    const resumer = new CoworkResumer({
      client: new BackendClient('https://api.example', (async () => ({ status: 200, json: async () => ({ data: { messages: [{ id: 'm1', seq: 1 }, { id: 'm2', seq: 2 }] } }) })) as never),
      isOnline: () => online,
      lastCursor: (id) => cursors.get(id) ?? null,
      setLastCursor,
    });
    return { resumer, setLastCursor };
  }

  it('first resume reports changed=true and stores a monotonic cursor', async () => {
    const { resumer, setLastCursor } = make();
    const r = await resumer.resume('c1');
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.cursor).toBe(2);
    expect(setLastCursor).toHaveBeenCalledWith('c1', 2);
  });

  it('second resume with unchanged server state reports changed=false (no duplicate action)', async () => {
    const { resumer, setLastCursor } = make(2);
    const r = await resumer.resume('c1');
    expect(r.changed).toBe(false);
    expect(setLastCursor).toHaveBeenCalledTimes(1); // same cursor, still tracked
    expect(r.cursor).toBe(2);
  });

  it('is offline-safe and never invents cloud state', async () => {
    const { resumer } = make(null, false);
    const r = await resumer.resume('c1');
    expect(r).toMatchObject({ ok: false, error: 'offline', changed: false });
  });

  it('maps 403/401 to auth_required and 404 to session_not_found', async () => {
    const client401 = new BackendClient('https://api.example', (async () => ({ status: 401, json: async () => ({}) })) as never);
    const r401 = await new CoworkResumer({ client: client401, isOnline: () => true, lastCursor: () => null, setLastCursor: () => undefined }).resume('c2');
    expect(r401.error).toBe('auth_required');

    const client404 = new BackendClient('https://api.example', (async () => ({ status: 404, json: async () => ({}) })) as never);
    const r404 = await new CoworkResumer({ client: client404, isOnline: () => true, lastCursor: () => null, setLastCursor: () => undefined }).resume('c3');
    expect(r404.error).toBe('session_not_found');
  });
});