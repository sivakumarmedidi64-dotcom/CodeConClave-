/**
 * CodeConClave — PKG-21 — Release identity (Git association).
 * The commit SHA is NEVER fabricated. When Git information is unavailable the
 * identity reports `available:false` (callers surface `GIT_VERSION = UNAVAILABLE`).
 */
import type { GitIdentity } from './types.js';

export interface GitInput {
  branch?: string | null;
  commitSha?: string | null;
  commitTimestamp?: string | null;
  author?: string | null;
}

export function resolveGitIdentity(input: GitInput): GitIdentity {
  const commitSha = input.commitSha?.trim() || null;
  const branch = input.branch?.trim() || null;
  const available = Boolean(commitSha) || Boolean(branch);

  return {
    available,
    branch: branch || undefined,
    commitSha: commitSha || undefined,
    commitTimestamp: input.commitTimestamp?.trim() || undefined,
    author: input.author?.trim() || undefined,
  };
}

/** Short human-friendly display: "abc123 (main)" or "UNAVAILABLE". */
export function gitVersionLabel(git: GitIdentity): string {
  if (!git.available) return 'UNAVAILABLE';
  const sha = git.commitSha ? git.commitSha.slice(0, 7) : '?';
  return git.branch ? `${sha} (${git.branch})` : sha;
}
