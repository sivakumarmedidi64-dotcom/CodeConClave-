/**
 * CodeConClave AI OS — P3.8 Performance Intelligence.
 *
 * Seven performance agents:
 *   - perf_profiler
 *   - cost_analyzer
 *   - latency_analyzer
 *   - concurrency_analyzer
 *   - memory_analyzer
 *   - egress_analyzer
 *   - caching_advisor
 * All produce RECOMMENDATIONS only — no automatic production optimization.
 * Reads ride observability/metrics (runtime/egress budgets are enforced by the
 * canonical resource governor, which personality never overrides).
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type PerformanceAgentName =
  | 'perf_profiler'
  | 'cost_analyzer'
  | 'latency_analyzer'
  | 'concurrency_analyzer'
  | 'memory_analyzer'
  | 'egress_analyzer'
  | 'caching_advisor';

export interface PerformanceAgent {
  name: PerformanceAgentName;
  task: string;
  requires: readonly string[];
  output: 'recommendation';
}

export const PERFORMANCE_AGENTS: readonly PerformanceAgent[] = [
  { name: 'perf_profiler', task: 'Profile a workload and identify hotspots', requires: ['metrics.read'], output: 'recommendation' },
  { name: 'cost_analyzer', task: 'Analyse estimated cost/run-time and propose reductions', requires: ['metrics.read', 'budget.read'], output: 'recommendation' },
  { name: 'latency_analyzer', task: 'Analyse latency and propose optimizations', requires: ['metrics.read'], output: 'recommendation' },
  { name: 'concurrency_analyzer', task: 'Analyse concurrency/queue behaviour under governor limits', requires: ['metrics.read', 'budget.read'], output: 'recommendation' },
  { name: 'memory_analyzer', task: 'Analyse memory/retention behaviour and propose tuning', requires: ['metrics.read'], output: 'recommendation' },
  { name: 'egress_analyzer', task: 'Analyse egress against budget and propose reductions', requires: ['metrics.read', 'budget.read'], output: 'recommendation' },
  { name: 'caching_advisor', task: 'Advise on caching/avoided recompute opportunities', requires: ['metrics.read'], output: 'recommendation' },
];

export type CapabilityHolder = (c: string) => boolean;
export type Executor = (name: PerformanceAgentName, input: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;

export class PerformanceIntelligence {
  constructor(private feature: () => P3Feature | null, private hasCap: CapabilityHolder, private executor: Executor) {}

  isEnabled(): boolean {
    return this.feature() === 'performance';
  }

  registry(): readonly PerformanceAgent[] {
    return PERFORMANCE_AGENTS;
  }

  async run(name: PerformanceAgentName, input: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; agent: PerformanceAgentName }> {
    this.ensure();
    const agent = PERFORMANCE_AGENTS.find((a) => a.name === name);
    if (!agent) throw AppError.notFound(`performance agent ${name}`, 'aios_p3_perf_no_agent');
    const missing = agent.requires.filter((c) => !this.hasCap(c));
    if (missing.length) throw AppError.forbidden('aios_p3_perf_cap', `missing ${missing.join(', ')}`);
    const res = await this.executor(name, sanitizeFields(input));
    return { ok: res.ok, result: sanitizeFields(res.result as Record<string, unknown>), agent: name };
  }

  private ensure(): void {
    if (this.feature() !== 'performance') throw AppError.conflict('aios_p3_perf_off', 'performance intelligence feature is off');
  }
}
