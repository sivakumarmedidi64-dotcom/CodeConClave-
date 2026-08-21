/**
 * CodeConClave — offline queue (Phase 16).
 * User actions taken while offline are queued locally (localStorage) with a
 * per-op idempotency key. On reconnect the queue flushes through the server's
 * Idempotency-Key support: the first attempt executes, identical retries
 * replay the stored response — nothing runs twice. Conflicts (server 409) are
 * surfaced with the server's message; the user decides — work is NEVER
 * silently discarded and success is NEVER reported for a failed sync.
 *
 * Ops supported today (each maps to a server route with idempotency):
 *   approval.decide      → POST /api/v1/execution/approvals/:id/decide
 *   notifications.markRead → POST /api/v1/notifications/read
 */
import { api, ApiError } from './api';

export type OfflineOpStatus = 'PENDING' | 'SYNCED' | 'FAILED' | 'CONFLICT';

export interface OfflineOp {
  localId: string;
  idempotencyKey: string;
  op: 'approval.decide' | 'notifications.markRead';
  payload: Record<string, unknown>;
  createdAt: number;
  retryCount: number;
  status: OfflineOpStatus;
  /** Set on conflict: the server's authoritative rejection. */
  serverError: { code: string; message: string } | null;
  /** Backoff: skip flush attempts until this wall-clock time. */
  nextAttemptAt: number;
}

const STORAGE_KEY = 'codeconclave_offline_queue';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2_000;

const listeners = new Set<(ops: OfflineOp[]) => void>();

export function subscribeOffline(listener: (ops: OfflineOp[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  const ops = listOfflineOps();
  for (const fn of listeners) fn(ops);
}

export function listOfflineOps(): OfflineOp[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OfflineOp[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(ops: OfflineOp[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
  } catch {
    /* storage unavailable — the queue is best-effort, never fatal */
  }
  emit();
}

function newIdempotencyKey(op: string): string {
  return `${op}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Queue an op (deduped by op+payload while a twin is still PENDING). */
export function enqueueOfflineOp(op: OfflineOp['op'], payload: Record<string, unknown>): OfflineOp | null {
  const ops = listOfflineOps();
  const twin = ops.find(
    (o) => o.op === op && JSON.stringify(o.payload) === JSON.stringify(payload) && o.status === 'PENDING',
  );
  if (twin) return twin;
  const entry: OfflineOp = {
    localId: `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    idempotencyKey: newIdempotencyKey(op),
    op,
    payload,
    createdAt: Date.now(),
    retryCount: 0,
    status: 'PENDING',
    serverError: null,
    nextAttemptAt: 0,
  };
  save([...ops, entry]);
  return entry;
}

export function pendingOfflineCount(): number {
  return listOfflineOps().filter((o) => o.status !== 'SYNCED').length;
}

function opRequest(entry: OfflineOp): { path: string; body: Record<string, unknown> } {
  if (entry.op === 'approval.decide') {
    return {
      path: `/api/v1/execution/approvals/${String(entry.payload.approvalId ?? '')}/decide`,
      body: { decision: entry.payload.decision, reason: entry.payload.reason ?? null },
    };
  }
  return { path: '/api/v1/notifications/read', body: {} };
}

/** Sync one op; returns the outcome. Never lies: errors stay visible. */
async function syncOp(entry: OfflineOp): Promise<{ status: OfflineOpStatus; message: string | null; code: string | null }> {
  const { path, body } = opRequest(entry);
  try {
    await api(path, { method: 'POST', body, idempotencyKey: entry.idempotencyKey });
    return { status: 'SYNCED', message: null, code: null };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      return { status: 'CONFLICT', message: err.message, code: err.code };
    }
    throw err; // server unavailable / transient - retry later, never lie
  }
}

/**
 * Flush the queue. Returns ops still needing attention (failed/conflicted),
 * or [] when everything synced. Any op that cannot sync stays visible.
 */
export async function flushOfflineQueue(): Promise<OfflineOp[]> {
  const ops = listOfflineOps();
  const due = ops.filter((o) => o.status === 'PENDING' && o.nextAttemptAt <= Date.now());
  if (due.length === 0) return ops.filter((o) => o.status !== 'SYNCED');
  const remaining: OfflineOp[] = [];
  for (const op of ops) {
    if (op.status !== 'PENDING' || op.nextAttemptAt > Date.now()) {
      if (op.status !== 'SYNCED') remaining.push(op);
      continue;
    }
    let outcome: { status: OfflineOpStatus; message: string | null; code: string | null };
    try {
      outcome = await syncOp(op);
    } catch {
      outcome = { status: 'FAILED', message: null, code: null }; // transient (network/server) - keep PENDING, never lie
    }
    if (outcome.status === 'SYNCED') continue; // done, drop from the queue
    const conflicted = outcome.status === 'CONFLICT';
    const next: OfflineOp = {
      ...op,
      status: conflicted ? 'CONFLICT' : 'FAILED',
      retryCount: op.retryCount + 1,
      serverError: {
        code: conflicted ? (outcome.code ?? 'conflict') : 'sync_failed',
        message: conflicted
          ? outcome.message ?? 'The server rejected this change — it was already applied or is outdated.'
          : 'Sync failed — will retry automatically.',
      },
      nextAttemptAt: Date.now() + RETRY_BASE_MS * 2 ** Math.min(op.retryCount, 4),
    };
    if (!conflicted && next.retryCount >= MAX_RETRIES) {
      next.status = 'FAILED';
    } else if (!conflicted) {
      next.status = 'PENDING'; // transient failure — keep retrying with backoff
    }
    remaining.push(next);
  }
  save(remaining);
  return remaining.filter((o) => o.status !== 'SYNCED');
}

/** User retry: reset the backoff and flush again immediately. */
export async function retryOfflineOp(localId: string): Promise<void> {
  const ops = listOfflineOps().map((o) =>
    o.localId === localId ? { ...o, status: 'PENDING' as const, retryCount: 0, nextAttemptAt: 0 } : o,
  );
  save(ops);
  await flushOfflineQueue();
}

/**
 * Conflict resolution — the server is authoritative. discard removes the op
 * (the user accepted the server state); keepLocal marks it PENDING so the user
 * can inspect and attempt again with full visibility of the server's answer.
 */
export function resolveOfflineConflict(localId: string, choice: 'discard' | 'keepLocal'): void {
  const ops = listOfflineOps();
  if (choice === 'discard') {
    save(ops.filter((o) => o.localId !== localId));
    return;
  }
  save(
    ops.map((o) =>
      o.localId === localId ? { ...o, status: 'PENDING' as const, retryCount: 0, nextAttemptAt: 0, serverError: null } : o,
    ),
  );
}

// ---------------------------------------------------------------- connectivity

export function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

let offlineSince: number | null = null;
let lastReconnectMsValue: number | null = null;

/** Milliseconds the last offline period lasted (measured, for the report). */
export function lastReconnectMs(): number | null {
  return lastReconnectMsValue;
}

export function initOfflineSync(): () => void {
  const onOffline = () => {
    offlineSince = Date.now();
  };
  const onOnline = () => {
    if (offlineSince !== null) {
      lastReconnectMsValue = Date.now() - offlineSince;
      offlineSince = null;
    }
    void flushOfflineQueue();
  };
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  return () => {
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
  };
}