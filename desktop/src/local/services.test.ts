/**
 * Local capabilities: workspace scoping + capability enforcement, files,
 * undo, terminal gate, git runner, watcher, and task monitor. "Capability
 * enforcement" and "workspace isolation" are tested against REAL directories.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager, CapabilityError } from './workspace.js';
import { FilesController } from './files-controller.js';
import { UndoService } from './undo.js';
import { TerminalHost, type SessionFactory } from './terminal-host.js';
import { GitRunner, type GitExec } from './git-runner.js';
import { WorkspaceWatcher } from './watcher.js';
import { LocalTaskMonitor } from './monitor.js';
import { ALL_CAPABILITIES, makeWorkspace } from './testutil.js';

function fakeSession(startOk = true) {
  const calls: string[] = [];
  const writes: string[] = [];
  return {
    calls,
    writes,
    session: {
      tabId: '',
      shell: '',
      cwd: '',
      start: () => {
        calls.push('start');
        return { ok: startOk };
      },
      write: (d: string) => writes.push(d),
      stop: () => void calls.push('stop'),
      getStatus: () => ({ status: 'RUNNING', exitCode: null }),
    },
  };
}

const factory: SessionFactory = (tabId, shell, cwd) => fakeSession().session;

describe('workspace manager', () => {
  it('denies operations without the active capability grant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ['workspace.read', 'files.read'] });
    expect(() => ws.requireActive('files.write')).toThrow(CapabilityError);
    expect(() => ws.requireActive('workspace.read')).not.toThrow();
  });

  it('refuses to open a root that has no grant (arbitrary path can never become a workspace)', () => {
    const ws = makeWorkspace({ capabilities: [] });
    expect(() => ws.open('C:/not-granted')).toThrow(/grant not found/);
  });

  it('resolves paths inside the root and rejects traversal escapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const ok = ws.resolveActive('sub/a.txt');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.abs.replace(/\//g, '\\')).toContain(join('sub', 'a.txt').replace(/\//g, '\\'));
    const esc = ws.resolveActive('../outside.txt');
    expect(esc.ok).toBe(false);
  });

  it('rejects protected paths regardless of the grant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    writeFileSync(join(dir, '.env'), 'SECRET=x', 'utf8');
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const res = ws.resolveActive('.env');
    expect(res.ok).toBe(false);
  });

  it('rejects a symlink that escapes the workspace root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'cc-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'x', 'utf8');
    let linked = false;
    try {
      symlinkSync(outside, join(dir, 'escape'), 'junction' as never);
      linked = true;
    } catch {
      linked = false; // no symlink permission on this host — skip
    }
    if (!linked) return;
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const res = ws.resolveActive('escape/secret.txt');
    expect(res.ok).toBe(false);
  });
});

describe('files controller', () => {
  it('lists, reads, and writes files only inside the active workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    writeFileSync(join(dir, 'a.txt'), 'abc', 'utf8');
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const list = files.list(undefined);
    expect(list.entries.map((e) => e.name)).toContain('a.txt');

    const read = files.read('a.txt');
    expect(read.ok).toBe(true);

    const w1 = files.write('new.txt', 'hello');
    expect(w1.ok).toBe(true);
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('hello');
  });

  it('denies reads that leave the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const res = files.read('../C:/Windows/win.ini');
    expect(res.ok).toBe(false);
  });

  it('denies protected files and non-regular attach targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'plain.txt'), 'x', 'utf8');
    writeFileSync(join(dir, '.env'), 'TOKEN=y', 'utf8');
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const a = files.attach([join(dir, 'plain.txt')]);
    expect(a.accepted).toBe(1);
    const b = files.attach([join(dir, 'sub'), join(dir, 'does-not-exist.txt'), join(dir, '.env')]);
    expect(b.accepted).toBe(0);
    expect(b.rejected.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['not a regular file', 'does not exist', 'path is protected by policy']),
    );
  });

  it('rejects an attach symlink whose target is protected (canonicalized before the policy check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'cc-out-'));
    writeFileSync(join(outside, 'id_rsa'), 'PRIVATE', 'utf8');
    let linked = false;
    try {
      symlinkSync(join(outside, 'id_rsa'), join(dir, 'innocent.txt'));
      linked = true;
    } catch {
      linked = false; // no symlink permission on this host — skip
    }
    if (!linked) return;
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const res = files.attach([join(dir, 'innocent.txt')]);
    expect(res.accepted).toBe(0);
    expect(res.rejected).toEqual([{ path: join(dir, 'innocent.txt'), reason: 'path is protected by policy' }]);
  });

  it('enforces files.write capability', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ['files.read'] });
    const files = new FilesController(ws);
    expect(() => files.write('x.txt', 'y')).toThrow(CapabilityError);
  });

  it('previews an edit diff without touching the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    writeFileSync(join(dir, 'a.txt'), 'abc', 'utf8');
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const res = files.diff('a.txt', 'abc\ndef');
    expect(res.ok).toBe(true);
    expect(res.diff).toContain('+def');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('abc');
  });

  it('denies a diff preview that escapes the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const res = files.diff('../C:/Windows/win.ini', 'x');
    expect(res.ok).toBe(false);
  });

  it('returns metadata for a file inside the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    writeFileSync(join(dir, 'a.txt'), 'abc', 'utf8');
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const res = files.metadata('a.txt');
    expect(res.ok).toBe(true);
    expect(res.name).toBe('a.txt');
    expect(res.isDirectory).toBe(false);
    expect(res.sizeBytes).toBe(3);
  });
});

describe('undo', () => {
  it('lists backups and rolls the workspace back exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const files = new FilesController(ws);
    const undo = new UndoService(ws);
    files.write('doc.md', 'version one');
    files.write('doc.md', 'version two');
    const items = undo.list();
    expect(items.length).toBe(1);
    const res = undo.rollback(items[0]!.id);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(dir, 'doc.md'), 'utf8')).toBe('version one');
  });

  it('rejects unknown undo ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const undo = new UndoService(ws);
    const res = undo.rollback('nope.000000000000');
    expect(res.ok).toBe(false);
  });
});

describe('terminal host', () => {
  it('denies shells outside the allow-list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const host = new TerminalHost(ws, { onOutput: () => undefined, onStatus: () => undefined }, factory);
    expect(() => host.open('sh', dir)).toThrow(CapabilityError);
  });

  it('opens a session in the resolved cwd and gates every typed line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const spy = fakeSession();
    const localFactory: SessionFactory = (tabId, shell, cwd) => {
      spy.session.tabId = tabId;
      spy.session.shell = shell;
      spy.session.cwd = cwd;
      return spy.session;
    };
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const host = new TerminalHost(ws, { onOutput: () => undefined, onStatus: () => undefined }, localFactory);
    const s = host.open('bash', './sub');
    expect(s.cwd.endsWith('sub')).toBe(true);
    expect(spy.calls).toContain('start');

    const bad = host.write(s.tabId, 'rm -rf /');
    expect(bad.accepted).toBe(false);
    const good = host.write(s.tabId, 'npm run test');
    expect(good.accepted).toBe(true);
    expect(spy.writes[0]).toBe('npm run test\n');
  });

  it('refuses writes to unknown sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const host = new TerminalHost(ws, { onOutput: () => undefined, onStatus: () => undefined }, factory);
    const res = host.write('tab-zzz', 'ls');
    expect(res.accepted).toBe(false);
  });
});

describe('git runner', () => {
  it('honors the subcommand allow-list and forces cwd to the workspace root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const calls: string[][] = [];
    const exec: GitExec = async (args, cwd) => {
      calls.push([...args]);
      expect(cwd).toBe(dir);
      if (args[0] === 'status') return { stdout: '## main...origin/main\n M file.ts\n?? new.ts\n', stderr: '', code: 0 };
      if (args[0] === 'diff') return { stdout: '+x\n-x\n'.repeat(40000), stderr: '', code: 0 };
      return { stdout: 'refs/heads/main\n', stderr: '', code: 0 };
    };
    const git = new GitRunner(ws, exec);
    const status = await git.status();
    expect(status.ok).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.files).toHaveLength(2);
    const diff = await git.diff();
    expect(diff.ok).toBe(true);
    expect(diff.truncated).toBe(true);
    expect(diff.diff.length).toBeLessThanOrEqual(200 * 1024);
    // only allow-listed commands are possible
    expect(calls.every((a) => ['status', 'diff', 'rev-parse', 'log', 'diff-index'].includes(a[0]!))).toBe(true);
  });

  it('maps git failure to an explicit error, never throwing raw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const git = new GitRunner(ws, async () => ({ stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git', code: 128 }));
    const status = await git.status();
    expect(status.ok).toBe(false);
    expect(status.error).toContain('not a git repository');
    const diff = await git.diff();
    expect(diff.ok).toBe(false);
    expect(diff.diff).toBe('');
  });
});

describe('workspace watcher ', () => {
  it('filters ignored/hidden paths and debounces before emitting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ALL_CAPABILITIES });
    const changes: unknown[] = [];
    const watcher = new WorkspaceWatcher(ws, { onChange: (c) => changes.push(c) }, () => ({ close: vi.fn() }));
    const cb = vi.fn();
    watcher.start();
    watcher.onEvent(dir, '.git/config', 'change');
    watcher.onEvent(dir, '.hidden.txt', 'change');
    watcher.onEvent(dir, 'src/app.ts', 'change');
    watcher.onEvent(dir, '.codeconclave-backups/x.bak', 'rename');
    expect(changes.length).toBe(0);
    watcher.flushNow();
    expect(changes).toHaveLength(1);
    expect((changes[0] as { path: string }).path).toBe('src/app.ts');
  });
});

describe('task monitor', () => {
  it('requires the task.monitor capability and never invents cloud state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ['task.monitor'] });
    const monitor = new LocalTaskMonitor(ws);
    const task = monitor.begin('terminal', 'npm run build');
    monitor.finish(task.id, 'SUCCEEDED');
    expect(monitor.list().map((t) => t.status)).toContain('SUCCEEDED');
  });

  it('is capability-gated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ws-'));
    const ws = makeWorkspace({ dir, capabilities: ['files.read'] });
    const monitor = new LocalTaskMonitor(ws);
    expect(() => monitor.list()).toThrow(CapabilityError);
  });
});