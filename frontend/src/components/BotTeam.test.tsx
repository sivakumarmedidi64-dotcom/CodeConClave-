import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BotTeam, finalAnswerFrom } from './BotTeam';
import { Bot, personaFor } from './Bot';
import { jsonResponse, stubFetch } from '../testutils';

const timeline = (status: string, runs: { type: string; state: string; output?: unknown }[], steps: unknown[] = []) => ({
  task: { id: 'tsk_1', status, title: 'Build a landing page' },
  steps,
  coworkerRuns: runs.map((r, i) => ({ id: `run_${i}`, coworker_type: r.type, order_index: i, state: r.state, output: r.output ?? null })),
  plan: { entries: runs.map((r) => ({ coworker: r.type })) },
});

function renderTeam(onFinal = vi.fn()) {
  render(
    <MemoryRouter>
      <BotTeam taskId="tsk_1" onFinal={onFinal} />
    </MemoryRouter>,
  );
  return onFinal;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('Bot', () => {
  it('names each specialist and announces its state', () => {
    render(<Bot kind="CODER" state="working" />);
    expect(screen.getByRole('img', { name: 'Cody, Coder — working' })).toBeInTheDocument();
    expect(personaFor('ARCHITECT').name).toBe('Archie');
    expect(personaFor('unknown_role').role).toBe('unknown_role');
  });
});

describe('BotTeam', () => {
  it('shows the planned specialists with their real states', async () => {
    stubFetch(async () =>
      jsonResponse({ data: timeline('RUNNING', [{ type: 'ARCHITECT', state: 'RUNNING' }, { type: 'CODER', state: 'QUEUED' }]) }),
    );
    renderTeam();
    expect(await screen.findByRole('img', { name: 'Archie, Architect — working' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cody, Coder — waiting' })).toBeInTheDocument();
    expect(screen.getByText('1 working')).toBeInTheDocument();
  });

  it('lets a finished bot burst away and hands the deliverable to the chat', async () => {
    stubFetch(async () =>
      jsonResponse({
        data: timeline('COMPLETED', [
          { type: 'CODER', state: 'COMPLETED', output: { summary: 'Built index.html with a hero section.' } },
          { type: 'REVIEWER', state: 'COMPLETED', output: { summary: 'Looks good.' } },
        ]),
      }),
    );
    const onFinal = renderTeam();
    await waitFor(() => expect(onFinal).toHaveBeenCalledWith('Built index.html with a hero section.', 'COMPLETED'));
    expect(onFinal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('img', { name: /Cody/ })).not.toBeInTheDocument(), { timeout: 2500 });
    expect(screen.getByText(/Done: .*Cody/)).toBeInTheDocument();
  });

  it('keeps a failed bot on stage', async () => {
    stubFetch(async () => jsonResponse({ data: timeline('FAILED', [{ type: 'TESTER', state: 'FAILED' }]) }));
    const onFinal = renderTeam();
    expect(await screen.findByRole('img', { name: 'Tess, Tester — failed' })).toBeInTheDocument();
    await waitFor(() => expect(onFinal).toHaveBeenCalledWith('The task failed.', 'FAILED'));
  });

  it('prefers the explicit output step and never promotes a review as the deliverable', () => {
    expect(finalAnswerFrom(timeline('COMPLETED', [], [{ kind: 'output', status: 'COMPLETED', output: 'Final report' }]) as never)).toBe('Final report');
    expect(finalAnswerFrom(timeline('COMPLETED', [{ type: 'REVIEWER', state: 'COMPLETED', output: { summary: 'lgtm' } }]) as never)).toBeNull();
  });
});
