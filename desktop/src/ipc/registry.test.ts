/**
 * IPC security boundary tests: the allow-list, sender validation, and payload
 * validation all happen BEFORE the handler runs. A handler must be
 * unreachable under a wrong channel, from a non-top frame, from a foreign
 * origin, or with an invalid payload.
 */
import { describe, it, expect } from 'vitest';
import { CHANNELS, IpcPayloadError, channelDef } from './channels.js';
import { IpcSecurityError, IpcRegistry, type SenderIdentity } from './registry.js';

const PORTALS = { isPermittedOrigin: (origin: string | null) => origin === 'https://app.codeconclave.in' };
const TOP = (origin: string | null = 'https://app.codeconclave.in'): SenderIdentity => ({ frameId: 0, isTopFrame: true, origin });
const IFRAME: SenderIdentity = { frameId: 3, isTopFrame: false, origin: 'https://app.codeconclave.in' };
const EVIL_ORIGIN: SenderIdentity = { frameId: 0, isTopFrame: true, origin: 'https://evil.example' };

describe('CHANNELS allow-list', () => {
  it('contains every channel referenced by the preload', () => {
    expect(CHANNELS.length).toBeGreaterThanOrEqual(24);
    expect(CHANNELS.every((c) => c.channel.startsWith('cc:'))).toBe(true);
  });

  it('rejects unknown channels as IpcSecurityError', () => {
    const reg = new IpcRegistry();
    reg.register('cc:git:status', async () => ({ ok: true }));
    return expect(reg.dispatch('cc:totally:unknown', {}, TOP(), PORTALS)).rejects.toBeInstanceOf(IpcSecurityError);
  });

  it('register() refuses non-allow-listed channels', () => {
    const r = new IpcRegistry();
    expect(() => r.register('cc:nope' as never, async () => 1)).toThrow(/not allow-listed/);
  });

  it('register() refuses duplicate channels', () => {
    const r = new IpcRegistry();
    r.register('cc:git:status', async () => ({ ok: true }));
    expect(() => r.register('cc:git:status', async () => ({ ok: true }))).toThrow(/already registered/);
  });
});

describe('sender validation', () => {
  it('rejects a non-top frame', async () => {
    const r = new IpcRegistry();
    r.register('cc:git:status', async () => ({ ok: true }));
    await expect(r.dispatch('cc:git:status', undefined, IFRAME, PORTALS)).rejects.toBeInstanceOf(IpcSecurityError);
  });

  it('rejects a foreign origin', async () => {
    const r = new IpcRegistry();
    r.register('cc:git:status', async () => ({ ok: true }));
    await expect(r.dispatch('cc:git:status', undefined, EVIL_ORIGIN, PORTALS)).rejects.toBeInstanceOf(IpcSecurityError);
  });

  it('rejects a frameId mismatch even when isTopFrame is true', async () => {
    const r = new IpcRegistry();
    r.register('cc:git:status', async () => ({ ok: true }));
    await expect(r.dispatch('cc:git:status', undefined, { frameId: 1, isTopFrame: true, origin: 'https://app.codeconclave.in' }, PORTALS)).rejects.toThrow(/top frame/);
  });

  it('permits an allow-listed channel from the top frame with a permitted origin', async () => {
    const r = new IpcRegistry();
    let ran = false;
    r.register('cc:git:status', async () => {
      ran = true;
      return { ok: true };
    });
    const out = await r.dispatch('cc:git:status', undefined, TOP(), PORTALS);
    expect(ran).toBe(true);
    expect(out).toEqual({ ok: true });
  });
});

describe('payload validation', () => {
  it('rejects wrong-typed payloads as IpcPayloadError', async () => {
    const r = new IpcRegistry();
    r.register('cc:files:read', async (p: { relPath: string }) => ({ relPath: p.relPath }));
    // relPath must be a string
    await expect(r.dispatch('cc:files:read', { relPath: 42 }, TOP(), PORTALS)).rejects.toBeInstanceOf(IpcPayloadError);
  });

  it('rejects a path that escapes the identifier shape', async () => {
    const r = new IpcRegistry();
    r.register('cc:undo:rollback', async () => ({ ok: true }));
    await expect(r.dispatch('cc:undo:rollback', { id: '../../etc/passwd' }, TOP(), PORTALS)).rejects.toBeInstanceOf(IpcPayloadError);
  });

  it('rejects oversized attach lists', async () => {
    const r = new IpcRegistry();
    r.register('cc:files:attach', async () => ({ accepted: 0, rejected: [] }));
    const many = Array.from({ length: 51 }, (_, i) => `C:/x/${i}.txt`);
    await expect(r.dispatch('cc:files:attach', { paths: many }, TOP(), PORTALS)).rejects.toBeInstanceOf(IpcPayloadError);
  });

  it('validates the payload against the exact channel def', async () => {
    const def = channelDef('cc:files:write');
    expect(def).toBeDefined();
    const clean = def!.validate({ relPath: 'a.txt', content: 'hi' }) as { relPath: string; content: string };
    expect(clean.relPath).toBe('a.txt');
  });

  it('new files.metadata channel requires a path and files.read capability', async () => {
    const def = channelDef('cc:files:metadata');
    expect(def).toBeDefined();
    expect(def!.capability).toBe('files.read');
    expect(channelDef('cc:files:diff')!.capability).toBe('files.write');
  });

  it('drops unknown top-level fields (no forwarder confusion)', async () => {
    const r = new IpcRegistry();
    r.register('cc:git:diff', async (p: {}) => ({ diff: JSON.stringify(p) }));
    const out = (await r.dispatch('cc:git:diff', { relPath: 'x', evil: 'field' }, TOP(), PORTALS)) as { diff: string };
    expect(out.diff).not.toContain('evil');
  });
});