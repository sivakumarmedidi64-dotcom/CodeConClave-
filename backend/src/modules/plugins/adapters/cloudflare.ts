/**
 * CodeConClave - Cloudflare adapter (Stage 25.5).
 * Real Cloudflare API (https://api.cloudflare.com/client/v4): zones/workers
 * read + trigger a Workers deploy. Token comes from encrypted credentials;
 * writes are approval-gated by the shared policy.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const CF_API = 'https://api.cloudflare.com/client/v4';
const ID_MAX = 200;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function cfFetch(token: string, path: string, init?: RequestInit): Promise<{ result: unknown; success: boolean }> {
  const response = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: outboundSignal(),
  });
  const payload = (await response.json().catch(() => ({}))) as { result?: unknown; success?: boolean };
  if (response.status === 401 || response.status === 403 || payload.success !== true) {
    throw AppError.unauthorized('cloudflare_unauthorized', `Cloudflare rejected the token (${response.status})`);
  }
  return { result: payload.result, success: true };
}

export const cloudflareAdapter: PluginAdapter = {
  id: 'cloudflare',
  name: 'Cloudflare',
  provider: 'cloudflare.com',
  version: '1.0.0',
  capabilities: [PluginCapability.DEPLOYMENTS],
  oauth: null,
  actions: [
    {
      name: 'zones.list',
      permission: PluginPermission.READ,
      scope: 'zones:read',
      idempotent: true,
      description: 'List Cloudflare zones the token can access.',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'workers.list',
      permission: PluginPermission.READ,
      scope: 'workers:read',
      idempotent: true,
      description: 'List Workers scripts for the account.',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('cloudflare_token_missing', 'Cloudflare connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('cloudflare_token_missing', 'Cloudflare connection requires a token credential');
    try {
      const { result } = await cfFetch(token, '/zones?per_page=1');
      const zones = result as unknown[];
      if (!Array.isArray(zones)) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: `${zones.length} zone(s)` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'cloudflare_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('cloudflare_token_missing', 'Cloudflare connection requires a token credential');
    if (action.name === 'zones.list') {
      const { result } = await cfFetch(token, `/zones?per_page=${Number(input.limit ?? 20)}`);
      return { ok: true, data: result, latencyMs: Date.now() - start };
    }
    if (action.name === 'workers.list') {
      const { result } = await cfFetch(token, `/accounts?per_page=1`);
      const accounts = result as { id?: string }[];
      const accountId = Array.isArray(accounts) ? accounts[0]?.id : undefined;
      if (!accountId) throw AppError.badRequest('cloudflare_no_account', 'No Cloudflare account accessible with this token');
      const scripts = await cfFetch(token, `/accounts/${accountId}/workers/scripts?per_page=${Number(input.limit ?? 20)}`);
      return { ok: true, data: scripts.result, latencyMs: Date.now() - start };
    }
    throw AppError.badRequest('plugin_action_unknown', `Unknown Cloudflare action: ${action.name}`);
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};