/**
 * CodeConClave — watchdog.
 * Runs periodic sweeps: task heartbeat recovery, timeout failure, approval
 * expiry, waiting-approval timeout, plugin health, outbox flush. Every sweep is
 * idempotent and audited. Runs in-process (with server) or standalone.
 * Error records are sanitized to message-only — never raw error objects that
 * could carry secrets. The last successful sweep timestamp feeds /health.
 */
import { logger } from '../shared/logger.js';
import { recoverStaleTasks, failTimedOutTasks, expireWaitingApprovals } from '../shared/queue.js';
import { expireStaleApprovals } from '../modules/execution/approvals.js';
import { recoverTimedOutTasks, blockBlockedDependencies } from '../modules/execution/tasks.js';
import { flushOutbox } from '../modules/outbox/service.js';
import { sweepPluginHealth } from '../modules/plugins/health.js';
import { sweepAgentRuns } from '../modules/agents/service.js';
import { sweepPaymentExpiry, sweepPendingIntentEvidence } from '../modules/payments/service.js';
import { sweepIntentExpiry } from '../modules/payments/intents.js';
import { sweepAutoApprovals } from '../modules/payments/autoapproval/service.js';
import { reconcilePaymentSweep } from '../modules/payments/reconcile/service.js';
import { expireStaleReservations } from '../modules/payments/pool/service.js';
import { purgeExpiredTrash } from '../modules/files/service.js';
import { expireInvitations } from '../modules/teams/service.js';
import { expireIdempotencyKeys } from '../modules/idempotency/service.js';
import { sweepScheduledRuns } from '../modules/scheduling/executor.js';
import { sweepAutomations } from '../modules/automations/executor.js';
import { sweepAutopsies } from '../modules/recovery/autopsy.js';
import { expireDurableCounters } from '../shared/durable-counters.js';
import { expireChallengeUses } from '../shared/durable-challenges.js';
import { expireStaleApiKeyConcurrency } from '../shared/durable-concurrency.js';
import { expirePaymentTokens } from '../shared/durable-payment-tokens.js';
import { incMetric } from '../observability/metrics.js';

const SWEEP_MS = 15_000;
const HEARTBEAT_TTL_MS = 30_000;

let lastRunAt: number | null = null;

/** Sanitized error text: message only (never stack traces or raw objects). */
export function errInfo(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Milliseconds since the last completed watchdog sweep, or null if never run. */
export function lastWatchdogRunAt(): number | null {
  return lastRunAt;
}

async function sweep(name: string, out: Record<string, number>, fn: () => Promise<number | Record<string, number>>): Promise<void> {
  try {
    const result = await fn();
    if (typeof result === 'number') out[name] = result;
    else Object.assign(out, result);
  } catch (err) {
    incMetric(`watchdog.${name}_failed`);
    logger.error(`watchdog ${name} sweep failed`, { error: errInfo(err) });
  }
}

export async function sweepOnce(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // NOTE: there is deliberately NO blanket heartbeat-refresh sweep here.
  // Refreshing every RUNNING heartbeat from the sweeper made recoverStaleTasks
  // dead code (nothing could ever go stale) and kept crashed workers' tasks
  // RUNNING forever. Liveness comes only from the worker itself via touchTask
  // during execution; the sweeper only reclaims tasks whose heartbeat aged out.
  await sweep('recovered', out, () => recoverStaleTasks(HEARTBEAT_TTL_MS));
  await sweep('timedOut', out, () => failTimedOutTasks());
  await sweep('retried', out, () => recoverTimedOutTasks());
  await sweep('blockedDependencies', out, () => blockBlockedDependencies());
  await sweep('approvals', out, async () => ({
    approvalsExpired: await expireStaleApprovals(),
    waitingApprovalsExpired: await expireWaitingApprovals(),
  }));
  await sweep('outbox', out, () => flushOutbox());
  await sweep('plugins', out, () => sweepPluginHealth());
  await sweep('agentRuns', out, () => sweepAgentRuns());
  await sweep('payments', out, () => sweepPaymentExpiry());
  await sweep('paymentIntents', out, () => sweepIntentExpiry());
  await sweep('poolReservations', out, () => expireStaleReservations());
  await sweep('mailboxReceipts', out, () => sweepPendingIntentEvidence());
  await sweep('autoApprovals', out, () => sweepAutoApprovals({ limit: 100 }));
  await sweep('reconcile', out, () => reconcilePaymentSweep());
  await sweep('trash', out, () => purgeExpiredTrash());
  await sweep('invitationsExpired', out, () => expireInvitations());
  await sweep('idempotencyExpired', out, () => expireIdempotencyKeys());
  await sweep('scheduledRuns', out, () => sweepScheduledRuns());
  await sweep('automations', out, () => sweepAutomations());
  await sweep('autopsies', out, () => sweepAutopsies());
  // Deterministic TTL cleanup for the durable state that replaces the Redis
  // store. Every one of these predicates is indexed on expires_at, bounded, and
  // idempotent, so running them from several instances concurrently is safe and
  // cleanup never depends on Render local disk.
  await sweep('durableCounters', out, async () => {
    const counters = await expireDurableCounters();
    return {
      durableCountersExpired: counters.counters,
      durableLastSeenExpired: counters.lastSeen,
    };
  });
  await sweep('durableChallenges', out, () => expireChallengeUses());
  await sweep('apiKeyConcurrency', out, () => expireStaleApiKeyConcurrency());
  await sweep('paymentTokens', out, async () => {
    const tokens = await expirePaymentTokens();
    return {
      demoActivationsExpired: tokens.demo,
      selfServiceTokensExpired: tokens.selfService,
    };
  });
  lastRunAt = Date.now();
  const totals = Object.values(out).reduce((a, b) => a + b, 0);
  if (totals > 0) logger.info('watchdog sweep', { out });
  return out;
}

export function startWatchdog(): () => void {
  logger.info('watchdog started', { sweepMs: SWEEP_MS });
  const timer = setInterval(() => void sweepOnce(), SWEEP_MS);
  void sweepOnce();
  return () => {
    clearInterval(timer);
    logger.info('watchdog stopped');
  };
}