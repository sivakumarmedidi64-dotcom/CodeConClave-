/**
 * CodeConClave — period digest tests.
 *
 * Pins: counts derived from real-shaped rows, failures carry real error
 * codes (never "looks fine"), top actions ranked deterministically, markdown
 * contains the same numbers as the struct (no invented metrics), input
 * validation. No DB, no network.
 */
import { describe, it, expect } from 'vitest';
import { buildPeriodDigest } from './weekly.js';

const TASKS = [
  { id: 't1', title: 'Ship login', status: 'COMPLETED', updatedAt: '2026-10-01' },
  { id: 't2', title: 'Fix flake', status: 'FAILED', errorCode: 'local_command_failed', updatedAt: '2026-10-02' },
  { id: 't3', title: 'Docs pass', status: 'CANCELLED', updatedAt: '2026-10-03' },
  { id: 't4', title: 'Migrate DB', status: 'RUNNING', updatedAt: '2026-10-04' },
  { id: 't5', title: 'Nightly', status: 'TIMED_OUT', errorCode: 'provider_timeout', updatedAt: '2026-10-05' },
];
const AUDITS = [
  { action: 'task.completed', resourceType: 'task', createdAt: '2026-10-01' },
  { action: 'task.completed', resourceType: 'task', createdAt: '2026-10-02' },
  { action: 'local.command_executed', resourceType: 'local_command', createdAt: '2026-10-03' },
];

describe('period digest — derived reporting', () => {
  it('derives counts, failures with real codes, and ranked actions', () => {
    const d = buildPeriodDigest({ period: '2026-W40', projectId: 'p1', tasks: TASKS, audits: AUDITS });
    expect(d.counts).toMatchObject({ total: 5, completed: 1, failed: 2, cancelled: 1 });
    expect(d.counts.byStatus).toMatchObject({ COMPLETED: 1, RUNNING: 1 });
    expect(d.failures).toEqual([
      { id: 't2', title: 'Fix flake', errorCode: 'local_command_failed' },
      { id: 't5', title: 'Nightly', errorCode: 'provider_timeout' },
    ]);
    expect(d.topActions[0]).toEqual({ action: 'task.completed', count: 2 });
    expect(d.markdown).toContain('completed 1, failed 2, cancelled 1');
    expect(d.markdown).toContain('[local_command_failed]');
    expect(d.markdown).toContain('[provider_timeout]');
  });

  it('says plainly when nothing failed', () => {
    const d = buildPeriodDigest({
      period: 'w',
      projectId: 'p1',
      tasks: [{ id: 't1', title: 'A', status: 'COMPLETED', updatedAt: 'x' }],
      audits: [],
    });
    expect(d.markdown).toContain('No failed tasks in this period.');
  });

  it('validates inputs', () => {
    expect(() => buildPeriodDigest({ period: '', projectId: 'p1', tasks: [], audits: [] })).toThrow(/period and projectId/);
    expect(() => buildPeriodDigest({ period: 'w', projectId: 'p1', tasks: null as never, audits: [] })).toThrow(/arrays/);
  });
});
