import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PipelineBots, botsFromStages } from './PipelineBots';
import type { PipelineStage } from '../lib/sse';

const st = (stage: string, status: PipelineStage['status'] = 'done', detail?: Record<string, unknown>): PipelineStage => ({ stage, status, label: stage, detail });
const state = (stages: PipelineStage[]) => Object.fromEntries(botsFromStages(stages).map((b) => [b.key, `${b.kind}:${b.state}`]));

describe('bots act out the real pipeline', () => {
  it('Plato routes, Sentry gates, the specialist works, Vera waits', () => {
    expect(state([st('intake')])).toEqual({ planner: 'PLANNER:thinking' });
    const running = [st('intake'), st('route'), st('dispatch', 'done', { role: 'Statistics' }), st('gate'), st('specialist', 'start')];
    expect(state(running)).toEqual({ planner: 'PLANNER:done', gate: 'SECURITY:done', specialist: 'RESEARCH:working', verify: 'VERIFY:waiting' });
  });
  it('a failed verification blocks the specialist; a repair puts it back to work', () => {
    const base = [st('intake'), st('route'), st('dispatch', 'done', { role: 'Coder' }), st('gate'), st('specialist', 'start'), st('verify', 'fail')];
    expect(state(base)).toMatchObject({ specialist: 'CODER:blocked', verify: 'VERIFY:blocked' });
    expect(state([...base, st('repair', 'start')])).toMatchObject({ specialist: 'CODER:working', verify: 'VERIFY:waiting' });
  });
  it('everyone is done (and bursts) once sealed; escalation fails the specialist and Vera', () => {
    const ok = [st('intake'), st('route'), st('dispatch', 'done', { role: 'Coder' }), st('gate'), st('specialist', 'start'), st('verify'), st('act', 'skip'), st('seal')];
    expect(Object.values(state(ok)).every((v) => v.endsWith(':done'))).toBe(true);
    const esc = [...ok.slice(0, 6), st('escalate', 'fail'), st('seal')];
    expect(state(esc)).toMatchObject({ specialist: 'CODER:failed', verify: 'VERIFY:failed' });
  });
  it('a Gate denial fails Sentry and stops there', () => {
    expect(state([st('intake'), st('route'), st('dispatch', 'done', { role: 'Documentation' }), st('gate', 'fail')])).toEqual({ planner: 'PLANNER:done', gate: 'SECURITY:failed' });
  });
  it('renders the cast with their jobs', () => {
    render(<PipelineBots stages={[st('intake'), st('route'), st('dispatch', 'done', { role: 'Coder' }), st('gate'), st('specialist', 'start')]} />);
    expect(screen.getByText('Routing')).toBeInTheDocument();
    expect(screen.getByText('Coder')).toBeInTheDocument();
    expect(screen.getAllByRole('img').length).toBe(4);
  });
});
