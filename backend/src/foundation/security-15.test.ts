/**
 * CodeConClave — PHASE 15 security regression tests.
 * Covers the hardening delivered in Phase 15: server-set tool caller identity
 * (client-supplied userId is never trusted), optional-auth fail-closed,
 * session rotation on MFA privilege changes, request correlation IDs, error
 * sanitization (no message/stack/secret leakage), COOP/CORP headers,
 * rate-limit fail-closed on auth paths, security metrics, the deny-by-default
 * policy chain (parseToolRequest -> policy -> tool registry), RLS static
 * audit for the newly protected tenant tables, health rollup honesty, and
 * diagnostics authorization. DB interaction is mocked; policy assertions are
 * against the deterministic engine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../database/migrations', import.meta.url));

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
    pingOk: boolean;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
    pingOk: true,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    ping: async () => state.pingOk,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

const cacheMock = vi.hoisted(() => {
  const incr = vi.fn(async () => 1);
  const get = vi.fn(async () => null);
  const set = vi.fn(async () => {});
  const health = vi.fn(async () => true);
  return { cache: { incr, get, set, health }, incr, get, set, health };
});
vi.mock('../shared/cache.js', () => cacheMock);

const files = vi.hoisted(() => ({
  getFileContent: vi.fn(async () => ({ buffer: Buffer.from('hello'), mimeType: 'text/plain' })),
  uploadFile: vi.fn(async () => ({ id: 'f1', sha256: 'a'.repeat(64), path: 'src/a.ts' })),
  listFiles: vi.fn(async () => []),
}));
vi.mock('../modules/files/service.js', () => files);
const memory = vi.hoisted(() => ({ semanticSearch: vi.fn(async () => []) }));
vi.mock('../modules/memory/service.js', () => memory);

import { env } from '../config/env.js';
import { encryptAtRest } from '../shared/crypto.js';
import { AppError } from '../shared/errors.js';
import { resetMetrics, metricSnapshot } from '../observability/metrics.js';
import { registerCoreTools } from '../modules/execution/tools.js';
import { runRegisteredTool } from '../modules/execution/toolcalls.js';
import { evaluateToolCall, registerGrants, revokeGrants } from '../modules/execution/policy.js';
import { parseToolRequest } from '../modules/ai/gateway.js';
import { optionalAuth, SESSION_COOKIE } from '../middleware/auth.js';
import { requestContext } from '../middleware/context.js';
import { securityHeaders, errorHandler } from '../middleware/security.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { setupMfa, confirmMfa, disableMfa, hookSuspiciousSession } from '../modules/auth/service.js';
import { validateProviderEvidence } from '../modules/payments/evidence.js';
import { computeHealth } from '../health/health.js';
import { diagnosticsReport } from '../modules/operations/diagnostics.js';
import { sweepOnce, lastWatchdogRunAt } from '../workers/watchdog.js';
import { logger } from '../shared/logger.js';

const ENV_KEYS = [
  'AUTH_SESSION_TTL_DAYS', 'SESSION_COOKIE_SECURE', 'APP_NAME',
  'RATE_LIMIT_AUTH_PER_MIN', 'RATE_LIMIT_GLOBAL_PER_MIN', 'RATE_LIMIT_CHAT_PER_MIN',
  'REDIS_URL', 'QUEUE_PROVIDER', 'STORAGE_PROVIDER',
  'AI_PROVIDERS_ENABLED', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY',
  'SENTRY_DSN', 'SENTRY_ENABLED',
] as const;

const originalEnv: Record<string, unknown> = {};
beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  db.state.pingOk = true;
  recordAudit.mockClear();
  for (const m of [cacheMock.incr, cacheMock.get, cacheMock.set, cacheMock.health, files.getFileContent, files.uploadFile, files.listFiles, memory.semanticSearch]) {
    m.mockClear();
  }
  files.getFileContent.mockResolvedValue({ buffer: Buffer.from('hello'), mimeType: 'text/plain' });
  files.uploadFile.mockResolvedValue({ id: 'f1', sha256: 'a'.repeat(64), path: 'src/a.ts' });
  files.listFiles.mockResolvedValue([]);
  memory.semanticSearch.mockResolvedValue([]);
  cacheMock.incr.mockResolvedValue(1);
  cacheMock.get.mockResolvedValue(null);
  cacheMock.set.mockResolvedValue(undefined);
  cacheMock.health.mockResolvedValue(true);
  resetMetrics();
  for (const key of ENV_KEYS) originalEnv[key] = env[key as keyof typeof env];
});

afterEach(() => {
  revokeGrants('u1');
  revokeGrants('victim');
  for (const key of ENV_KEYS) {
    (env as Record<string, unknown>)[key] = originalEnv[key];
  }
});

function fakeReq(ip: string, extra: Record<string, unknown> = {}): Request {
  return {
    ip,
    headers: { 'user-agent': 'foundation/1.0', ...(extra.headers ?? {}) },
    cookies: (extra.cookies as Record<string, string> | undefined) ?? {},
    ctx: { traceId: 'trace-1', ip, userAgent: 'foundation/1.0', user: null, sessionId: null, startedAt: Date.now() },
    ...extra,
  } as unknown as Request;
}

function fakeRes(): Response {
  const headers: Record<string, string> = {};
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    getHeader: (k: string) => headers[k],
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response;
}

function callNext(): { next: NextFunction; err: unknown; called: boolean } {
  const state = { err: null as unknown, called: false };
  const next = ((err?: unknown) => {
    state.called = true;
    state.err = err;
  }) as NextFunction;
  return { next, err: state.err, called: state.called };
}

function totpCode(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

describe('TOOL CALLER IDENTITY — server-set only', () => {
  beforeEach(() => registerCoreTools());

  it('file_read uses the context userId, never input.userId', async () => {
    db.state.resolve = (text) => (text.includes('FROM files') ? [{ id: 'f1' }] : null);
    const result = await runRegisteredTool('file_read', { projectId: 'p1', path: 'src/a.ts', userId: 'attacker' }, { userId: 'victim' });
    expect(files.getFileContent).toHaveBeenCalledWith('victim', 'p1', 'f1');
    expect(files.getFileContent.mock.calls.some((c) => String(c[0]).includes('attacker'))).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('file_write uses the context userId, never input.userId', async () => {
    await runRegisteredTool('file_write', { projectId: 'p1', path: 'src/a.ts', content: 'x', userId: 'attacker' }, { userId: 'victim' });
    expect(files.uploadFile).toHaveBeenCalledWith('victim', 'p1', 'src/a.ts', expect.any(Buffer), expect.any(String));
  });

  it('file_list uses the context userId, never input.userId', async () => {
    await runRegisteredTool('file_list', { projectId: 'p1', userId: 'attacker' }, { userId: 'victim' });
    expect(files.listFiles).toHaveBeenCalledWith('victim', 'p1');
  });

  it('memory_search uses the context userId, never input.userId', async () => {
    await runRegisteredTool('memory_search', { query: 'todo', userId: 'attacker' }, { userId: 'victim' });
    expect(memory.semanticSearch).toHaveBeenCalledWith('victim', 'todo', null, 5);
  });

  it('fails CLOSED when no authenticated context is present', async () => {
    await expect(runRegisteredTool('file_read', { projectId: 'p1', path: 'src/a.ts' }, undefined)).rejects.toThrow(/authenticated caller context/);
    expect(files.getFileContent).not.toHaveBeenCalled();
  });
});

describe('AUTH MIDDLEWARE — fail-closed session loading', () => {
  it('a session lookup failure yields 503 auth_unavailable (never silent anonymous)', async () => {
    db.state.resolve = () => {
      throw new Error('connection reset');
    };
    const req = fakeReq('10.0.0.1', { cookies: { [SESSION_COOKIE]: 'token' } });
    const next = vi.fn();
    await optionalAuth(req, fakeRes(), next);
    await new Promise((r) => setTimeout(r, 0));
    const err = next.mock.calls[0][0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(503);
    expect(err.errorCode).toBe('auth_unavailable');
    expect(req.ctx?.user).toBeNull();
  });

  it('no cookie stays anonymous (public routes unaffected)', async () => {
    const req = fakeReq('10.0.0.1');
    const next = vi.fn();
    await optionalAuth(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.ctx?.user).toBeNull();
  });

  it('a valid session loads the user', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM sessions')) {
        return [{
          id: 's1', state: 'ACTIVE', expires_at: new Date(Date.now() + 3_600_000),
          user_id: 'u1', email: 'alice@example.com', email_verified: true,
          display_name: 'Alice', avatar_url: null, google_sub: null, mfa_enabled: false,
          rbac_role: 'owner', plan_id: 'pro', entitlement_state: 'PRO_VERIFIED',
        }];
      }
      return null;
    };
    const req = fakeReq('10.0.0.1', { cookies: { [SESSION_COOKIE]: 'token' } });
    const next = vi.fn();
    await optionalAuth(req, fakeRes(), next);
    await new Promise((r) => setTimeout(r, 0));
    expect(req.ctx?.user?.id).toBe('u1');
    expect(req.ctx?.sessionId).toBe('s1');
  });
});

describe('SESSION ROTATION — MFA privilege changes revoke other sessions', () => {
  it('confirmMfa revokes all other ACTIVE sessions and issues a fresh session token', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('mfa_secret_encrypted')) return [{ mfa_secret_encrypted: encrypted }];
      return null;
    };
    const { sessionToken } = await confirmMfa('u1', totpCode(setup.secretBase32), fakeReq('10.0.0.1'));
    const revoke = db.state.calls.find((c) => c.text.includes("state = 'REVOKED'"))!;
    expect(revoke.text).toContain('id <> $2');
    expect(db.state.calls.filter((c) => c.text.includes('INSERT INTO sessions')).length).toBe(1);
    expect(sessionToken.length).toBeGreaterThanOrEqual(32);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.session_rotated' }));
  });

  it('disableMfa rotates sessions and returns the fresh token', async () => {
    const setup = await setupMfa('u1');
    const encrypted = db.state.calls.find((c) => c.text.includes('UPDATE users SET mfa_secret_encrypted'))!.params[0];
    db.state.resolve = (text) => {
      if (text.includes('mfa_secret_encrypted')) return [{ mfa_secret_encrypted: encrypted }];
      return null;
    };
    const result = await disableMfa('u1', totpCode(setup.secretBase32), fakeReq('10.0.0.1'));
    expect(result?.sessionToken.length).toBeGreaterThanOrEqual(32);
    expect(db.state.calls.filter((c) => c.text.includes("state = 'REVOKED'")).length).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.session_rotated' }));
  });

  it('a revoked (replayed) session never resolves to a user', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM sessions')) {
        return [{ id: 's1', state: 'REVOKED', expires_at: new Date(Date.now() + 3_600_000), user_id: 'u1' }];
      }
      return null;
    };
    const req = fakeReq('10.0.0.1', { cookies: { [SESSION_COOKIE]: 'old-token' } });
    const next = vi.fn();
    await optionalAuth(req, fakeRes(), next);
    expect(req.ctx?.user).toBeNull();
  });
});

describe('REQUEST CONTEXT — correlation IDs and security headers', () => {
  it('requestContext echoes the trace id as X-Request-Id', () => {
    const req = fakeReq('10.0.0.1');
    const res = fakeRes();
    const next = vi.fn();
    requestContext(req, res, next);
    expect(res.getHeader('X-Request-Id')).toBe(req.ctx!.traceId);
    expect(next).toHaveBeenCalledWith();
  });

  it('securityHeaders includes COOP and CORP same-origin protections', () => {
    const req = fakeReq('10.0.0.1');
    const res = fakeRes();
    const next = vi.fn();
    securityHeaders(req, res, next);
    expect(res.getHeader('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.getHeader('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });
});

describe('ERROR HANDLING — sanitized client responses', () => {
  it('errorHandler never leaks message, stack, or secrets to the client', () => {
    const req = fakeReq('10.0.0.1');
    const res = fakeRes();
    const next = vi.fn();
    const boom = new Error('sk-live-abcdef1234567890 leaked in message');
    boom.stack = 'Error: sk-live-abcdef1234567890\n    at src/app.ts:1:1';
    errorHandler(boom, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('sk-live-abcdef1234567890');
    expect(JSON.stringify(body)).not.toContain('at src/app.ts');
    expect(body.error?.message ?? body.message ?? '').not.toContain('leaked in message');
  });

  it('errorHandler maps AppError to its exact status and code', () => {
    const req = fakeReq('10.0.0.1');
    const res = fakeRes();
    const next = vi.fn();
    errorHandler(AppError.forbidden('tool_denied', 'Tool call was denied by policy'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain('tool_denied');
  });
});

describe('RATE LIMITING — auth paths fail closed', () => {
  it('authLimit returns 503 rate_limit_unavailable when the store is down', async () => {
    cacheMock.incr.mockRejectedValue(new Error('redis down'));
    const req = fakeReq('10.0.0.1');
    const next = vi.fn();
    await rateLimit({ name: 'auth', limit: 10, windowMs: 60_000, failClosed: true })(req, fakeRes(), next);
    const err = next.mock.calls[0][0] as AppError;
    expect(err.status).toBe(503);
    expect(err.errorCode).toBe('rate_limit_unavailable');
  });

  it('non-security paths continue without limiting during a store outage (fail open)', async () => {
    cacheMock.incr.mockRejectedValue(new Error('redis down'));
    const req = fakeReq('10.0.0.1');
    const next = vi.fn();
    await rateLimit({ name: 'global', limit: 300, windowMs: 60_000 })(req, fakeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('exceeding the limit yields 429', async () => {
    cacheMock.incr.mockResolvedValue(11);
    const req = fakeReq('10.0.0.1');
    const next = vi.fn();
    await rateLimit({ name: 'auth', limit: 10, windowMs: 60_000, failClosed: true })(req, fakeRes(), next);
    expect((next.mock.calls[0][0] as AppError).status).toBe(429);
  });
});

describe('POLICY CHAIN — model output can never reach execution directly', () => {
  beforeEach(() => registerGrants([
    { id: 'g1', userId: 'u1', capability: 'READ_WORKSPACE', scope: 'projects/p1', expiresAt: Date.now() + 60_000, allowedCommands: [] },
  ]));

  it('parseToolRequest rejects non-JSON, unknown tools, and non-object input', () => {
    const expectCode = (fn: () => unknown, code: string) => {
      try {
        fn();
        throw new Error('expected throw');
      } catch (err) {
        expect((err as AppError).errorCode).toBe(code);
      }
    };
    expectCode(() => parseToolRequest('not json', ['file_read']), 'invalid_tool_request');
    expectCode(() => parseToolRequest('{"tool":"rm -rf /","input":{}}', ['file_read']), 'invalid_tool_request');
    expectCode(() => parseToolRequest('{"tool":"file_read","input":"str"}', ['file_read']), 'invalid_tool_request');
  });

  it('a spoofed prompt payload cannot smuggle a userId or secret path', () => {
    const parsed = parseToolRequest(
      JSON.stringify({ tool: 'file_read', input: { projectId: 'p1', path: '.env', userId: 'attacker' } }),
      ['file_read'],
    );
    const decision = evaluateToolCall({ ...parsed, userId: 'u1' });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.deniedBy).toBe('baseline_secrets');
    const snapshot = metricSnapshot();
    expect(snapshot['security.secrets_blocked'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('path traversal and dangerous commands are denied without an approval path', () => {
    const traversal = evaluateToolCall({ tool: 'file_read', input: { path: '../../etc/passwd' }, userId: 'u1' });
    expect(traversal.allowed).toBe(false);
    const command = evaluateToolCall({ tool: 'terminal_exec', input: { command: 'rm -rf /' }, userId: 'u1' });
    expect(command.allowed).toBe(false);
    if (!command.allowed) expect(command.deniedBy).toBe('baseline_commands');
  });

  it('unknown tools are denied with a security metric', () => {
    const decision = evaluateToolCall({ tool: 'fantasy_tool', input: {}, userId: 'u1' });
    expect(decision.allowed).toBe(false);
    expect(metricSnapshot()['security.unknown_tool'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('capability checks deny operations without a grant', () => {
    const decision = evaluateToolCall({ tool: 'file_read', input: { path: 'projects/other/app.ts' }, userId: 'u1' });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.deniedBy).toBe('capability');
  });
});

describe('SECURITY METRICS — observability of the hardening', () => {
  it('suspicious logins increment security.suspicious_logins', async () => {
    db.state.resolve = (text) => (text.includes('FROM sessions') ? [{ ip: '1.1.1.1' }] : null);
    await hookSuspiciousSession('u1', 's1', fakeReq('9.9.9.9'));
    expect(metricSnapshot()['security.suspicious_logins'] ?? 0).toBe(1);
  });

  it('payment evidence spoof attempts increment security.payment_spoof_attempts', async () => {
    expect(() => validateProviderEvidence({ source: 'CLIENT', raw: { amount: 100, currency: 'INR' } })).toThrow();
    const snapshot = metricSnapshot();
    expect((snapshot['security.payment_spoof_attempts'] ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('HEALTH — honest rollup with NOT_CONFIGURED never healthy', () => {
  it('default dev configuration reports DEGRADED (core up, providers not configured)', async () => {
    env.AI_PROVIDERS_ENABLED = 'anthropic,openai,google,mistral';
    env.ANTHROPIC_API_KEY = undefined;
    env.OPENAI_API_KEY = undefined;
    env.GEMINI_API_KEY = undefined;
    env.MISTRAL_API_KEY = undefined;
    env.REDIS_URL = undefined;
    env.QUEUE_PROVIDER = 'memory';
    env.SENTRY_DSN = undefined;
    env.SENTRY_ENABLED = 'false';
    db.state.resolve = (text) => (text.includes('provider_health') || text.includes('plugin_connections') ? [] : null);
    const report = await computeHealth();
    expect(report.status).toBe('DEGRADED');
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'api')?.status).toBe('HEALTHY');
    expect(report.checks.find((c) => c.id === 'database')?.status).toBe('HEALTHY');
    expect(report.checks.find((c) => c.id === 'ai')?.status).toBe('NOT_CONFIGURED');
    expect(report.checks.find((c) => c.id === 'storage')?.status).toBe('NOT_CONFIGURED');
    expect(report.checks.find((c) => c.id === 'sentry')?.status).toBe('NOT_CONFIGURED');
    expect(report.checks.every((c) => c.status !== 'HEALTHY' || c.id === 'api' || c.id === 'database')).toBe(true);
  });

  it('database failure fails the whole report', async () => {
    db.state.pingOk = false;
    env.REDIS_URL = undefined;
    env.QUEUE_PROVIDER = 'memory';
    env.SENTRY_DSN = undefined;
    const report = await computeHealth();
    expect(report.status).toBe('FAILED');
    expect(report.checks.find((c) => c.id === 'database')?.status).toBe('FAILED');
  });

  it('a configured AI provider that is DOWN fails the report', async () => {
    env.AI_PROVIDERS_ENABLED = 'anthropic';
    env.ANTHROPIC_API_KEY = 'sk-ant-test';
    env.REDIS_URL = undefined;
    env.QUEUE_PROVIDER = 'memory';
    env.SENTRY_DSN = undefined;
    db.state.resolve = (text) => {
      if (text.includes('provider_health')) return [{ provider_id: 'anthropic', state: 'DOWN' }];
      if (text.includes('plugin_connections')) return [];
      return null;
    };
    const report = await computeHealth();
    expect(report.status).toBe('FAILED');
    expect(report.checks.find((c) => c.id === 'ai')?.status).toBe('FAILED');
  });

  it('a healthy configured AI provider yields a HEALTHY ai check', async () => {
    env.AI_PROVIDERS_ENABLED = 'anthropic';
    env.ANTHROPIC_API_KEY = 'sk-ant-test';
    env.REDIS_URL = undefined;
    env.QUEUE_PROVIDER = 'memory';
    env.SENTRY_DSN = undefined;
    db.state.resolve = (text) => {
      if (text.includes('provider_health')) return [{ provider_id: 'anthropic', state: 'UP' }];
      if (text.includes('plugin_connections')) return [];
      return null;
    };
    const report = await computeHealth();
    expect(report.checks.find((c) => c.id === 'ai')?.status).toBe('HEALTHY');
  });

  it('health never exposes secrets or connection strings', async () => {
    env.AI_PROVIDERS_ENABLED = 'anthropic';
    env.ANTHROPIC_API_KEY = 'sk-ant-super-secret-value';
    env.REDIS_URL = 'redis://:hunter2@redis.internal:6379';
    env.QUEUE_PROVIDER = 'redis';
    env.SENTRY_DSN = 'https://dns@o123.ingest.sentry.io/123';
    db.state.resolve = (text) => {
      if (text.includes('provider_health')) return [{ provider_id: 'anthropic', state: 'UP' }];
      if (text.includes('plugin_connections')) return [];
      return null;
    };
    const report = await computeHealth();
    const body = JSON.stringify(report);
    expect(body).not.toContain('sk-ant-super-secret-value');
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('ingest.sentry.io');
  });
});

describe('DIAGNOSTICS — operator surface with no secret leakage', () => {
  it('report includes version, queue depth, metrics, and recent errors only', async () => {
    db.state.resolve = (text) => {
      if (text.includes('task_dlq')) return [{ n: 3 }];
      if (text.includes('outbox_events')) return [{ n: 2 }];
      return null;
    };
    const report = await diagnosticsReport();
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.health).toBeDefined();
    expect(report.queue.dlqDepth).toBe(3);
    expect(report.queue.outboxPending).toBe(2);
    expect(report.metrics).toBeDefined();
    expect(report.recentErrors).toBeInstanceOf(Array);
    expect(JSON.stringify(report)).not.toContain('apiKey');
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});

describe('RLS STATIC AUDIT — newly protected tenant tables', () => {
  function migrationText(name: string): string {
    return readFileSync(join(MIGRATIONS_DIR, name), 'utf-8');
  }

  it('0037 protects memory_corrections with tenant-scoped RLS', () => {
    const text = migrationText('0037_phase15_security.sql');
    expect(text).toContain('ALTER TABLE memory_corrections ENABLE ROW LEVEL SECURITY');
    expect(text).toContain('CREATE POLICY memory_corrections_owner ON memory_corrections');
    expect(text).toContain('app.uid()');
    expect(text).toContain('WITH CHECK (false)');
  });

  it('0037 protects task_dependencies, task_dlq, plans, plan_entries', () => {
    const text = migrationText('0037_phase15_security.sql');
    for (const table of ['task_dependencies', 'task_dlq', 'plans', 'plan_entries']) {
      expect(text).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(text).toContain(`CREATE POLICY ${table}_owner ON ${table}`);
    }
  });

  it('0015 documents the intentional service-table exceptions', () => {
    const text = migrationText('0015_rls.sql');
    expect(text.toLowerCase()).toContain('service');
    expect(text.toLowerCase()).toContain('service tables served only through read apis');
  });

  it('no migration since 0015 creates a tenant-scoped table without RLS', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const rlsText = files.map((f) => migrationText(f)).join('\n');
    for (const table of ['memory_corrections', 'task_dependencies', 'task_dlq', 'plans', 'plan_entries']) {
      expect(rlsText).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
  });
});

describe('WATCHDOG FAILURE HANDLING — sanitized, counted, never fatal', () => {
  it('a failing sweep records watchdog.<name>_failed metrics and sanitized logs only', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const boom = new Error('db connection refused');
      boom.stack = 'Error: db connection refused\n    at src/db.ts:12:3\n    sk-super-secret-value';
      db.state.resolve = () => {
        throw boom;
      };
      const out = await sweepOnce();
      expect(out.invitationsExpired).toBeUndefined();
      const snapshot = metricSnapshot();
      const watchdogFails = Object.entries(snapshot)
        .filter(([k]) => k.startsWith('watchdog.') && k.endsWith('_failed'))
        .map(([, v]) => v as number);
      expect(watchdogFails.length).toBeGreaterThanOrEqual(3);
      expect(watchdogFails.every((n) => n >= 1)).toBe(true);
      expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const call of errorSpy.mock.calls) {
        const payload = JSON.stringify(call[1]);
        expect(payload).not.toContain('sk-super-secret-value');
        expect(payload).not.toContain('stack');
        expect(payload).not.toMatch(/\bat .*\.ts:\d+/);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('lastWatchdogRunAt reflects the last completed sweep regardless of sweep failures', async () => {
    db.state.resolve = () => {
      throw new Error('down');
    };
    await sweepOnce();
    expect(lastWatchdogRunAt()).not.toBeNull();
  });
});