/**
 * CodeConClave — ConnectivityIndicator tests (Phase 16).
 * Live state derives from navigator.onLine and the real offline queue:
 * Offline when the browser says so; Reconnecting while queued work is still
 * pending; Online otherwise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ConnectivityIndicator } from './ConnectivityIndicator';
import { enqueueOfflineOp, resolveOfflineConflict } from '../lib/offline';

function setOnLine(onLine: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });
}

beforeEach(() => setOnLine(true));
afterEach(() => setOnLine(true));

describe('ConnectivityIndicator', () => {
  it('shows Online when the browser is online and nothing is queued', () => {
    render(<ConnectivityIndicator />);
    expect(screen.getByTestId('connectivity')).toHaveTextContent('Online');
  });

  it('shows Offline when the browser reports offline', () => {
    setOnLine(false);
    render(<ConnectivityIndicator />);
    expect(screen.getByTestId('connectivity')).toHaveTextContent('Offline');
  });

  it('shows Reconnecting while queued work is pending after a reconnect', () => {
    enqueueOfflineOp('approval.decide', { approvalId: 'a1', decision: 'APPROVE', reason: null });
    setOnLine(false);
    render(<ConnectivityIndicator />);
    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByTestId('connectivity')).toHaveTextContent('Reconnecting');

    act(() => {
      resolveOfflineConflict('nope', 'discard'); // no-op; queue still has the op
    });
    expect(screen.getByTestId('connectivity')).toHaveTextContent('Reconnecting');

    const stored = JSON.parse(localStorage.getItem('codeconclave_offline_queue') ?? '[]') as { localId: string }[];
    expect(stored).toHaveLength(1);
    act(() => {
      resolveOfflineConflict(stored[0]!.localId, 'discard');
    });
    expect(screen.getByTestId('connectivity')).toHaveTextContent('Online');
  });
});