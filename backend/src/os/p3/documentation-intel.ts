/**
 * CodeConClave AI OS — P3.11 Documentation Intelligence.
 *
 * Six documentation agents. No silent production documentation changes: every
 * write-target change is a PROPOSAL requiring confirmation. Agents:
 *   - doc_listener
 *   - changelog_writer
 *   - knowledge_base_builder
 *   - doc_reviewer
 *   - readme_generator
 *   - diagram_as_code
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type DocumentationAgentName =
  | 'doc_listener'
  | 'changelog_writer'
  | 'knowledge_base_builder'
  | 'doc_reviewer'
  | 'readme_generator'
  | 'diagram_as_code';

export interface DocumentationAgent {
  name: DocumentationAgentName;
  task: string;
  requires: readonly string[];
  output: 'proposal' | 'report';
}

export const DOCUMENTATION_AGENTS: readonly DocumentationAgent[] = [
  { name: 'doc_listener', task: 'Observe changes and propose doc updates (never silent production writes)', requires: ['filesystem.read', 'scan.read'], output: 'proposal' },
  { name: 'changelog_writer', task: 'Propose a changelog entry from verified changes', requires: ['filesystem.read'], output: 'proposal' },
  { name: 'knowledge_base_builder', task: 'Propose knowledge-base artifacts from docs', requires: ['filesystem.read', 'memory.read'], output: 'proposal' },
  { name: 'doc_reviewer', task: 'Review docs for accuracy and freshness (proposals only)', requires: ['filesystem.read'], output: 'proposal' },
  { name: 'readme_generator', task: 'Propose a README from project manifest', requires: ['filesystem.read'], output: 'proposal' },
  { name: 'diagram_as_code', task: 'Propose diagram-as-code from architecture description', requires: ['filesystem.read', 'context.read'], output: 'proposal' },
];

export type CapabilityHolder = (c: string) => boolean;
export type Executor = (name: DocumentationAgentName, input: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;

export class DocumentationIntelligence {
  constructor(private feature: () => P3Feature | null, private hasCap: CapabilityHolder, private executor: Executor) {}

  isEnabled(): boolean {
    return this.feature() === 'documentation';
  }

  registry(): readonly DocumentationAgent[] {
    return DOCUMENTATION_AGENTS;
  }

  async run(name: DocumentationAgentName, input: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; agent: DocumentationAgentName }> {
    this.ensure();
    const agent = DOCUMENTATION_AGENTS.find((a) => a.name === name);
    if (!agent) throw AppError.notFound(`documentation agent ${name}`, 'aios_p3_doc_no_agent');
    const missing = agent.requires.filter((c) => !this.hasCap(c));
    if (missing.length) throw AppError.forbidden('aios_p3_doc_cap', `missing ${missing.join(', ')}`);
    const res = await this.executor(name, sanitizeFields(input));
    return { ok: res.ok, result: sanitizeFields(res.result as Record<string, unknown>), agent: name };
  }

  private ensure(): void {
    if (this.feature() !== 'documentation') throw AppError.conflict('aios_p3_doc_off', 'documentation intelligence feature is off');
  }
}
