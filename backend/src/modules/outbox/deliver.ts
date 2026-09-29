/**
 * CodeConClave — email delivery transports.
 *
 * PRIMARY rail: Resend HTTP API (unchanged, no SDK dependency).
 * Provider errors are classified so the outbox can decide retry vs permanent
 * failure: 4xx auth/invalid are permanent (retrying cannot help), 429 and 5xx
 * are transient, network failures are treated as provider unreachable.
 * API keys are read from env only and never logged.
 *
 * PILOT rail: Gmail SMTP (TEMPORARY, configuration-driven). Used only when
 * EMAIL_TRANSPORT=gmail, for the zero-cost small real-user pilot without a
 * verified sending domain / RESEND_API_KEY. It is NOT the final production
 * architecture — Resend / domain-based transactional email remains the
 * intended long-term path and is NOT removed. Gmail SMTP sender must be the
 * authenticated account (GMAIL_USER or GMAIL_FROM_EMAIL); the From of the
 * underlying message is therefore derived from the account, never spoofed.
 * GMAIL_APP_PASSWORD is read from env only: never printed, never logged,
 * never returned to any client.
 */
import nodemailer from 'nodemailer';
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

/**
 * Classify an SMTP reply code into the email error taxonomy the outbox drives
 * retry/permanent decisions from.
 *  - 5xx that cannot be fixed by retrying (bad recipient, rejected sender,
 *    message blocked) map to invalid_request (permanent).
 *  - 5xx that are account/credential problems map to auth_invalid (permanent).
 *  - 4xx are transient (from the server's perspective) -> retryable
 *    (provider_unavailable / rate_limited).
 *  - Anything unrecognized stays retryable-unreachable so a RETRY never fakes
 *    a delivery and never turns a transient outage into a silent permanent one.
 */
export function classifySmtpCode(code: number): EmailErrorClass {
  if (code === 530 || code === 534 || code === 535) return 'auth_invalid';
  if (code === 550 || code === 551 || code === 552 || code === 553 || code === 554 || code === 558) return 'invalid_request';
  if (code === 452) return 'rate_limited';
  if (code >= 400 && code < 500) return 'provider_unavailable';
  if (code >= 500 && code < 600) return 'invalid_request';
  return 'provider_unreachable';
}

/**
 * TEMPORARY PILOT transport: send via Gmail SMTP (app password) on a dedicated
 * account. See the module header for scope and the "not the long-term path"
 * guarantee. Creates a fresh SMTP connection per send (pilot volumes,
 * acceptable; the outbox dedupes rows so retries never double-send at the row
 * level). Auth credentials come from env only and are never part of any error
 * text or log.
 */
export async function gmailSmtpSend(input: ResendEmailInput): Promise<void> {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    throw new EmailDeliveryError(
      'not_configured',
      'EMAIL_TRANSPORT=gmail requires GMAIL_USER and GMAIL_APP_PASSWORD (never expose their values)',
    );
  }
  const fromAddress = env.GMAIL_FROM_EMAIL?.trim() || env.GMAIL_USER;
  try {
    await nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 45_000,
    }).sendMail({
      from: `"${(env.APP_NAME || 'CodeConClave').replace(/"/g, '')}" <${fromAddress}>`,
      to: input.to.join(', '),
      subject: input.subject,
      html: input.html,
    });
  } catch (err) {
    const raw = err as { code?: number | string; responseCode?: number | string };
    const codeRaw = raw.responseCode ?? raw.code;
    const code = typeof codeRaw === 'number' ? codeRaw : Number.parseInt(String(codeRaw), 10);
    // nodemailer socket/DNS/TLS failures carry a symbolic code (ETIMEDOUT,
    // ESOCKET, ECONNREFUSED, EDNS, EAUTH, ETLS) with no SMTP reply. Keep the
    // bounded symbol for diagnostics only — never a credential or message body.
    const symbol = String(raw.code ?? '').slice(0, 32);
    const hasReply = Number.isFinite(code);
    const errorClass: EmailErrorClass = hasReply
      ? classifySmtpCode(code)
      : symbol === 'EAUTH'
        ? 'auth_invalid'
        : 'provider_unreachable';
    logger.warn('gmail smtp delivery rejected', { errorClass, status: hasReply ? code : null, smtp: symbol || null });
    // The SMTP server text may echo an address but never a credential; keep
    // internal detail out of the persisted error class and keep it bounded.
    throw new EmailDeliveryError(errorClass, `Gmail SMTP delivery failed (${errorClass})`, hasReply ? code : null);
  }
}