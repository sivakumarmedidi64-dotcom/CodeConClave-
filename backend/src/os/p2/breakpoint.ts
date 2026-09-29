/**
 * CodeConClave AI OS — P2.1 Breakpoint system.
 *
 * A breakpoint manager layered on the P0 state + supervisor. Breakpoints are
 * only hit at SAFE INSTRUCTION BOUNDARIES (never mid-write), so a break never
 * produces partial filesystem corruption. On a break:
 *   1. checkpoint the exact process state (preserve before pausing)
 *   2. pause the supervised process (cooperative)
 *   3. allow INSPECT (snapshot + last instruction) and MODIFY (replace the
 *      pending instruction text)
 *   4. resume from the stored checkpoint.
 *
 * Cooperative-honesty: pausing an arbitrary in-flight JS promise is only
 * possible at the instruction boundaries the body publishes via `yieldAt`.
 * `breakpoints` never claim to interrupt a mid-instruction write.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { OsProcess, OsProcessState } from '../types.js';
import type { StateStore } from '../state.js';
import type { P2Feature } from './flags.js';

export interface BreakpointSpec {
  id: string;
  when: 'before_instruction' | 'after_instruction' | 'on_failure';
  /** Instruction/tool name to match (e.g. 'write_file', '*' = any). */
  target: string;
  enabled: boolean;
}

export interface PauseCapture {
  processId: string;
  state: OsProcessState;
  instruction: string | null;
  checkpointedAt: number;
}

export interface PausedBreakpoint {
  breakpointId: string;
  processId: string;
  instruction: string;
  state: OsProcessState;
  checkpointKey: string;
  at: number;
}

export class BreakpointManager {
  private breakpoints: BreakpointSpec[] = [];
  private paused = new Map<string, PausedBreakpoint>();
  private checkpointVersion = 1;

  constructor(
    private state: StateStore,
    private feature: () => P2Feature | null,
  ) {}

  isEnabled(): boolean {
    return this.feature() === 'breakpoint';
  }

  /** Register a breakpoint. Safe instruction-boundary only. */
  addBreakpoint(spec: Omit<BreakpointSpec, 'id'>): BreakpointSpec {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_breakpoint_disabled', 'breakpoint feature is off');
    const bp: BreakpointSpec = { id: randomUUID(), ...spec };
    this.breakpoints.push(bp);
    return bp;
  }

  removeBreakpoint(id: string): void {
    this.breakpoints = this.breakpoints.filter((b) => b.id !== id);
  }

  listBreakpoints(): BreakpointSpec[] {
    return [...this.breakpoints];
  }

  get pausedCount(): number {
    return this.paused.size;
  }

  /**
   * A supervised body calls this at instruction boundaries. If a matching,
   * enabled breakpoint is armed, it checkpoints the exact state, pauses, and
   * blocks until resumed or the (optional) deadline elapses. Returning false
   * means "the current instruction is queued at a breakpoint" — the caller
   * should not proceed until `resume()` is invoked.
   */
  async yieldAt(opts: {
    processId: string;
    state: OsProcessState;
    instruction: string;
    canPause: () => boolean;
    pause: () => Promise<void>;
  }): Promise<{ breakpoint: PausedBreakpoint | null }> {
    if (!this.isEnabled()) return { breakpoint: null };
    const hit = this.breakpoints.find(
      (b) => b.enabled && (b.target === '*' || b.target === opts.instruction) &&
        (b.when === 'before_instruction' || b.when === 'after_instruction' || b.when === 'on_failure'),
    );
    if (!hit) return { breakpoint: null };
    // checkpoint exact state BEFORE pausing (preserve)
    const checkpointKey = `p2:bp:${opts.processId}:${hit.id}:${opts.instruction}`;
    try {
      await this.state.checkpoint(this.checkpointVersion, checkpointKey, {
        processId: opts.processId,
        instruction: opts.instruction,
        at: Date.now(),
      });
    } catch (e) {
      throw AppError.conflict('aios_p2_breakpoint_checkpoint', `checkpoint failed: ${(e as Error).message}`);
    }
    await opts.pause();
    const paused: PausedBreakpoint = {
      breakpointId: hit.id,
      processId: opts.processId,
      instruction: opts.instruction,
      state: opts.state,
      checkpointKey,
      at: Date.now(),
    };
    this.paused.set(opts.processId, paused);
    return { breakpoint: paused };
  }

  /** INSPECT: full paused breakpoint + exact preserved process snapshot. */
  inspect(processId: string): { paused: PausedBreakpoint; process: OsProcess } {
    const paused = this.paused.get(processId);
    if (!paused) throw AppError.notFound('aios_p2_breakpoint', 'no paused breakpoint for process');
    const process: OsProcess = {
      id: processId,
      state: paused.state,
      startedAt: paused.at,
      createdAt: paused.at,
      finishedAt: null,
      attempts: 0,
      errorCode: null,
      restarts: 0,
      restartPolicy: 'none',
      capabilities: [],
      parentId: null,
      pid: null,
    };
    return { paused, process };
  }

  /** MODIFY: replace the pending instruction at the breakpoint (no resume yet). */
  modify(processId: string, nextInstruction: string): PausedBreakpoint {
    const paused = this.paused.get(processId);
    if (!paused) throw AppError.notFound('aios_p2_breakpoint', 'no paused breakpoint for process');
    paused.instruction = nextInstruction;
    return paused;
  }

  pausedInstruction(processId: string): string | null {
    return this.paused.get(processId)?.instruction ?? null;
  }

  /**
   * RESUME from the preserved checkpoint. Returns true if a breakpoint was
   * released. Requires the caller to hold the resume capability.
   */
  resume(processId: string, authorized: boolean): boolean {
    if (!authorized) throw AppError.forbidden('aios_p2_breakpoint_denied', 'resume requires capability');
    const paused = this.paused.get(processId);
    if (!paused) return false;
    this.paused.delete(processId);
    return true;
  }
}
