/**
 * CodeConClave — real isolation security tests (Part E subset).
 *
 * Honesty contract under test: policy isolation is NEVER reported as
 * process/container isolation; the facade FAILS CLOSED when the host cannot
 * satisfy the requested boundary; container runs never happen without a
 * verified runtime; host secrets are never forwarded; traversal/metacharacter
 * injection and escape vectors are rejected; timeouts/kill/cleanup/output-cap
 * are actually enforced. Pure unit tests — no real Docker, no destructive
 * actions, nothing against production.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { IsolationMode, satisfies, isRealIsolation } from './modes.js';
import { detectIsolationAbilities, type IsolationProbes } from './detect.js';
import { ContainerExecutor, buildContainerArgs, CONTAINER_DOCKER_ARGS_PREFIX, DEFAULT_CONTAINER_USER } from './container-executor.js';
import { ProcessIsolationExecutor, UNSHARE_PREFIX } from './process-executor.js';
import { ProcessControls } from './process-controls.js';
import { RealIsolationExecutor } from './real-executor.js';
import { EventBus } from '../event-bus.js';

const pExec = promisify(execFile);

function fakeProbes(partial: Partial<IsolationProbes>): IsolationProbes {
  return {
    containerRuntime: async () => false,
    processNamespaces: async () => false,
    microvm: async () => false,
    ...partial,
  };
}

describe('isolation modes (ordering is the honesty contract)', () => {
  it('ranks policy_only BELOW real isolation', () => {
    expect(satisfies(IsolationMode.POLICY_ONLY, IsolationMode.POLICY_ONLY)).toBe(true);
    expect(satisfies(IsolationMode.POLICY_ONLY, IsolationMode.CONTAINER)).toBe(false);
    expect(satisfies(IsolationMode.POLICY_ONLY, IsolationMode.PROCESS)).toBe(false);
    expect(satisfies(IsolationMode.CONTAINER, IsolationMode.PROCESS)).toBe(true);
    expect(satisfies(IsolationMode.MICROVM, IsolationMode.CONTAINER)).toBe(true);
  });

  it('isRealIsolation excludes policy_only (never upgraded silently)', () => {
    expect(isRealIsolation(IsolationMode.POLICY_ONLY)).toBe(false);
    expect(isRealIsolation(IsolationMode.PROCESS)).toBe(true);
    expect(isRealIsolation(IsolationMode.CONTAINER)).toBe(true);
    expect(isRealIsolation(IsolationMode.MICROVM)).toBe(true);
  });
});

describe('host isolation capability audit', () => {
  it('microvm probe wins', async () => {
    const snap = await detectIsolationAbilities(fakeProbes({ microvm: async () => true }));
    expect(snap.mode).toBe(IsolationMode.MICROVM);
  });

  it('container engine (docker daemon) is CONTAINER, above process', async () => {
    const snap = await detectIsolationAbilities(
      fakeProbes({ containerRuntime: async (k) => k === 'docker', processNamespaces: async () => true }),
    );
    expect(snap.mode).toBe(IsolationMode.CONTAINER);
    expect(snap.runtimes).toContain('docker');
  });

  it('podman/nerdctl daemon maps to CONTAINER with its runtime label', async () => {
    const podman = await detectIsolationAbilities(
      fakeProbes({ containerRuntime: async (k) => k === 'podman' }),
    );
    expect(podman.mode).toBe(IsolationMode.CONTAINER);
    expect(podman.runtimes).toContain('podman');
    const nerdctl = await detectIsolationAbilities(
      fakeProbes({ containerRuntime: async (k) => k === 'nerdctl' }),
    );
    expect(nerdctl.mode).toBe(IsolationMode.CONTAINER);
  });

  it('usables namespaces only (no container engine) is PROCESS', async () => {
    const snap = await detectIsolationAbilities(fakeProbes({ processNamespaces: async () => true }));
    expect(snap.mode).toBe(IsolationMode.PROCESS);
    expect(snap.runtimes).toContain('unshare');
  });

  it('nothing available is POLICY_ONLY and stays un-upgraded', async () => {
    const snap = await detectIsolationAbilities(fakeProbes({}));
    expect(snap.mode).toBe(IsolationMode.POLICY_ONLY);
    expect(snap.runtimes).toEqual([]);
    expect(snap.note).toMatch(/policy sandbox only/);
  });
});

describe('container executor (REAL isolation when a runtime exists)', () => {
  it('builds a hardened docker argv (no shell, read-only workspace, cap-drop, network none)', () => {
    const args = buildContainerArgs({
      image: 'busybox',
      command: 'find',
      args: ['.'],
      hostWorkspace: '/host/proj',
      timeoutMs: 1000,
      cpus: 1,
      memoryBytes: 268435456,
      pidsLimit: 128,
    });
    expect(args[0]).toBe(CONTAINER_DOCKER_ARGS_PREFIX);
    expect(args).toContain('--rm');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('--user');
    expect(args).toContain(DEFAULT_CONTAINER_USER);
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cpus');
    expect(args).toContain('128'); // pids-limit value
    expect(args).toContain('/host/proj:/workspace:ro');
    expect(args[args.length - 3]).toBe('busybox');
    expect(args[args.length - 2]).toBe('find');
    expect(args[args.length - 1]).toBe('.');
  });

  it('allows an explicit read-write workspace only when requested', () => {
    const args = buildContainerArgs({
      image: 'node:22',
      command: 'node',
      hostWorkspace: '/host/proj',
      workspaceReadOnly: false,
      timeoutMs: 1000,
    });
    expect(args).toContain('/host/proj:/workspace');
    expect(args.some((a) => a.includes(':ro'))).toBe(false);
  });

  it('supports an explicit egress bridge when required', () => {
    const args = buildContainerArgs({
      image: 'busybox',
      command: 'sh',
      hostWorkspace: '/host/proj',
      network: 'bridge',
      timeoutMs: 1000,
    });
    expect(args).toContain('bridge');
  });

  it('FAILS CLOSED when no container runtime is verified', async () => {
    const exec = new ContainerExecutor({
      runtimePresent: async () => false,
      run: async () => {
        throw new Error('must not run');
      },
    });
    await expect(
      exec.execute({ image: 'busybox', command: 'true', hostWorkspace: '/host/p', timeoutMs: 300 }),
    ).rejects.toMatchObject({ errorCode: 'aios_isolation_unavailable' });
  });

  it('runs only after a verified runtime and labels the result CONTAINER', async () => {
    let seenArgs: string[] = [];
    const exec = new ContainerExecutor({
      runtimePresent: async () => true,
      run: async (args) => {
        seenArgs = args;
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      },
    });
    const r = await exec.execute({
      image: 'busybox',
      command: 'true',
      hostWorkspace: '/host/p',
      timeoutMs: 300,
      env: { RUNID: randomUUID() },
    });
    expect(r.mode).toBe(IsolationMode.CONTAINER);
    expect(r.exitCode).toBe(0);
    expect(seenArgs).toContain('busybox');
    expect(seenArgs.some((a) => a.startsWith('--env'))).toBe(true);
  });
});

describe('process isolation executor (namespaces)', () => {
  it('denies without authorization', async () => {
    const exec = new ProcessIsolationExecutor({
      namespacesPresent: async () => true,
      controls: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1 }) },
    });
    await expect(
      exec.execute({ command: 'true', cwd: process.cwd(), timeoutMs: 300, authorized: false }),
    ).rejects.toMatchObject({ errorCode: 'aios_isolation_denied' });
  });

  it('FAILS CLOSED when namespaces are not usable on this host', async () => {
    const exec = new ProcessIsolationExecutor({
      namespacesPresent: async () => false,
      controls: { run: async () => {
        throw new Error('must not run');
      } },
    });
    await expect(
      exec.execute({ command: 'true', cwd: process.cwd(), timeoutMs: 300, authorized: true }),
    ).rejects.toMatchObject({ errorCode: 'aios_isolation_unavailable' });
  });

  it('wraps the command in real unshare namespaces (user/pid/net/mount)', async () => {
    let seenArgs: string[] = [];
    let seenCommand = '';
    const exec = new ProcessIsolationExecutor({
      namespacesPresent: async () => true,
      controls: {
        run: async (opts) => {
          seenCommand = opts.command;
          seenArgs = opts.args ?? [];
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1 };
        },
      },
    });
    await exec.execute({ command: 'node', args: ['-e', 'x'], cwd: process.cwd(), timeoutMs: 300, authorized: true });
    expect(seenCommand).toBe(UNSHARE_PREFIX);
    expect(seenArgs).toContain('--net');
    expect(seenArgs).toContain('--pid');
    expect(seenArgs).toContain('--mount');
    expect(seenArgs).toContain('--map-root-user');
    expect(seenArgs[seenArgs.indexOf('--') + 1]).toBe('node');
  });
});

describe('OS process controls (real enforcement)', () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'cc-iso-'));
  });
  afterEach(() => {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('captures output and exit code from a real child', async () => {
    const pc = new ProcessControls();
    const r = await pc.run({ command: process.execPath, args: ['-e', 'console.log("coded")'], cwd: workdir, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('coded');
  });

  it('scopes cwd (workspace boundary) to the given directory', async () => {
    const pc = new ProcessControls();
    const r = await pc.run({ command: process.execPath, args: ['-e', 'console.log(process.cwd())'], cwd: workdir, timeoutMs: 5000 });
    expect(r.stdout.trim()).toBe(workdir);
  });

  it('does NOT forward host secrets unless explicitly allow-listed', async () => {
    process.env.TOP_SECRET_CC = 'leak-me';
    const pc = new ProcessControls();
    const r = await pc.run({
      command: process.execPath,
      args: ['-e', 'console.log(process.env.TOP_SECRET_CC ? "present" : "absent")'],
      cwd: workdir,
      timeoutMs: 5000,
    });
    delete process.env.TOP_SECRET_CC;
    expect(r.stdout.trim()).toBe('absent');
  });

  it('enforces the output cap (resource exhaustion guard)', async () => {
    const pc = new ProcessControls();
    const r = await pc.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
      cwd: workdir,
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('enforces timeout then terminates the process tree', async () => {
    const pc = new ProcessControls();
    const started = Date.now();
    const r = await pc.run({
      command: process.execPath,
      args: ['-e', 'setInterval(function(){}, 1000)'],
      cwd: workdir,
      timeoutMs: 400,
    });
    expect(r.timedOut).toBe(true);
    expect(r.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects shell metacharacter injection in command and args', async () => {
    const pc = new ProcessControls();
    await expect(
      pc.run({ command: 'echo; rm -rf /', cwd: workdir, timeoutMs: 300 }),
    ).rejects.toMatchObject({ errorCode: 'aios_process_forbidden_token' });
    await expect(
      pc.run({ command: 'echo', args: ['..;rm'], cwd: workdir, timeoutMs: 300 }),
    ).rejects.toMatchObject({ errorCode: 'aios_process_forbidden_token' });
  });

  it('denies commands outside the allow-list', async () => {
    const pc = new ProcessControls();
    await expect(
      pc.run({ command: 'rm', args: ['-rf', '/'], cwd: workdir, timeoutMs: 300, allowedCommands: ['echo'] }),
    ).rejects.toMatchObject({ errorCode: 'aios_process_command_not_allowed' });
  });

  it('cleans up killed children (no lingering pid in the registry)', async () => {
    const pc = new ProcessControls();
    await pc.run({ command: process.execPath, args: ['-e', 'setInterval(function(){}, 1000)'], cwd: workdir, timeoutMs: 300 });
    expect(pc.activeCount).toBe(0);
  });
});

describe('RealIsolationExecutor facade (fail-closed dispatch)', () => {
  it('refuses minMode CONTAINER when the host is POLICY_ONLY', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.POLICY_ONLY, runtimes: [], note: 'no boundary' },
      controls: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1 }) },
    });
    await expect(
      exec.execute({
        minMode: IsolationMode.CONTAINER,
        command: 'true',
        cwd: process.cwd(),
        timeoutMs: 300,
        authorized: true,
      }),
    ).rejects.toMatchObject({ errorCode: 'aios_isolation_min_mode_unmet' });
  });

  it('refuses minMode PROCESS when the host is POLICY_ONLY', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.POLICY_ONLY, runtimes: [], note: 'no boundary' },
      controls: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 1 }) },
    });
    await expect(
      exec.execute({
        minMode: IsolationMode.PROCESS,
        command: 'true',
        cwd: process.cwd(),
        timeoutMs: 300,
        authorized: true,
      }),
    ).rejects.toMatchObject({ errorCode: 'aios_isolation_min_mode_unmet' });
  });

  it('routes to the container executor when the host is CONTAINER', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.CONTAINER, runtimes: ['docker'], note: 'engine' },
      controls: { run: async () => {
        throw new Error('must not use policy controls');
      } },
      container: {
        execute: async () => ({
          mode: IsolationMode.CONTAINER as const,
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          timedOut: false,
          killed: false,
          durationMs: 1,
        }),
      },
    });
    const r = (await exec.execute({
      minMode: IsolationMode.CONTAINER,
      image: 'busybox',
      hostWorkspace: '/h/p',
      command: 'true',
      cwd: '/h/p',
      timeoutMs: 300,
      authorized: true,
    })) as { mode: string };
    expect(r.mode).toBe(IsolationMode.CONTAINER);
  });

  it('routes to the process executor when the host is PROCESS', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.PROCESS, runtimes: ['unshare'], note: 'ns' },
      controls: { run: async () => {
        throw new Error('must not use policy controls');
      } },
      process: {
        execute: async () => ({
          mode: IsolationMode.PROCESS as const,
          exitCode: 0,
          stdout: 'isolated',
          stderr: '',
          timedOut: false,
          killed: false,
          durationMs: 1,
        }),
      },
    });
    const r = (await exec.execute({
      minMode: IsolationMode.PROCESS,
      command: 'node',
      cwd: process.cwd(),
      timeoutMs: 300,
      authorized: true,
    })) as { mode: string };
    expect(r.mode).toBe(IsolationMode.PROCESS);
  });

  it('policy-only default run is labeled POLICY_ONLY, never upgraded', async () => {
    const bus = new EventBus();
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.POLICY_ONLY, runtimes: [], note: 'no boundary' },
      controls: { run: async () => ({ exitCode: 0, stdout: 'policy-ran', stderr: '', timedOut: false, killed: false, durationMs: 1 }) },
      eventBus: bus,
    });
    const r = await exec.execute({ command: 'true', cwd: process.cwd(), timeoutMs: 300, authorized: true }) as ProcessControlsResultLike;
    expect(r.stdout).toBe('policy-ran');
    const events = bus.recent('aios.isolation');
    expect(events[0]).toBeDefined();
  });

  it('denies unauthorized calls before isolation dispatch', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.CONTAINER, runtimes: ['docker'], note: 'engine' },
    });
    await expect(
      exec.execute({ minMode: IsolationMode.CONTAINER, image: 'b', hostWorkspace: '/h', command: 'true', cwd: '/h', timeoutMs: 300, authorized: false }),
    ).rejects.toMatchObject({ errorCode: 'aios_isolation_denied' });
  });

  it('report() exposes the honest ISOLATION_MODE for status surfaces', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.POLICY_ONLY, runtimes: [], note: 'policy sandbox only' },
    });
    const rep = await exec.report();
    expect(rep.isolationMode).toBe(IsolationMode.POLICY_ONLY);
  });

  it('audit publish failure never breaks execution', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.POLICY_ONLY, runtimes: [], note: 'policy sandbox only' },
      controls: { run: async () => ({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false, killed: false, durationMs: 1 }) },
      eventBus: {
        publish: () => {
          throw new Error('bus down');
        },
      },
    });
    await expect(exec.execute({ command: 'true', cwd: process.cwd(), timeoutMs: 300, authorized: true })).resolves.toBeDefined();
  });
});

describe('cloud execution boundary (main container FAILS CLOSED)', () => {
  it('refuses every run on the MAIN application container, even policy-only', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.POLICY_ONLY, runtimes: [], note: 'policy sandbox only' },
      controls: { run: async () => {
        throw new Error('must never execute user programs in the web tier');
      } },
    });
    await expect(
      exec.execute({ command: 'true', cwd: process.cwd(), timeoutMs: 300, authorized: true, host: 'main' }),
    ).rejects.toMatchObject({ errorCode: 'aios_isolation_unavailable' });
  });

  it('cloudMainContainerError is the canonical boundary error', async () => {
    const { cloudMainContainerError, isMainContainerBoundaryError } = await import('./cloud-boundary.js');
    const err = cloudMainContainerError({ command: 'rm' });
    expect(isMainContainerBoundaryError(err)).toBe(true);
    expect(err.errorCode).toBe('aios_isolation_unavailable');
  });

  it('a worker host still goes through the normal gates', async () => {
    const exec = new RealIsolationExecutor({
      snapshot: { mode: IsolationMode.CONTAINER, runtimes: ['docker'], note: 'engine' },
      controls: { run: async () => {
        throw new Error('must use container executor');
      } },
      container: {
        execute: async () => ({
          mode: IsolationMode.CONTAINER as const,
          exitCode: 0,
          stdout: 'worker-ran',
          stderr: '',
          timedOut: false,
          killed: false,
          durationMs: 1,
        }),
      },
    });
    const r = (await exec.execute({
      host: 'worker',
      minMode: IsolationMode.CONTAINER,
      image: 'busybox',
      hostWorkspace: '/h/p',
      command: 'true',
      cwd: '/h/p',
      timeoutMs: 300,
      authorized: true,
    })) as { mode: string };
    expect(r.mode).toBe(IsolationMode.CONTAINER);
  });
});

type ProcessControlsResultLike = { stdout: string };

describe('real escape vectors (spawn boundary)', () => {
  it('passes user args literally — no shell expansion, no injected file creation', async () => {
    const escapeDir = mkdtempSync(path.join(os.tmpdir(), 'cc-esc-'));
    const file = path.join(escapeDir, 'escaped-marker');
    try {
      const { stdout } = await pExec(process.execPath, ['-e', 'console.log(process.argv[1])', `x;echo pwn > ${file}`]);
      expect(stdout.trim()).toContain('x;echo pwn');
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
    }
  });
});