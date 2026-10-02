/**
 * CodeConClave — CSP_ENABLED secure-by-default tests.
 *
 * Verifies the Content-Security-Policy header is set based on CSP_ENABLED:
 * - Unset → CSP enabled (secure default)
 * - Explicit "true" → CSP enabled
 * - Explicit "false" → CSP disabled (development mode)
 *
 * The env config defaults CSP_ENABLED to 'true' (secure by default).
 * In production, a disabled CSP causes a startup guard failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    getHeader: (k: string) => headers[k],
    headers,
  } as unknown as Response;
}

function fakeReq() {
  return { headers: {}, ctx: {} } as unknown as Request;
}

async function importFreshEnv(): Promise<{ env: Record<string, unknown> }> {
  vi.resetModules();
  const mod = (await import('../config/env.js')) as { env: Record<string, unknown> };
  return { env: mod.env };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CSP_ENABLED secure-by-default', () => {
  it('defaults to CSP enabled when CSP_ENABLED is unset', async () => {
    const mod = await importFreshEnv();
    expect(mod.env.CSP_ENABLED).toBe('true');
  });

  it('explicit "true" keeps CSP enabled', async () => {
    vi.stubEnv('CSP_ENABLED', 'true');
    const mod = await importFreshEnv();
    expect(mod.env.CSP_ENABLED).toBe('true');
  });

  it('explicit "false" disables CSP (development mode)', async () => {
    vi.stubEnv('CSP_ENABLED', 'false');
    const mod = await importFreshEnv();
    expect(mod.env.CSP_ENABLED).toBe('false');
  });
});

describe('CSP middleware respects CSP_ENABLED', () => {
  it('sets Content-Security-Policy header when CSP_ENABLED is "true"', async () => {
    vi.stubEnv('CSP_ENABLED', 'true');
    vi.resetModules();
    const { securityHeaders } = await import('../middleware/security.js');
    const res = fakeRes();
    securityHeaders(fakeReq(), res, vi.fn() as NextFunction);
    expect(res.getHeader('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.getHeader('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('omits Content-Security-Policy header when CSP_ENABLED is "false"', async () => {
    vi.stubEnv('CSP_ENABLED', 'false');
    vi.resetModules();
    const { securityHeaders } = await import('../middleware/security.js');
    const res = fakeRes();
    securityHeaders(fakeReq(), res, vi.fn() as NextFunction);
    expect(res.getHeader('Content-Security-Policy')).toBeUndefined();
  });
});
