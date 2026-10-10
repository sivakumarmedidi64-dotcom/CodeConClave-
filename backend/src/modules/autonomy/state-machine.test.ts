/**
 * CodeConClave — PKG-25 state-machine unit tests.
 * Covers the Phase 2 lifecycle additions (READY/EXECUTING/WAITING_FOR_DEVICE/
 * RECOVERABLE/PAUSED), idempotent self-transitions, terminal resurrection, and
 * the canonical happy path.
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_STATUS,
  isValidTaskStatus,
  invalidTransitionReason,
  assertNotTerminalResurrection,
  guardTransition,
} from './state-machine.js';

describe('state machine — Phase 2 state set', () => {
  it('exposes every canonical + Phase 2 status', () => {
    expect(TASK_STATUS).toEqual(expect.arrayContaining([
      'CREATED', 'PLANNED', 'WAITING_APPROVAL', 'RUNNING', 'TESTING', 'VERIFIED', 'COMPLETED',
      'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW',
      'READY', 'EXECUTING', 'WAITING_FOR_DEVICE', 'RECOVERABLE', 'PAUSED',
    ]));
    expect(Array.from(new Set(TASK_STATUS))).toHaveLength(TASK_STATUS.length);
  });

  it('all canonical + PAUSED statuses are valid task statuses', () => {
    for (const s of TASK_STATUS) {
      expect(isValidTaskStatus(s)).toBe(true);
    }
    expect(isValidTaskStatus('BOGUS')).toBe(false);
  });
});

describe('state machine — legal transitions', () => {
  it('accepts the canonical happy path', () => {
    expect(() => guardTransition('CREATED', 'PLANNED')).not.toThrow();
    expect(() => guardTransition('PLANNED', 'WAITING_APPROVAL')).not.toThrow();
    expect(() => guardTransition('WAITING_APPROVAL', 'RUNNING')).not.toThrow();
    expect(() => guardTransition('RUNNING', 'TESTING')).not.toThrow();
    expect(() => guardTransition('TESTING', 'VERIFIED')).not.toThrow();
    expect(() => guardTransition('VERIFIED', 'COMPLETED')).not.toThrow();
  });

  it('accepts the Phase 2 device-aware + recovery transitions', () => {
    expect(() => guardTransition('CREATED', 'READY')).not.toThrow();
    expect(() => guardTransition('READY', 'EXECUTING')).not.toThrow();
    expect(() => guardTransition('CREATED', 'WAITING_FOR_DEVICE')).not.toThrow();
    expect(() => guardTransition('WAITING_FOR_DEVICE', 'EXECUTING')).not.toThrow();
    expect(() => guardTransition('RUNNING', 'RECOVERABLE')).not.toThrow();
    expect(() => guardTransition('RECOVERABLE', 'CREATED')).not.toThrow();
    expect(() => guardTransition('FAILED', 'RECOVERABLE')).not.toThrow();
    expect(() => guardTransition('TIMED_OUT', 'FAILED')).not.toThrow();
    expect(() => guardTransition('WAITING_FOR_LOCAL_AGENT', 'EXECUTING')).not.toThrow();
  });

  it('accepts PAUSED as pause/resume lifecycle', () => {
    expect(() => guardTransition('RUNNING', 'PAUSED')).not.toThrow();
    expect(() => guardTransition('CREATED', 'PAUSED')).not.toThrow();
    expect(() => guardTransition('EXECUTING', 'PAUSED')).not.toThrow();
    expect(() => guardTransition('PAUSED', 'CREATED')).not.toThrow();
    expect(() => guardTransition('PAUSED', 'PLANNED')).not.toThrow();
    expect(() => guardTransition('PAUSED', 'CANCELLED')).not.toThrow();
  });

  it('accepts retry + recovery returns to CREATED', () => {
    expect(() => guardTransition('FAILED', 'CREATED')).not.toThrow();
    expect(() => guardTransition('TIMED_OUT', 'CREATED')).not.toThrow();
    expect(() => guardTransition('BLOCKED', 'CREATED')).not.toThrow();
  });
});

describe('state machine — illegal + terminal guards', () => {
  it('rejects impossible forward rewrites', () => {
    expect(() => guardTransition('CREATED', 'VERIFIED')).toThrow(/illegal transition CREATED -> VERIFIED/);
    expect(() => guardTransition('PLANNED', 'VERIFIED')).toThrow(/illegal transition/);
    expect(() => guardTransition('COMPLETED', 'RUNNING')).toThrow(/terminal COMPLETED/);
  });

  it('rejects terminal resurrection', () => {
    expect(() => guardTransition('COMPLETED', 'PLANNED')).toThrow(/terminal COMPLETED/);
    expect(() => guardTransition('CANCELLED', 'CREATED')).toThrow(/terminal CANCELLED/);
  });

  it('refuses to refresh a terminal task into itself', () => {
    expect(() => guardTransition('COMPLETED', 'COMPLETED')).toThrow(/terminal COMPLETED/);
    expect(() => guardTransition('FAILED', 'FAILED')).toThrow(/terminal FAILED/);
  });

  it('tolerates idempotent self-transitions for live statuses', () => {
    expect(() => guardTransition('CREATED', 'CREATED')).not.toThrow();
    expect(() => guardTransition('PAUSED', 'PAUSED')).not.toThrow();
    expect(() => guardTransition('RUNNING', 'RUNNING')).not.toThrow();
  });

  it('rejects every COMPLETED/CANCELLED exit via assertNotTerminalResurrection', () => {
    expect(assertNotTerminalResurrection).toEqual(expect.any(Function));
    expect(() => assertNotTerminalResurrection('COMPLETED', 'CREATED')).toThrow();
    expect(() => assertNotTerminalResurrection('FAILED', 'CREATED')).not.toThrow();
  });

  it('reports a reason instead of throwing for unknown statuses', () => {
    expect(invalidTransitionReason('BOGUS', 'CREATED')).toMatch(/unknown source status 'BOGUS'/);
    expect(invalidTransitionReason('CREATED', 'BOGUS')).toMatch(/unknown target status 'BOGUS'/);
  });
});

describe('state machine — exhaustive matrix over the real ALLOWED map (task-state matrix)', () => {
  it('every live-status transition either passes the map or is a rejected illegal transition (no silent drift)', () => {
    for (const from of TASK_STATUS) {
      for (const to of TASK_STATUS) {
        if (from === to) continue; // self-rewrites are idempotent by design (below)
        const reason = invalidTransitionReason(from, to);
        if (reason) {
          expect(() => guardTransition(from, to)).toThrow(/invalid_task_transition/);
        }
      }
    }
    // guardTransition treats same-status live rewrites as an idempotent no-op.
    for (const from of TASK_STATUS) {
      if (['COMPLETED', 'CANCELLED', 'FAILED', 'TIMED_OUT'].includes(from)) continue;
      expect(() => guardTransition(from, from)).not.toThrow();
    }
  });

  it('no terminal source may re-enter the lifecycle without an explicit retry path', () => {
    const retryableRetryTargets = (from: string): string[] => {
      if (from === 'FAILED') return ['CREATED', 'BLOCKED', 'RECOVERABLE'];
      if (from === 'TIMED_OUT') return ['CREATED', 'BLOCKED', 'RECOVERABLE', 'FAILED'];
      return [];
    };
    for (const from of TASK_STATUS) {
      const isTerminal = ['COMPLETED', 'CANCELLED', 'FAILED', 'TIMED_OUT'].includes(from);
      if (!isTerminal) continue;
      for (const to of TASK_STATUS) {
        if (retryableRetryTargets(from).includes(to)) continue;
        // Including self-transitions: a terminal task must never be "refreshed"
        // into itself, and COMPLETED/CANCELLED have no exit at all.
        expect(() => guardTransition(from, to), `${from} -> ${to}`).toThrow(/invalid_task_transition/);
      }
    }
  });

  it('every transition target named in the map is itself a valid, declared status', () => {
    const reachable = new Set<string>();
    for (const from of TASK_STATUS) {
      for (const to of TASK_STATUS) {
        if (invalidTransitionReason(from, to) === null) reachable.add(to);
      }
    }
    for (const reached of reachable) {
      expect(isValidTaskStatus(reached), `'${reached}' is not a declared TASK_STATUS`).toBe(true);
    }
  });

  it('the canonical lifecycle chain is complete and every branch status is reachable from a live status', () => {
    const chain = ['CREATED', 'PLANNED', 'WAITING_APPROVAL', 'RUNNING', 'TESTING', 'VERIFIED', 'COMPLETED'];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(invalidTransitionReason(chain[i]!, chain[i + 1]!), `${chain[i]} -> ${chain[i + 1]}`).toBeNull();
    }
    // Branch statuses must be reachable (honest states are used, never dead).
    for (const branch of ['FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW', 'PAUSED']) {
      const reachable = TASK_STATUS.some((from) => invalidTransitionReason(from, branch) === null);
      expect(reachable, `'${branch}' is unreachable from every status`).toBe(true);
    }
  });
});