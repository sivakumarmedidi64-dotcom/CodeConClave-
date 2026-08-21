/**
 * CodeConClave — Slack adapter (Stage 25.5).
 * Real Slack Web API: auth.test for health, conversations.list + channels.history
 * for read, chat.postMessage for send. Typed actions; write/send actions are
 * approval-gated by the shared policy. Token comes from encrypted credentials.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const SLACK_API = 'https://slack.com/api';
const TOKEN_MAX = 200;
const TEXT_MAX = 2000;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function call(method: string, token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams(
      Object.entries(body).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]),
    ),
    signal: outboundSignal(),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    const reason = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw AppError.unavailable('slack_api_rejected', `Slack ${method} failed: ${reason}`);
  }
  return payload;
}

export const slackAdapter: PluginAdapter = {
  id: 'slack',
  name: 'Slack',
  provider: 'slack.com',
  version: '1.0.0',
  capabilities: [PluginCapability.MESSAGES, PluginCapability.CHANNELS],
  oauth: null,
  actions: [
    {
      name: 'messages.list',
      permission: PluginPermission.READ,
      scope: 'channels:read',
      idempotent: true,
      description: 'List recent messages in a Slack channel.',
      inputSchema: z.object({
        channel: z.string().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(50).default(10),
        timeoutMs: z.coerce.number().int().min(100).max(15_000).optional(),
      }),
    },
    {
      name: 'channels.list',
      permission: PluginPermission.READ,
      scope: 'channels:read',
      idempotent: true,
      description: 'List Slack channels the token can access.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'messages.send',
      permission: PluginPermission.SEND,
      scope: 'chat:write',
      idempotent: false,
      description: 'Send a message to a Slack channel.',
      inputSchema: z.object({
        channel: z.string().min(1).max(TOKEN_MAX),
        text: z.string().min(1).max(TEXT_MAX),
        threadTs: z.string().max(200).optional(),
        timeoutMs: z.coerce.number().int().min(100).max(15_000).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('slack_token_missing', 'Slack connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('slack_token_missing', 'Slack connection requires a token credential');
    const payload = await call('auth.test', token, {});
    if (payload.ok !== true) {
      return { ok: false, latencyMs: Date.now() - start, detail: 'auth.test rejected the token' };
    }
    return { ok: true, latencyMs: Date.now() - start, detail: String(payload.user ?? '') };
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('slack_token_missing', 'Slack connection requires a token credential');
    if (action.name === 'messages.list') {
      const payload = await call('conversations.history', token, {
        channel: String(input.channel),
        limit: Number(input.limit ?? 10),
      });
      return { ok: true, data: payload.messages ?? [], latencyMs: Date.now() - start };
    }
    if (action.name === 'channels.list') {
      const payload = await call('conversations.list', token, { types: 'public_channel,private_channel', limit: 100 });
      return { ok: true, data: payload.channels ?? [], latencyMs: Date.now() - start };
    }
    if (action.name === 'messages.send') {
      const payload = await call('chat.postMessage', token, {
        channel: String(input.channel),
        text: String(input.text),
        ...(input.threadTs ? { thread_ts: String(input.threadTs) } : {}),
      });
      return { ok: true, data: payload, latencyMs: Date.now() - start };
    }
    throw AppError.badRequest('plugin_action_unknown', `Unknown Slack action: ${action.name}`);
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};
