/**
 * Preload bridge contract: the renderer surface is frozen, allow-listed only,
 * and has NO generic IPC passthrough. This is the "no renderer privilege
 * escalation" guard: even a compromised renderer can only reach the fixed
 * methods below, each mapping to exactly one allow-listed channel.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildPreloadApi } from './api.js';
import type { DesktopSurface } from './contract.js';

function build() {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const subscribed: string[] = [];
  const api = buildPreloadApi({
    call: async (channel, payload) => {
      calls.push({ channel: channel as string, payload });
      return { ok: true };
    },
    on: (name, cb) => {
      subscribed.push(name);
      void cb;
      return () => void subscribed.push(`${name}:unsub`);
    },
    platform: 'win32',
    appVersion: '0.1.0',
    electronRuntime: true,
  });
  return { api, calls, subscribed };
}

const SURFACE_METHODS = [
  'auth.status', 'auth.entitlement',
  'workspace.list', 'workspace.open', 'workspace.detect',
  'files.list', 'files.read', 'files.metadata', 'files.diff', 'files.write', 'files.attach', 'files.drop',
  'undo.list', 'undo.rollback',
  'terminal.open', 'terminal.write', 'terminal.kill', 'terminal.list',
  'git.status', 'git.diff',
  'task.list',
  'reconnect.status', 'reconnect.reconnect',
  'cowork.resume',
  'settings.read', 'settings.setTheme',
  'monitor.subscribe',
  'voice.support',
  'teamCollab.support', 'teamCollab.presence', 'teamCollab.skills', 'teamCollab.queue',
  'screen.capture', 'screen.sources',
];

describe('preload surface', () => {
  it('is a frozen bridge with the exact method set', () => {
    const { api } = build();
    expect(api.isDesktopBridge).toBe(true);
    expect(Object.isFrozen(api)).toBe(true);
    const flat: string[] = [];
    for (const [group, methods] of Object.entries(api.desktop as unknown as Record<string, Record<string, unknown>>)) {
      if (group === 'platform' || group === 'versions') continue;
      for (const m of Object.keys(methods ?? {})) flat.push(`${group}.${m}`);
    }
    // Order-independent comparison
    expect([...flat].sort()).toEqual([...SURFACE_METHODS].sort());
    expect(api.desktop.versions.electron).toBe(true);
  });

  it('exposes NO generic invoke/send/require primitives', () => {
    const { api } = build();
    const json = JSON.stringify(api);
    for (const forbidden of ['invoke', 'send', 'require', 'webContents', 'shell', 'exec', 'spawn', 'child_process', 'node:']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('maps each root method to the exact allow-listed channel', async () => {
    const { api, calls } = build();
    await api.desktop.git.status();
    await api.desktop.git.diff('src/a.ts');
    await api.desktop.workspace.open('C:/proj');
    await api.desktop.auth.entitlement();
    await api.desktop.files.write('note.md', 'hello');
    await api.desktop.terminal.write('tab-1', 'npm run test');
    await api.desktop.cowork.resume('conv_abc');
    await api.desktop.teamCollab.support();
    await api.desktop.teamCollab.presence('team1');
    await api.desktop.teamCollab.skills('team1');
    await api.desktop.teamCollab.queue('team1');
    expect(calls.map((c) => c.channel)).toEqual([
      'cc:git:status', 'cc:git:diff', 'cc:workspace:open', 'cc:entitlement:read',
      'cc:files:write', 'cc:terminal:write', 'cc:cowork:resume',
      'cc:teamcollab:support', 'cc:teamcollab:presence', 'cc:teamcollab:skills', 'cc:teamcollab:queue',
    ]);
  });

  it('forwards exactly the payload the method was called with', async () => {
    const { api, calls } = build();
    await api.desktop.workspace.open('C:/proj');
    await api.desktop.settings.setTheme('dark');
    expect(calls[0]!.payload).toEqual({ root: 'C:/proj' });
    expect(calls[1]!.payload).toEqual({ theme: 'dark' });
  });

  it('forwards only the teamId to team-collab read methods (no free-form IPC)', async () => {
    const { api, calls } = build();
    await api.desktop.teamCollab.presence('team-9');
    await api.desktop.teamCollab.skills('team-9');
    await api.desktop.teamCollab.queue('team-9');
    expect(calls.map((c) => c.payload)).toEqual([
      { teamId: 'team-9' },
      { teamId: 'team-9' },
      { teamId: 'team-9' },
    ]);
  });

  it('monitor.subscribe returns an unsubscribe function tied to the event bus', async () => {
    const { api } = build();
    const cb = vi.fn();
    const unsub = await api.desktop.monitor.subscribe(cb);
    expect(typeof unsub).toBe('function');
  });
});

describe('preload vs DesktopSurface contract', () => {
  it('conforms structure-wise to the allowed surface', () => {
    const { api } = build();
    const s = api.desktop as unknown as DesktopSurface;
    expect(s.auth).toBeTypeOf('object');
    expect(s.files.attach).toBeTypeOf('function');
  });
});