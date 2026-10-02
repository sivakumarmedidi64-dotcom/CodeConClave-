/**
 * CodeConClave AI OS — ContainerExecutor (REAL container isolation).
 *
 * Runs a command inside a disposable container with explicit hard limits:
 *   - --network none (default; no egress at all) or bridge
 *   - --memory / --cpus / --pids-limit where required (REAL, enforced by the
 *     container engine, unlike Node-process approximations)
 *   - --user nobody, --cap-drop=ALL, --security-opt no-new-privileges
 *   - read-only rootfs + workspace mounted (read-only by default)
 *   - --rm (cleanup), timeout -> docker kill, output capture, audit event
 *
 * FAILS CLOSED: never runs when the caller has not confirmed a real container
 * runtime is present. A CLI binary existing is NOT proof of a runtime — the
 * facade only routes to this executor after a successful daemon probe.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { IsolationMode } from './modes.js';

export const DEFAULT_CONTAINER_USER = '65534:65534';
export const DEFAULT_CONTAINER_WORKSPACE = '/workspace';

export interface ContainerRunOptions {
  image: string;
  command: string;
  args?: string[];
  /** Absolute host directory mounted into the container. */
  hostWorkspace: string;
  /** Mount the workspace read-only (default true — containers must not mutate the host project). */
  workspaceReadOnly?: boolean;
  containerWorkspace?: string;
  network?: 'none' | 'bridge';
  cpus?: number;
  memoryBytes?: number;
  pidsLimit?: number;
  user?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Explicit non-secret env overrides (host secrets are never forwarded). */
  env?: Record<string, string>;
  containerName?: string;
}

export interface ContainerRunResult {
  mode: 'container' | 'microvm';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

export const CONTAINER_DOCKER_ARGS_PREFIX = 'run';

/** Pure argv builder — deterministic and unit-testable without Docker. */
export function buildContainerArgs(opts: ContainerRunOptions): string[] {
  const args: string[] = [CONTAINER_DOCKER_ARGS_PREFIX, '--rm', '--init', '--detach=false'];
  if (opts.containerName) args.push('--name', opts.containerName);
  args.push('--cap-drop=ALL', '--security-opt', 'no-new-privileges');
  args.push('--user', opts.user ?? DEFAULT_CONTAINER_USER);
  if (opts.cpus !== undefined) args.push('--cpus', String(opts.cpus));
  if (opts.memoryBytes !== undefined) args.push('--memory', String(opts.memoryBytes));
  if (opts.pidsLimit !== undefined) args.push('--pids-limit', String(opts.pidsLimit));
  args.push('--network', opts.network ?? 'none');
  args.push('--read-only');
  args.push('--workdir', opts.containerWorkspace ?? DEFAULT_CONTAINER_WORKSPACE);
  args.push(
    '--volume',
    `${opts.hostWorkspace}:${opts.containerWorkspace ?? DEFAULT_CONTAINER_WORKSPACE}${opts.workspaceReadOnly === false ? '' : ':ro'}`,
  );
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) args.push('--env', `${k}=${v}`);
  }
  args.push(opts.image, opts.command, ...(opts.args ?? []));
  return args;
}

export interface ContainerExecutorDeps {
  runtimePresent: () => Promise<boolean>;
  /** Injectable spawn: (cmd, args) => { code|signal, stdout, stderr, onTimeout } — 'docker' by default. */
  run: (args: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

async function dockerRun(args: string[], timeoutMs: number) {
  const { spawn } = await import('node:child_process');
  return await new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* noop */
        }
        const killer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
        }, 700);
        killer.unref();
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < 512 * 1024) stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < 512 * 1024) stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(AppError.badRequest('aios_container_spawn_error', `failed to start docker: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
    },
  );
}

export class ContainerExecutor {
  constructor(private deps: ContainerExecutorDeps) {}

  /**
   * Run inside a real container. Throws `aios_isolation_unavailable` (FAIL
   * CLOSED) unless a container runtime was positively verified.
   */
  async execute(opts: ContainerRunOptions): Promise<ContainerRunResult> {
    if (!(await this.deps.runtimePresent())) {
      throw AppError.unavailable(
        'aios_isolation_unavailable',
        'no reachable container engine — real container isolation is unavailable; refusing to degrade to policy-only',
      );
    }
    const started = Date.now();
    const args = buildContainerArgs(opts);
    logger.info('aios.isolation.container.start', {
      image: opts.image,
      command: opts.command,
      network: opts.network ?? 'none',
      readOnlyWorkspace: opts.workspaceReadOnly !== false,
    });
    const result = await this.deps.run(args, opts.timeoutMs);
    logger.info('aios.isolation.container.done', {
      command: opts.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      interrupted: result.timedOut,
    });
    return {
      mode: IsolationMode.CONTAINER,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      killed: result.timedOut,
      durationMs: Date.now() - started,
    };
  }
}

export const defaultContainerExecutorDeps = (): ContainerExecutorDeps => ({
  runtimePresent: async () => {
    const { detectIsolationAbilities } = await import('./detect.js');
    const snap = await detectIsolationAbilities();
    return snap.mode === IsolationMode.CONTAINER || snap.mode === IsolationMode.MICROVM;
  },
  run: dockerRun,
});