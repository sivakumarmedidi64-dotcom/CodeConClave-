/**
 * CodeConClave AI OS — P3.10 Team Intelligence.
 *
 * Five team agents (recommendations only):
 *   - team_coordination
 *   - handoff
 *   - cowork_allocator
 *   - availability
 *   - knowledge_share
 * They respect workspace boundaries, team permissions/roles, privacy, and RBAC.
 * None reveal cross-boundary data; any shared knowledge is a proposal requiring
 * explicit permission.
 */
import { AppError } from '../../shared/errors.js';
import { sanitizeFields } from '../observability.js';
import type { P3Feature } from './flags.js';

export type TeamAgentName =
  | 'team_coordination'
  | 'handoff'
  | 'cowork_allocator'
  | 'availability'
  | 'knowledge_share';

export interface TeamAgent {
  name: TeamAgentName;
  task: string;
  requires: readonly string[];
  scope: 'workspace' | 'team';
  output: 'recommendation' | 'report';
}

export const TEAM_AGENTS: readonly TeamAgent[] = [
  { name: 'team_coordination', task: 'Propose coordination actions across the team', requires: ['team.read'], scope: 'team', output: 'recommendation' },
  { name: 'handoff', task: 'Propose a structured handoff between coworkers', requires: ['context.read', 'context.write'], scope: 'workspace', output: 'recommendation' },
  { name: 'cowork_allocator', task: 'Advise on cowork/task allocation within RBAC', requires: ['team.read', 'context.read'], scope: 'workspace', output: 'recommendation' },
  { name: 'availability', task: 'Report availability within the workspace/team', requires: ['team.read'], scope: 'team', output: 'report' },
  { name: 'knowledge_share', task: 'Propose a knowledge artifact with explicit sharing permission', requires: ['memory.read', 'context.write'], scope: 'workspace', output: 'recommendation' },
];

export type CapabilityHolder = (c: string) => boolean;
export type Executor = (name: TeamAgentName, input: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;

export class TeamIntelligence {
  constructor(private feature: () => P3Feature | null, private hasCap: CapabilityHolder, private executor: Executor) {}

  isEnabled(): boolean {
    return this.feature() === 'team';
  }

  registry(): readonly TeamAgent[] {
    return TEAM_AGENTS;
  }

  async run(name: TeamAgentName, input: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; agent: TeamAgentName }> {
    this.ensure();
    const agent = TEAM_AGENTS.find((a) => a.name === name);
    if (!agent) throw AppError.notFound(`team agent ${name}`, 'aios_p3_team_no_agent');
    const missing = agent.requires.filter((c) => !this.hasCap(c));
    if (missing.length) throw AppError.forbidden('aios_p3_team_cap', `missing ${missing.join(', ')}`);
    const res = await this.executor(name, sanitizeFields(input));
    return { ok: res.ok, result: sanitizeFields(res.result as Record<string, unknown>), agent: name };
  }

  private ensure(): void {
    if (this.feature() !== 'team') throw AppError.conflict('aios_p3_team_off', 'team intelligence feature is off');
  }
}
