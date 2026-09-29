/**
 * CodeConClave AI OS — ProcessIsolationExecutor (REAL process isolation).
 *
 * Runs a command inside real Linux namespaces created unprivileged via
 * `unshare --user --map-root-user --pid --fork --net --mount`: a genuine
 * per-run process/network/mount/pids isolation boundary (no shared network
 * namespace, no host-visible proc beyond the tree). Combines that with the
 * OS process controls (timeout -> kill tree, output cap, cwd scope, sanitized
 * env).
 *
 * FAILS CLOSED: if the host cannot create the namespaces (no unshare, EPERM,
 * non-Linux, Windows, container without privileges) it refuses to run and
 * reports `aios_isolation_unavailable`. It never silently falls back to the
 * policy sandbox and rebrands it as process isolation.
 */
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { ProcessControls, type ProcessControlsOptions } from './process-controls.js';
import { IsolationMode } from './modes.js';

export const UNSHARE_PREFIX = 'unshare';

export interface ProcessIsolationOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  authorized: boolean;
}

export interface ProcessIsolationResult {
  mode: 'process';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

export interface ProcessIsolationDeps {
  namespacesPresent: () => Promise<boolean>;
  controls: Pick<ProcessControls, 'run'>;
}

export class ProcessIsolationExecutor {
  constructor(private deps: ProcessIsolationDeps) {}

  static unshareArgs(args: string[]): string[] {
    return ['--user', '--map-root-user', '--pid', '--fork', '--net', '--mount', '--', ...args];
  }

  async execute(opts: ProcessIsolationOptions): Promise<ProcessIsolationResult> {
    if (!opts.authorized) {
      throw AppError.forbidden('aios_isolation_denied', 'caller lacks the required capability');
    }
    if (!(await this.deps.namespacesPresent())) {
      throw AppError.unavailable(
        'aios_isolation_unavailable',
        'real process isolation (unshare namespaces) is not usable on this host; refusing to degrade to policy-only',
      );
    }
    const args = ProcessIsolationExecutor.unshareArgs([opts.command, ...(opts.args ?? [])]);
    logger.info('aios.isolation.process.start', { command: opts.command, cwd: opts.cwd });
    const started = Date.now();
    const inner: ProcessControlsOptions = {
      command: UNSHARE_PREFIX,
      args,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      env: opts.env,
      allowedCommands: ['unshare'],
    };
    const r = await this.deps.controls.run(inner);
    logger.info('aios.isolation.process.done', {
      command: opts.command,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    });
    return {
      mode: IsolationMode.PROCESS,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      killed: r.killed,
      durationMs: Date.now() - started,
    };
  }
}