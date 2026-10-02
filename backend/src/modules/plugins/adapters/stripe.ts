/**
 * CodeConClave - Stripe adapter (user-supplied secret key).
 * Real Stripe API v1 (https://api.stripe.com/v1): account + balance for health,
 * read-only lists. Stripe returns JSON by default. Nothing is faked offline.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginPermission } from '@codeconclave/shared';

const STRIPE_API = 'https://api.stripe.com/v1';

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function stripeFetch(key: string, path: string, opts: { method?: string; form?: Record<string, string> } = {}): Promise<unknown> {
  const body = opts.form
    ? new URLSearchParams(
        Object.entries(opts.form).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
      ).toString()
    : undefined;
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('stripe_unauthorized', 'Stripe rejected the secret key');
  }
  if (!response.ok) throw AppError.unavailable('stripe_api_rejected', `Stripe API failed (${response.status})`);
  return response.json();
}

export const stripeAdapter: PluginAdapter = {
  id: 'stripe',
  name: 'Stripe',
  provider: 'stripe.com',
  version: '1.0.0',
  capabilities: [],
  oauth: null,
  actions: [
    {
      name: 'account.get',
      permission: PluginPermission.READ,
      scope: 'account:read',
      idempotent: true,
      description: 'The Stripe account the key belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'balance.get',
      permission: PluginPermission.READ,
      scope: 'account:read',
      idempotent: true,
      description: 'Current Stripe account balance.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'customers.list',
      permission: PluginPermission.READ,
      scope: 'customers:read',
      idempotent: true,
      description: 'List customers, newest first.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
        query: z.string().max(400).optional(),
      }),
    },
    {
      name: 'invoices.list',
      permission: PluginPermission.READ,
      scope: 'invoices:read',
      idempotent: true,
      description: 'List recent invoices.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(10),
        status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    const key = tokenFor(creds);
    if (!key) throw AppError.badRequest('stripe_key_missing', 'Stripe connection requires a secret key credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const key = tokenFor(creds);
    if (!key) throw AppError.badRequest('stripe_key_missing', 'Stripe connection requires a secret key credential');
    try {
      const payload = (await stripeFetch(key, '/account')) as { id?: string; email?: string };
      if (!payload?.id) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.email ?? undefined };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'stripe_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const key = tokenFor(creds);
    if (!key) throw AppError.badRequest('stripe_key_missing', 'Stripe connection requires a secret key credential');
    switch (action.name) {
      case 'account.get':
        return { ok: true, data: await stripeFetch(key, '/account'), latencyMs: Date.now() - start };
      case 'balance.get':
        return { ok: true, data: await stripeFetch(key, '/balance'), latencyMs: Date.now() - start };
      case 'customers.list':
        return {
          ok: true,
          data: await stripeFetch(key, `/customers?limit=${Number(input.limit ?? 10)}${input.query ? `&query=${encodeURIComponent(String(input.query))}` : ''}`),
          latencyMs: Date.now() - start,
        };
      case 'invoices.list':
        return {
          ok: true,
          data: await stripeFetch(key, `/invoices?limit=${Number(input.limit ?? 10)}${input.status ? `&status=${encodeURIComponent(String(input.status))}` : ''}`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Stripe action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};