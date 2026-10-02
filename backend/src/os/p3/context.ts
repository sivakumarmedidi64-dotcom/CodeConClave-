/**
 * CodeConClave AI OS — P3.5 Context Intelligence.
 *
 * Nine context/productivity agents that ride the EXISTING Memory + Filesystem +
 * Context systems (no separate memory architecture). Each agent declares the
 * capabilities (tools) it may request, and `runAgent` enforces that the caller
 * actually holds those capabilities at runtime (canonical capability chain).
 * Recommendations-first: agents never mutate production — they emit proposals.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type ContextAgentName =
  | 'memory_compaction'
  | 'small_to_big'
  | 'context_swap'
  | 'notice_reminder'
  | 'theorem_math'
  | 'decision'
  | 'instruction_following'
  | 'ambiguity_detection'
  | 'document_grounding';

export interface ContextAgent {
  name: ContextAgentName;
  category: 'memory' | 'reasoning' | 'guardrails' | 'grounding';
  task: string;
  requires: readonly string[]; // capability names it may use
}

export const CONTEXT_AGENTS: readonly ContextAgent[] = [
  { name: 'memory_compaction', category: 'memory', task: 'Summarize and compact long-lived memory without losing facts', requires: ['memory.read', 'memory.write'] },
  { name: 'small_to_big', category: 'memory', task: 'Escalate from small to big context with retrieval of relevant memory', requires: ['memory.read', 'context.read'] },
  { name: 'context_swap', category: 'memory', task: 'Swap working context across tasks, persisting state to memory', requires: ['memory.write', 'context.write'] },
  { name: 'notice_reminder', category: 'reasoning', task: 'Track notices and time-based reminders across a session', requires: ['context.read', 'context.write'] },
  { name: 'theorem_math', category: 'reasoning', task: 'Step-by-step theorem and math reasoning with rigor checks', requires: ['context.read'] },
  { name: 'decision', category: 'reasoning', task: 'Structured decision analysis with options and trade-offs', requires: ['context.read', 'context.write'] },
  { name: 'instruction_following', category: 'guardrails', task: 'Verify the actor followed explicit instructions and flag drift', requires: ['context.read'] },
  { name: 'ambiguity_detection', category: 'guardrails', task: 'Detect ambiguous or underspecified instructions and request clarification', requires: ['context.read'] },
  { name: 'document_grounding', category: 'grounding', task: 'Ground answers in provided documents via filesystem + memory', requires: ['filesystem.read', 'memory.read'] },
];

export type CapabilityHolder = (capability: string) => boolean;
export type AgentExecutor = (name: ContextAgentName, input: Record<string, unknown>, capabilities: readonly string[]) => Promise<{ ok: boolean; result: unknown }>;

export class ContextIntelligence {
  constructor(
    private feature: () => P3Feature | null,
    private hasCap: CapabilityHolder,
    private executor: AgentExecutor,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'context';
  }

  registry(): readonly ContextAgent[] {
    return CONTEXT_AGENTS;
  }

  agent(name: ContextAgentName): ContextAgent | undefined {
    return CONTEXT_AGENTS.find((a) => a.name === name);
  }

  /**
   * Run a context agent. The agent may only use capabilities the caller holds
   * (canonical chain). Output is redacted and returned as a recommendation.
   */
  async run(name: ContextAgentName, input: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; agent: ContextAgentName }> {
    this.ensure();
    const agent = this.agent(name);
    if (!agent) throw AppError.notFound(`context agent ${name}`, 'aios_p3_ctx_no_agent');
    const missing = agent.requires.filter((c) => !this.hasCap(c));
    if (missing.length > 0) {
      throw AppError.forbidden('aios_p3_ctx_cap', `agent ${name} unavailable: missing ${missing.join(', ')}`);
    }
    const res = await this.executor(name, sanitizeFields(input), agent.requires);
    return { ok: res.ok, result: sanitizeFields(res.result as Record<string, unknown>), agent: name };
  }

  /** No-op guard usable by the caller before relying on an agent. */
  ensure(): void {
    if (this.feature() !== 'context') throw AppError.conflict('aios_p3_ctx_off', 'context intelligence feature is off');
  }
}

export function nextAgentPrompt(agent: ContextAgent): string {
  return `agent=${agent.name} (${agent.category}) :: ${agent.task}`;
}
