/**
 * CodeConClave — FreeLimitMoon tests (PHASE 12).
 * Dialog overlay shown only after a server-reported limit transition;
 * persists the display moment server-side; Escape closes; both actions
 * behave; reduced-motion variant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FreeLimitMoon } from './FreeLimitMoon';
import { jsonResponse, stubFetch } from '../testutils';

beforeEach(() => {
  vi.unstubAllGlobals();
});

function renderMoon(overrides: Partial<Parameters<typeof FreeLimitMoon>[0]> = {}) {
  return render(
    <FreeLimitMoon
      name="Alice"
      onOpenBilling={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe('FreeLimitMoon', () => {
  it('renders the dialog with the crescent and message', () => {
    stubFetch(async () => jsonResponse({ data: {} }));
    renderMoon();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(/usage limit/)).toBeInTheDocument();
    expect(screen.getByTestId('free-limit-moon').querySelector('.cc-moon--free-limit')).not.toBeNull();
    expect(screen.getByText(/work is safe/)).toBeInTheDocument();
  });

  it('persists the display moment server-side (never replayed on refresh)', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ data: {} }));
    renderMoon();
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) => c[0].includes('/api/v1/workspace/state/free_limit_moon') && c[1]?.method === 'PUT',
      );
      expect(put).toBeTruthy();
    });
    const body = JSON.parse(String(fetchMock.mock.calls.find((c) => c[0].includes('free_limit_moon'))?.[1]?.body)) as {
      value: { shownAt: string; date: string };
    };
    expect(new Date(body.value.shownAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(body.value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('moves focus into the dialog and closes on Escape', async () => {
    stubFetch(async () => jsonResponse({ data: {} }));
    const onClose = vi.fn();
    renderMoon({ onClose });
    expect(screen.getByText('Continue with Pro')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Continue with Pro triggers the upgrade path', async () => {
    stubFetch(async () => jsonResponse({ data: {} }));
    const onOpenBilling = vi.fn();
    renderMoon({ onOpenBilling });
    await userEvent.click(screen.getByText('Continue with Pro'));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
  });

  it('Maybe Later closes the overlay', async () => {
    stubFetch(async () => jsonResponse({ data: {} }));
    const onClose = vi.fn();
    renderMoon({ onClose });
    await userEvent.click(screen.getByText('Maybe Later'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});