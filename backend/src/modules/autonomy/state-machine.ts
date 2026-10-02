/**
 * CodeConClave — PKG-25 — explicit task state-machine validator.
 *
 * Additive HARDENING: the DB `tasks.status` CHECK permits any value from the
 * enum, so nothing today rejects a semantically-impossible rewrite such as
 * COMPLETED → RUNNING. This module encodes the canonical lifecycle from
 * `modules/execution/tasks.ts` and REJECTS illegal transitions.
 *
 * Canonical lifecycle:
 *   CREATED → PLANNED → WAITING_APPROVAL → RUNNING → TESTING → VERIFIED → COMPLETED
 *   branch-out → FAILED / TIMED_OUT / CANCELLED / BLOCKED /
 *                WAITING_FOR_LOCAL_AGENT / REQUIRES_REVIEW
 * Claimable-from (not necessarily reached via RUNNING) include CREATED/PLANNED/CHANGED.
 */

export const TASK_STATUS = [
  'CREATED',
  'PLANNED',
  'WAITING_APPROVAL',
  'RUNNING',
  'TESTING',
  'VERIFIED',
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'BLOCKED',
  'WAITING_FOR_LOCAL_AGENT',
  'REQUIRES_REVIEW',
  'READY',
  'EXECUTING',
  'WAITING_FOR_DEVICE',
  'RECOVERABLE',
  'PAUSED',
] as const;

export type TaskStatus = (typeof TASK_STATUS)[number];

/** Statuses that are terminal (no further forward progress permitted). */
export const TERMINAL_STATUS: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'DEAD_LETTERED',
]);

/** Statuses a worker may claim and begin executing (queue claim gate). */
export const CLAIMABLE_STATUS: ReadonlySet<string> = new Set([
  'CREATED',
  'PLANNED',
  'CHANGED',
]);

/** Statuses that represent active execution (heartbeat applies). */
export const RUNNING_LIKE_STATUS: ReadonlySet<string> = new Set([
  'RUNNING',
  'EXECUTING',
  'TESTING',
]);

/**
 * Allowed transitions. Keys/values are the semantic states reachable in the
 * engine. If a transition is not listed here it is INVALID and rejected.
 * Retry (FAILED/TIMED_OUT/BLOCKED → CREATED) is explicitly scheduled by
 * scheduleRetry and is legal by definition.
 */
