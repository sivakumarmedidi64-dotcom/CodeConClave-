import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/db.js', () => ({ withTenant: vi.fn(), withSystem: vi.fn() }));
vi.mock('./killSwitch.js', () => ({ killSwitchActive: vi.fn(), killSwitchStatus: vi.fn(), setKillSwitch: vi.fn() }));

import { emergencyStop, releaseHold } from './emergency.js';

function harness(opts: { failAssignment?: string; raceTask?: string } = {}) {
  const calls: string[] = [];
  const deps = {
    setGlobalHold: vi.fn(async (_u: string, active: boolean) => {
      calls.push(active ? 'hold:on' : 'hold:off');
    }),
    listActiveAssignments: vi.fn(async () => {
      calls.push('list:assignments');
      return [{ id: 'asg_1' }, { id: 'asg_2' }];
    }),
    cancelAssignment: vi.fn(async (id: string) => {
      if (id === opts.failAssignment) throw new Error('agent offline');
      calls.push(`cancel:${id}`);
    }),
    listCancellableTasks: vi.fn(async () => [{ id: 'tsk_1' }, { id: 'tsk_2' }, { id: 'tsk_3' }]),
    cancelTask: vi.fn(async (_u: string, id: string) => {
      if (id === opts.raceTask) throw new Error('task_not_cancellable');
      calls.push(`cancel:${id}`);
    }),
    audit: vi.fn(async () => undefined),
  };
  return { deps, calls };
}

describe('Stop everything (emergency stop)', () => {
  it('holds unattended work FIRST, then cancels laptop actions and every running task', async () => {
    const { deps, calls } = harness();
    const out = await emergencyStop('usr_1', 'panic', deps);
    expect(calls[0]).toBe('hold:on'); // before any cancellation
    expect(calls).toEqual(['hold:on', 'list:assignments', 'cancel:asg_1', 'cancel:asg_2', 'cancel:tsk_1', 'cancel:tsk_2', 'cancel:tsk_3']);
    expect(out).toMatchObject({ assignmentsCancelled: 2, assignmentsFailed: 0, tasksCancelled: 3, tasksSkipped: 0 });
    expect(deps.audit).toHaveBeenCalledWith('control.emergency_stop', 'usr_1', expect.objectContaining({ reason: 'panic', tasksCancelled: 3 }));
  });

  it('reports failures and races honestly instead of hiding them', async () => {
    const { deps } = harness({ failAssignment: 'asg_2', raceTask: 'tsk_2' });
    const out = await emergencyStop('usr_1', 'panic', deps);
    expect(out).toMatchObject({ assignmentsCancelled: 1, assignmentsFailed: 1, tasksCancelled: 2, tasksSkipped: 1 });
  });

  it('Resume releases the hold', async () => {
    const { deps, calls } = harness();
    expect(await releaseHold('usr_1', deps)).toEqual({ held: false, heldSince: null, reason: null });
    expect(calls).toEqual(['hold:off']);
  });
});
