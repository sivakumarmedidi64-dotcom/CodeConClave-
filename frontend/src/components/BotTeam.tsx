/**
 * The bot team for one Cowork task, driven by the real task timeline
 * (/api/v1/execution/tasks/:id). Specialists from the plan appear as bots,
 * work while their coworker run is RUNNING, burst away when it COMPLETES
 * (gone after the animation), and stay red if they FAIL. When the task
 * finishes, the deliverable is handed back to the chat via `onFinal`.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Bot, personaFor, type BotState } from './Bot';

interface CoworkerRun {
  id: string;
  coworker_type: string;
  order_index: number;
  state: string;
  output: unknown;
}

interface Step {
  kind: string;
  status: string;
  output: string | null;
}

interface Timeline {
  task: { id: string; status: string; title: string };
  steps: Step[];
  coworkerRuns: CoworkerRun[];
  plan: { entries?: { coworker: string }[] } | null;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTER', 'TIMED_OUT']);
const POLL_MS = 2000;
// Ribbons orbit, then the burst — matches the cc-bb-vanish animation (1.9s).
const BURST_MS = 2000;

function runState(state: string | undefined): BotState {
  switch (state) {
    case 'RUNNING':
      return 'working';
    case 'PLANNING':
    case 'VERIFYING':
      return 'thinking';
    case 'COMPLETED':
      return 'done';
    case 'BLOCKED':
      return 'blocked';
    case 'FAILED':
    case 'TIMED_OUT':
    case 'CANCELLED':
      return 'failed';
    case 'QUEUED':
      return 'waiting';
    default:
      return 'idle';
  }
}

/** Best human-readable deliverable from the timeline (never invented). */
export function finalAnswerFrom(t: Timeline): string | null {
  const out = [...t.steps].reverse().find((s) => s.kind === 'output' && s.output);
  if (out?.output) return out.output;
  const runs = [...t.coworkerRuns].sort((a, b) => b.order_index - a.order_index);
  for (const r of runs) {
    if (r.state !== 'COMPLETED' || r.coworker_type === 'REVIEWER') continue;
    const o = r.output as { summary?: unknown; text?: unknown; content?: unknown } | string | null;
    if (typeof o === 'string' && o.trim()) return o;
    if (o && typeof o === 'object') {
      for (const k of ['summary', 'text', 'content'] as const) {
        if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
      }
    }
  }
  return null;
}

export function BotTeam({ taskId, onFinal }: { taskId: string; onFinal?: (text: string, status: string) => void }) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const finalSent = useRef(false);
  const burstTimers = useRef(new Map<string, number>());

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const t = await api<Timeline>(`/api/v1/execution/tasks/${taskId}`);
        if (!alive) return;
        // A malformed reply must show an error, never crash the chat render.
        if (!t || !t.task || !Array.isArray(t.steps) || !Array.isArray(t.coworkerRuns)) {
          throw new Error('The task status could not be read.');
        }
        setTimeline(t);
        setError(null);
        if (TERMINAL.has(t.task.status)) {
          if (!finalSent.current) {
            finalSent.current = true;
            const text = finalAnswerFrom(t);
            onFinal?.(
              text ?? (t.task.status === 'COMPLETED' ? 'The team finished — open the task to see what it produced.' : `The task ${t.task.status.toLowerCase().replace('_', ' ')}.`),
              t.task.status,
            );
          }
          return;
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not reach the task');
      }
      if (alive) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Roster: the plan's specialists, then any run the plan did not list.
  const runs = timeline?.coworkerRuns ?? [];
  const roster: string[] = [];
  for (const e of timeline?.plan?.entries ?? []) if (!roster.includes(e.coworker)) roster.push(e.coworker);
  for (const r of [...runs].sort((a, b) => a.order_index - b.order_index)) if (!roster.includes(r.coworker_type)) roster.push(r.coworker_type);
  const planStep = timeline?.steps.find((s) => s.kind === 'plan');
  // Before a plan exists the Planner is the only member: it picks the team.
  if (roster.length === 0 && timeline) roster.push('PLANNER');

  const paused = timeline?.task.status === 'WAITING_APPROVAL';
  const stateOf = (kind: string): BotState => {
    if (kind === 'PLANNER' && runs.length === 0) {
      if (planStep?.status === 'COMPLETED') return 'done';
      if (planStep || timeline?.task.status === 'RUNNING') return 'thinking';
      return 'waiting';
    }
    const s = runState(runs.find((r) => r.coworker_type === kind)?.state ?? 'QUEUED');
    // Paused for the user's approval: whoever is up next is blocked on you.
    return paused && (s === 'working' || s === 'waiting' || s === 'thinking') ? 'blocked' : s;
  };

  // A finished bot plays its burst, then leaves the stage.
  useEffect(() => {
    for (const kind of roster) {
      if (stateOf(kind) === 'done' && !gone.has(kind) && !burstTimers.current.has(kind)) {
        const id = window.setTimeout(() => setGone((prev) => new Set(prev).add(kind)), BURST_MS);
        burstTimers.current.set(kind, id);
      }
    }
  });
  useEffect(() => () => burstTimers.current.forEach((id) => window.clearTimeout(id)), []);

  const status = timeline?.task.status;
  const onStage = roster.filter((k) => !gone.has(k));
  const finished = roster.filter((k) => gone.has(k));

  return (
    <section className="cc-botteam" aria-label="Bot team working on your task" aria-live="polite" data-testid="bot-team">
      <div className="cc-botteam__head">
        <strong>Your bot team</strong>
        <span className="cc-botteam__status">
          {!timeline && !error && 'assembling…'}
          {status === 'WAITING_APPROVAL' && 'waiting for your approval'}
          {status && status !== 'WAITING_APPROVAL' && !TERMINAL.has(status) && `${onStage.filter((k) => stateOf(k) === 'working').length} working`}
          {status && TERMINAL.has(status) && status.toLowerCase()}
        </span>
        <Link to="/work" className="cc-botteam__link">
          Open task
        </Link>
      </div>
      {error && <p className="cc-hint">{error}</p>}
      {status === 'WAITING_APPROVAL' && (
        <p className="cc-hint">
          The team paused for a risky step. <Link to="/approvals">Review it in Approvals</Link> to let them continue.
        </p>
      )}
      <div className="cc-botteam__stage">
        {onStage.map((k) => (
          <Bot key={k} kind={k} state={stateOf(k)} />
        ))}
        {timeline && onStage.length === 0 && roster.length > 0 && <p className="cc-hint">Every specialist finished their part.</p>}
      </div>
      {finished.length > 0 && (
        <p className="cc-botteam__done">
          Done: {finished.map((k) => personaFor(k).name).join(', ')}
        </p>
      )}
    </section>
  );
}
