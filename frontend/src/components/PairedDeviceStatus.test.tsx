import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../lib/api';
import { PairedDeviceStatus } from './PairedDeviceStatus';

vi.mock('../lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  apiMock.mockReset();
});

describe('PairedDeviceStatus', () => {
  it('shows live ONLINE presence and ignores revoked devices', async () => {
    apiMock.mockResolvedValue({ devices: [
      { id: 'd1', name: 'Laptop', state: 'PAIRED', presence: 'ONLINE' },
      { id: 'd2', name: 'Old laptop', state: 'REVOKED', presence: 'ONLINE' },
    ] });
    render(<PairedDeviceStatus description="Files remain on the paired device." />);

    await waitFor(() => expect(screen.getByTestId('paired-device-status')).toHaveAttribute('data-state', 'online'));
    expect(screen.getByTestId('paired-device-presence')).toHaveTextContent('1 of 1 paired device currently connected');
    expect(screen.getByText('Files remain on the paired device.')).toBeInTheDocument();
    expect(screen.getByTestId('paired-device-checked')).toBeInTheDocument();
  });

  it('reports stale and offline presence as degraded or unavailable', async () => {
    apiMock.mockResolvedValue({ devices: [{ id: 'd1', name: 'Laptop', state: 'PAIRED', presence: 'STALE' }] });
    render(<PairedDeviceStatus description="Local files are separate." />);
    await waitFor(() => expect(screen.getByTestId('paired-device-status')).toHaveAttribute('data-state', 'degraded'));
    expect(screen.getByTestId('paired-device-presence')).toHaveTextContent('stale heartbeat');

    apiMock.mockRejectedValueOnce(new Error('backend unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh paired-device status' }));
    await waitFor(() => expect(screen.getByTestId('paired-device-status')).toHaveAttribute('data-state', 'error'));
    expect(screen.getByTestId('paired-device-presence')).toHaveTextContent('could not be confirmed');
  });

  it('polls presence again without claiming a connection after a failed request', async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValueOnce({ devices: [] }).mockResolvedValueOnce({ devices: [
      { id: 'd1', name: 'Laptop', state: 'PAIRED', presence: 'ONLINE' },
    ] });
    render(<PairedDeviceStatus description="Status only." />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('paired-device-presence')).toHaveTextContent('NO PAIRED DEVICE');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('paired-device-presence')).toHaveTextContent('ONLINE');
  });
});
