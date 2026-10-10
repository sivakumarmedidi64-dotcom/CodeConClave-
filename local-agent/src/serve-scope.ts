/**
 * CodeConClave Local Agent — serve-path scope resolution.
 *
 * Pure helpers used by the `serve` command handlers to map a requested path
 * to the workspace grant that covers it. The critical invariant (regression:
 * file.read/file.diff/file.write denied every nested path with "capability
 * not granted" because the capability check compared the workspace ROOT
 * against the resolved FILE path): capability checks MUST run against the
 * matched grant — never against the resolved file path.
 */
import { resolveWorkspacePath } from './policy.js';
import type { AgentConfig, WorkspaceGrant } from './config.js';

export interface WorkspaceScope {
  ok: true;
  /** The resolved requested path (file or dir inside the grant). */
  abs: string;
  /** The workspace grant whose root covers `abs`. */
  grant: WorkspaceGrant;
}

export type WorkspaceScopeResult = WorkspaceScope | { ok: false; reason: string };

/** Find the first granted workspace containing `path`. */
export function workspaceFor(config: AgentConfig, path: string): WorkspaceScopeResult {
  for (const w of config.workspaces ?? []) {
    const resolved = resolveWorkspacePath(w.root, path);
    if (resolved.ok) return { ok: true, abs: resolved.abs, grant: w };
  }
  return { ok: false, reason: 'path is not inside any granted workspace' };
}

/** Path of `path` relative to an already-resolved scope (used by file.* ops). */
export function requestedWithin(scope: { abs: string }, path: string): string {
  return path.startsWith(scope.abs) ? path.slice(scope.abs.length).replace(/^[\\/]/, '') || '.' : path;
}

/** Whether the matched workspace grant carries a capability. */
export function grantHasCap(grant: WorkspaceGrant | undefined, cap: string): boolean {
  return Boolean(grant && (grant.capabilities ?? []).includes(cap));
}
