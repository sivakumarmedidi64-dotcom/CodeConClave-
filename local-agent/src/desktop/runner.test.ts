/**
 * CodeConClave Local Agent — P2 desktop-control runner tests.
 *
 * Proves the desktop surface is minimal and honest:
 *  - command builders produce safe PowerShell (quoted, allowlist-gated);
 *  - the runner refuses while disabled, on non-Windows, and without a grant;
 *  - an app outside the allowlist is never launched;
 *  - a real success reports the REAL windows/result, never a fabricated one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildListWindowsCommand,
  buildOpenAppCommand,
  buildFocusWindowCommand,
  parseWindows,
  desktopRequiredCapabilities,
  advertisedDesktopCapabilities,
  runDesktopInstruction,
} from './runner.js';
import type { AgentConfig } from '../config.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    version: '0.1.0',
    deviceId: 'dev_1',
    deviceSecretHash: 'x',
    createdAt: new Date().toISOString(),
    workspaces: [],
    desktop: [{ name: 'Workstation', capabilities: ['desktop.inspect', 'desktop.open_app', 'desktop.focus_window'] }],
    ...overrides,
  };
}

const instruction = {
  type: 'desktop',
  grants: { capabilities: ['desktop.inspect', 'desktop.open_app'], lifetimeMs: 3600_000 },
  actions: [{ op: 'list_windows' }],
};

const ok = (output: string) => ({ ok: true, output, exitCode: 0, timedOut: false });

const deps = (run: ReturnType<typeof vi.fn>, platform: NodeJS.Platform = 'win32') => ({
  send: () => undefined,
  reportProgress: () => undefined,
  run: run as never,
  platform,
});

describe('desktop runner — command builders', () => {
  it('single-quotes values and doubles embedded quotes', () => {
    expect(buildOpenAppCommand('notepad')).toBe("Start-Process -FilePath 'notepad'");
    expect(buildFocusWindowCommand("it's")).toContain("'it''s'");
  });

  it('builds a window-enumeration command', () => {
    expect(buildListWindowsCommand()).toContain('Get-Process');
    expect(buildListWindowsCommand()).toContain('MainWindowTitle');
  });
});

describe('desktop runner — parsing + capabilities', () => {
  it('parses an array, a single object, empty and malformed output', () => {
    expect(parseWindows(JSON.stringify([{ Id: 1, ProcessName: 'notepad', MainWindowTitle: 'Untitled' }]))).toEqual([
      { id: 1, process: 'notepad', title: 'Untitled' },
    ]);
    expect(parseWindows(JSON.stringify({ Id: 2, ProcessName: 'calc', MainWindowTitle: 'Calculator' }))).toHaveLength(1);
    expect(parseWindows('')).toEqual([]);
    expect(parseWindows('null')).toEqual([]);
    expect(parseWindows('not json')).toEqual([]);
    expect(parseWindows(JSON.stringify({ Id: 3, ProcessName: 'x', MainWindowTitle: '' }))).toEqual([]);
  });

  it('advertises only known, gated desktop capabilities', () => {
    expect(advertisedDesktopCapabilities(makeConfig())).toEqual([]);
    vi.stubEnv('DESKTOP_CONTROL_ENABLED', 'true');
    expect(advertisedDesktopCapabilities(makeConfig()).sort()).toEqual(['desktop.focus_window', 'desktop.inspect', 'desktop.open_app']);
    const dirty = makeConfig({ desktop: [{ name: 'x', capabilities: ['desktop.inspect', 'bogus'] }] });
    expect(advertisedDesktopCapabilities(dirty)).toEqual([]);
  });

  it('derives required capabilities from the actions', () => {
    expect(desktopRequiredCapabilities({ actions: [{ op: 'open_app', app: 'notepad' }, { op: 'bogus' }] })).toEqual(['desktop.open_app']);
  });
});

describe('desktop runner — execution honesty', () => {
  beforeEach(() => {
    vi.stubEnv('DESKTOP_CONTROL_ENABLED', 'true');
    vi.stubEnv('DESKTOP_ALLOWED_APPS', 'notepad');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses while the device gate is off', async () => {
    vi.stubEnv('DESKTOP_CONTROL_ENABLED', 'false');
    const run = vi.fn();
    const outcome = await runDesktopInstruction(instruction, makeConfig(), 'lta', 1, deps(run));
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('desktop_not_enabled');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses honestly on a non-Windows platform', async () => {
    const run = vi.fn();
    const outcome = await runDesktopInstruction(instruction, makeConfig(), 'lta', 1, deps(run, 'linux'));
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('desktop_unsupported_platform');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses when no desktop grant provides the capability', async () => {
    const run = vi.fn();
    const outcome = await runDesktopInstruction(instruction, makeConfig({ desktop: [] }), 'lta', 1, deps(run));
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('desktop_capability_not_granted');
    expect(run).not.toHaveBeenCalled();
  });

  it('never launches an app outside the local allowlist', async () => {
    const run = vi.fn();
    const instr = { ...instruction, actions: [{ op: 'open_app', app: 'powershell' }] };
    const outcome = await runDesktopInstruction(instr, makeConfig(), 'lta', 1, deps(run));
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('desktop_app_not_allowlisted');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports the REAL enumerated windows on success', async () => {
    const run = vi.fn(async () => ok(JSON.stringify([{ Id: 7, ProcessName: 'notepad', MainWindowTitle: 'Untitled - Notepad' }])));
    const outcome = await runDesktopInstruction(instruction, makeConfig(), 'lta', 1, deps(run));
    expect(outcome.ok).toBe(true);
    expect(outcome.summary.actionsAttempted).toBe(1);
    expect(outcome.summary.windows).toEqual([{ process: 'notepad', title: 'Untitled - Notepad' }]);
  });

  it('launches an allow-listed app via Start-Process', async () => {
    const run = vi.fn(async (_shell: string, _command: string) => ok(''));
    const instr = { ...instruction, actions: [{ op: 'open_app', app: 'notepad' }] };
    const outcome = await runDesktopInstruction(instr, makeConfig(), 'lta', 1, deps(run));
    expect(outcome.ok).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(String(run.mock.calls[0]![1])).toContain("Start-Process -FilePath 'notepad'");
  });

  it('fails honestly when the underlying PowerShell action fails', async () => {
    const run = vi.fn(async () => ({ ok: true, output: 'boom', exitCode: 1, timedOut: false }));
    const outcome = await runDesktopInstruction(instruction, makeConfig(), 'lta', 1, deps(run));
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('desktop_action_failed');
  });
});
