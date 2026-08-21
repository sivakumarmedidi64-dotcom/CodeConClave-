/**
 * CodeConClave - Discord adapter (Stage 25.5).
 * Real Discord API: a webhook URL credential posts messages; GET /gateway and
 * /users/@me authorize a bot token for health. Send-only by design: read is
 * not implemented, so messages.send is the sole typed action and is
 * approval-gated by the shared policy. No credentials are ever exposed.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const DISCORD_API = 'https://discord.com/api/v10';
const WEBHOOK_MAX = 300;
const TEXT_MAX = 2000;

function webhookFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['webhook_url'];
}

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

export const discordAdapter: PluginAdapter = {
  id: 'discord',
  name: 'Discord',
  provider: 'discord.com',
  version: '1.0.0',
  capabilities: [PluginCapability.MESSAGES],
  oauth: null,
  actions: [
    {
      name: 'messages.send',
      permission: PluginPermission.SEND,
      scope: 'chat:write',
      idempotent: false,
      description: 'Post a message to a Discord channel via a webhook URL.',
      inputSchema: z.object({
        webhookUrl: z.string().min(1).max(WEBHOOK_MAX).optional(),
        text: z.string().min(1).max(TEXT_MAX),
        username: z.string().max(80).optional(),
        timeoutMs: z.coerce.number().int().min(100).max(15_000).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!webhookFor(creds) && !tokenFor(creds)) {
      throw AppError.badRequest('discord_credentials_missing', 'Discord connection requires a webhook URL or bot token');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    try {
      const token = tokenFor(creds);
      if (token) {
        const response = await fetch(`${DISCORD_API}/users/@me`, {
          headers: { Authorization: `Bot ${token}` },
          signal: outboundSignal(),
        });
        if (!response.ok) return { ok: false, latencyMs: Date.now() - start, detail: `discord_status_${response.status}` };
        return { ok: true, latencyMs: Date.now() - start, detail: 'bot token accepted' };
      }
      const webhook = webhookFor(creds);
      if (!webhook) return { ok: false, latencyMs: Date.now() - start, detail: 'credentials_missing' };
      // Webhook GET returns the webhook metadata without sending anything.
      const response = await fetch(webhook, { signal: outboundSignal() });
      if (!response.ok) return { ok: false, latencyMs: Date.now() - start, detail: `discord_status_${response.status}` };
      return { ok: true, latencyMs: Date.now() - start, detail: 'webhook reachable' };
    } catch {
      return { ok: false, latencyMs: Date.now() - start, detail: 'discord_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    if (action.name === 'messages.send') {
      const webhook = String(input.webhookUrl ?? '') || (webhookFor(creds) ?? '');
      if (!webhook) throw AppError.badRequest('discord_webhook_missing', 'Discord send requires a webhook URL');
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: String(input.text),
          ...(input.username ? { username: String(input.username) } : {}),
        }),
        signal: outboundSignal(),
      });
      if (!response.ok) throw AppError.unavailable('discord_send_failed', `Discord rejected the message (${response.status})`);
      return { ok: true, data: { sent: true }, latencyMs: Date.now() - start };
    }
    throw AppError.badRequest('plugin_action_unknown', `Unknown Discord action: ${action.name}`);
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};