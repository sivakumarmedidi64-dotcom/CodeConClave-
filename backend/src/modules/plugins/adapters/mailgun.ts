/**
 * CodeConClave - Mailgun adapter (user-supplied API key, "key-...").
 * Real Mailgun REST v3. Health via /v3/domains; domain/event reads and a
 * send action (SEND-gated). Domains are supplied with the domain name.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const MAILGUN_API = 'https://api.mailgun.net/v3';
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const KEY_RE = /^key-[A-Za-z0-9]{1,96}$/;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function mgFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${MAILGUN_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('mailgun_unauthorized', 'Mailgun rejected the API key');
  }
  if (!response.ok) throw AppError.unavailable('mailgun_api_rejected', `Mailgun API failed (${response.status})`);
  return response.json();
}

export const mailgunAdapter: PluginAdapter = {
  id: 'mailgun',
  name: 'Mailgun',
  provider: 'mailgun.com',
  version: '1.0.0',
  capabilities: [PluginCapability.EMAIL],
  oauth: null,
  actions: [
    {
      name: 'domains.list',
      permission: PluginPermission.READ,
      scope: 'email:read',
      idempotent: true,
      description: 'Domains on the Mailgun account.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'events.list',
      permission: PluginPermission.READ,
      scope: 'email:read',
      idempotent: true,
      description: 'Recent delivery events for a domain.',
      inputSchema: z.object({ domain: z.string().regex(DOMAIN_RE, 'Provide a domain name e.g. mg.example.com') }),
    },
    {
      name: 'messages.send',
      permission: PluginPermission.SEND,
      scope: 'email:send',
      idempotent: false,
      description: 'Send an email through a verified domain.',
      inputSchema: z.object({
        domain: z.string().regex(DOMAIN_RE, 'Provide a domain name e.g. mg.example.com'),
        from: z.string().min(3).max(400),
        to: z.string().min(3).max(1000),
        subject: z.string().min(1).max(998),
        text: z.string().min(1).max(20_000),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    const token = tokenFor(creds);
    if (!token || !KEY_RE.test(token)) {
      throw AppError.badRequest('mailgun_token_invalid', 'Mailgun connection requires an API key in the form key-...');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('mailgun_token_invalid', 'Mailgun connection requires an API key in the form key-...');
    try {
      const payload = (await mgFetch(token, '/domains')) as { items?: unknown[]; total_count?: number };
      if (typeof payload?.total_count !== 'number') return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: `${payload.total_count} domain(s)` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'mailgun_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('mailgun_token_invalid', 'Mailgun connection requires an API key in the form key-...');
    switch (action.name) {
      case 'domains.list':
        return { ok: true, data: await mgFetch(token, '/domains'), latencyMs: Date.now() - start };
      case 'events.list':
        return { ok: true, data: await mgFetch(token, `/domains/${encodeURIComponent(String(input.domain))}/events?limit=25`), latencyMs: Date.now() - start };
      case 'messages.send': {
        const params = new URLSearchParams();
        params.set('from', String(input.from));
        params.set('to', String(input.to));
        params.set('subject', String(input.subject));
        params.set('text', String(input.text));
        const response = await fetch(`${MAILGUN_API}/domains/${encodeURIComponent(String(input.domain))}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: outboundSignal(),
        });
        if (!response.ok && !(response.status === 401 || response.status === 403)) {
          const body = await response.text().catch(() => '');
          throw AppError.unavailable('mailgun_send_rejected', `Mailgun rejected the send (${response.status}): ${body.slice(0, 200)}`);
        }
        if (!response.ok) {
          throw AppError.unauthorized('mailgun_unauthorized', 'Mailgun rejected the API key');
        }
        return { ok: true, data: await response.json(), latencyMs: Date.now() - start };
      }
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Mailgun action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};