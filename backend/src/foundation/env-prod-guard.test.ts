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
    // P0-3/P1-4/P1-5: a production instance behind a load balancer needs an
    // explicit proxy model, a shared cache, and one origin. This test pins the
    // fully-configured happy path; the individual requirements are covered by
    // the dedicated guards below.
    vi.stubEnv('TRUST_PROXY', '1');
    vi.stubEnv('REDIS_URL', 'redis://redis.internal:6379');
    vi.stubEnv('QUEUE_PROVIDER', 'redis');
    vi.stubEnv('APP_URL', 'https://codeconclave.example');
    vi.stubEnv('API_URL', 'https://codeconclave.example');
    const mod = await importFreshEnv();
    expect(mod.isProd).toBe(true);
    expect(mod.env.SESSION_COOKIE_SECURE).toBe('true');
    expect(mod.env.CSP_ENABLED).toBe('true');
  });

  it('refuses to start in production without an explicit proxy model', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    vi.stubEnv('TRUST_PROXY', 'false');
    await expect(importFreshEnv()).rejects.toThrow(/TRUST_PROXY/);
  });

  it('refuses to start in production with a shared-cache-less config', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    vi.stubEnv('TRUST_PROXY', '1');
    vi.stubEnv('REDIS_URL', '');
    await expect(importFreshEnv()).rejects.toThrow(/REDIS_URL/);
  });

  it('refuses to start in production with the in-memory queue', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    vi.stubEnv('TRUST_PROXY', '1');
    vi.stubEnv('REDIS_URL', 'redis://redis.internal:6379');
    vi.stubEnv('QUEUE_PROVIDER', 'memory');
    await expect(importFreshEnv()).rejects.toThrow(/QUEUE_PROVIDER/);
  });

  it('refuses to start in production on a split web/API origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    vi.stubEnv('TRUST_PROXY', '1');
    vi.stubEnv('REDIS_URL', 'redis://redis.internal:6379');
    vi.stubEnv('QUEUE_PROVIDER', 'redis');
    vi.stubEnv('APP_URL', 'https://app.vercel.app');
    vi.stubEnv('API_URL', 'https://api.up.railway.app');
    await expect(importFreshEnv()).rejects.toThrow(/different origins/);
  });

  it('refuses to start in production with a wildcard CORS origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    vi.stubEnv('TRUST_PROXY', '1');
    vi.stubEnv('REDIS_URL', 'redis://redis.internal:6379');
    vi.stubEnv('QUEUE_PROVIDER', 'redis');
    vi.stubEnv('APP_URL', 'https://codeconclave.example');
    vi.stubEnv('API_URL', 'https://codeconclave.example');
    vi.stubEnv('CORS_ORIGINS', '*');
    await expect(importFreshEnv()).rejects.toThrow(/CORS_ORIGINS/);
  });

  it('does not enforce the guard outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SESSION_SECRET', DEV_SESSION);
    vi.stubEnv('JWT_SECRET', DEV_JWT);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
    const mod = await importFreshEnv();
    expect(mod.isProd).toBe(false);
  });

  function happyBase(): void {
    vi.stubEnv('SESSION_SECRET', STRONG);
    vi.stubEnv('JWT_SECRET', STRONG);
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    vi.stubEnv('CSP_ENABLED', 'true');
    vi.stubEnv('TRUST_PROXY', '1');
    vi.stubEnv('REDIS_URL', 'redis://redis.internal:6379');
    vi.stubEnv('QUEUE_PROVIDER', 'redis');
    vi.stubEnv('APP_URL', 'https://codeconclave.example');
    vi.stubEnv('API_URL', 'https://codeconclave.example');
  }

  it('refuses to start in production with the webhook rail enabled but no internal token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    happyBase();
    vi.stubEnv('RAZORPAY_WEBHOOK_ENABLED', 'true');
    await expect(importFreshEnv()).rejects.toThrow(/INTERNAL_WEBHOOK_TOKEN/);
  });

  it('starts in production with the webhook rail enabled and the internal token set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    happyBase();
    vi.stubEnv('RAZORPAY_WEBHOOK_ENABLED', 'true');
    vi.stubEnv('INTERNAL_WEBHOOK_TOKEN', 'tok_prod_rail_1234');
    const mod = await importFreshEnv();
    expect(mod.isProd).toBe(true);
    expect(mod.env.INTERNAL_WEBHOOK_TOKEN).toBe('tok_prod_rail_1234');
  });

  it('does not require the internal token when the webhook rail is disabled in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    happyBase();
    vi.stubEnv('RAZORPAY_WEBHOOK_ENABLED', 'false');
    const mod = await importFreshEnv();
    expect(mod.isProd).toBe(true);
    expect(mod.env.INTERNAL_WEBHOOK_TOKEN).toBeUndefined();
  });
});