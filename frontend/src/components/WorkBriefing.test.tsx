/**
 * CodeConclave — WorkBriefing tests.
 *
 * Pins: the balance line counts from the given queue (no invented numbers),
 * approvals link only when the server reports pendings, and a failed
 * approvals fetch hides that clause instead of breaking the briefing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkBriefing } from './WorkBriefing';
import type { Task } from '../lib/types';

function json(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function task(id: string, status: string): Task {
  return { id, title: id, status } as unknown as Task;
}

function setup(tasks: Task[], approvals: Response | 'throw') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/execution/approvals')) {
        if (approvals === 'throw') throw new Error('down');
        return approvals;
      }
      return json({ data: {} });
    }),
  );
  render(
    <MemoryRouter>
      <WorkBriefing tasks={tasks} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkBriefing', () => {
  it('reports the balance: done vs still open, with waiting split out', async () => {
    setup(
      [task('t1', 'COMPLETED'), task('t2', 'RUNNING'), task('t3', 'WAITING_APPROVAL'), task('t4', 'QUEUED'), task('t5', 'FAILED')],
      json({ data: { approvals: [], pendingCount: 2 } }),
    );
    const line = await screen.findByTestId('work-briefing-line');
    expect(line).toHaveTextContent('1 done');
    expect(line).toHaveTextContent('3 still open');
    expect(line).toHaveTextContent('1 failed');
    expect(await screen.findByTestId('work-briefing-approvals')).toHaveTextContent('2 decisions waiting on you');
  });

  it('hides the approvals clause when that fetch fails', async () => {
    setup([task('t1', 'COMPLETED')], 'throw');
    expect(await screen.findByTestId('work-briefing-line')).toHaveTextContent('1 done');
    expect(screen.queryByTestId('work-briefing-approvals')).toBeNull();
  });

  it('renders nothing when there is no queue and no pendings', async () => {
    setup([], json({ data: { approvals: [], pendingCount: 0 } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('work-briefing')).toBeNull();
  });
});
