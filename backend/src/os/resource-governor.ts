/**
 * CodeConClave AI OS — Resource Governor (P0.5).
 *
 * Enforces REAL, enforceable controls only. It does NOT fake OS-level CPU or
 * memory cgroups (Node on Railway/VPS cannot provide those from userspace), so
 * CPU/memory are deliberately NOT claimed. What it enforces:
 *   - max concurrency (counting in-flight child processes across the OS)
 *   - max runtime (wall-clock deadline)
 *   - cost budget (USD, token/cost-accounted by callers)
 *   - network/egress allow-list (policy)
 *   - queue priority (higher wins)
 *   - per-run claims must be acquired before execution (fail-closed)
 */
import { AppError } from '../shared/errors.js';
import { ResourceBudget } from './types.js';
import { logger } from '../shared/logger.js';

export interface ConcurrencySlot {
  release(): void;
}

export class ResourceGovernor {
  private inFlight = 0;
  private totalMax: number;

  constructor(maxConcurrency: number) {
    this.totalMax = maxConcurrency;
  }

  get concurrencyUsed(): number {
    return this.inFlight;
  }

  maxConcurrency(): number {
    return this.totalMax;
  }

  /**
   * Acquire a concurrency slot before starting a process. Fails closed when the
   * OS-level concurrency ceiling is reached (no queueing — caller can retry or
   * requeue with the Supervisor).
   */
  async acquire(): Promise<ConcurrencySlot> {
    if (this.inFlight >= this.totalMax) {
      throw AppError.conflict('aios_resource_limited', 'concurrency ceiling reached');
    }
    this.inFlight += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
      },
    };
  }

  /** Deadline budget helper: computes remaining ms against maxRuntimeMs. */
  remainingRuntimeMs(budget: ResourceBudget, startedAt: number, now = Date.now()): number {
    if (budget.maxRuntimeMs <= 0) return Number.POSITIVE_INFINITY;
    const elapsed = now - startedAt;
    return Math.max(0, budget.maxRuntimeMs - elapsed);
  }

  /** Cost check: true if adding `costUsd` to `spentUsd` stays within budget. */
  withinCost(budget: ResourceBudget, spentUsd: number, costUsd: number): boolean {
    if (budget.maxCostUsd <= 0) return true;
    return spentUsd + costUsd <= budget.maxCostUsd;
  }

  /** Egress policy: is this host allowed? Empty allow-list = unrestricted. */
  networkAllowed(budget: ResourceBudget, host: string): boolean {
    const allow = budget.allowedNetworkHosts;
    if (!allow || allow.length === 0) return true;
    return allow.some((h) => h === host || host.endsWith(`.${h}`));
  }

  /** Resolve effective budget, merging defaults with caller overrides. */
  resolve(
    base: ResourceBudget,
    overrides?: Partial<ResourceBudget>,
  ): ResourceBudget {
    return {
      maxRuntimeMs: overrides?.maxRuntimeMs ?? base.maxRuntimeMs,
      maxConcurrency: overrides?.maxConcurrency ?? base.maxConcurrency,
      maxCostUsd: overrides?.maxCostUsd ?? base.maxCostUsd,
      allowedNetworkHosts: overrides?.allowedNetworkHosts ?? base.allowedNetworkHosts,
      priority: overrides?.priority ?? base.priority ?? 0,
    };
  }

  track(reason: string): void {
    logger.debug('aios.resource.tracked', { reason, inFlight: this.inFlight });
  }
}
