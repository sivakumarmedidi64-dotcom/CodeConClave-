/**
 * CodeConClave — OfflineBanner tests (Phase 16).
 * Queued changes are visible offline; transient failures never report success;
 * server conflicts are surfaced with the server's message and the user
 * chooses (discard / try again) — work is never silently dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OfflineBanner } from './OfflineBanner';
import { enqueueOfflineOp, listOfflineOps } from '../lib/offline';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
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

function setOnLine(onLine: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({});
  setOnLine(true);
});

afterEach(() => setOnLine(true));

describe('OfflineBanner', () => {
  it('renders nothing when online with an empty queue', () => {
    const { container } = render(<OfflineBanner />);
    expect(container.querySelector('[data-testid="offline-banner"]')).toBeNull();
  });

  it('shows queued changes while offline and counts them', () => {
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    enqueueOfflineOp('notifications.markRead', {});
    setOnLine(false);
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Offline.');
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('2 queued changes');
  });

  it('clears the offline banner once the browser is back online', async () => {
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    setOnLine(false);
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Offline.');
    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(screen.queryByTestId('offline-banner')).toBeNull());
  });

  it('never reports success after a failed sync — the op stays visible', async () => {
    apiMock.mockRejectedValue(new Error('network down'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    await import('../lib/offline').then((m) => m.flushOfflineQueue());
    setOnLine(false);
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('queued');
    expect(screen.queryByText(/synced|Sync failed/)).toBeNull();
  });

  it('surfaces a server conflict with its message and discards on user choice', async () => {
    const { ApiError: MockApiError } = await import('../lib/api');
    apiMock.mockRejectedValueOnce(new MockApiError(409, 'conflict', 'already decided elsewhere'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    await import('../lib/offline').then((m) => m.flushOfflineQueue());
    render(<OfflineBanner />);
    expect(screen.getByTestId('conflict-line')).toHaveTextContent('already decided elsewhere');
    await userEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(listOfflineOps()).toEqual([]);
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('re-attempts a conflicted op via Try again (idempotent server call)', async () => {
    const { ApiError: MockApiError } = await import('../lib/api');
    apiMock.mockRejectedValueOnce(new MockApiError(409, 'conflict', 'out of date'));
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    await import('../lib/offline').then((m) => m.flushOfflineQueue());
    render(<OfflineBanner />);
    expect(screen.getByTestId('conflict-line')).toHaveTextContent('out of date');
    apiMock.mockResolvedValue({});
    await userEvent.click(screen.getByRole('button', { name: 'Try Approval decision again' }));
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(listOfflineOps()).toEqual([]);
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});