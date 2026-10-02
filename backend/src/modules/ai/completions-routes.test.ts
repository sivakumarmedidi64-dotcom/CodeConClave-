/**
 * CodeConClave — POST /api/v1/ai/chat/completions (self-serve API product).
 * Contract tests, hermetic: gateway completion, entitlement and user lookup are
 * mocked, the AI router / providers / registry are NOT touched. Stream framing
 * is asserted verbatim (OpenAI-shaped `data:` lines).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import { errorHandler } from '../../middleware/security.js';

const completeWithFallback = vi.hoisted(() => vi.fn());
const planRoute = vi.hoisted(() => vi.fn());
const getUserById = vi.hoisted(() => vi.fn());
const apiAccessEntitlementState = vi.hoisted(() => vi.fn());
const workspaceAccess = vi.hoisted(() => vi.fn());

vi.mock('./gateway.js', () => ({
  completeWithFallback,
  premiumBudgetRemaining: vi.fn(async () => 4),
}));
vi.mock('./router.js', () => ({ planRoute }));
vi.mock('../../middleware/auth.js', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../auth/service.js', () => ({ getUserById }));
vi.mock('../apikeys/service.js', () => ({ apiAccessEntitlementState }));
// The AI router refuses a session user with no live paid entitlement. This
// contract test is about completions, so the workspace lookup is mocked here
// and gated explicitly in the "session gate" describe block below.
vi.mock('../../middleware/entitlement.js', () => ({
  workspaceAccess,
  workspaceReasonMessage: (reason: string) => `Reason: ${reason}`,
}));

import { aiRoutes } from './routes.js';

const SUMMARY = {
  text: 'Hello, operator.',
  modelId: 'gemini-1.5-flash',
  providerId: 'google',
  inputTokens: 7,
  outputTokens: 3,
  estimatedCostUsd: 0.0005,
  durationMs: 11,
  usedFallback: false,
  fallbackReason: null,
} as const;

function buildApp(): { app: Express; server: Server; port: number } {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.ctx = {
      correlationId: 'test',
      user: { id: 'u1', email: 'api@example.com', emailVerified: true, displayName: null, avatarUrl: null, googleSub: null, role: null, primaryUseCase: null, mfaEnabled: false, rbacRole: 'owner', planId: 'free', entitlementState: 'PRO_VERIFIED' },
    } as never;
    next();
  });
  app.use('/api/v1/ai', aiRoutes());
  app.use(errorHandler);
  const server = createServer(app);
  return { app, server, port: 0 };
}

async function withServer<T>(app: Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 4000;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function message(content: string) {
  return { role: 'user', content };
}

describe('POST /api/v1/ai/chat/completions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserById.mockReset();
    getUserById.mockResolvedValue({ id: 'u1', email: 'api@example.com', emailVerified: true, planId: 'free' });
    apiAccessEntitlementState.mockReset();
    apiAccessEntitlementState.mockResolvedValue({ state: 'PRO_VERIFIED', expiresAt: null, entitled: true });
    planRoute.mockReset();
    planRoute.mockResolvedValue({
      taskType: 'TASK',
      routingPreference: 'AUTO',
      selectedModel: 'gemini-1.5-flash',
      selectedProvider: 'google',
      reason: 'fixture',
      fallbackChain: [],
      estimatedCost: 0,
      capabilityMatch: true,
      confidence: 'high',
      healthState: 'UP',
      requestedModelHonored: true,
      requestedModelSubstituted: false,
      features: {},
    });
    completeWithFallback.mockReset();
    completeWithFallback.mockResolvedValue({ ...SUMMARY });
    workspaceAccess.mockReset();
    workspaceAccess.mockResolvedValue({ unlocked: true, reason: null, planId: 'pro', entitled: true });
  });

  it('returns an OpenAI-shaped non-streaming completion with usage', async () => {
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [message('ping')] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.data.id).toMatch(/^msg_/);
      expect(body.data.object).toBe('chat.completion');
      expect(body.data.model).toBe('gemini-1.5-flash');
      expect(body.data.choices[0].message.content).toBe('Hello, operator.');
      expect(body.data.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    });
  });

  it('runs with paid gateway semantics for a verified API Access customer', async () => {
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [message('hi')] }),
      });
      expect(res.status).toBe(200);
      const opts = completeWithFallback.mock.calls[0][0] as {
        ctx?: { planId?: string; coworkerType?: string; sessionId?: string };
        messages?: unknown[];
        maxTokens?: number;
        temperature?: number;
        opts?: Record<string, unknown>;
      };
      expect(opts.ctx?.planId).toBe('pro');
      expect(opts.ctx?.coworkerType).toBe('API');
      expect(opts.ctx?.sessionId).toMatch(/^ses_/);
      expect(opts.messages).toEqual([{ role: 'user', content: 'hi' }]);
      // Sensible defaults when stream/max_tokens/temperature are omitted.
      expect(opts.maxTokens).toBe(1024);
      expect(opts.temperature).toBe(1);
      // Autonomous routing picks the fixture model through planRoute.
      expect(opts.opts?.requestedModelId).toBe('gemini-1.5-flash');
      expect(planRoute).toHaveBeenCalledTimes(1);
    });
  });

  it('pins an explicit model and skips autonomous routing', async () => {
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-1.5-flash', messages: [message('hi')], max_tokens: 42, temperature: 0.5 }),
      });
      expect(res.status).toBe(200);
      expect(planRoute).not.toHaveBeenCalled();
      const opts = completeWithFallback.mock.calls[0][0] as { opts?: Record<string, unknown>; maxTokens?: number; temperature?: number };
      expect(opts.opts?.requestedModelId).toBe('gemini-1.5-flash');
      expect(opts.maxTokens).toBe(42);
      expect(opts.temperature).toBe(0.5);
    });
  });

  it('streams OpenAI-shaped SSE frames ending with [DONE]', async () => {
    completeWithFallback.mockImplementation(async (opts: { onChunk?: (c: { delta: string }) => void }) => {
      for (const delta of ['Hel', 'lo, ', 'operator.']) {
        await opts.onChunk?.({ delta });
      }
      return { ...SUMMARY };
    });
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, messages: [message('hi')] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const raw = await res.text();
      const frames = raw.split(/\n\n/).filter(Boolean);
      expect(frames.length).toBe(5); // 3 content + 1 final usage + 1 [DONE]
      const content = frames
        .slice(0, 3)
        .map((f) => JSON.parse(f.replace(/^data: /, '')))
        .map((f) => f.choices[0].delta.content)
        .join('');
      expect(content).toBe('Hello, operator.');
      const finalFrame = JSON.parse(frames[3]!.replace(/^data: /, ''));
      expect(finalFrame.choices[0].finish_reason).toBe('stop');
      expect(finalFrame.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
      expect(frames[4]).toBe('data: [DONE]');
    });
  });

  it('rejects a missing messages array', async () => {
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(completeWithFallback).not.toHaveBeenCalled();
    });
  });

  it('rejects unsupported roles before any provider call', async () => {
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'tool', content: 'x' }] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('unsupported_role');
      expect(completeWithFallback).not.toHaveBeenCalled();
    });
  });

  it('accepts multimodal text + image_url parts', async () => {
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', url: 'https://example.com/i.png' }] }] }),
      });
      expect(res.status).toBe(200);
      const opts = completeWithFallback.mock.calls[0][0] as { messages?: unknown[] };
      expect(opts.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', url: 'https://example.com/i.png' }] },
      ]);
    });
  });

  it('writes an error frame and ends when streaming fails mid-flight', async () => {
    completeWithFallback.mockImplementation(async (opts: { onChunk?: (c: { delta: string }) => void }) => {
      await opts.onChunk?.({ delta: 'partial' });
      throw new Error('provider down');
    });
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, messages: [message('hi')] }),
      });
      const raw = await res.text();
      const frames = raw.split(/\n\n/).filter(Boolean);
      expect(frames.length).toBeGreaterThanOrEqual(2);
      const errorFrame = JSON.parse(frames[frames.length - 1]!.replace(/^data: /, ''));
      expect(errorFrame.error.code).toBe('internal_error');
    });
  });
});

describe('POST /api/v1/ai/chat/completions — session entitlement gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserById.mockResolvedValue({ id: 'u1', email: 'api@example.com', emailVerified: true, planId: 'free' });
    apiAccessEntitlementState.mockResolvedValue({ state: 'PRO_VERIFIED', expiresAt: null, entitled: true });
    planRoute.mockResolvedValue(null);
    completeWithFallback.mockResolvedValue({ ...SUMMARY });
    workspaceAccess.mockReset();
  });

  it('refuses a session user with no live paid entitlement and never calls the gateway', async () => {
    workspaceAccess.mockResolvedValue({ unlocked: false, reason: 'upgrade_required', planId: 'free', entitled: false });
    apiAccessEntitlementState.mockResolvedValue({ state: 'FREE', expiresAt: null, entitled: false });
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [message('ping')] }),
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('entitlement_required');
      expect(completeWithFallback).not.toHaveBeenCalled();
    });
  });

  it('admits a FREE-plan session that holds a verified API Access grant', async () => {
    // API Access is a separate product from the workspace plan, so a paid API
    // customer must not be locked out by the workspace gate.
    workspaceAccess.mockResolvedValue({ unlocked: false, reason: 'upgrade_required', planId: 'free', entitled: false });
    apiAccessEntitlementState.mockResolvedValue({ state: 'PRO_VERIFIED', expiresAt: null, entitled: true });
    planRoute.mockResolvedValue({
      taskType: 'TASK',
      routingPreference: 'AUTO',
      selectedModel: 'gemini-1.5-flash',
      selectedProvider: 'google',
      reason: 'fixture',
      fallbackChain: [],
      estimatedCost: 0,
      capabilityMatch: true,
      confidence: 'high',
      healthState: 'UP',
      requestedModelHonored: true,
      requestedModelSubstituted: false,
      features: {},
    });
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [message('ping')] }),
      });
      expect(res.status).toBe(200);
    });
  });

  it('fails closed with 503 when the entitlement lookup itself errors', async () => {
    workspaceAccess.mockRejectedValue(new Error('db down'));
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [message('ping')] }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('entitlement_check_failed');
      expect(completeWithFallback).not.toHaveBeenCalled();
    });
  });

  it('does not apply the workspace rule to an already-authorised Bearer key request', async () => {
    // apiKeyAuth owns the paid decision for cc_live_* requests; the workspace
    // gate must not run a second, stricter check over them.
    const { app } = buildApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/v1/ai/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer cc_live_test' },
        body: JSON.stringify({ messages: [message('ping')] }),
      });
      expect(res.status).toBe(200);
      expect(workspaceAccess).not.toHaveBeenCalled();
    });
  });
});