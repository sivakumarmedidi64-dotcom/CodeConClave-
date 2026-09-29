/**
 * CodeConClave Desktop — workspace manager (local).
 *
 * Workspaces come from the local-agent grants (deny-by-default). The active
 * workspace scopes every local operation: file, terminal, git, undo, attach.
 * An operation WITHOUT a capability grant is denied before touching the disk.
 * The active root is validated against the grants — an arbitrary path can
 * never become a workspace.
 */
import { resolveWorkspacePath } from '@codeconclave/local-agent/policy';
import type { WorkspaceGrant } from '@codeconclave/local-agent/config';
import { CAPABILITY_IDS, type CapabilityId, type WorkspaceSummary } from '../types.js';

export class CapabilityError extends Error {
  readonly code = 'capability_denied';
  constructor(capability: string) {
    super(`capability denied: ${capability}`);
    this.name = 'CapabilityError';
  }
}

export class WorkspaceError extends Error {
  readonly code = 'workspace_error';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceStore {
  activeRoot(): string | null;
  setActiveRoot(root: string | null): void;
}

export class WorkspaceManager {
  constructor(
    private readonly grants: () => WorkspaceGrant[],
    private readonly store: WorkspaceStore,
  ) {}

  summaries(): WorkspaceSummary[] {
    return this.grants().map((g) => ({
      root: g.root,
      name: g.name || g.root,
      active: this.store.activeRoot() === g.root,
      exists: true,
      capabilities: (g.capabilities ?? []).filter((c): c is CapabilityId => (CAPABILITY_IDS as readonly string[]).includes(c)),
    }));
  }

  activeGrant(): WorkspaceGrant | null {
    const active = this.store.activeRoot();
    if (!active) return null;
    return this.grants().find((g) => g.root === active) ?? null;
  }

  open(root: string): WorkspaceSummary {
    const grant = this.grants().find((g) => g.root === root);
    if (!grant) throw new WorkspaceError('workspace grant not found');
    this.requireCapability(grant, 'workspace.switch');
    this.store.setActiveRoot(grant.root);
    return this.summaries().find((s) => s.root === grant.root)!;
  }

  /** Detect local workspace roots: grants from config (the grant list is
   *  authoritative; existence is validated lazily by path resolution). */
  detect(): WorkspaceSummary[] {
    return this.summaries();
  }

  /** Require the ACTIVE grant to carry `capability`, else throw CapabilityError. */
  requireActive(capability: CapabilityId): WorkspaceGrant {
    const grant = this.activeGrant();
    if (!grant) throw new CapabilityError(capability);
    this.requireCapability(grant, capability);
    return grant;
  }

  requireCapability(grant: WorkspaceGrant, capability: CapabilityId): void {
    if (!(grant.capabilities ?? []).includes(capability)) {
      throw new CapabilityError(capability);
    }
  }

  /** Scoped path resolution against the active root. Uses canonical policy
   *  defenses (traversal, symlink escape, protected paths). */
  resolveActive(requested: string): { ok: true; abs: string; grant: WorkspaceGrant } | { ok: false; reason: string } {
    let grant: WorkspaceGrant;
    try {
      grant = this.requireActive('files.read');
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'capability denied' };
    }
    const resolved = resolveWorkspacePath(grant.root, requested);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return { ok: true, abs: resolved.abs, grant };
  }
}