/**
 * CodeConClave AI OS — safe, policy-gated Git engine (P1.4).
 *
 * A real, minimal Git abstraction that executes `git` ONLY through the OS
 * policy sandbox (allow-listed command, no shell, token-safety checks, hard
 * timeout) and only when the caller holds the matching capability
 * (`git.read` / `git.write`). It supports the smallest honest surface:
 *   - status / diff                            (read: git.read)
 *   - branches list, create-branch, checkout   (write: git.write)
 *   - commit / revert                          (write: git.write)
 *   - merge (no-ff, local-only) / conflict     (write: git.write)
 *
 * It NEVER pushes, never auto-merges, and never runs outside the sandbox cwd.
 * This is additive: it does not replace or rewire the existing Git Ninja stub,
 * which remains intact. If the sandbox has not allow-listed `git`, every
 * operation fails closed with a clear capability error.
 */
import { AppError } from '../shared/errors.js';
import { sandboxHealthOk } from './sandbox.js';
import { logger } from '../shared/logger.js';

export interface GitExecution {
  authorize: boolean;
  writeCapability: boolean;
  allowedCommands: string[];
  timeoutMs: number;
  cwd: string;
  /** Execute [command, ...args] through the policy sandbox. */
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

export class GitEngine {
  constructor(private ex: GitExecution) {}

  private async statusCheck(): Promise<void> {
    if (!this.ex.authorize) {
      throw AppError.forbidden('aios_git_denied', 'caller lacks git capability');
    }
    if (!sandboxHealthOk({ commands: this.ex.allowedCommands, timeoutMs: this.ex.timeoutMs })) {
      throw AppError.conflict('aios_git_sandbox_unhealthy', 'git sandbox not configured');
    }
  }

  private async runGit(args: string[], write: boolean): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    await this.statusCheck();
    if (write && !this.ex.writeCapability) {
      throw AppError.forbidden('aios_git_write_denied', 'caller lacks git.write capability');
    }
    if (!this.ex.allowedCommands.includes('git')) {
      throw AppError.forbidden('aios_git_command_not_allowed', 'git not allow-listed in sandbox');
    }
    return this.ex.run(['git', ...args]);
  }

  private assertZero(r: { stdout: string; stderr: string; exitCode: number | null }, op: string, extra = ''): string {
    if (r.exitCode !== 0) {
      throw AppError.badRequest('aios_git_failed', `git ${op} failed: ${r.stderr || 'unknown error'} ${extra}`.trim());
    }
    return r.stdout;
  }

  /** git status --porcelain. */
  async status(): Promise<string[]> {
    const out = this.assertZero(await this.runGit(['status', '--porcelain'], false), 'status');
    return out.split('\n').filter((l) => l.trim() !== '');
  }

  /** git diff (uncommitted). */
  async diff(): Promise<string> {
    return this.assertZero(await this.runGit(['diff'], false), 'diff');
  }

  /** git branch --list. */
  async branches(): Promise<string[]> {
    const out = this.assertZero(await this.runGit(['branch', '--list'], false), 'branch');
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\*\s*/, '').trim());
  }

  /** git checkout -b <name> (write). */
  async createBranch(name: string): Promise<void> {
    if (!/^[A-Za-z0-9._\/-]+$/.test(name)) {
      throw AppError.badRequest('aios_git_bad_branch', 'invalid branch name');
    }
    this.assertZero(await this.runGit(['checkout', '-b', name], true), 'checkout -b', `(${name})`);
    logger.info('aios.git.branch_created', { branch: name, cwd: this.ex.cwd });
  }

  /** git checkout <ref> (write). */
  async checkout(ref: string): Promise<void> {
    this.assertZero(await this.runGit(['checkout', ref], true), 'checkout', `(${ref})`);
  }

  /** git commit -m <msg> (write). */
  async commit(message: string): Promise<string> {
    const safe = String(message).slice(0, 2000).replace(/[\r\n]+/g, ' ');
    const out = this.assertZero(await this.runGit(['commit', '-m', safe], true), 'commit');
    logger.info('aios.git.commit', { cwd: this.ex.cwd });
    return out;
  }

  /** git revert <ref> --no-edit (write). */
  async revert(ref: string): Promise<string> {
    const out = this.assertZero(await this.runGit(['revert', ref, '--no-edit'], true), 'revert', `(${ref})`);
    logger.info('aios.git.revert', { ref, cwd: this.ex.cwd });
    return out;
  }

  /** git merge --no-ff <ref> (write). Local only; never pushed. */
  async mergeNoFastForward(ref: string): Promise<{ merged: boolean; conflicts: string[] }> {
    const r = await this.runGit(['merge', '--no-ff', ref], true);
    if (r.exitCode === 0) {
      logger.info('aios.git.merge', { ref, cwd: this.ex.cwd });
      return { merged: true, conflicts: [] };
    }
    // git merge exits 1 on conflict, 128 on error
    if (r.exitCode === 1) {
      const conflicts = await this.conflicts();
      return { merged: false, conflicts };
    }
    throw AppError.badRequest('aios_git_merge_error', `git merge failed: ${r.stderr}`);
  }

  /** Detect merge conflicts (git diff --name-only --diff-filter=U). */
  async conflicts(): Promise<string[]> {
    try {
      const out = this.assertZero(await this.runGit(['diff', '--name-only', '--diff-filter=U'], false), 'diff --filter=U');
      return out.split('\n').filter((l) => l.trim() !== '');
    } catch {
      return [];
    }
  }

  /** The configured workspace root (used for scoping/audit). */
  get workspace(): string {
    return this.ex.cwd;
  }
}
