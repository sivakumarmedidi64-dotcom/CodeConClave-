/**
 * The bots act out the real pipeline (never decoration): their states are
 * derived only from the server's stage events.
 *   Plato (Planner)  — Route · scout
 *   Sentry (Security) — Gate · sentinel
 *   the specialist    — the ONE role Dispatch picked (Cody for code, Scout
 *                       for science, Rhea for reviews…)
 *   Vera (Verify)     — Verify · judge (kernel proofs)
 * When the answer is sealed they burst and disappear.
 */
import { Bot, type BotState } from './Bot';
import type { PipelineStage } from '../lib/sse';

/** Which bot plays each of the 13 specialist roles. */
export const ROLE_BOT: Record<string, string> = {
  Architect: 'ARCHITECT',
  Coder: 'CODER',
  Debugger: 'CODER',
  Reviewer: 'REVIEWER',
  Tester: 'TESTER',
  Security: 'SECURITY',
  DevOps: 'PERFORMANCE',
  'UI/UX': 'ARCHITECT',
  Documentation: 'DOCS',
  'Quantum Physics': 'RESEARCH',
  'Nuclear Physics': 'RESEARCH',
  'Computational Math': 'RESEARCH',
  Statistics: 'RESEARCH',
};

export interface BotSlot {
  key: string;
  kind: string;
  state: BotState;
  job: string;
}

/** Pure: stage events → the bot cast and each bot's state. */
export function botsFromStages(stages: PipelineStage[]): BotSlot[] {
  const has = (stage: string, status?: PipelineStage['status']) => stages.some((s) => s.stage === stage && (!status || s.status === status));
  const last = (stage: string) => [...stages].reverse().find((s) => s.stage === stage);
  const sealed = has('seal');
  const fin = (s: BotState): BotState => (sealed && s !== 'failed' ? 'done' : s);

  if (has('known')) return [{ key: 'docs', kind: 'DOCS', state: fin('working'), job: 'Answering from records' }];
  if (has('cache', 'done')) return [{ key: 'verify', kind: 'VERIFY', state: fin('working'), job: 'Serving a verified answer' }];

  const slots: BotSlot[] = [];
  slots.push({ key: 'planner', kind: 'PLANNER', state: fin(has('route') ? 'done' : 'thinking'), job: 'Routing' });
  if (!has('route')) return slots;

  const dispatch = last('dispatch');
  const role = String(dispatch?.detail?.role ?? '');
  const gate = last('gate');
  slots.push({ key: 'gate', kind: 'SECURITY', state: fin(!gate ? 'thinking' : gate.status === 'fail' ? 'failed' : 'done'), job: 'Gate' });
  if (!gate || gate.status === 'fail') return slots;

  const verify = last('verify');
  const names = stages.map((s) => s.stage);
  const repairing = names.lastIndexOf('repair') > names.lastIndexOf('verify');
  let specialist: BotState = 'working';
  if (has('escalate') || has('halted') || (last('specialist')?.status === 'fail')) specialist = 'failed';
  else if (has('budget')) specialist = 'blocked';
  else if (verify && verify.status === 'fail' && !repairing) specialist = 'blocked';
  else if (verify && verify.status === 'done') specialist = 'done';
  slots.push({ key: 'specialist', kind: ROLE_BOT[role] ?? 'CODER', state: fin(specialist), job: role || 'Specialist' });

  let vera: BotState = 'waiting';
  if (has('escalate')) vera = 'failed';
  else if (verify && verify.status === 'done') vera = 'done';
  else if (verify && verify.status === 'fail') vera = repairing ? 'waiting' : 'blocked';
  else if (has('specialist')) vera = 'waiting';
  slots.push({ key: 'verify', kind: 'VERIFY', state: fin(vera), job: 'Verify' });
  return slots;
}

export function PipelineBots({ stages }: { stages: PipelineStage[] }) {
  if (!stages.length) return null;
  const slots = botsFromStages(stages);
  return (
    <div className="pv3-bots" aria-label="The bot team working on this answer" data-testid="pipeline-bots">
      {slots.map((s) => (
        <div key={s.key} className="pv3-bot">
          <Bot kind={s.kind} state={s.state} size={34} showName={false} />
          <span className="pv3-bot__job">{s.job}</span>
        </div>
      ))}
    </div>
  );
}
