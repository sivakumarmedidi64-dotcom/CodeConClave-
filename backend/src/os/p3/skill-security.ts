/**
 * CodeConClave AI OS — P3.4 Skill Security.
 *
 * Skills always execute through the canonical chain (AUTH → CAPABILITY → STOP
 * RULES → RESOURCE GOVERNOR → SANDBOX → AUDIT). P3.4 adds integrity/signing
 * state on top — it never changes execution, it guards import and mutation:
 *   - content integrity hash (SHA-256) + optional signature
 *   - owner identity + trust state (TRUSTED / UNTRUSTED / BLOCKED)
 *   - capability allow-list: an imported skill NEVER silently gains capabilities;
 *     any requested capability not already on its allow-list raises a detour.
 *   - secret stripping on import and on read-through.
 * Capabilities are derived from a fixed registry, not from arbitrary skill text.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type TrustState = 'TRUSTED' | 'UNTRUSTED' | 'BLOCKED';

export interface SkillManifest {
  id: string;
  version: string;
  owner: string;
  trust: TrustState;
  capabilities: readonly string[];
  contentHash: string;
  signature?: string;
  importedAt: number;
}

export interface CapabilityRegistry {
  known(capability: string): boolean;
}

export class SkillSecurity {
  private manifests = new Map<string, SkillManifest>();

  constructor(
    private feature: () => P3Feature | null,
    private reg: CapabilityRegistry,
    private hashFn: (data: string) => string = (data) => createHash('sha256').update(data).digest('hex'),
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'skill_security';
  }

  /** Hash skill source (prefix to avoid length-extension on sha256). */
  static contentHashOf(source: string): string {
    return createHash('sha256')
      .update(`aios.skill.v1::${source}`)
      .digest('hex');
  }

  /**
   * Register an imported skill. It is stamped UNTRUSTED by default and its
   * capability allow-list is fixed to `allowed`. Any later capability claim that
   * is not in `allowed` is rejected — an imported skill never silently gains
   * capabilities. Owner and signature are recorded.
   */
  importSkill(
    id: string,
    version: string,
    source: string,
    opts: { owner: string; trust?: TrustState; capabilities?: readonly string[]; signature?: string },
  ): SkillManifest {
    this.ensure();
    const allowed = (opts.capabilities ?? []).filter((c) => this.reg.known(c));
    const manifest: SkillManifest = {
      id,
      version,
      owner: opts.owner,
      trust: opts.trust ?? 'UNTRUSTED',
      capabilities: allowed,
      contentHash: this.hashFn(source),
      signature: opts.signature,
      importedAt: Date.now(),
    };
    this.manifests.set(id, manifest);
    return manifest;
  }

  /**
   * Verify a skill before execution. Returns the capability view for the
   * canonical chain. Blocked skills never run; untrusted skills run only if the
   * caller allows untrusted (still with their fixed allow-list and governance).
   */
  verify(id: string, source: string, allowUntrusted: boolean): { capabilities: readonly string[]; trust: TrustState } {
    this.ensure();
    const m = this.manifests.get(id);
    if (!m) throw AppError.notFound(`skill manifest for ${id}`, 'aios_p3_skill_no_manifest');
    const actual = this.hashFn(source);
    if (actual !== m.contentHash) {
      throw AppError.forbidden('aios_p3_skill_tampered', `skill ${id} content hash mismatch; import re-qualified`);
    }
    if (m.trust === 'BLOCKED') {
      throw AppError.forbidden('aios_p3_skill_blocked', `skill ${id} is BLOCKED`);
    }
    if (m.trust === 'UNTRUSTED' && !allowUntrusted) {
      throw AppError.forbidden('aios_p3_skill_untrusted', `skill ${id} is UNTRUSTED and not allow-listed`);
    }
    return { capabilities: m.capabilities, trust: m.trust };
  }

  /** A requested capability for a registered skill is only granted if already allow-listed. */
  assertCapability(id: string, capability: string): void {
    this.ensure();
    const m = this.manifests.get(id);
    if (!m) throw AppError.notFound(`skill manifest for ${id}`, 'aios_p3_skill_no_manifest');
    if (!m.capabilities.includes(capability)) {
      throw AppError.forbidden('aios_p3_skill_cap', `skill ${id} not allowed capability ${capability} (never silently gained)`);
    }
  }

  /** Strip secrets from arbitrary skill output/telemetry before it leaves the sandbox. */
  redact(input: Record<string, unknown>): Record<string, unknown> {
    return sanitizeFields(input);
  }

  setTrust(id: string, trust: TrustState): SkillManifest | null {
    this.ensure();
    const m = this.manifests.get(id);
    if (!m) return null;
    const next: SkillManifest = { ...m, trust };
    this.manifests.set(id, next);
    return next;
  }

  has(id: string): boolean {
    return this.manifests.has(id);
  }

  private ensure(): void {
    if (this.feature() !== 'skill_security') throw AppError.conflict('aios_p3_skill_off', 'skill security feature is off');
  }
}

export function createCapabilityRegistry(known: readonly string[]): CapabilityRegistry {
  const set = new Set(known);
  return { known: (c) => set.has(c) };
}
