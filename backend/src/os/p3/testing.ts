/**
 * CodeConClave AI OS — P3.6 Testing Intelligence.
 *
 * Five testing agents:
 *   - test_generator
 *   - test_fixer
 *   - coverage_analyzer
 *   - regression_risk_analyzer
 *   - test_runner
 * They produce PROPOSALS and reports only — running the full suite is a
 * separate, permissioned action and is never auto-pushed to production.
 * Capabilities are enforced through the canonical chain.
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type TestingAgentName =
  | 'test_generator'
  | 'test_fixer'
  | 'coverage_analyzer'
  | 'regression_risk_analyzer'
  | 'test_runner';

export interface TestingAgent {
  name: TestingAgentName;
  task: string;
  requires: readonly string[];
  output: 'proposal' | 'report';
}

export const TESTING_AGENTS: readonly TestingAgent[] = [
  { name: 'test_generator', task: 'Propose new unit/integration tests from behaviour specs', requires: ['filesystem.read', 'test.dry_run'], output: 'proposal' },
  { name: 'test_fixer', task: 'Analyse failing tests and propose minimal fixes', requires: ['filesystem.read', 'test.dry_run'], output: 'proposal' },
  { name: 'coverage_analyzer', task: 'Produce a coverage report and gaps summary', requires: ['test.read'], output: 'report' },
  { name: 'regression_risk_analyzer', task: 'Assess regression risk of a change across touchpoints', requires: ['test.read', 'filesystem.read'], output: 'report' },
  { name: 'test_runner', task: 'Orchestrate a gated test run and report results', requires: ['test.run'], output: 'report' },
];

export type CapabilityHolder = (c: string) => boolean;
export type Executor = (name: TestingAgentName, input: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;

export class TestingIntelligence {
  constructor(private feature: () => P3Feature | null, private hasCap: CapabilityHolder, private executor: Executor) {}

  isEnabled(): boolean {
    return this.feature() === 'testing';
  }

  registry(): readonly TestingAgent[] {
    return TESTING_AGENTS;
  }

  async run(name: TestingAgentName, input: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; agent: TestingAgentName }> {
    this.ensure();
    const agent = TESTING_AGENTS.find((a) => a.name === name);
    if (!agent) throw AppError.notFound(`testing agent ${name}`, 'aios_p3_test_no_agent');
    const missing = agent.requires.filter((c) => !this.hasCap(c));
    if (missing.length) throw AppError.forbidden('aios_p3_test_cap', `missing ${missing.join(', ')}`);
    const res = await this.executor(name, sanitizeFields(input));
    return { ok: res.ok, result: sanitizeFields(res.result as Record<string, unknown>), agent: name };
  }

  private ensure(): void {
    if (this.feature() !== 'testing') throw AppError.conflict('aios_p3_test_off', 'testing intelligence feature is off');
  }
}
