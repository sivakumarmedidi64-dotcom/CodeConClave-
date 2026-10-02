/**
 * CodeConClave — Cloudflare Worker Razorpay Webhook Adapter
 *
 * Minimal webhook adapter that:
 * 1. Receives raw Razorpay webhook body
 * 2. Verifies HMAC-SHA256 signature using RAZORPAY_WEBHOOK_SECRET
 * 3. Forwards verified event to CodeConClave backend
 * 10. Does NOT independently grant entitlements
 * 11. Does NOT trust browser redirects or customer-submitted claims
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

interface Env {
  // Cloudflare Worker secrets (set via `wrangler secret put`)
  RAZORPAY_WEBHOOK_SECRET: string;
  // Backend URL to forward verified webhooks to
  CODECONCLAVE_BACKEND_URL: string;
  // Optional: internal token for authenticating worker-to-backend requests
  INTERNAL_WEBHOOK_TOKEN?: string;
  // Optional: legacy signing secret valid ONLY while set (used to accept a
  // Razorpay replay signed with the secret that was active at event time;
  // remove after the replay is delivered)
  RAZORPAY_WEBHOOK_SECRET_LEGACY?: string;
}

interface RazorpayWebhookEvent {
  event: string;
  id: string;
  payload: {
    payment?: {
      entity: {
        id: string;
        amount: number;
        email?: string;
        created_at: number;
        notes?: Record<string, string>;
      };
    };
    payment_link?: {
      entity: {
        id?: string;
        reference_id?: string;
        notes?: Record<string, string>;
      };
    };
  };
}

export function verifySignature(
  secret: string,
  rawBody: string,
  signature: string
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return signature.length === expected.length && timingSafeEqual(sigBuffer, expectedBuffer);
}

export async function forwardToBackend(
  backendUrl: string,
  rawBody: string,
  signature: string,
  internalToken?: string
): Promise<{ success: boolean; status: number; body?: string }> {
  const url = `${backendUrl.replace(/\/$/, '')}/api/v1/payments/webhook/razorpay`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Razorpay-Signature': signature,
  };

  if (internalToken) {
    headers['Authorization'] = `Bearer ${internalToken}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: rawBody,
    });

    const body = await response.text();
    return {
      success: response.ok,
      status: response.status,
      body,
    };
  } catch (err) {
    console.error('Failed to forward webhook to backend:', err);
    return {
      success: false,
      status: 502,
      body: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Only accept POST to /razorpay/webhook
    if (request.method !== 'POST' || url.pathname !== '/razorpay/webhook') {
      return new Response('Not Found', { status: 404 });
    }

    // Verify required secrets are configured
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      console.error('RAZORPAY_WEBHOOK_SECRET not configured');
      return new Response('Internal Server Error', { status: 500 });
    }

    if (!env.CODECONCLAVE_BACKEND_URL) {
      console.error('CODECONCLAVE_BACKEND_URL not configured');
      return new Response('Internal Server Error', { status: 500 });
    }

    // Get raw body as text (for HMAC verification) - read ONCE
    const rawBody = await request.text();

    // Get Razorpay signature from header
    const signature = request.headers.get('x-razorpay-signature') ?? '';
    if (!signature) {
      console.warn('Missing x-razorpay-signature header');
      return new Response('Unauthorized', { status: 401 });
    }

    // Verify HMAC-SHA256 signature (current secret, with optional legacy
    // fallback to accept a replay signed with the event-time secret)
    const isValid =
      verifySignature(env.RAZORPAY_WEBHOOK_SECRET, rawBody, signature) ||
      Boolean(
        env.RAZORPAY_WEBHOOK_SECRET_LEGACY &&
          verifySignature(env.RAZORPAY_WEBHOOK_SECRET_LEGACY, rawBody, signature)
      );
    if (!isValid) {
      console.warn('Invalid Razorpay webhook signature');
      return new Response('Invalid signature', { status: 401 });
    }

    // Parse the event from the already-read raw body
    let event: RazorpayWebhookEvent;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // Forward to CodeConClave backend
    const result = await forwardToBackend(
      env.CODECONCLAVE_BACKEND_URL,
      rawBody,
      signature,
      env.INTERNAL_WEBHOOK_TOKEN
    );

    if (!result.success) {
      console.error('Failed to forward webhook to backend:', {
        status: result.status,
        body: result.body,
      });
      // Return 502 so Razorpay will retry
      return new Response('Bad Gateway', { status: 502 });
    }

    // Success - return the backend's response to Razorpay
    return new Response(result.body, {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};