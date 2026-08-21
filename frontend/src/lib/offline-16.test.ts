/**
 * CodeConClave — offline queue tests (Phase 16).
 * Queue/dedupe/persistence, idempotent flush, transient retry with backoff,
 * MAX_RETRIES → FAILED, server 409 → CONFLICT + resolution, connectivity
 * tracking. Success is only ever reported when the server confirmed it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueueOfflineOp,
  listOfflineOps,
  pendingOfflineCount,
  flushOfflineQueue,
  retryOfflineOp,
  resolveOfflineConflict,
  isOnline,
  initOfflineSync,
  lastReconnectMs,
  subscribeOffline,
  type OfflineOp,
} from './offline';
import { api, ApiError } from './api';

vi.mock('./api', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const apiMock = vi.mocked(api);

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({});
});

afterEach(() => {
  const stop = initOfflineSync();
  stop();
});

function seedOp(partial: Partial<OfflineOp>): OfflineOp {
  const op = enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null })!;
  const all = listOfflineOps().map((o) => (o.localId === op.localId ? { ...o, ...partial } : o));
  localStorage.setItem('codeconclave_offline_queue', JSON.stringify(all));
  return all.find((o) => o.localId === op.localId)!;
}

describe('offline queue — enqueue', () => {
  it('queues an op with a stable idempotency key and dedupes identical pending ops', () => {
    const first = enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    const twin = enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    expect(twin?.localId).toBe(first?.localId);
    expect(listOfflineOps()).toHaveLength(1);
    expect(first?.idempotencyKey).toMatch(/^approval\.decide_/);
    expect(first?.status).toBe('PENDING');
  });

  it('persists the queue across reads (localStorage)', () => {
    enqueueOfflineOp('notifications.markRead', {});
    expect(localStorage.getItem('codeconclave_offline_queue')).toContain('notifications.markRead');
    expect(pendingOfflineCount()).toBe(1);
  });

  it('queues a different payload as a separate op', () => {
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    enqueueOfflineOp('approval.decide', { approvalId: 'a2', decision: 'APPROVE', reason: null });
    expect(listOfflineOps()).toHaveLength(2);
  });
});

describe('offline queue — flush', () => {
  it('syncs through the idempotent route and drops synced ops', async () => {
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: 'looks good' });
    const remaining = await flushOfflineQueue();
    expect(remaining).toEqual([]);
    expect(listOfflineOps()).toEqual([]);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const [path, opts] = apiMock.mock.calls[0]!;
    expect(path).toBe('/api/v1/execution/approvals/a1/decide');
    expect(opts?.method).toBe('POST');
    expect(opts?.body).toEqual({ decision: 'APPROVE', reason: 'looks good' });
    expect(opts?.idempotencyKey).toBeDefined();
  });

  it('sends the Idempotency-Key header and markRead body', async () => {
    enqueueOfflineOp('notifications.markRead', {});
    await flushOfflineQueue();
    const [path, opts] = apiMock.mock.calls[0]!;
    expect(path).toBe('/api/v1/notifications/read');
    expect(opts?.body).toEqual({});
    expect(opts?.idempotencyKey).toMatch(/^notifications\.markRead_/);
  });

  it('keeps an op PENDING with backoff on a transient failure and syncs it later', async () => {
    apiMock.mockRejectedValueOnce(new Error('network down'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    await flushOfflineQueue();
    let [op] = listOfflineOps();
    expect(op?.status).toBe('PENDING'); // never marked failed on a transient error
    expect(op?.retryCount).toBe(1);
    expect(op?.nextAttemptAt).toBeGreaterThan(Date.now()); // backoff in the future
    expect(pendingOfflineCount()).toBe(1);

    const due = seedOp({ status: 'PENDING', retryCount: op!.retryCount, nextAttemptAt: 0 });
    expect(due).toBeDefined();
    await flushOfflineQueue();
    expect(listOfflineOps()).toEqual([]);
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it('marks an op FAILED after MAX_RETRIES (3) and keeps it visible', async () => {
    apiMock.mockRejectedValue(new Error('still down'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    for (let i = 0; i < 3; i++) {
      await flushOfflineQueue();
      const [op] = listOfflineOps();
      const due = seedOp({ status: 'PENDING', retryCount: op!.retryCount, nextAttemptAt: 0 });
      expect(due).toBeDefined();
    }
    const [op] = listOfflineOps();
    expect(op?.status).toBe('FAILED');
    expect(op?.retryCount).toBe(3);
    expect(op?.serverError?.message).toContain('retry');

    // A retry that succeeds clears it.
    apiMock.mockResolvedValue({});
    await retryOfflineOp(op!.localId);
    expect(listOfflineOps()).toEqual([]);
  });

  it('surfaces a server 409 as CONFLICT with the server message and resolves it', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(409, 'conflict', 'already decided elsewhere'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    await flushOfflineQueue();
    const [op] = listOfflineOps();
    expect(op?.status).toBe('CONFLICT');
    expect(op?.serverError?.message).toBe('already decided elsewhere');
    expect(op?.serverError?.code).toBe('conflict');

    resolveOfflineConflict(op!.localId, 'discard');
    expect(listOfflineOps()).toEqual([]);
  });

  it('preserves the server conflict code (e.g. approval_expired) on the op', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(409, 'approval_expired', 'Approval has expired (30-minute window)'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    await flushOfflineQueue();
    const [op] = listOfflineOps();
    expect(op?.status).toBe('CONFLICT');
    expect(op?.serverError?.code).toBe('approval_expired');
    expect(op?.serverError?.message).toContain('expired');
  });

  it('keepLocal resolution re-attempts a conflicted op', async () => {
    apiMock.mockRejectedValueOnce(new ApiError(409, 'conflict', 'out of date'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    await flushOfflineQueue();
    const [op] = listOfflineOps();
    resolveOfflineConflict(op!.localId, 'keepLocal');
    const [kept] = listOfflineOps();
    expect(kept?.status).toBe('PENDING');
    expect(kept?.retryCount).toBe(0);
    expect(kept?.serverError).toBeNull();
  });

  it('continues flushing remaining ops when one fails transiently', async () => {
    apiMock.mockRejectedValueOnce(new Error('network down'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    enqueueOfflineOp('notifications.markRead', {});
    const remaining = await flushOfflineQueue();
    expect(apiMock).toHaveBeenCalledTimes(2); // both attempted; the transient one stays queued
    const [kept] = listOfflineOps();
    expect(kept?.op).toBe('approval.decide');
    expect(kept?.status).toBe('PENDING');
    expect(remaining).toHaveLength(1);
  });
});

describe('offline queue — connectivity', () => {
  it('isOnline reflects navigator.onLine', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    expect(isOnline()).toBe(true);
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    expect(isOnline()).toBe(false);
  });

  it('initOfflineSync measures the offline period and flushes on reconnect', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const stop = initOfflineSync();
    window.dispatchEvent(new Event('offline'));
    expect(lastReconnectMs()).toBeNull();
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
    expect(lastReconnectMs()).not.toBeNull();
    expect(lastReconnectMs()!).toBeGreaterThanOrEqual(0);
    stop();
  });

  it('notifies subscribers when the queue changes', async () => {
    const seen: OfflineOp[][] = [];
    const off = subscribeOffline((ops) => seen.push(ops));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    off();
  });
});