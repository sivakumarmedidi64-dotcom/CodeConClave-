/**
 * CodeConClave — Resend adapter (Phase 10).
 * Exposes email operations through the plugin/integration layer without
 * duplicating the notification/outbox delivery engine: the outbox remains the
 * engine for notifications; this adapter is the plugin surface for direct
 * transactional sends + delivery metadata, talking to the same Resend API
 * with the same server-side key.
 */
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const str = z.string().min(1).max(500);

function apiKeyFor(creds: PluginCredentials): string {
  const key = creds.kinds['api_key'] ?? env.RESEND_API_KEY;
  if (!key) throw AppError.badRequest('credentials_missing', 'Resend API key is required (store one on connect)');
  return key;
}

export const resendAdapter: PluginAdapter = {
  id: 'resend',
  name: 'Resend Email',
  provider: 'api.resend.com',
  version: '1.0.0',
  capabilities: [PluginCapability.EMAIL],
  oauth: null,
  actions: [
    {
      name: 'email.send',
      permission: PluginPermission.SEND,
      scope: 'email:send',
      idempotent: true,
      description: 'Send a transactional email via Resend (idempotency key supported).',
      inputSchema: z.object({
        from: z.string().max(320).default(env.RESEND_FROM_EMAIL),
        to: z.array(str).min(1).max(50),
        subject: str,
        html: str,
        idempotencyKey: str.optional(),
      }),
    },
    {
      name: 'email.status',
      permission: PluginPermission.READ,
      scope: 'email:read',
      idempotent: true,
      description: 'Delivery metadata for a sent email (id from email.send).',
      inputSchema: z.object({ emailId: str }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    apiKeyFor(creds);
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    try {
      const key = apiKeyFor(creds);
      const response = await fetch('https://api.resend.com/emails', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        signal: outboundSignal(),
      });
      if (!response.ok) return { ok: false, latencyMs: Date.now() - start, detail: `resend_status_${response.status}` };
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start, detail: 'resend_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const key = apiKeyFor(creds);
    if (action.name === 'email.send') {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...(input.idempotencyKey ? { 'Idempotency-Key': String(input.idempotencyKey) } : {}),
        },
        body: JSON.stringify({
          from: String(input.from),
          to: input.to as string[],
          subject: String(input.subject),
          html: String(input.html),
        }),
        signal: outboundSignal(),
      });
      if (!response.ok) throw AppError.unavailable('resend_send_failed', `Resend rejected the send (${response.status})`);
      const data = (await response.json()) as { id?: string };
      return { ok: true, data: { id: data.id ?? null }, latencyMs: Date.now() - start };
    }
    if (action.name === 'email.status') {
      const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(String(input.emailId))}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: outboundSignal(),
      });
      if (!response.ok) throw AppError.notFound('Email', 'resend_email_not_found');
      return { ok: true, data: await response.json(), latencyMs: Date.now() - start };
    }
    throw AppError.badRequest('plugin_action_unknown', `Unknown Resend action: ${action.name}`);
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};