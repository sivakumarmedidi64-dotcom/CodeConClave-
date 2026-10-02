/**
 * CodeConClave AI OS — P3.9 Architecture Intelligence.
 *
 * Five architecture agents:
 *   - architecture_reviewer
 *   - dependency_analyzer
 *   - canonical_compliance_checker
 *   - tech_debt_analyzer
 *   - module_boundary_checker
 * They flag adherence to canonical primitives and surface DUPLICATE/LEGACY
 * subsystem risks as recommendations. No architecture redesign — these only
 * observe and advise within the existing canonical model.
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type ArchitectureAgentName =
  | 'architecture_reviewer'
  | 'dependency_analyzer'
  | 'canonical_compliance_checker'
  | 'tech_debt_analyzer'
  | 'module_boundary_checker';

export interface ArchitectureAgent {
  name: ArchitectureAgentName;
  task: string;
  requires: readonly string[];
  output: 'report' | 'recommendation';
}

export const ARCHITECTURE_AGENTS: readonly ArchitectureAgent[] = [
  { name: 'architecture_reviewer', task: 'Review a component against the unified AI OS architecture', requires: ['filesystem.read', 'context.read'], output: 'report' },
  { name: 'dependency_analyzer', task: 'Map dependencies and flag hidden coupling', requires: ['filesystem.read'], output: 'report' },
  { name: 'canonical_compliance_checker', task: 'Flag use of duplicate/non-canonical subsystems', requires: ['filesystem.read', 'context.read'], output: 'recommendation' },
  { name: 'tech_debt_analyzer', task: 'Surface tech debt with remediation proposals', requires: ['filesystem.read'], output: 'recommendation' },
  { name: 'module_boundary_checker', task: 'Check LOCAL/CLOUD/SHARED boundary integrity', requires: ['filesystem.read'], output: 'report' },
];

export type CapabilityHolder = (c: string) => boolean;
export type Executor = (name: ArchitectureAgentName, input: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;

export class ArchitectureIntelligence {
  constructor(private feature: () => P3Feature | null, private hasCap: CapabilityHolder, private executor: Executor) {}

  isEnabled(): boolean {
    return this.feature() === 'architecture';
  }

  registry(): readonly ArchitectureAgent[] {
    return ARCHITECTURE_AGENTS;
  }

  async run(name: ArchitectureAgentName, input: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; agent: ArchitectureAgentName }> {
    this.ensure();
    const agent = ARCHITECTURE_AGENTS.find((a) => a.name === name);
    if (!agent) throw AppError.notFound(`architecture agent ${name}`, 'aios_p3_arch_no_agent');
    const missing = agent.requires.filter((c) => !this.hasCap(c));
    if (missing.length) throw AppError.forbidden('aios_p3_arch_cap', `missing ${missing.join(', ')}`);
    const res = await this.executor(name, sanitizeFields(input));
    return { ok: res.ok, result: sanitizeFields(res.result as Record<string, unknown>), agent: name };
  }

  private ensure(): void {
    if (this.feature() !== 'architecture') throw AppError.conflict('aios_p3_arch_off', 'architecture intelligence feature is off');
  }
}
