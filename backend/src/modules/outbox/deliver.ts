/**
 * CodeConClave — email delivery via Resend HTTP API (no SDK dependency).
 * Provider errors are classified so the outbox can decide retry vs permanent
 * failure: 4xx auth/invalid are permanent (retrying cannot help), 429 and 5xx
 * are transient, network failures are treated as provider unreachable.
 * API keys are read from env only and never logged.
 */
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { outboundSignal } from '../../shared/http-timeout.js';

export type EmailErrorClass =
  | 'not_configured'
  | 'auth_invalid'
  | 'invalid_request'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'provider_unreachable';

export class EmailDeliveryError extends Error {
  readonly code: EmailErrorClass;
  readonly status: number | null;

  constructor(code: EmailErrorClass, message: string, status: number | null = null) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = code;
    this.status = status;
  }
}

/** Classify a Resend HTTP status into transient vs permanent error classes. */
export function classifyResendStatus(status: number): EmailErrorClass {
  if (status === 401 || status === 403) return 'auth_invalid';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_unavailable';
}

export interface ResendEmailInput {
  from: string;
  to: string[];
  subject: string;
  html: string;
  /** Idempotency key sent to Resend so a retried delivery is not duplicated. */
  idempotencyKey?: string;
}

export async function resendFetch(input: ResendEmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) throw new EmailDeliveryError('not_configured', 'RESEND_API_KEY is not configured');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
      }),
      signal: outboundSignal(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('resend unreachable', { error: message });
    throw new EmailDeliveryError('provider_unreachable', 'Resend API unreachable');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger.warn('resend delivery rejected', { status: response.status });
    throw new EmailDeliveryError(classifyResendStatus(response.status), `Resend delivery failed (${response.status})`, response.status);
  }
}