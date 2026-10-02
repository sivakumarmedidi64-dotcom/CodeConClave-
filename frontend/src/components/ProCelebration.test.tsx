/**
 * CodeConClave — ProCelebration behavior tests.
 * The celebration is client-only and observational: it must appear once after
 * the server confirms PRO_VERIFIED (fresh activation), never for free or
 * long-standing Pro accounts, and stay dismissed for the same activation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../auth/AuthProvider';
import { ProCelebration } from './ProCelebration';
import { TEST_USER, jsonResponse, stubFetch } from '../testutils';

function fetchHandler(entitlementState: string, activatedAt: string | null) {
  return async (url: string) => {
    if (url.includes('/api/v1/auth/me')) {
      return jsonResponse({ data: { user: { ...TEST_USER, entitlementState } } });
    }
    if (url.includes('/api/v1/payments/status')) {
      return jsonResponse({
        data: {
          effectivePlan: entitlementState === 'PRO_VERIFIED' ? 'pro' : 'free',
          accountEmail: null,
          plans: [
            {
              planId: 'pro',
              intentStatus: entitlementState === 'PRO_VERIFIED' ? 'ACTIVE' : null,
              confidence: entitlementState === 'PRO_VERIFIED' ? 1 : null,
              entitlementState,
              activatedAt,
            },
          ],
        },
      });
    }
    return jsonResponse({ data: {} });
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProCelebration', () => {
  it('appears once after a fresh Pro activation and hides on dismiss', async () => {
    stubFetch(fetchHandler('PRO_VERIFIED', new Date().toISOString()));
    render(
      <AuthProvider>
        <ProCelebration />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    screen.getByRole('button', { name: 'Dismiss' }).click();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('does not appear for free accounts', async () => {
    stubFetch(fetchHandler('FREE', null));
    render(
      <AuthProvider>
        <ProCelebration />
      </AuthProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not appear for a long-standing Pro account', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    stubFetch(fetchHandler('PRO_VERIFIED', old));
    render(
      <AuthProvider>
        <ProCelebration />
      </AuthProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});