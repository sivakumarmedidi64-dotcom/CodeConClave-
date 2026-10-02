/**
 * CodeConClave Desktop — shared-auth rail checks (email OTP).
 * The desktop shells the SAME web UI (settings.appUrl) and its BackendClient
 * talks to the SAME backend origin with the shared httpOnly session cookie.
 * There is no separate desktop auth: passwordless OTP sign-in is the web flow,
 * and account continuity (web login then desktop login, same email) is
 * guaranteed by the backend's single user table. See backend otp.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { BackendClient } from './client.js';
import { DEFAULTS } from '../desktop/settings.js';

describe('desktop shared-auth rail (email OTP)', () => {
  it('hosts the same web UI in dev that exposes the OTP login flow', () => {
    expect(DEFAULTS.appUrl).toBe('http://localhost:8080');
  });

  it('resolves the web OTP endpoints against the configured backend origin (same account)', () => {
    const client = new BackendClient('https://codeconclave-backend.example');
    expect(client.origin()).toBe('https://codeconclave-backend.example');
    expect(`${client.baseUrl}/api/v1/auth/otp/request`).toBe('https://codeconclave-backend.example/api/v1/auth/otp/request');
    expect(`${client.baseUrl}/api/v1/auth/otp/verify`).toBe('https://codeconclave-backend.example/api/v1/auth/otp/verify');
  });

  it('carries the shared httpOnly session cookie on every backend call', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({ data: {} }) }));
    const client = new BackendClient('https://codeconclave-backend.example', fetchImpl as never);
    await client.getJson('/api/v1/auth/me');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://codeconclave-backend.example/api/v1/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});