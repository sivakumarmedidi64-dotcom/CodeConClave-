/**
 * CodeConClave — shared test helpers (PHASE 11).
 */
import { vi } from 'vitest';
import type { User } from './lib/types';

export const TEST_USER: User = {
  id: 'u1',
  email: 'alice@example.com',
  emailVerified: true,
  displayName: 'Alice',
  avatarUrl: null,
  mfaEnabled: false,
  rbacRole: 'member',
  planId: 'free',
  entitlementState: 'FREE',
};

export function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob(['x'], { type: 'text/plain' }),
  } as unknown as Response;
}

export function authed(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/v1/auth/me')) return jsonResponse({ data: { user: TEST_USER } });
    return handler(url, init);
  };
}

/** Default shell handler: /auth/me, workspace prefs + state, empty everything else. */
export function shellHandler(url: string): Promise<Response> {
  if (url.includes('/api/v1/auth/me')) return Promise.resolve(jsonResponse({ data: { user: TEST_USER } }));
  if (url.includes('/api/v1/workspace/preferences')) return Promise.resolve(jsonResponse({ data: { prefs: { theme: 'light' } } }));
  if (url.includes('/api/v1/workspace/state')) return Promise.resolve(jsonResponse({ data: { state: [] } }));
  return Promise.resolve(jsonResponse({ data: {} }));
}

export function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(handler);
  vi.stubGlobal('fetch', fn);
  return fn;
}
