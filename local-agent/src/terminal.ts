/**
 * CodeConClave Local Agent — terminal session manager (Section 6.1, Phase 4B).
 * Real local shells (bash/zsh/node/python/powershell), bounded history
 * (last 1000 lines per spec 10.2), the Phase 4B state machine
 * (PLANNED/STARTING/RUNNING/COMPLETED/FAILED/KILLED/TIMED_OUT) and an optional
 * per-session timeout. RUNNING is only ever reported after the real child
 * process confirms spawn (the 'spawn' event carries the real pid); the cloud
 * never fabricates execution state.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type ProcessStatus =
  | 'PLANNED'
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'KILLED'
  | 'TIMED_OUT';

export interface TerminalEvents {
  output: (channel: 'stdout' | 'stderr', text: string) => void;
  status: (tabId: string, status: ProcessStatus, exitCode: number | null) => void;
}

export interface TerminalOptions {
  /** Auto-kill the process after this many ms while RUNNING → TIMED_OUT. */
  timeoutMs?: number;
}

export const SHELLS: Record<string, { command: string; args: string[] }> = {
  bash: { command: 'bash', args: ['--norc'] },
  zsh: { command: 'zsh', args: [] },
  node: { command: 'node', args: [] },
  python: { command: 'python', args: ['-i'] },
  powershell: { command: 'powershell', args: ['-NoLogo'] },
};

const HISTORY_LIMIT = 1000;

export class TerminalSession {
  readonly tabId: string;
  readonly shell: string;
  readonly cwd: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private status: ProcessStatus = 'PLANNED';
  private exitCode: number | null = null;
  private pid: number | null = null;
  private history: string[] = [];
  private emitter = new EventEmitter();
  private timeoutTimer: NodeJS.Timeout | null = null;
  private readonly opts: TerminalOptions;

  constructor(tabId: string, shell: string, cwd: string, opts: TerminalOptions = {}) {
    this.tabId = tabId;
    this.shell = SHELLS[shell] ? shell : 'bash';
    this.cwd = cwd;
    this.opts = opts;
  }

  on<K extends keyof TerminalEvents>(event: K, cb: TerminalEvents[K]): void {
    this.emitter.on(event as string, cb);
  }

  getStatus(): { status: ProcessStatus; exitCode: number | null; pid: number | null } {
    return { status: this.status, exitCode: this.exitCode, pid: this.pid };
  }

  getHistory(): string[] {
    return this.history;
  }

  start(): { ok: boolean; error?: string } {
    if (this.proc) return { ok: false, error: 'already running' };
    const def = SHELLS[this.shell] ?? { command: 'bash', args: ['--norc'] };
    try {
      const child = spawn(def.command, def.args, {
        cwd: this.cwd,
        env: process.env,
      }) as ChildProcessWithoutNullStreams;
      this.proc = child;
      this.status = 'STARTING';
      this.exitCode = null;
      this.pid = null;
      child.on('spawn', () => {
        // Real process evidence: the OS has created the child and handed us a pid.
        if (this.proc !== child || this.status !== 'STARTING') return;
        this.status = 'RUNNING';
        this.pid = child.pid ?? null;
        this.emitStatus();
        this.armTimeout();
      });
      child.stdout.on('data', (d: Buffer) => this.push('stdout', d.toString()));
      child.stderr.on('data', (d: Buffer) => this.push('stderr', d.toString()));
      child.on('error', (err) => {
        if (this.proc !== child) return;
        this.proc = null;
        this.pid = null;
        this.clearTimeout();
        this.status = 'FAILED';
        this.push('stderr', `\n[codeconclave] failed to start ${this.shell}: ${err.message}\n`);
        this.emitStatus();
      });
      child.on('exit', (code) => {
        if (this.proc !== child) return; // already stopped or timed out
        this.proc = null;
        this.pid = null;
        this.clearTimeout();
        if (this.status === 'STARTING') {
          // Exited before the spawn event (e.g. bad shell) — real exit code wins.
          this.status = code === 0 ? 'COMPLETED' : 'FAILED';
        } else if (this.status !== 'KILLED' && this.status !== 'TIMED_OUT') {
          this.status = code === 0 ? 'COMPLETED' : 'FAILED';
        }
        this.exitCode = code;
        this.emitStatus();
      });
      this.emitStatus();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'spawn failed' };
    }
  }

  write(data: string): void {
    // Writes queue on the child stdin stream; allow them while STARTING so a
    // script typed immediately after start() is never dropped.
    if (this.proc && (this.status === 'RUNNING' || this.status === 'STARTING')) {
      this.proc.stdin.write(data);
    }
  }

  stop(): void {
    this.clearTimeout();
    const child = this.proc;
    this.proc = null;
    if (!child) return;
    if (this.status === 'RUNNING' || this.status === 'STARTING') {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      this.status = 'KILLED';
      this.emitStatus();
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  private armTimeout(): void {
    const ms = this.opts.timeoutMs;
    if (!ms || ms <= 0) return;
    this.timeoutTimer = setTimeout(() => {
      if (this.status !== 'RUNNING' || !this.proc) return;
      this.status = 'TIMED_OUT';
      const child = this.proc;
      this.proc = null;
      this.pid = null;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 2000).unref?.();
      this.emitStatus();
    }, ms);
    this.timeoutTimer.unref?.();
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private push(channel: 'stdout' | 'stderr', text: string): void {
    this.history.push(text);
    if (this.history.length > HISTORY_LIMIT) {
      this.history = this.history.slice(this.history.length - HISTORY_LIMIT);
    }
    this.emitter.emit('output', channel, text);
  }

  private emitStatus(): void {
    this.emitter.emit('status', this.tabId, this.status, this.exitCode);
  }
}