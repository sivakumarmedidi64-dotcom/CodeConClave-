/**
 * CodeConClave AI OS — P2.18 Scheduling.
 *
 * REUSES the existing recurrence engine (modules/scheduling/recurrence's
 * `nextRunAt` / `ScheduleAnchor`) — no duplicate schedule model. Scheduled jobs
 * run through the P1 DAG executor + supervisor and, critically, re-apply the
 * CURRENT workspace stop rules at execution time, so a job scheduled when
 * limits differed cannot bypass today's policy. Deadlines and max-files budgets
 * are shared (cross-agent accounting) with any other work in the same
 * workspace.
 */
import { AppError } from '../../shared/errors.js';
import { nextRunAt, ScheduleAnchor } from '../../modules/scheduling/recurrence.js';
import type { P2Feature } from './flags.js';

export interface ScheduledJob {
  id: string;
  name: string;
  anchor: ScheduleAnchor;
  workspaceId: string | null;
  payload: Record<string, unknown>;
  nextRun: Date | null;
  lastRun: Date | null;
  lastExit: 'ok' | 'failed' | 'blocked' | null;
}

export class Scheduler {
  private jobs = new Map<string, ScheduledJob>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private feature: () => P2Feature | null) {}

  isEnabled(): boolean {
    return this.feature() === 'scheduler';
  }

  /** Register a scheduled job. Reuses the existing recurrence anchor (no duplicate model). */
  schedule(input: { name: string; anchor: ScheduleAnchor; workspaceId?: string | null; payload?: Record<string, unknown> }): ScheduledJob {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_scheduler_disabled', 'scheduling feature is off');
    const job: ScheduledJob = {
      id: `job_${Math.random().toString(36).slice(2, 10)}`,
      name: input.name,
      anchor: input.anchor,
      workspaceId: input.workspaceId ?? null,
      payload: input.payload ?? {},
      nextRun: nextRunAt(input.anchor, new Date()),
      lastRun: null,
      lastExit: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  cancel(id: string): void {
    this.jobs.delete(id);
  }

  jobsDue(at: Date): ScheduledJob[] {
    return [...this.jobs.values()].filter((j) => j.nextRun != null && j.nextRun <= at);
  }

  /**
   * Due = run now. Each run goes through the DAG executor + the provided
   * `gate` (current capability + stop rules). If the gate denies, the job is
   * recorded as BLOCKED and does not execute — it cannot bypass today's rules.
   */
  async runDue(
    at: Date,
    opts: {
      gate: (job: ScheduledJob) => Promise<{ allowed: boolean }>;
      run: (job: ScheduledJob) => Promise<{ ok: boolean }>;
    },
  ): Promise<Array<{ id: string; exit: 'ok' | 'failed' | 'blocked' }>> {
    if (!this.isEnabled()) throw AppError.conflict('aios_p2_scheduler_disabled', 'scheduling feature is off');
    const due = this.jobsDue(at);
    const out: Array<{ id: string; exit: 'ok' | 'failed' | 'blocked' }> = [];
    for (const job of due) {
      const gate = await opts.gate(job);
      if (!gate.allowed) {
        job.lastExit = 'blocked';
        out.push({ id: job.id, exit: 'blocked' });
      } else {
        const res = await opts.run(job);
        job.lastExit = res.ok ? 'ok' : 'failed';
        out.push({ id: job.id, exit: job.lastExit });
      }
      job.lastRun = at;
      job.nextRun = nextRunAt(job.anchor, at);
    }
    return out;
  }

  /** Poll-based background loop (bounded). Caller provides the gate + run. */
  async startLoop(opts: { intervalMs?: number; gate: (job: ScheduledJob) => Promise<{ allowed: boolean }>; run: (job: ScheduledJob) => Promise<{ ok: boolean }> }): Promise<void> {
    if (this.running) return;
    this.running = true;
    const interval = opts.intervalMs ?? 15_000;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runDue(new Date(), { gate: opts.gate, run: opts.run });
      } catch {
        /* loop is resilient; next tick continues */
      }
      this.timer = setTimeout(tick, interval);
      if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
        (this.timer as unknown as { unref: () => void }).unref();
      }
    };
    void tick();
  }

  stopLoop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  list(): ScheduledJob[] {
    return [...this.jobs.values()];
  }
}
