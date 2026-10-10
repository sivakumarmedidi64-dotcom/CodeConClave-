/**
 * CodeConClave — unified action planner tests.
 *
 * Pins the grounding contract: surfaces resolve exactly like the router,
 * disabled surfaces BLOCK (never silently re-route), dependencies validate,
 * and `ready` is true only when every step is routable now. No DB, no
 * network — gates come from the mocked env.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  UNIFIED_ACTION_RUNTIME_ENABLED: 'true',
  LOCAL_EXECUTION_ENABLED: 'true',
  BROWSER_CONTROL_ENABLED: 'true',
  DESKTOP_CONTROL_ENABLED: 'true',
  LIVE_PREVIEW_ENABLED: 'true',
}));
vi.mock('../../config/env.js', () => ({ env: mockEnv }));

import { planObjective } from './planner.js';

beforeEach(() => {
  mockEnv.UNIFIED_ACTION_RUNTIME_ENABLED = 'true';
  mockEnv.LOCAL_EXECUTION_ENABLED = 'true';
  mockEnv.BROWSER_CONTROL_ENABLED = 'true';
  mockEnv.DESKTOP_CONTROL_ENABLED = 'true';
  mockEnv.LIVE_PREVIEW_ENABLED = 'true';
});

describe('action planner — happy path', () => {
  it('grounds a multi-surface objective into an ordered READY plan', () => {
    const plan = planObjective({
      projectId: 'p1',
      objective: 'Inspect my project, run tests and show me the app',
      steps: [
        { title: 'Inspect the workspace' },
        { title: 'Run tests', surface: 'LOCAL', deviceId: 'd1', localInstruction: { command: 'npm test' } },
        { title: 'Show the app', surface: 'PREVIEW', dependsOn: [0, 1] },
      ],
    });
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.surface)).toEqual(['CLOUD', 'LOCAL', 'PREVIEW']);
    expect(plan.steps.map((s) => s.readiness)).toEqual(['READY', 'READY', 'READY']);
    expect(plan.steps[1]!.permissionRequired).toContain('paired-device');
    expect(plan.warnings).toEqual([]);
  });

  it('infers BROWSER/DESKTOP from instruction kind like the router does', () => {
    const plan = planObjective({
      projectId: 'p1',
      objective: 'research then inspect',
      steps: [
        { title: 'Read docs', localInstruction: { type: 'browser', grants: {}, actions: [] } },
        { title: 'List windows', localInstruction: { type: 'desktop', grants: {}, actions: [] } },
      ],
    });
    expect(plan.steps.map((s) => s.surface)).toEqual(['BROWSER', 'DESKTOP']);
    expect(plan.ready).toBe(true);
  });

  it('warns when a device-bound step has no device yet (still READY, honestly flagged)', () => {
    const plan = planObjective({
      projectId: 'p1',
      objective: 'run tests',
      steps: [{ title: 'Run tests', surface: 'LOCAL', localInstruction: { command: 'npm test' } }],
    });
    expect(plan.ready).toBe(true);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('without a deviceId');
  });
});

describe('action planner — blocking honesty', () => {
  it('BLOCKS a step whose surface is disabled instead of re-routing it', () => {
    mockEnv.LOCAL_EXECUTION_ENABLED = 'false';
    const plan = planObjective({
      projectId: 'p1',
      objective: 'fix the login bug locally',
      steps: [{ title: 'Edit login.ts', surface: 'LOCAL', deviceId: 'd1', localInstruction: { command: 'npm test' } }],
    });
    expect(plan.ready).toBe(false);
    expect(plan.steps[0]!.readiness).toBe('BLOCKED');
    expect(plan.steps[0]!.surface).toBe('LOCAL');
    expect(plan.steps[0]!.blockReason).toContain('disabled');
  });

  it('BLOCKS unknown surfaces instead of reinterpreting them', () => {
    const plan = planObjective({
      projectId: 'p1',
      objective: 'do the thing',
      steps: [{ title: 'Mystery step', surface: 'QUANTUM' }],
    });
    expect(plan.ready).toBe(false);
    expect(plan.steps[0]!.blockReason).toContain('unknown surface');
  });

  it('BLOCKS out-of-range and self dependencies', () => {
    const plan = planObjective({
      projectId: 'p1',
      objective: 'bad deps',
      steps: [
        { title: 'First', dependsOn: [7] },
        { title: 'Second', dependsOn: [1] },
      ],
    });
    expect(plan.ready).toBe(false);
    expect(plan.steps[0]!.blockReason).toContain('dependsOn');
    expect(plan.steps[1]!.blockReason).toContain('dependsOn');
  });

  it('BLOCKS every step on a dependency cycle', () => {
    const plan = planObjective({
      projectId: 'p1',
      objective: 'cyclic',
      steps: [
        { title: 'A', dependsOn: [1] },
        { title: 'B', dependsOn: [0] },
      ],
    });
    expect(plan.ready).toBe(false);
    expect(plan.steps.every((s) => s.blockReason === 'dependency cycle detected in plan steps')).toBe(true);
  });

  it('rejects empty objectives and empty step lists', () => {
    expect(() => planObjective({ projectId: 'p1', objective: '  ', steps: [{ title: 'x' }] })).toThrow(/objective/);
    expect(() => planObjective({ projectId: 'p1', objective: 'do it', steps: [] })).toThrow(/at least one/);
  });
});
