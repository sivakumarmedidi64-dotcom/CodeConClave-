/**
 * CodeConClave — PKG-25 — autonomy module tests.
 *
 * Deterministic, DB-independent coverage of the additive proofs + hardening
 * layer over the EXISTING 24/7 engine: the state-machine guard, the logic
 * harness (full lifecycle), the recurrence engine, and the honest truth model.
 * Real-infrastructure evidence lives in `autonomy.real.test.ts` (gated on a
 * reachable database) — never implied here.
 */
import { describe, it, expect } from 'vitest';
import {
  assertValidTransition,
  guardTransition,
  invalidTransitionReason,
  isValidTaskStatus,
} from './state-machine.js';
import { runLogicHarness, LOGIC_PHASE_NAMES } from './harness.js';
import { nextRunAt, occurrencesBetween, parseCron } from '../scheduling/recurrence.js';
import { buildTruthReport, TRUTH_KEYS } from './truth.js';

// ---------------------------------------------------------------- state machine
describe('24/7 state machine guard', () => {
  it('accepts the canonical lifecycle CREATED->RUNNING->TESTING->VERIFIED->COMPLETED', () => {
    const t: string[] = ['CREATED', 'RUNNING', 'TESTING', 'VERIFIED', 'COMPLETED'];
    for (let i = 0; i < t.length - 1; i++) {
      expect(() => assertValidTransition(t[i], t[i + 1])).not.toThrow();
    }
  });

  it('rejects COMPLETED -> RUNNING (terminal workflow resurrected)', () => {
    expect(invalidTransitionReason('COMPLETED', 'RUNNING')).toContain('illegal transition');
    expect(() => assertValidTransition('COMPLETED', 'RUNNING')).toThrow(/invalid_task_transition/);
  });

  it('rejects CANCELLED -> CREATED (cancelled work resurrected)', () => {
    expect(invalidTransitionReason('CANCELLED', 'CREATED')).toContain('illegal transition');
  });

  it('guards terminal resurrection COMPLETED->RUNNING', () => {
    expect(() => guardTransition('COMPLETED', 'RUNNING')).toThrow(/terminal/);
  });

  it('allows FAILED -> CREATED (explicit retry path)', () => {
    expect(invalidTransitionReason('FAILED', 'CREATED')).toBeNull();
  });

  it('allows TIMED_OUT -> CREATED (timeout retry path)', () => {
    expect(invalidTransitionReason('TIMED_OUT', 'CREATED')).toBeNull();
  });

  it('allows BLOCKED -> CREATED (unblock/retry path)', () => {
    expect(invalidTransitionReason('BLOCKED', 'CREATED')).toBeNull();
  });

  it('rejects an unknown source status', () => {
    expect(invalidTransitionReason('NOPE', 'RUNNING')).toContain('unknown source');
  });

  it('rejects an unknown target status', () => {
    expect(invalidTransitionReason('CREATED', 'NOPE')).toContain('unknown target');
  });

  it('recognizes the frozen DB status enum values', () => {
    for (const s of ['CREATED', 'PLANNED', 'WAITING_APPROVAL', 'RUNNING', 'TESTING', 'VERIFIED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW']) {
      expect(isValidTaskStatus(s)).toBe(true);
    }
  });

  it('allows WAITING_APPROVAL -> PLANNED (approval resolved)', () => {
    expect(invalidTransitionReason('WAITING_APPROVAL', 'PLANNED')).toBeNull();
  });
});

