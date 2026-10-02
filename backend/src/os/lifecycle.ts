/**
 * CodeConClave AI OS — process lifecycle / shutdown helpers (P1.2).
 *
 * Additive helper for child-process cleanup, parent/child failure propagation,
 * and graceful shutdown with honest cancellation escalation.
 *
 * HONESTY NOTE: the OS supervisor uses cooperative cancellation — it cannot
 * forcibly interrupt an arbitrary in-flight JS promise. `gracefulShutdown`
 * performs cooperative escalation: it waits a grace window for the supervised
 * work to observe cancellation, then records a `force` escalation and force-
 * transitions the process to `killed`. For real OS-level child processes
 * (spawned via the policy sandbox), the sandbox already owns SIGTERM→SIGKILL
 * escalation and process-tree cleanup; this module additionally tracks child
 * processes so a supervised process can be torn down as a unit.
 */
import { ChildProcess } from 'node:child_process';
import { logger } from '../shared/logger.js';

/** Tracks child processes grouped under a parent so they can be cleaned up as a unit. */
export class ProcessTree {
  private groups = new Map<string, Set<ChildProcess>>();

  register(parentId: string, child: ChildProcess): void {
    let set = this.groups.get(parentId);
    if (!set) {
      set = new Set();
      this.groups.set(parentId, set);
    }
    set.add(child);
    child.once('exit', () => this.unregister(parentId, child));
  }

  private unregister(parentId: string, child: ChildProcess): void {
    const set = this.groups.get(parentId);
    if (!set) return;
    set.delete(child);
    if (set.size === 0) this.groups.delete(parentId);
  }

  childrenOf(parentId: string): ChildProcess[] {
    return [...(this.groups.get(parentId) ?? [])];
  }

  /** SIGTERM then SIGKILL escalation for every child of a parent (best-effort). */
  async killTree(parentId: string, graceMs = 500): Promise<void> {
    const children = this.childrenOf(parentId);
    for (const c of children) {
      try {
        if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    }
    if (children.length > 0) {
      await new Promise<void>((r) => setTimeout(r, graceMs));
    }
    for (const c of children) {
      try {
        if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }
  }

  /** Number of live tracked children (observability). */
  liveCount(): number {
    let n = 0;
    for (const set of this.groups.values()) n += set.size;
    return n;
  }
}

export interface ShutdownResult {
  processId: string;
  escalation: 'cooperative' | 'force';
  stoppedWithinGrace: boolean;
}

/**
 * Cooperative shutdown with escalation. Waits up to `graceMs` for `wasStopped`
 * (the supervised body's cancellation completion) to become true; if it does
 * not, records a `force` escalation and force-kills the process tree.
 */
export async function gracefulShutdown(opts: {
  processId: string;
  /** Promise that resolves when the supervised work has fully stopped. */
  stopped: Promise<unknown>;
  /** Signal the supervised work to stop (cooperative). */
  requestStop: () => void;
  graceMs?: number;
  onEscalation?: (result: ShutdownResult) => void;
  tree?: ProcessTree;
}): Promise<ShutdownResult> {
  const graceMs = opts.graceMs ?? 1500;
  opts.requestStop();
  let stoppedWithinGrace = true;
  const outcome: ShutdownResult = {
    processId: opts.processId,
    escalation: 'cooperative',
    stoppedWithinGrace: true,
  };
  try {
    await Promise.race([
      opts.stopped,
      new Promise<void>((r) => setTimeout(() => {
        stoppedWithinGrace = false;
        r();
      }, graceMs)),
    ]);
  } catch {
    stoppedWithinGrace = false;
  }
  if (!stoppedWithinGrace) {
    outcome.escalation = 'force';
    outcome.stoppedWithinGrace = false;
    if (opts.tree) {
      await opts.tree.killTree(opts.processId);
    }
    logger.warn('aios.lifecycle.force_shutdown', { processId: opts.processId });
  }
  opts.onEscalation?.(outcome);
  return outcome;
}

/** Parent/child failure propagation: terminate `childIds` (force) when the parent process failed. */
export async function propagateFailure(opts: {
  parentId: string;
  childIds: string[];
  tree: ProcessTree;
  reason: string;
}): Promise<void> {
  logger.warn('aios.lifecycle.propagate_failure', {
    parentId: opts.parentId,
    childIds: opts.childIds,
    reason: opts.reason,
  });
  for (const id of opts.childIds) {
    await opts.tree.killTree(id);
  }
}
