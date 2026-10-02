/**
 * CodeConClave - Twilio adapter (user-supplied "Account SID:Auth Token").
 * Real Twilio REST API: account identity for health + message list, plus a
 * send action (approval-gated). Single credential value is "AC...:authToken".
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const TWILIO_API = 'https://api.twilio.com/2010-04-01/Accounts';
const E164 = /^\+[1-9]\d{1,14}$/;
const TEXT_MAX = 1600;

interface TwilioAuth {
  sid: string;
  authToken: string;
}

function twilioAuth(creds: PluginCredentials): TwilioAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const sid = raw.slice(0, sep);
  const authToken = raw.slice(sep + 1);
  if (!sid.startsWith('AC') || sid.length < 30 || !authToken) return null;
  return { sid, authToken };
}

async function twilioFetch(auth: TwilioAuth, path: string, opts: { method?: string; form?: Record<string, string> } = {}): Promise<unknown> {
  const body = opts.form ? new URLSearchParams(opts.form as Record<string, string>).toString() : undefined;
  const response = await fetch(`${TWILIO_API}/${encodeURIComponent(auth.sid)}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.sid}:${auth.authToken}`).toString('base64')}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('twilio_unauthorized', 'Twilio rejected the Account SID / Auth Token pair');
  }
  if (!response.ok) throw AppError.unavailable('twilio_api_rejected', `Twilio API failed (${response.status})`);
  return response.json();
}

export const twilioAdapter: PluginAdapter = {
  id: 'twilio',
  name: 'Twilio',
  provider: 'twilio.com',
  version: '1.0.0',
  capabilities: [PluginCapability.MESSAGES],
  oauth: null,
  actions: [
    {
      name: 'account.get',
      permission: PluginPermission.READ,
      scope: 'messages:read',
      idempotent: true,
      description: 'The Twilio account the SID belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'messages.list',
      permission: PluginPermission.READ,
      scope: 'messages:read',
      idempotent: true,
      description: 'Recent messages for the account.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
        to: z.string().regex(E164).optional(),
      }),
    },
    {
      name: 'messages.send',
      permission: PluginPermission.SEND,
      scope: 'messages:send',
      idempotent: false,
      description: 'Send an SMS message (approval required).',
      inputSchema: z.object({
        to: z.string().regex(E164),
        from: z.string().regex(E164),
        body: z.string().min(1).max(TEXT_MAX),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!twilioAuth(creds)) {
      throw AppError.badRequest('twilio_auth_invalid', 'Twilio connection requires an "Account SID:Auth Token" credential');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = twilioAuth(creds);
    if (!auth) throw AppError.badRequest('twilio_auth_invalid', 'Twilio connection requires an "Account SID:Auth Token" credential');
    try {
      const payload = (await twilioFetch(auth, `.json`)) as { sid?: string; friendly_name?: string };
      if (!payload?.sid) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.friendly_name ?? undefined };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'twilio_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = twilioAuth(creds);
    if (!auth) throw AppError.badRequest('twilio_auth_invalid', 'Twilio connection requires an "Account SID:Auth Token" credential');
    switch (action.name) {
      case 'account.get':
        return { ok: true, data: await twilioFetch(auth, `.json`), latencyMs: Date.now() - start };
      case 'messages.list':
        return {
          ok: true,
          data: await twilioFetch(auth, `/Messages.json?PageSize=${Number(input.limit ?? 10)}${input.to ? `&To=${encodeURIComponent(String(input.to))}` : ''}`),
          latencyMs: Date.now() - start,
        };
      case 'messages.send':
        return {
          ok: true,
          data: await twilioFetch(auth, `/Messages.json`, {
            method: 'POST',
            form: { To: String(input.to), From: String(input.from), Body: String(input.body) },
          }),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Twilio action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};