// ---------------------------------------------------------------- logic harness
describe('24/7 durability logic harness', () => {
  const result = runLogicHarness();

  it('harness passes every phase', () => {
    expect(result.ok).toBe(true);
    for (const p of result.phases) {
      expect(p.ok, p.phase).toBe(true);
    }
  });

  it('covers every required durability phase', () => {
    const names = result.phases.map((p) => p.phase);
    for (const phase of LOGIC_PHASE_NAMES) {
      expect(names).toContain(phase);
    }
  });

  it('persists creation state', () => {
    const p = result.phases.find((x) => x.phase === 'creation')!;
    expect(p.ok).toBe(true);
  });

  it('schedules/claims the task', () => {
    expect(result.phases.find((x) => x.phase === 'scheduling')!.ok).toBe(true);
  });

  it('proves user-disconnect continuity (backend advances alone)', () => {
    expect(result.phases.find((x) => x.phase === 'disconnect-continuity')!.ok).toBe(true);
  });

  it('recovers a transient failure via retry', () => {
    expect(result.phases.find((x) => x.phase === 'transient-retry')!.ok).toBe(true);
  });

  it('resumes from the durable checkpoint after a retry', () => {
    expect(result.phases.find((x) => x.phase === 'resume-after-retry')!.ok).toBe(true);
  });

  it('recognizes permanent failure', () => {
    expect(result.phases.find((x) => x.phase === 'permanent-failure')!.ok).toBe(true);
  });

  it('rejects invalid transitions inside the lifecycle', () => {
    expect(result.phases.find((x) => x.phase === 'invalid-transition')!.ok).toBe(true);
  });

  it('completes with a persisted result', () => {
    expect(result.phases.find((x) => x.phase === 'completion')!.ok).toBe(true);
  });

  it('enforces exactly-once per recurring occurrence', () => {
    expect(result.phases.find((x) => x.phase === 'recurring-exactly-once')!.ok).toBe(true);
  });

  it('computes recurrence math correctly', () => {
    expect(result.phases.find((x) => x.phase === 'recurring-math')!.ok).toBe(true);
  });

  it('carries continuity/memory forward', () => {
    expect(result.phases.find((x) => x.phase === 'continuity')!.ok).toBe(true);
  });

  it('never double-applies an idempotent side effect', () => {
    expect(result.phases.find((x) => x.phase === 'idempotent-side-effect')!.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- recurrence
describe('24/7 recurrence engine', () => {
  const now = new Date('2026-01-06T00:00:00Z'); // Tuesday

  it('hourly next-run lands exactly on the hour', () => {
    const next = nextRunAt({ recurrence: 'HOURLY', runAt: '00', runOnDays: [], timezone: 'UTC' }, now)!;
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('daily next-run matches the configured time', () => {
    const next = nextRunAt({ recurrence: 'DAILY', runAt: '09:30', runOnDays: [], timezone: 'UTC' }, now)!;
    expect(next.toISOString()).toBe('2026-01-06T09:30:00.000Z');
  });

  it('weekly next-run skips days outside the run set', () => {
    const next = nextRunAt({ recurrence: 'WEEKLY', runAt: '09:00', runOnDays: ['MON', 'WED', 'FRI'], timezone: 'UTC' }, now)!;
    expect(next.toISOString()).toBe('2026-01-07T09:00:00.000Z'); // Wednesday
  });

  it('occurrencesBetween yields only configured weekdays, strictly increasing', () => {
    const between = occurrencesBetween({ recurrence: 'WEEKLY', runAt: '09:00', runOnDays: ['MON', 'WED', 'FRI'], timezone: 'UTC' }, now, new Date('2026-02-01T00:00:00Z'), 10);
    expect(between.length).toBeGreaterThanOrEqual(1);
    expect(between.length).toBeLessThanOrEqual(10);
    for (const d of between) expect([1, 3, 5]).toContain(d.getUTCDay());
    for (let i = 1; i < between.length; i++) expect(between[i].getTime()).toBeGreaterThan(between[i - 1].getTime());
  });

  it('rejects an invalid cron expression', () => {
    expect(parseCron('61 * * * *')).toBeNull();
  });

  it('parses a valid cron expression', () => {
    expect(parseCron('0 9 * * 1')).not.toBeNull();
  });
});

// ---------------------------------------------------------------- honest truth model
describe('24/7 honest truth model', () => {
  const base = {
    autonomyLogic: true,
    taskPersistence: true,
    restartRecovery: true,
    userDisconnectContinuity: true,
    failureRecovery: true,
    recurringAutonomy: true,
    memoryContinuity: true,
    realLongRunning: false,
    real247: false,
  };

  it('reports REAL_24_7_INFRASTRUCTURE as ENVIRONMENT_BLOCKED (honest, not verified)', async () => {
    const truth = await buildTruthReport(base, { db: true, wire: true, mode: 'REAL_INFRASTRUCTURE' });
    const item = truth.find((x) => x.key === 'REAL_24_7_INFRASTRUCTURE')!;
    expect(item.status).toBe('ENVIRONMENT_BLOCKED');
    expect(item.runtimeNote).toBeTruthy();
  });

  it('reports REAL_LONG_RUNNING_EXECUTION as ENVIRONMENT_BLOCKED (honest)', async () => {
    const truth = await buildTruthReport(base, { db: true, wire: true });
    expect(truth.find((x) => x.key === 'REAL_LONG_RUNNING_EXECUTION')!.status).toBe('ENVIRONMENT_BLOCKED');
  });

  it('marks AUTONOMY_LOGIC VERIFIED when the logic harness proves it', async () => {
    const truth = await buildTruthReport(base, { db: true, wire: true, mode: 'REAL_INFRASTRUCTURE' });
    expect(truth.find((x) => x.key === 'AUTONOMY_LOGIC')!.status).toBe('VERIFIED');
  });

  it('marks 24_7_AUTONOMOUS_COWORK composite VERIFIED only when core logic holds', async () => {
    const truth = await buildTruthReport(base, { db: true, wire: true });
    expect(truth.find((x) => x.key === '24_7_AUTONOMOUS_COWORK')!.status).toBe('VERIFIED');
  });

  it('reports NOT_VERIFIED when the proof is absent (no fabricated claims)', async () => {
    const truth = await buildTruthReport({ ...base, failureRecovery: false }, { db: true, wire: true });
    expect(truth.find((x) => x.key === 'FAILURE_RECOVERY')!.status).toBe('NOT_VERIFIED');
  });

  it('annotates real-infra items with an environment caveat (no DB)', async () => {
    const truth = await buildTruthReport({ ...base, realLongRunning: false, real247: false }, { db: false, wire: false });
    for (const k of ['REAL_24_7_INFRASTRUCTURE', 'REAL_LONG_RUNNING_EXECUTION']) {
      expect(truth.find((x) => x.key === k)!.runtimeNote).toBeTruthy();
    }
    expect(truth.every((x) => TRUTH_KEYS.includes(x.key))).toBe(true);
  });

  it('emits all ten truth keys', async () => {
    const truth = await buildTruthReport(base, { db: true, wire: true });
    expect(truth.map((x) => x.key).sort()).toEqual([...TRUTH_KEYS].sort());
  });
});
