/**
 * CodeConClave — plugin circuit breaker + rate limiter + retry (Phase 10).
 * Per-connection: CLOSED → (repeated failures) → OPEN → (cooldown) →
 * HALF_OPEN → (trial success) → CLOSED / (trial failure) → OPEN.
 * Retries only apply to idempotent actions with exponential backoff.
 * All state is in-memory per process (deterministic, test-friendly).
 */
import { AppError } from '../../shared/errors.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Circuit {
  state: CircuitState;
  failures: number;
  openedAt: number;
  successSinceHalfOpen: number;
}

const FAILURE_THRESHOLD = 3;
const OPEN_COOLDOWN_MS = 30_000;

const circuits = new Map<string, Circuit>();

function circuitFor(connectionId: string): Circuit {
  let c = circuits.get(connectionId);
  if (!c) {
    c = { state: 'CLOSED', failures: 0, openedAt: 0, successSinceHalfOpen: 0 };
    circuits.set(connectionId, c);
  }
  return c;
}

export function circuitState(connectionId: string): CircuitState {
  const c = circuitFor(connectionId);
  if (c.state === 'OPEN' && Date.now() - c.openedAt >= OPEN_COOLDOWN_MS) {
    c.state = 'HALF_OPEN';
    c.successSinceHalfOpen = 0;
  }
  return c.state;
}

/** Called before every provider call. Throws when the circuit is OPEN. */
export function checkCircuit(connectionId: string): void {
  const state = circuitState(connectionId);
  if (state === 'OPEN') {
    throw AppError.unavailable('plugin_circuit_open', 'Plugin circuit is open; provider calls are paused');
  }
}

export function recordCircuitSuccess(connectionId: string): void {
  const c = circuitFor(connectionId);
  if (c.state === 'HALF_OPEN') {
    c.successSinceHalfOpen += 1;
    if (c.successSinceHalfOpen >= 1) {
      c.state = 'CLOSED';
      c.failures = 0;
    }
    return;
  }
  c.state = 'CLOSED';
  c.failures = 0;
}

export function recordCircuitFailure(connectionId: string): void {
  const c = circuitFor(connectionId);
  if (c.state === 'HALF_OPEN') {
    c.state = 'OPEN';
    c.openedAt = Date.now();
    c.failures = 0;
    return;
  }
  c.failures += 1;
  if (c.failures >= FAILURE_THRESHOLD) {
    c.state = 'OPEN';
    c.openedAt = Date.now();
    c.failures = 0;
  }
}

export function resetCircuits(): void {
  circuits.clear();
}

// ---------------------------------------------------------------- rate limit

/** Actions per connection per window (sliding). */
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateBuckets = new Map<string, number[]>();

export function checkRateLimit(connectionId: string): void {
  const now = Date.now();
  const hits = (rateBuckets.get(connectionId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(connectionId, hits);
    throw AppError.tooMany('plugin_rate_limited', 'Plugin action rate limit exceeded');
  }
  hits.push(now);
  rateBuckets.set(connectionId, hits);
}

export function resetRateLimiters(): void {
  rateBuckets.clear();
}

// ---------------------------------------------------------------- retry + backoff

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
  idempotent: boolean;
}

export class ProviderTimeoutError extends Error {
  constructor(message = 'Plugin provider call timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const attempts = opts.idempotent ? Math.max(1, opts.attempts) : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const result = await Promise.race([
        fn(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new ProviderTimeoutError()));
        }),
      ]);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError instanceof AppError) throw lastError;
  if (lastError instanceof ProviderTimeoutError) throw lastError;
  throw lastError instanceof Error
    ? new Error(`Plugin provider call failed: ${lastError.message}`)
    : new Error('Plugin provider call failed');
}