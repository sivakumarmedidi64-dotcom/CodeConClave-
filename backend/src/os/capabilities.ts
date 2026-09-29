/**
 * CodeConClave AI OS — capability model (P0.4).
 *
 * A canonical, scoped, auditable, revocable capability layer. Each
 * process/agent holds explicitly granted capabilities only. This is the
 * capability primitive; the existing deny-by-default policy engines remain
 * intact and are not weakened. Local/cloud threat models still differ — callers
 * decide which caps to grant, this module only enforces the set.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { Capability, CapabilityKind } from './types.js';
import { logger } from '../shared/logger.js';

export interface CapabilityGrantResult {
  capability: Capability;
  revokeToken: string;
}

/** Deterministic permission check across an explicit grant set (no globals). */
export function hasCapability(
  capabilities: readonly Capability[],
  kind: CapabilityKind | string,
  scope?: string,
  resource?: string,
): boolean {
  return capabilities.some(
    (c) =>
      c.kind === kind &&
      (scope === undefined || c.scope === scope) &&
      (resource === undefined || c.resource === undefined || c.resource === resource),
  );
}

/**
 * Immutable capability ledger. Grants are append-only and auditable; a revoke
 * token marks a grant inactive without deleting history (audit trail).
 */
export class CapabilityLedger {
  private grants = new Map<string, { cap: Capability; revokedAt: number | null }>();

  grant(params: {
    kind: CapabilityKind | string;
    scope: string;
    resource?: string;
    actor: string;
  }): CapabilityGrantResult {
    const kind = params.kind;
    const scope = params.scope;
    if (!kind || !scope) {
      throw AppError.badRequest('aios_capability_invalid', 'capability kind and scope are required');
    }
    const cap: Capability = {
      kind,
      scope,
      resource: params.resource,
      grantedAt: Date.now(),
    };
    const id = randomUUID();
    this.grants.set(id, { cap, revokedAt: null });
    logger.info('aios.capability.granted', { id, kind, scope, actor: params.actor });
    return { capability: cap, revokeToken: id };
  }

  /** Whether a specific grant id is currently active. */
  isGranted(revokeToken: string): boolean {
    const entry = this.grants.get(revokeToken);
    return Boolean(entry && entry.revokedAt === null);
  }

  revoke(revokeToken: string, actor: string): void {
    const entry = this.grants.get(revokeToken);
    if (!entry) throw AppError.notFound('aios_capability', 'capability grant not found');
    if (entry.revokedAt !== null) {
      throw AppError.conflict('aios_capability_revoked', 'capability already revoked');
    }
    entry.revokedAt = Date.now();
    logger.info('aios.capability.revoked', { id: revokeToken, kind: entry.cap.kind, actor });
  }

  /** Effective (active) capabilities. */
  active(): Capability[] {
    const out: Capability[] = [];
    for (const entry of this.grants.values()) {
      if (entry.revokedAt === null) out.push(entry.cap);
    }
    return out;
  }
}

/** A capability set attached to a single process/agent. */
export class CapabilitySet {
  private caps = new Map<string, Capability>();

  has(kind: CapabilityKind | string, scope?: string, resource?: string): boolean {
    return hasCapability(this.list(), kind, scope, resource);
  }

  add(kind: CapabilityKind | string, scope: string, resource?: string): void {
    const key = `${kind}:${scope}:${resource ?? ''}`;
    this.caps.set(key, { kind, scope, resource, grantedAt: Date.now() });
  }

  remove(kind: CapabilityKind | string, scope: string): void {
    const key = `${kind}:${scope}:`;
    // revoke all matching (scope-only) plus exact-resource entries
    for (const k of [...this.caps.keys()]) {
      if (k.startsWith(`${kind}:${scope}:`)) this.caps.delete(k);
    }
  }

  list(): Capability[] {
    return [...this.caps.values()];
  }
}
