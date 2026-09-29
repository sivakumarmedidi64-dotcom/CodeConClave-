/**
 * CodeConClave Desktop — git runner (local).
 *
 * The runner exposes a FIXED, allow-listed set of read-only subcommands
 * (status / diff / branch / shallow log). There is NO arbitrary argument
 * passthrough: callers can only request allow-listed subcommands, and the
 * subcommand whitelist is enforced again at the boundary (defense in depth).
 * Remotes (push/pull/fetch), destructive ops (reset/checkout --), and network
 * args are structurally impossible to request, so the desktop foundation
 * cannot mutate git state — matching "Git status / Git diff" scope.
 */
import { execFile, type ExecFileOptions } from 'node:child_process';
import type { GitDiffResult, GitFileStatus, GitStatusResult } from '../types.js';
import { WorkspaceManager } from './workspace.js';

export const GIT_ALLOWED = [
  'status',
  'diff',
  'rev-parse',
  'log',
  'diff-index',
] as const;

export type GitSubcommand = (typeof GIT_ALLOWED)[number];

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type GitExec = (args: string[], cwd: string) => Promise<ExecResult>;

const MAX_DIFF_BYTES = 200 * 1024;

/** Real git executor: execFile (no shell), cwd forced to the workspace root. */
export function makeGitExec(exec: typeof execFile = execFile): GitExec {
  return (args, cwd) =>
    new Promise((resolve) => {
      exec('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true } as ExecFileOptions, (err, stdout, stderr) => {
        resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? 1 : 0 });
      });
    });
}

export class GitRunner {
  constructor(
    private readonly ws: WorkspaceManager,
    private readonly exec: GitExec = makeGitExec(),
  ) {}

  private grant() {
    return this.ws.requireActive('git.read');
  }

  private async run(subcommand: GitSubcommand, args: string[]): Promise<ExecResult> {
    if (!GIT_ALLOWED.includes(subcommand)) throw new Error(`git subcommand not allowed: ${subcommand}`);
    const grant = this.grant();
    const fullArgs = [subcommand, ...args];
    return this.exec(fullArgs, grant.root);
  }

  async status(): Promise<GitStatusResult> {
    const res = await this.run('status', ['--porcelain=v1', '-b']);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'git status failed', branch: null, clean: false, files: [] };
    const lines = res.stdout.replace(/\r/g, '').split('\n').filter(Boolean);
    const branchLine = lines[0] ?? '';
    const branch = /^## (.+?)(\.\.\.|$)/.exec(branchLine)?.[1] ?? null;
    const files: GitFileStatus[] = lines.slice(1).map((l) => {
      const xy = l.slice(0, 2);
      const path = l.slice(3);
      const kind: GitFileStatus['kind'] =
        xy[0] === 'U' || xy[1] === 'U' || /^(AA|DD)$/.test(xy)
          ? 'conflicted'
          : xy === '??'
            ? 'untracked'
            : xy.includes('R')
              ? 'renamed'
              : xy.includes('D')
                ? 'deleted'
                : xy.includes('A')
                  ? 'added'
                  : 'modified';
      return { kind, path };
    });
    return { ok: true, branch, clean: files.length === 0, files };
  }

  async diff(relPath?: string): Promise<GitDiffResult> {
    if (relPath) {
      const resolved = this.ws.resolveActive(relPath);
      if (!resolved.ok) return { ok: false, error: resolved.reason, diff: '', truncated: false };
    }
    const args = relPath ? ['--', relPath] : [];
    const res = await this.run('diff', args);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || 'git diff failed', diff: '', truncated: false };
    const truncated = res.stdout.length > MAX_DIFF_BYTES;
    return { ok: true, diff: truncated ? res.stdout.slice(0, MAX_DIFF_BYTES) : res.stdout, truncated };
  }
}