const ALLOWED: Record<string, ReadonlySet<string>> = {
  CREATED: new Set(['PLANNED', 'WAITING_APPROVAL', 'RUNNING', 'CHANGED', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW', 'READY', 'WAITING_FOR_DEVICE', 'PAUSED', 'COMPLETED']),
  PLANNED: new Set(['CREATED', 'RUNNING', 'WAITING_APPROVAL', 'CHANGED', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW', 'READY', 'WAITING_FOR_DEVICE', 'PAUSED', 'COMPLETED']),
  CHANGED: new Set(['CREATED', 'PLANNED', 'RUNNING', 'WAITING_APPROVAL', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW', 'PAUSED']),
  WAITING_APPROVAL: new Set(['PLANNED', 'CREATED', 'RUNNING', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'BLOCKED', 'REQUIRES_REVIEW', 'PAUSED']),
  RUNNING: new Set(['TESTING', 'VERIFIED', 'COMPLETED', 'PLANNED', 'CREATED', 'WAITING_APPROVAL', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW', 'EXECUTING', 'WAITING_FOR_DEVICE', 'RECOVERABLE', 'PAUSED']),
  TESTING: new Set(['VERIFIED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'REQUIRES_REVIEW', 'PAUSED']),
  VERIFIED: new Set(['COMPLETED', 'TESTING', 'RUNNING', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'REQUIRES_REVIEW', 'PAUSED']),
  COMPLETED: new Set(),
  FAILED: new Set(['CREATED', 'BLOCKED', 'RECOVERABLE']),
  TIMED_OUT: new Set(['CREATED', 'BLOCKED', 'RECOVERABLE', 'FAILED']),
  CANCELLED: new Set(),
  BLOCKED: new Set(['CREATED', 'PLANNED', 'RUNNING', 'FAILED', 'TIMED_OUT', 'RECOVERABLE', 'PAUSED']),
  WAITING_FOR_LOCAL_AGENT: new Set(['CREATED', 'PLANNED', 'RUNNING', 'REQUIRES_REVIEW', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'EXECUTING', 'WAITING_FOR_DEVICE', 'RECOVERABLE', 'PAUSED']),
  REQUIRES_REVIEW: new Set(['CREATED', 'PLANNED', 'RUNNING', 'TESTING', 'VERIFIED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'PAUSED']),
  READY: new Set(['RUNNING', 'EXECUTING', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'BLOCKED', 'REQUIRES_REVIEW', 'PLANNED', 'CREATED', 'WAITING_FOR_DEVICE', 'PAUSED', 'COMPLETED']),
  EXECUTING: new Set(['READY', 'RUNNING', 'TESTING', 'VERIFIED', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'REQUIRES_REVIEW', 'WAITING_FOR_DEVICE', 'RECOVERABLE', 'PAUSED']),
  WAITING_FOR_DEVICE: new Set(['EXECUTING', 'RUNNING', 'READY', 'PLANNED', 'CREATED', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'BLOCKED', 'REQUIRES_REVIEW', 'RECOVERABLE', 'PAUSED']),
  RECOVERABLE: new Set(['EXECUTING', 'RUNNING', 'READY', 'PLANNED', 'CREATED', 'REQUIRES_REVIEW', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'PAUSED']),
  PAUSED: new Set(['CREATED', 'PLANNED', 'WAITING_APPROVAL', 'RUNNING', 'TESTING', 'VERIFIED', 'WAITING_FOR_LOCAL_AGENT', 'REQUIRES_REVIEW', 'READY', 'EXECUTING', 'WAITING_FOR_DEVICE', 'RECOVERABLE', 'CANCELLED', 'FAILED', 'TIMED_OUT', 'BLOCKED']),
};

/** True when a status string is a valid, known task status. */
export function isValidTaskStatus(status: string): boolean {
  return (TASK_STATUS as readonly string[]).includes(status);
}

/**
 * Validate a transition. Returns a reason string when invalid, else null.
 * Any unknown source/target, or a transition absent from ALLOWED, is invalid.
 */
export function invalidTransitionReason(from: string, to: string): string | null {
  if (!isValidTaskStatus(from)) return `unknown source status '${from}'`;
  if (!isValidTaskStatus(to)) return `unknown target status '${to}'`;
  const allowed = ALLOWED[from];
  if (!allowed) return `no transitions defined from '${from}'`;
  if (allowed.has(to)) return null;
  return `illegal transition ${from} -> ${to}`;
}

/** Throw unless `from -> to` is a legal lifecycle transition. */
export function assertValidTransition(from: string, to: string): void {
  const reason = invalidTransitionReason(from, to);
  if (reason) {
    throw new Error(`invalid_task_transition: ${reason}`);
  }
}

/**
 * End-to-end terminal-to-active guard: a task that reached a terminal state
 * must never be resumed except through an explicit retry (FAILED/TIMED_OUT
 * → CREATED). This blocks the class of corruption where COMPLETED/CANCELLED
 * work is silently resurrected.
 */
export function assertNotTerminalResurrection(from: string, to: string): void {
  if (TERMINAL_STATUS.has(from) && from !== 'FAILED' && from !== 'TIMED_OUT') {
    throw new Error(`invalid_task_transition: terminal ${from} cannot transition to ${to}`);
  }
}

/** Combined guard used by the autonomy machinery. */
export function guardTransition(from: string, to: string): void {
  if (from === to) {
    // Idempotent re-enqueue/resume writes (e.g. a first attempt already
    // CREATED being re-scheduled) are a no-op, not a state rewrite. Still
    // refuse to "refresh" a terminal task into itself, which would be a
    // resume-by-rename of dead work.
    if (TERMINAL_STATUS.has(from)) {
      throw new Error(`invalid_task_transition: terminal ${from} cannot transition to ${to}`);
    }
    return;
  }
  assertNotTerminalResurrection(from, to);
  assertValidTransition(from, to);
}
