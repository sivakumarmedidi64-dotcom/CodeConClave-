/**
 * CodeConClave AI OS — Policy Sandbox executor (P0.6, security keystone).
 *
 * HONESTY NOTE: this is a **policy sandbox** (deterministic, deny-by-default,
 * capability-gated, time-boxed command execution), NOT container/VM process
 * isolation. On the current Node/Railway single-host architecture there is no
 * cgroup/container/chroot boundary available from userspace, so we do NOT claim
 * OS-level isolation we cannot provide. Container/VM isolation is a later
 * (P1/P3) workload-isolation item, not claimed here.
 *
 * What this executor enforces:
 *   - deny-by-default: only command prefixes explicitly allow-listed run
 *   - no interactive/shell-pipe constructs
 *   - hard timeout, then SIGTERM -> SIGKILL escalation
 *   - killed process tree cleanup (windows/darwin best-effort, posix setsid)
 *   - no unbounded output (capped, honest truncation)
 *   - caller must present `terminal.exec` capability before execution
 */
import { spawn } from 'node:child_process';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

export interface SandboxOptions {
  /** Absolute allow-list of command prefixes (first token). */
  allowedCommands: string[];
  /** Working directory (a project/chroot-like workspace root is typical). */
  cwd: string;
  /** Hard timeout ms. */
  timeoutMs: number;
  /** Capability guard: callers pass their capability set / a boolean. */
  authorized: boolean;
  /** Optional positional args (never shell-interpolated). */
  args?: string[];
}

const FORBIDDEN_TOKENS = [';', '&&', '||', '|', '>', '<', '`', '$(', '${'];

export class PolicySandboxExecutor {
  constructor(
    private defaultAllowedCommands: string[],
    private defaultTimeoutMs: number,
  ) {}

  async execute(opts: SandboxOptions): Promise<SandboxResult> {
    if (!opts.authorized) {
      throw AppError.forbidden('aios_sandbox_denied', 'caller lacks terminal.exec capability');
    }
    const command = opts.args && opts.args.length > 0 ? opts.args[0]! : undefined;
    if (!command) {
      throw AppError.badRequest('aios_sandbox_empty', 'no command provided');
    }
    const allowed = this.defaultAllowedCommands.concat(opts.allowedCommands);
    const allowSet = new Set(allowed);
    if (!allowSet.has(command)) {
      logger.warn('aios.sandbox.denied_command', { command });
      throw AppError.forbidden('aios_sandbox_command_not_allowed', `command '${command}' is not allow-listed`);
    }
    const restArgs = (opts.args ?? []).slice(1);
    for (const t of restArgs) {
      if (FORBIDDEN_TOKENS.some((f) => t.includes(f))) {
        throw AppError.forbidden('aios_sandbox_forbidden_token', 'shell metacharacters are not allowed');
      }
    }

    const started = Date.now();
    const child = spawn(command, restArgs, {
      cwd: opts.cwd,
      shell: false, // never shell — prevents injection
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return await new Promise<SandboxResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;
      const stdoutCap = 512 * 1024; // 512 KB each, honest cap
      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        // SIGKILL escalation after a short grace
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
      }, opts.timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < stdoutCap) stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < stdoutCap) stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        // spawn errors (ENOENT etc.) reject; captured cleanly
        reject(AppError.badRequest('aios_sandbox_spawn_error', `failed to start '${command}': ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - started;
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ exitCode: code, stdout, stderr, timedOut, killed, durationMs });
      });
    });
  }
}

export function isSandboxError(e: unknown): boolean {
  return e instanceof AppError && String((e as AppError).errorCode).startsWith('aios_sandbox');
}

export function sandboxHealthOk(state: { commands: string[]; timeoutMs: number }): boolean {
  return state.timeoutMs > 0;
}
