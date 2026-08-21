/**
 * CodeConClave - Sentry adapter (Stage 25.5).
 * Real Sentry API (https://sentry.io/api/0): organization listing for health,
 * issues list/read. Read-only by design (monitoring capability). Token comes
 * from encrypted credentials; nothing is faked when the API is unreachable.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const SENTRY_API = 'https://sentry.io/api/0';
const SLUG_MAX = 200;
const ID_MAX = 120;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function sentryFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${SENTRY_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('sentry_unauthorized', 'Sentry rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('sentry_api_rejected', `Sentry API failed (${response.status})`);
  return response.json();
}

export const sentryAdapter: PluginAdapter = {
  id: 'sentry',
  name: 'Sentry',
  provider: 'sentry.io',
  version: '1.0.0',
  capabilities: [PluginCapability.MONITORING],
  oauth: null,
  actions: [
    {
      name: 'organizations.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'List Sentry organizations the token can access.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'issues.list',
      permission: PluginPermission.READ,
      scope: 'issues:read',
      idempotent: true,
      description: 'List recent issues for a Sentry project.',
      inputSchema: z.object({
        organization: z.string().min(1).max(SLUG_MAX),
        project: z.string().min(1).max(SLUG_MAX),
        limit: z.coerce.number().int().min(1).max(50).default(10),
        timeoutMs: z.coerce.number().int().min(100).max(15_000).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('sentry_token_missing', 'Sentry connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('sentry_token_missing', 'Sentry connection requires a token credential');
    try {
      const payload = (await sentryFetch(token, '/organizations/')) as { slug?: string }[];
      if (!Array.isArray(payload)) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: `${payload.length} organization(s)` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'sentry_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('sentry_token_missing', 'Sentry connection requires a token credential');
    if (action.name === 'organizations.list') {
      const data = (await sentryFetch(token, '/organizations/')) as unknown;
      return { ok: true, data, latencyMs: Date.now() - start };
    }
    if (action.name === 'issues.list') {
      const org = encodeURIComponent(String(input.organization));
      const project = encodeURIComponent(String(input.project));
      const data = await sentryFetch(
        token,
        `/projects/${org}/${project}/issues/?limit=${Number(input.limit ?? 10)}`,
      );
      return { ok: true, data, latencyMs: Date.now() - start };
    }
    throw AppError.badRequest('plugin_action_unknown', `Unknown Sentry action: ${action.name}`);
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};