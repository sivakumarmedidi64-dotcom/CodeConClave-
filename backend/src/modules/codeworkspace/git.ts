/**
 * CodeConClave — PKG-22 Advanced Code Workspace — Git/version awareness.
 * Honest Git/history availability check. When the workspace root has no `.git`,
 * `GIT_HISTORY = UNAVAILABLE` (never fabricated). When present, only commit
 * association metadata that can be stat checked is reported. No secret/exact
 * content leakage.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { rootForProject, workspaceUsable } from './security.js';
import { workspaceEnabled } from './config.js';

export async function gitStatus(projectId: string): Promise<{ state: 'VERIFIED' | 'UNAVAILABLE' | 'ENVIRONMENT_BLOCKED'; hasRepo: boolean; lastEditedAt?: Date }> {
  if (!workspaceEnabled()) return { state: 'ENVIRONMENT_BLOCKED', hasRepo: false };
  const usable = await workspaceUsable(projectId);
  if (!usable) return { state: 'ENVIRONMENT_BLOCKED', hasRepo: false };
  const root = rootForProject(projectId);
  if (!root) return { state: 'ENVIRONMENT_BLOCKED', hasRepo: false };
  const hasRepo = existsSync(path.join(root, '.git'));
  if (!hasRepo) return { state: 'UNAVAILABLE', hasRepo: false };
  // A `.git` directory is present; we do not fabricate commit hashes — the
  // rich version history surface requires a real git invocation and reports
  // UNAVAILABLE until that is wired through the policy sandbox.
  return { state: 'UNAVAILABLE', hasRepo: true };
}
