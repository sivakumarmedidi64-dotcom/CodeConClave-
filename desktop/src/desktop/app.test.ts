/**
 * DesktopApp composition: end-to-end over the IPC registry with a real
 * backend-like fetch spy. Covers preload↔main↔service wiring, capability
 * enforcement through the real channels, origin gating, entitlement honesty,
 * local-only settings, and cowork resume idempotency.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopApp } from './app.js';
import { SettingsStore } from './settings.js';
import { type SenderIdentity } from '../ipc/registry.js';
import { ALL_CAPABILITIES } from '../local/testutil.js';

const TOP: SenderIdentity = { frameId: 0, isTopFrame: true, origin: 'http://localhost:4000' };
const EVIL: SenderIdentity = { frameId: 0, isTopFrame: true, origin: 'https://evil.example' };

function meJson(): { data: { user: { id: string; planId: string; entitlementState: string } } } {
  return { data: { user: { id: 'u1', planId: 'pro', entitlementState: 'PRO_VERIFIED' } } };
}

function conversationJson(): { data: { messages: Array<{ id: string; seq: number }> } } {
  return { data: { messages: [{ id: 'm1', seq: 1 }, { id: 'm2', seq: 2 }] } };
}

function fetchSpy() {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/v1/auth/me')) return { status: 200, json: async () => meJson() };
    if (url.includes('/api/v1/conversations/')) return { status: 200, json: async () => conversationJson() };
    return { status: 404, json: async () => ({}) };
  });
}

function makeApp(opts: { capabilities?: readonly string[]; fetchImpl?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-app-'));
  const settings = new SettingsStore({ path: join(dir, 'settings.json') });
  const app = new DesktopApp({
    baseUrl: 'http://localhost:4000',
    grants: [{ root: dir, name: 'test', capabilities: [...(opts.capabilities ?? ALL_CAPABILITIES)] }],
    settings,
    fetchImpl: (opts.fetchImpl as never) ?? fetchSpy(),
    appVersion: '0.1.0',
  });
  return { app, dir, settings };
}

async function waitOnline(app: DesktopApp): Promise<void> {
  app.start();
  for (let i = 0; i < 50; i++) {
    if (app.reconnect.status.online) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('app never reached online state');
}

describe('DesktopApp IPC + composition', () => {
  it('rejects unknown channels and foreign origins at the boundary', async () => {
    const { app } = makeApp();
    await expect(app.dispatch('cc:zzz', {}, TOP)).rejects.toThrow(/not allow-listed/);
    await expect(app.dispatch('cc:git:status', undefined, EVIL)).rejects.toThrow(/origin not permitted/);
  });

  it('reads entitlement from the canonical backend endpoint, never inventing state', async () => {
    const { app } = makeApp();
    const out = (await app.dispatch('cc:entitlement:read', undefined, TOP)) as { planId: string; entitlementState: string; online: boolean };
    expect(out.planId).toBe('pro');
    expect(out.entitlementState).toBe('PRO_VERIFIED');
    expect(out.online).toBe(true);
  });

  it('exposes zero secrets across the bridge', async () => {
    const { app } = makeApp();
    const e = await app.dispatch('cc:auth:status', undefined, TOP);
    expect(JSON.stringify(e)).not.toMatch(/token|secret|password|cookie|Bearer|[A-Za-z0-9_-]{32,}/);
  });

  it('permits file/git work only when the capability is granted', async () => {
    const { app, dir } = makeApp({ capabilities: ['files.write', 'files.read', 'workspace.read', 'workspace.switch'] });
    const opened = (await app.dispatch('cc:workspace:open', { root: dir }, TOP)) as { root: string; active: boolean };
    expect(opened.active).toBe(true);
    const written = await app.dispatch('cc:files:write', { relPath: 'notes.md', content: 'content' }, TOP);
    expect(written).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('content');

    await expect(app.dispatch('cc:git:status', undefined, TOP)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(app.dispatch('cc:git:diff', undefined, TOP)).rejects.toMatchObject({ code: 'capability_denied' });
  });

  it('keeps settings purely local and sanitized', async () => {
    const { app } = makeApp();
    const a = (await app.dispatch('cc:settings:read', undefined, TOP)) as { ui: { theme: string } };
    expect(a.ui.theme).toBe('system');
    const b = (await app.dispatch('cc:settings:ui', { theme: 'dark' }, TOP)) as { ui: { theme: string } };
    expect(b.ui.theme).toBe('dark');
    const junk = (await app.dispatch('cc:settings:ui', { theme: '<script>' }, TOP)) as { ui: { theme: string } };
    expect(junk.ui.theme).toBe('system');
  });

  it('cowork resume is idempotent against backend cursor state', async () => {
    const { app } = makeApp();
    await waitOnline(app);
    const r1 = await app.dispatch('cc:cowork:resume', { sessionId: 'conv_1' }, TOP);
    expect(r1).toMatchObject({ ok: true, resumed: true, changed: true, cursor: 2 });
    const r2 = await app.dispatch('cc:cowork:resume', { sessionId: 'conv_1' }, TOP);
    expect(r2).toMatchObject({ ok: true, resumed: true, changed: false, cursor: 2 });
  });

  it('reports offline cowork resume without inventing state', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const { app } = makeApp({ fetchImpl });
    const e = await app.dispatch('cc:entitlement:read', undefined, TOP);
    expect(e).toMatchObject({ online: false, entitlementState: 'UNKNOWN' });
    const r = await app.dispatch('cc:cowork:resume', { sessionId: 'conv_9' }, TOP);
    expect(r).toMatchObject({ ok: false, error: 'offline', changed: false });
  });

  it('start() probes connectivity and never throws', async () => {
    const { app } = makeApp();
    app.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(app.reconnect.status).toBeTruthy();
  });
});