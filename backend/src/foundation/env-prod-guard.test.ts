/**
 * CodeConClave — PHASE 18 production configuration guard tests.
 * With NODE_ENV=production the backend must fail fast rather than silently
 * run with the public dev-default secrets, insecure cookies, or a disabled
 * CSP. These tests re-import the config module fresh with stubbed env; the
 * guard is inactive outside production (dev/test defaults remain valid).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const DEV_SESSION = 'dev_only_session_secret_do_not_use_in_prod';
const DEV_JWT = 'dev_only_jwt_secret_do_not_use_in_prod';
const STRONG = '0123456789abcdef0123456789abcdef0123456789abcdef';

async function importFreshEnv(): Promise<{ isProd: boolean; env: Record<string, unknown> }> {
  vi.resetModules();
  const mod = (await import('../config/env.js')) as { isProd: boolean; env: Record<string, unknown> };
  return { isProd: mod.isProd, env: mod.env };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PRODUCTION CONFIGURATION GUARD (Phase 18)', () => {
  it('refuses to start in production with the weak dev secrets', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', DEV_SESSION);
    vi.stubEnv('JWT_SECRET', DEV_JWT);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    await expect(importFreshEnv()).rejects.toThrow(/SESSION_SECRET and JWT_SECRET/);
  });

  it('refuses to start in production without secure cookies', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
    vi.stubEnv('CSP_ENABLED', 'true');
    await expect(importFreshEnv()).rejects.toThrow(/SESSION_COOKIE_SECURE/);
  });

  it('refuses to start in production with CSP disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'false');
    await expect(importFreshEnv()).rejects.toThrow(/CSP_ENABLED/);
  });

  it('starts in production when secrets are strong and cookies secure', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    const mod = await importFreshEnv();
    expect(mod.isProd).toBe(true);
    expect(mod.env.SESSION_COOKIE_SECURE).toBe('true');
    expect(mod.env.CSP_ENABLED).toBe('true');
  });

  it('does not enforce the guard outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SESSION_SECRET', DEV_SESSION);
    vi.stubEnv('JWT_SECRET', DEV_JWT);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
    const mod = await importFreshEnv();
    expect(mod.isProd).toBe(false);
  });
});