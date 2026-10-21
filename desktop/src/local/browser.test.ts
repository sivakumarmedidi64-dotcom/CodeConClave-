/**
 * Built-in browser pane + "open in my browser": URL policy, pane lifecycle
 * with a fake view, installed-browser detection, and the IPC wiring through
 * the real DesktopApp registry (boundary validation included).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPane, SEARCH_URL, normalizeBrowserUrl, type PaneBounds, type PaneView } from './browser-pane.js';
import { detectBrowsers, launchCommand, safeExternalUrl } from './browser-launch.js';
import { DesktopApp } from '../desktop/app.js';
import { SettingsStore } from '../desktop/settings.js';
import type { SenderIdentity } from '../ipc/registry.js';

const TOP: SenderIdentity = { frameId: 0, isTopFrame: true, origin: 'http://localhost:4000' };

function fakeView() {
  const calls: string[] = [];
  let url = '';
  let bounds: PaneBounds | null = null;
  let visible = false;
  const history: string[] = [];
  const view: PaneView = {
    load: async (u) => {
      calls.push(`load ${u}`);
      url = u;
      history.push(u);
    },
    back: () => calls.push('back'),
    forward: () => calls.push('forward'),
    reload: () => calls.push('reload'),
    stop: () => calls.push('stop'),
    setBounds: (b) => {
      bounds = b;
    },
    setVisible: (v) => {
      visible = v;
    },
    destroy: () => calls.push('destroy'),
    state: () => ({ url, title: url ? 'Page' : '', canGoBack: history.length > 1, canGoForward: false, loading: false }),
  };
  return { view, calls, get bounds() { return bounds; }, get visible() { return visible; } };
}

describe('normalizeBrowserUrl', () => {
  it('accepts web pages and fixes what people type', () => {
    expect(normalizeBrowserUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserUrl('docs.example.com:8443/x')).toBe('https://docs.example.com:8443/x');
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserUrl('127.0.0.1:8080/health')).toBe('http://127.0.0.1:8080/health');
  });
  it('turns plain words into a search', () => {
    expect(normalizeBrowserUrl('react hooks tutorial')).toBe(SEARCH_URL + 'react%20hooks%20tutorial');
  });
  it('refuses anything that is not http(s)', () => {
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<b>x</b>', 'chrome://settings', 'about:blank', 'mailto:a@b.c', 'devtools://x', '']) {
      const out = normalizeBrowserUrl(bad);
      // Either refused, or (for scheme-looking words) only ever a search URL.
      expect(out === null || out.startsWith(SEARCH_URL)).toBe(true);
    }
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('BrowserPane', () => {
  it('opens, lays itself over the reserved rectangle, navigates, hides and closes', async () => {
    const fake = fakeView();
    const states: unknown[] = [];
    const pane = new BrowserPane(() => fake.view, (s) => states.push(s));
    const s1 = await pane.open('example.com', { x: 240.4, y: 60, width: 800, height: 600 });
    expect(s1).toMatchObject({ available: true, open: true, visible: true, url: 'https://example.com/' });
    expect(fake.bounds).toEqual({ x: 240, y: 60, width: 800, height: 600 });
    expect(fake.visible).toBe(true);
    await pane.navigate('news.example.org');
    expect(pane.nav('back').canGoBack).toBe(true);
    expect(fake.calls).toContain('back');
    expect(pane.hide()).toMatchObject({ visible: false, open: true });
    expect(fake.visible).toBe(false);
    expect(pane.close()).toMatchObject({ open: false, url: '' });
    expect(fake.calls).toContain('destroy');
    expect(states.length).toBeGreaterThan(3);
  });

  it('refuses non-web URLs and reports unavailable outside the desktop app', async () => {
    const pane = new BrowserPane(() => fakeView().view);
    await expect(pane.open('file:///C:/secret.txt')).rejects.toThrow(/http and https/);
    const web = new BrowserPane(null);
    expect(web.state().available).toBe(false);
    await expect(web.open('example.com')).rejects.toThrow(/desktop app/);
  });
});

describe('installed browsers', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  it('always offers built-in and system default; others only when installed', () => {
    const present = new Set(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']);
    const list = detectBrowsers('win32', env, (p) => present.has(p));
    expect(list.map((b) => b.id)).toEqual(['builtin', 'default', 'chrome', 'edge']);
  });
  it('launches without a shell, URL as a single argument', () => {
    const chrome = { id: 'chrome' as const, name: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' };
    expect(launchCommand('win32', chrome, 'https://example.com/')).toEqual({ command: chrome.path, args: ['https://example.com/'] });
    expect(launchCommand('darwin', { id: 'firefox', name: 'Firefox', path: '/Applications/Firefox.app' }, 'https://x.dev/')).toEqual({
      command: 'open',
      args: ['-a', '/Applications/Firefox.app', 'https://x.dev/'],
    });
  });
  it('only lets http(s) out', () => {
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
    expect(safeExternalUrl('--disable-web-security')).toBeNull();
    expect(safeExternalUrl('file:///C:/x')).toBeNull();
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('browser IPC through DesktopApp', () => {
  function makeApp(installed: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'cc-browser-'));
    const settings = new SettingsStore({ path: join(dir, 'settings.json') });
    const fake = fakeView();
    const spawned: { command: string; args: string[] }[] = [];
    const opened: string[] = [];
    const app = new DesktopApp({
      baseUrl: 'http://localhost:4000',
      grants: [],
      settings,
      fetchImpl: (async () => ({ status: 404, json: async () => ({}) })) as never,
      browserViewFactory: () => fake.view,
      openExternal: async (u) => {
        opened.push(u);
      },
      spawnDetached: (command, args) => spawned.push({ command, args }),
      fileExists: (p) => installed.includes(p),
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
    });
    return { app, settings, fake, spawned, opened };
  }

  it('opens the built-in pane and validates bounds at the boundary', async () => {
    const { app, fake } = makeApp();
    const s = (await app.dispatch('cc:browser:open', { url: 'example.com', bounds: { x: 10, y: 20, width: 300, height: 200 } }, TOP)) as { open: boolean };
    expect(s.open).toBe(true);
    expect(fake.bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    await expect(app.dispatch('cc:browser:bounds', { x: -1, y: 0, width: 1, height: 1 }, TOP)).rejects.toThrow(/invalid number/);
    await expect(app.dispatch('cc:browser:nav', { action: 'exec' }, TOP)).rejects.toThrow(/invalid action/);
  });

  it('defaults to the built-in browser and sends external links to the system default', async () => {
    const { app, opened, spawned } = makeApp();
    const list = (await app.dispatch('cc:browser:list', undefined, TOP)) as { choice: string; browsers: { id: string }[] };
    expect(list.choice).toBe('builtin');
    expect(list.browsers.map((b) => b.id)).toEqual(['builtin', 'default']);
    const out = (await app.dispatch('cc:browser:external', { url: 'https://example.com' }, TOP)) as { openedIn: string };
    expect(out.openedIn).toBe('System default browser');
    expect(opened).toEqual(['https://example.com/']);
    expect(spawned).toEqual([]);
  });

  it('remembers the picked browser and launches it; refuses one that is not installed', async () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const { app, settings, spawned } = makeApp([chrome]);
    await expect(app.dispatch('cc:browser:choose', { choice: 'firefox' }, TOP)).rejects.toThrow(/not installed/);
    await app.dispatch('cc:browser:choose', { choice: 'chrome' }, TOP);
    expect(settings.read().browser.choice).toBe('chrome');
    const out = (await app.dispatch('cc:browser:external', { url: 'https://example.com/docs' }, TOP)) as { openedIn: string };
    expect(out.openedIn).toBe('Google Chrome');
    expect(spawned).toEqual([{ command: chrome, args: ['https://example.com/docs'] }]);
    await expect(app.dispatch('cc:browser:external', { url: 'file:///C:/x' }, TOP)).rejects.toThrow(/http and https/);
  });

  it('routes clicked links: built-in pick → Browser page request; other pick → that browser', async () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const { app, spawned } = makeApp([chrome]);
    const requests = vi.fn();
    app.bus.subscribe('browser-request', requests);
    await app.openLink('https://example.com/a');
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ payload: { url: 'https://example.com/a' } }));
    await app.openLink('javascript:alert(1)');
    expect(requests).toHaveBeenCalledTimes(1);
    await app.dispatch('cc:browser:choose', { choice: 'chrome' }, TOP);
    await app.openLink('https://example.com/b');
    expect(spawned).toEqual([{ command: chrome, args: ['https://example.com/b'] }]);
  });

  it('pushes pane state to the renderer on the event bus', async () => {
    const { app } = makeApp();
    const seen = vi.fn();
    app.bus.subscribe('browser', seen);
    await app.dispatch('cc:browser:open', { url: 'https://example.com' }, TOP);
    expect(seen).toHaveBeenCalled();
  });
});
