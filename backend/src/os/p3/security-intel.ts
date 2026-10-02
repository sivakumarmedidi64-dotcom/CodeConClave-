/**
 * CodeConClave AI OS — P3.7 Security Intelligence.
 *
 * Seven security agents:
 *   - secret_scanner
 *   - dependency_vuln_analyzer
 *   - threat_modeler
 *   - secure_code_reviewer
 *   - incident_analyzer
 *   - compliance_checker
 *   - security_scanner
 * They produce reports and recommendations only. Scanning/chaos NEVER targets
 * production. Findings ride the canonical audit/observability path; nothing is
 * auto-applied.
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type SecurityAgentName =
  | 'secret_scanner'
  | 'dependency_vuln_analyzer'
  | 'threat_modeler'
  | 'secure_code_reviewer'
  | 'incident_analyzer'
  | 'compliance_checker'
  | 'security_scanner';

export interface SecurityAgent {
  name: SecurityAgentName;
  task: string;
  requires: readonly string[];
  output: 'report' | 'recommendation';
}

export const SECURITY_AGENTS: readonly SecurityAgent[] = [
  { name: 'secret_scanner', task: 'Detect secrets/keys/credentials in a non-production scope', requires: ['scan.read'], output: 'report' },
  { name: 'dependency_vuln_analyzer', task: 'Assess dependency vulnerabilities and propose mitigations', requires: ['scan.read'], output: 'recommendation' },
  { name: 'threat_modeler', task: 'Produce a threat model for a component', requires: ['filesystem.read'], output: 'report' },
  { name: 'secure_code_reviewer', task: 'Review code for security weaknesses (proposals only)', requires: ['filesystem.read', 'scan.read'], output: 'recommendation' },
  { name: 'incident_analyzer', task: 'Analyse an incident timeline and propose remediations', requires: ['audit.read'], output: 'recommendation' },
  { name: 'compliance_checker', task: 'Compare posture against a compliance checklist', requires: ['audit.read', 'scan.read'], output: 'report' },
  { name: 'security_scanner', task: 'Coordinate a non-production scan and summarize findings', requires: ['scan.dry_run'], output: 'report' },
];

export type CapabilityHolder = (c: string) => boolean;
export type Executor = (name: SecurityAgentName, input: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;

export class SecurityIntelligence {
  constructor(private feature: () => P3Feature | null, private hasCap: CapabilityHolder, private executor: Executor) {}

  isEnabled(): boolean {
    return this.feature() === 'security';
  }

  registry(): readonly SecurityAgent[] {
    return SECURITY_AGENTS;
  }

  async run(name: SecurityAgentName, input: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; agent: SecurityAgentName }> {
    this.ensure();
    const agent = SECURITY_AGENTS.find((a) => a.name === name);
    if (!agent) throw AppError.notFound(`security agent ${name}`, 'aios_p3_sec_no_agent');
    const missing = agent.requires.filter((c) => !this.hasCap(c));
    if (missing.length) throw AppError.forbidden('aios_p3_sec_cap', `missing ${missing.join(', ')}`);
    const res = await this.executor(name, sanitizeFields(input));
    return { ok: res.ok, result: sanitizeFields(res.result as Record<string, unknown>), agent: name };
  }

  private ensure(): void {
    if (this.feature() !== 'security') throw AppError.conflict('aios_p3_sec_off', 'security intelligence feature is off');
  }
}
