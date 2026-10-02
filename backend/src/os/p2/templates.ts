/**
 * CodeConClave AI OS — P2.12 Cowork Templates.
 *
 * Reusable, versioned cowork session templates (a set of prompt/command steps
 * plus a personality and stop-rule policy reference). Templates NEVER retain
 * secrets: a dedicated sanitizer strips secret-shaped values (keys, tokens,
 * passwords) when a template is created and again on render. Every template is
 * versioned and immutable-on-write; a bad update can be rolled back to a prior
 * version. Rendering a template is inert (no execution); execution always flows
 * through current stop rules.
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P2Feature } from './flags.js';
import type { PersonalityMode } from './personality.js';

export interface TemplateStep {
  id: string;
  kind: 'prompt' | 'command';
  text: string;
}

export interface CoworkTemplate {
  id: string;
  name: string;
  version: number;
  steps: TemplateStep[];
  personality: PersonalityMode;
  stopRuleProfile: string | null;
  createdAt: number;
  updatedAt: number;
}

export class CoworkTemplates {
  private templates = new Map<string, CoworkTemplate[]>();

  constructor(private feature: () => P2Feature | null) {}

  isEnabled(): boolean {
    return this.feature() === 'templates';
  }

  /** Create v1 of a template. Secret-shaped values are stripped. */
  create(input: { name: string; steps: Array<Omit<TemplateStep, 'id'>>; personality: PersonalityMode; stopRuleProfile?: string | null }): CoworkTemplate {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_templates_disabled', 'cowork templates are off');
    const tpl = this.build(1, input.name, input.steps, input.personality, input.stopRuleProfile ?? null, Date.now());
    if (!this.templates.has(tpl.id)) this.templates.set(tpl.id, []);
    this.templates.get(tpl.id)!.push(tpl);
    return tpl;
  }

  /** Update -> next version (immutable prior version retained for rollback). */
  update(id: string, input: { name?: string; steps?: Array<Omit<TemplateStep, 'id'>>; personality?: PersonalityMode; stopRuleProfile?: string | null }): CoworkTemplate {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_templates_disabled', 'cowork templates are off');
    const versions = this.requireVersions(id);
    const prev = versions[versions.length - 1]!;
    const now = Date.now();
    const tpl = this.build(
      prev.version + 1,
      input.name ?? prev.name,
      input.steps ?? prev.steps.map((s) => ({ kind: s.kind, text: s.text })),
      input.personality ?? prev.personality,
      input.stopRuleProfile !== undefined ? input.stopRuleProfile : prev.stopRuleProfile,
      now,
    );
    versions.push(tpl);
    return tpl;
  }

  /** ROLLBACK: switch the active version to a prior version number. */
  rollback(id: string, toVersion: number): CoworkTemplate {
    const versions = this.requireVersions(id);
    const target = versions.find((v) => v.version === toVersion);
    if (!target) throw AppError.notFound('aios_p2_template_version', 'template version not found');
    const now = Date.now();
    const rolled: CoworkTemplate = {
      ...target,
      version: versions[versions.length - 1]!.version + 1,
      updatedAt: now,
    };
    versions.push(rolled);
    return rolled;
  }

  getActive(id: string): CoworkTemplate {
    const versions = this.requireVersions(id);
    return versions[versions.length - 1]!;
  }

  listVersions(id: string): CoworkTemplate[] {
    return [...this.requireVersions(id)];
  }

  listAll(): CoworkTemplate[] {
    const out: CoworkTemplate[] = [];
    for (const versions of this.templates.values()) out.push(versions[versions.length - 1]!);
    return out;
  }

  /**
   * RENDER: return the sanitized steps (no secrets) plus a static stop-rule
   * profile reference. Rendering performs no execution.
   */
  render(id: string): { id: string; name: string; steps: TemplateStep[]; personality: PersonalityMode; stopRuleProfile: string | null } {
    const tpl = this.getActive(id);
    return {
      id: tpl.id,
      name: tpl.name,
      steps: tpl.steps.map((s) => ({ ...s, text: String(s.text) })),
      personality: tpl.personality,
      stopRuleProfile: tpl.stopRuleProfile,
    };
  }

  private build(version: number, name: string, steps: Array<Omit<TemplateStep, 'id'>>, personality: PersonalityMode, stopRuleProfile: string | null, at: number): CoworkTemplate {
    const sanitized = sanitizeFields({ steps }).steps as Array<Omit<TemplateStep, 'id'>>;
    const id = slug(name);
    return {
      id: id || `tpl_${Date.now()}`,
      name,
      version,
      steps: sanitized.map((s) => ({ ...s, id: `step_${Math.random().toString(36).slice(2, 8)}` })),
      personality,
      stopRuleProfile,
      createdAt: at,
      updatedAt: at,
    };
  }

  private requireVersions(id: string): CoworkTemplate[] {
    const versions = this.templates.get(id);
    if (!versions || versions.length === 0) throw AppError.notFound('aios_p2_template', `template ${id} not found`);
    return versions;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}


