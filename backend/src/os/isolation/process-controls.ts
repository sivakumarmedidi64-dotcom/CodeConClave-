/**
 * CodeConClave AI OS — OS process controls (shared primitive).
 *
 * Enforceable, real OS controls on a child process tree: bounded output,
 * hard timeout with SIGTERM -> SIGKILL escalation + group kill, cwd scoping,
 * env sanitization (never forwards host secrets), no shell. This primitive is
 * NOT in itself a container or namespace boundary — it is the shared backend
 * of the process/container executors and is reported as such. Honesty note:
 * on hosts without namespaces the existence of these controls is POLICY_ONLY,
 * never PROCESS/CONTAINER.
 */
import { spawn } from 'node:child_process';
import { AppError } from '../../shared/errors.js';

export interface ProcessControlsOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Absent = empty env (no host secrets leak); map = exact allow-listed set. */
  env?: Record<string, string>;
  /** Allow-list of command prefixes (first token); enforced when provided. */
  allowedCommands?: string[];
}

export interface ProcessControlsResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

const FORBIDDEN_TOKEN = /[;&|><`]|\$\{|\$\(/;

export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

export class ProcessControls {
  private running = new Set<number>();

  constructor(private defaultTimeoutMs = 30_000) {}

  get activeCount(): number {
    return this.running.size;
  }

  killAll(): void {
    for (const pid of [...this.running]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.running.clear();
  }

  async run(opts: ProcessControlsOptions): Promise<ProcessControlsResult> {
    if (opts.allowedCommands && !opts.allowedCommands.includes(opts.command)) {
      throw AppError.forbidden('aios_process_command_not_allowed', `command '${opts.command}' is not allow-listed`);
    }
    if (FORBIDDEN_TOKEN.test(opts.command)) {
      throw AppError.badRequest('aios_process_forbidden_token', 'shell metacharacters are not allowed in command');
    }
    for (const a of opts.args ?? []) {
      if (FORBIDDEN_TOKEN.test(a)) {
        throw AppError.badRequest('aios_process_forbidden_token', 'shell metacharacters are not allowed in arguments');
      }
    }

    const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const started = Date.now();
    const env =
      opts.env === undefined ? {} : { ...process.env, ...opts.env } /* explicit allow-list only when provided */;

    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      shell: false,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (child.pid) this.running.delete(child.pid);
    };

    return await new Promise<ProcessControlsResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      if (child.pid) {
        this.running.add(child.pid);
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killed = true;
          this.terminateTree(child);
        }, opts.timeoutMs || this.defaultTimeoutMs);
        timeoutHandle.unref?.();
      }

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < cap) stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < cap) stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        finish();
        if (killed) {
          resolve({ exitCode: null, stdout, stderr, timedOut, killed, durationMs: Date.now() - started });
          return;
        }
        reject(
          AppError.badRequest('aios_process_spawn_error', `failed to start '${opts.command}': ${err.message}`),
        );
      });
      child.on('close', (code) => {
        finish();
        resolve({ exitCode: code, stdout, stderr, timedOut, killed, durationMs: Date.now() - started });
      });
    });
  }

  private terminateTree(child: import('node:child_process').ChildProcess): void {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* group already gone */
          }
        }
      } catch {
        /* noop */
      }
    }, 700);
    killer.unref();
  }
}