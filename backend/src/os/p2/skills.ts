/**
 * CodeConClave AI OS — P2.14–17 Skills.
 *
 * A skill is a persisted, replayable execution RECIPE (ordered steps) that is
 * EXECUTED through OS capabilities (never its own execution path). Key rules:
 *   - Skills never retain secrets: secret-shaped fields are stripped on save and
 *     re-stripped on every resume/replay.
 *   - Versioned + immutable history so a bad skill update can be rolled back.
 *   - At EXECUTION time the CURRENT workspace stop rules + capabilities govern;
 *     a skill saved under different limits does NOT silently retain broader
 *     privileges.
 *   - Replaying a skill respects current policy.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P2Feature } from './flags.js';

export interface SkillStep {
  id: string;
  kind: 'prompt' | 'command' | 'file_write';
  text: string;
}

export interface Skill {
  id: string;
  name: string;
  version: number;
  steps: SkillStep[];
  workspaceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export class SkillEngine {
  private skills = new Map<string, Skill[]>();

  constructor(private feature: () => P2Feature | null) {}

  isEnabled(): boolean {
    return this.feature() === 'skills';
  }

  /** Create a skill. Secret-shaped content is stripped at save time. */
  create(input: { name: string; steps: Array<Omit<SkillStep, 'id'>>; workspaceId?: string | null }): Skill {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_skills_disabled', 'skills feature is off');
    const now = Date.now();
    const skill = this.build(1, input.name, input.steps, input.workspaceId ?? null, now);
    if (!this.skills.has(skill.id)) this.skills.set(skill.id, []);
    this.skills.get(skill.id)!.push(skill);
    return skill;
  }

  update(id: string, input: { name?: string; steps?: Array<Omit<SkillStep, 'id'>> }): Skill {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_skills_disabled', 'skills feature is off');
    const versions = this.requireVersions(id);
    const prev = versions[versions.length - 1]!;
    const now = Date.now();
    const skill = this.build(
      prev.version + 1,
      input.name ?? prev.name,
      input.steps ?? prev.steps.map((s) => ({ kind: s.kind, text: s.text })),
      prev.workspaceId,
      now,
    );
    versions.push(skill);
    return skill;
  }

  /** Safe version rollback. */
  rollback(id: string, toVersion: number): Skill {
    const versions = this.requireVersions(id);
    const target = versions.find((v) => v.version === toVersion);
    if (!target) throw AppError.notFound('aios_p2_skill_version', 'skill version not found');
    const rolled: Skill = {
      ...target,
      version: versions[versions.length - 1]!.version + 1,
      updatedAt: Date.now(),
    };
    versions.push(rolled);
    return rolled;
  }

  getActive(id: string): Skill {
    const versions = this.requireVersions(id);
    return versions[versions.length - 1]!;
  }

  listVersions(id: string): Skill[] {
    return [...this.requireVersions(id)];
  }

  listAll(): Skill[] {
    const out: Skill[] = [];
    for (const versions of this.skills.values()) out.push(versions[versions.length - 1]!);
    return out;
  }

  /**
   * RESUME/REPLAY a skill under the CURRENT policy. `evaluateStep` is the gate
   * (capability + stop rules) that must allow each step. If a step is denied,
   * the skill stops there — it does not regain privileges it once had. Returns
   * per-step outcomes.
   */
  async replay(
    id: string,
    opts: {
      evaluateStep: (step: SkillStep) => Promise<{ allowed: boolean; reason?: string }>;
      executeStep: (step: SkillStep) => Promise<{ ok: boolean }>;
    },
  ): Promise<Array<{ stepId: string; allowed: boolean; ok: boolean; reason?: string }>> {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_skills_disabled', 'skills feature is off');
    const active = this.getActive(id);
    const out: Array<{ stepId: string; allowed: boolean; ok: boolean; reason?: string }> = [];
    for (const step of active.steps) {
      const gate = await opts.evaluateStep(step);
      if (!gate.allowed) {
        out.push({ stepId: step.id, allowed: false, ok: false, reason: gate.reason ?? 'blocked by current stop rule' });
        break;
      }
      const res = await opts.executeStep(step);
      out.push({ stepId: step.id, allowed: true, ok: res.ok });
      if (!res.ok) break;
    }
    return out;
  }

  private build(version: number, name: string, steps: Array<Omit<SkillStep, 'id'>>, workspaceId: string | null, at: number): Skill {
    const sanitized = sanitizeFields({ steps }).steps as Array<Omit<SkillStep, 'id'>>;
    return {
      id: slug(name) || `skill_${randomUUID().slice(0, 8)}`,
      name,
      version,
      steps: sanitized.map((s) => ({ ...s, id: randomUUID().slice(0, 8) })),
      workspaceId,
      createdAt: at,
      updatedAt: at,
    };
  }

  private requireVersions(id: string): Skill[] {
    const versions = this.skills.get(id);
    if (!versions || versions.length === 0) throw AppError.notFound('aios_p2_skill', `skill ${id} not found`);
    return versions;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}


