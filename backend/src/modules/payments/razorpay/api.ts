/**
 * CodeConClave — server-only Razorpay REST client for the API reconciliation rail.
 *
 * Used ONLY by the bounded reconciliation service and the founder "Verify
 * payment with Razorpay" action. Credentials (RAZORPAY_KEY_ID /
 * RAZORPAY_KEY_SECRET) are read from env, kept server-side, never logged, never
 * returned by any endpoint and never bundled to the desktop/frontend. The
 * response surface is reduced here to safe, immutable verification fields —
 * full provider payloads (which may embed customer data) never leave this module.
 */
import { env } from '../../../config/env.js';

const RAZORPAY_BASE_URL = 'https://api.razorpay.com/v1';

export type RazorpayApiErrorCode = 'auth_error' | 'not_found' | 'rate_limited' | 'http_error' | 'network';

export class RazorpayApiError extends Error {
  readonly code: RazorpayApiErrorCode;
  readonly status: number | null;
  constructor(code: RazorpayApiErrorCode, status: number | null = null, message?: string) {
    super(message ?? `Razorpay API error (${code})`);
    this.name = 'RazorpayApiError';
    this.code = code;
    this.status = status;
  }
}

/** Safe, normalized Payment entity — amount in paise, currency upper-cased. */
export interface RazorpayPayment {
  id: string;
  status: string;
  captured: boolean;
  amount: number;
  amount_refunded: number;
  currency: string;
  refund_status: string;
  email: string | null;
  created_at: number; // epoch seconds
  method: string | null;
}

/** Whether both server-only API credentials are configured (optional rail). */
export function razorpayApiConfigured(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

function authHeader(): string | null {
  const id = env.RAZORPAY_KEY_ID;
  const secret = env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) return null;
  return `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
}

async function get<T>(path: string): Promise<T> {
  const auth = authHeader();
  if (!auth) throw new RazorpayApiError('auth_error', 401, 'Razorpay API credentials are not configured');
  let res: Response;
  try {
    res = await fetch(`${RAZORPAY_BASE_URL}${path}`, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RazorpayApiError('network', null, 'Razorpay API unreachable');
  }
  if (res.status === 401 || res.status === 403) throw new RazorpayApiError('auth_error', res.status, 'Razorpay API authentication failed');
  if (res.status === 429) throw new RazorpayApiError('rate_limited', res.status, 'Razorpay API rate limit hit');
  if (res.status === 404) throw new RazorpayApiError('not_found', res.status, 'Razorpay resource not found');
  if (!res.ok) throw new RazorpayApiError('http_error', res.status, `Razorpay API HTTP ${res.status}`);
  return (await res.json()) as T;
}

function normalizePayment(raw: unknown): RazorpayPayment | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !/^pay_[A-Za-z0-9_-]{4,}$/.test(p.id)) return null;
  return {
    id: p.id,
    status: typeof p.status === 'string' ? p.status : 'unknown',
    captured: p.captured === true,
    amount: typeof p.amount === 'number' ? p.amount : 0,
    amount_refunded: typeof p.amount_refunded === 'number' ? p.amount_refunded : 0,
    currency: typeof p.currency === 'string' ? p.currency.toUpperCase() : 'INR',
    refund_status: typeof p.refund_status === 'string' ? p.refund_status : '',
    email: typeof p.email === 'string' && p.email.length > 0 ? p.email : null,
    created_at: typeof p.created_at === 'number' ? p.created_at : 0,
    method: typeof p.method === 'string' ? p.method : null,
  };
}

/** Fetch a single payment by id (founder verify / explicit-id path). */
export async function fetchPayment(paymentId: string): Promise<RazorpayPayment | null> {
  try {
    const raw = await get<unknown>(`/payments/${encodeURIComponent(paymentId)}`);
    return normalizePayment(raw);
  } catch (err) {
    if (err instanceof RazorpayApiError && err.code === 'not_found') return null;
    throw err;
  }
}

/** Payments raised against a Payment Link — the product-context binding. */
export async function fetchLinkPayments(linkId: string): Promise<RazorpayPayment[]> {
  const raw = await get<{ items?: unknown[] }>(`/payment_links/${encodeURIComponent(linkId)}/payments?count=100`);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return items.map(normalizePayment).filter((p): p is RazorpayPayment => p !== null);
}

/**
 * Credential health WITHOUT leaking values: MISSING (not configured), VALID
 * (authenticated GET succeeded), INVALID (auth rejected), PRESENT (configured
 * but the probe could not conclude — e.g. provider network/5xx).
 */
export async function probeRazorpayCredentials(): Promise<'MISSING' | 'VALID' | 'INVALID' | 'PRESENT'> {
  if (!razorpayApiConfigured()) return 'MISSING';
  const target =
    env.RAZORPAY_PRO_PAYMENT_LINK_ID ??
    env.RAZORPAY_TEAM_PAYMENT_LINK_ID ??
    env.RAZORPAY_API_PAYMENT_LINK_ID;
  try {
    if (target) await get<unknown>(`/payment_links/${encodeURIComponent(target)}?count=1`);
    else await get<unknown>('/payments?count=1');
    return 'VALID';
  } catch (err) {
    if (err instanceof RazorpayApiError && err.code === 'auth_error') return 'INVALID';
    return 'PRESENT';
  }
}