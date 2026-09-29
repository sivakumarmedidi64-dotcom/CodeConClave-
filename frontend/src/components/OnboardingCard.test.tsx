/**
 * CodeConClave — OnboardingCard tests.
 * The minimal onboarding requirement (display name, role, primary use case)
 * persists through the existing account profile API so Web + Desktop share it.
 * The card hides for complete profiles, never reappears after save, and the
 * skip affordance does not block usage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { OnboardingCard } from '../components/OnboardingCard';
import { jsonResponse, stubFetch } from '../testutils';
import type { User } from '../lib/types';

const COMPLETE: User = {
  id: 'u1',
  email: 'alice@example.com',
  emailVerified: true,
  displayName: 'Alice',
  avatarUrl: null,
  role: 'Developer',
  primaryUseCase: 'Build software',
  mfaEnabled: false,
  rbacRole: 'member',
  planId: 'free',
  entitlementState: 'FREE',
};

function profileUser(overrides: Partial<User>): User {
  return { ...COMPLETE, ...overrides };
}

function authed(handler: (url: string, init?: RequestInit) => Promise<Response>, user: User) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user } });
    if (url.includes('/api/v1/auth/profile') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Partial<User>;
      return jsonResponse({ data: { user: { ...user, ...body } } });
    }
    return handler(url, init);
  };
}

function renderCard(user: User, handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = stubFetch(authed(handler, user));
  const result = render(
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <OnboardingCard />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return { fetchFn, ...result };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('OnboardingCard', () => {
  it('asks for a display name when the profile does not have one', async () => {
    renderCard(profileUser({ displayName: null, role: null, primaryUseCase: null }), async () => jsonResponse({ data: {} }));
    expect(await screen.findByText('Complete your profile')).toBeInTheDocument();
    expect(screen.getByLabelText('What should we call you?')).toBeInTheDocument();
  });

  it('shows role + primary use case fields for an incomplete Google profile', async () => {
    renderCard(profileUser({ role: null, primaryUseCase: null }), async () => jsonResponse({ data: {} }));
    expect(await screen.findByLabelText('Your role')).toBeInTheDocument();
    expect(screen.getByLabelText('Primary use case')).toBeInTheDocument();
  });

  it('persists the chosen role + use case via the profile API and disappears', async () => {
    const fetchFn = renderCard(profileUser({ role: null, primaryUseCase: null }), async () => jsonResponse({ data: {} })).fetchFn;
    await userEvent.selectOptions(await screen.findByLabelText('Your role'), 'Founder');
    await userEvent.selectOptions(screen.getByLabelText('Primary use case'), 'Research');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => {
      const call = fetchFn.mock.calls.find(([u, init]) => String(u).includes('/api/v1/auth/profile') && init?.method === 'PATCH');
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}')) as { role?: string; primaryUseCase?: string };
      expect(body.role).toBe('Founder');
      expect(body.primaryUseCase).toBe('Research');
    });
    await waitFor(() => expect(screen.queryByText('Complete your profile')).not.toBeInTheDocument());
  });

  it('does not render at all for a complete profile (no duplicate prompts)', async () => {
    renderCard(COMPLETE, async () => jsonResponse({ data: {} }));
    await waitFor(() => expect(screen.queryByText('Complete your profile')).not.toBeInTheDocument());
  });

  it('skip for now never blocks usage', async () => {
    renderCard(profileUser({ role: null, primaryUseCase: null }), async () => jsonResponse({ data: {} }));
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(screen.queryByText('Complete your profile')).not.toBeInTheDocument());
  });
});