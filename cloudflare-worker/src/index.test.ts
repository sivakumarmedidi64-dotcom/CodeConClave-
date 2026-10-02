import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import worker from '../src/index';

const TEST_SECRET = 'test_webhook_secret_12345';
const TEST_BACKEND_URL = 'https://backend.example.com';

function rawEvent(overrides: { event?: string } = {}): string {
  return JSON.stringify({
    event: overrides.event ?? 'payment.captured',
    id: 'evt_1',
    payload: {
      payment: {
        entity: {
          id: 'pay_1',
          amount: 99900,
          email: 'user@example.com',
          created_at: 1700000000,
          notes: { reference: 'CCPRO-ABC123' },
        },
      },
      payment_link: {
        entity: {
          id: 'plink_1',
          reference_id: 'CCPRO-ABC123',
          notes: { reference: 'CCPRO-ABC123' },
        },
      },
    },
  });
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function testEnv(overrides: { RAZORPAY_WEBHOOK_SECRET?: string } = {}): {
  RAZORPAY_WEBHOOK_SECRET: string;
  CODECONCLAVE_BACKEND_URL: string;
  INTERNAL_WEBHOOK_TOKEN: string;
} {
  return {
    RAZORPAY_WEBHOOK_SECRET: TEST_SECRET,
    CODECONCLAVE_BACKEND_URL: TEST_BACKEND_URL,
    INTERNAL_WEBHOOK_TOKEN: 'tok_1',
    ...overrides,
  };
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://worker.example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('Cloudflare Worker Razorpay Webhook Adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-POST requests', async () => {
    const request = new Request('https://worker.example.com/razorpay/webhook', { method: 'GET' });
    const response = await worker.fetch(request, testEnv());
    expect(response.status).toBe(404);
  });

  it('rejects wrong path', async () => {
    const body = rawEvent();
    const response = await worker.fetch(
      post('/nope', body, { 'x-razorpay-signature': sign(TEST_SECRET, body) }),
      testEnv(),
    );
    expect(response.status).toBe(404);
  });

  it('rejects missing signature header', async () => {
    const response = await worker.fetch(post('/razorpay/webhook', rawEvent()), testEnv());
    expect(response.status).toBe(401);
  });

  it('rejects invalid signature (timing-safe path, length mismatch)', async () => {
    const response = await worker.fetch(
      post('/razorpay/webhook', rawEvent(), { 'x-razorpay-signature': 'deadbeef' }),
      testEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('rejects tampered signature for modified body', async () => {
    const body = rawEvent();
    const sig = sign(TEST_SECRET, body);
    const modified = body.replace('99900', '100000');
    const response = await worker.fetch(
      post('/razorpay/webhook', modified, { 'x-razorpay-signature': sig }),
      testEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('rejects invalid JSON body (after signature check)', async () => {
    const body = '{not json';
    const response = await worker.fetch(
      post('/razorpay/webhook', body, { 'x-razorpay-signature': sign(TEST_SECRET, body) }),
      testEnv(),
    );
    expect(response.status).toBe(400);
  });

  it('returns 500 when webhook secret is not configured (never forwards)', async () => {
    const body = rawEvent();
    const response = await worker.fetch(
      post('/razorpay/webhook', body, { 'x-razorpay-signature': sign(TEST_SECRET, body) }),
      testEnv({ RAZORPAY_WEBHOOK_SECRET: '' }),
    );
    expect(response.status).toBe(500);
  });

  it('forwards a verified webhook to the backend with raw body + signature + internal token', async () => {
    const body = rawEvent();
    const signature = sign(TEST_SECRET, body);
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const response = await worker.fetch(post('/razorpay/webhook', body, { 'x-razorpay-signature': signature }), testEnv());
    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://backend.example.com/api/v1/payments/webhook/razorpay',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Razorpay-Signature': signature,
          Authorization: 'Bearer tok_1',
        }),
        body,
      }),
    );
  });

  it('returns 502 on backend error so Razorpay retries (never grants entitlement)', async () => {
    const body = rawEvent();
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const response = await worker.fetch(
      post('/razorpay/webhook', body, { 'x-razorpay-signature': sign(TEST_SECRET, body) }),
      testEnv(),
    );
    expect(response.status).toBe(502);
  });

  it('verifySignature rejects a wrong-length signature before timing-safe compare', async () => {
    const { verifySignature } = await import('../src/index');
    expect(verifySignature(TEST_SECRET, rawEvent(), 'a')).toBe(false);
    expect(verifySignature(TEST_SECRET, rawEvent(), sign(TEST_SECRET, rawEvent()))).toBe(true);
  });
});