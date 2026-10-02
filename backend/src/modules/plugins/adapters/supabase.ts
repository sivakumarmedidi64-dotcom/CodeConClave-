/**
 * CodeConClave - Supabase adapter (user-supplied "Project-ref:Service-role-key").
 * Real Supabase REST + Auth admin API on the user's project. Health via the
 * Auth admin endpoint; users + table reads.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const KEY_MAX = 2048;

interface SupaAuth {
  ref: string;
  key: string;
}

function supaAuth(creds: PluginCredentials): SupaAuth | null {
  const raw = creds.kinds['token'] ?? creds.kinds['api_key'];
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const ref = raw.slice(0, sep).replace(/^https?:\/\//, '').replace(/\.supabase\.co.*$/, '');
  const key = raw.slice(sep + 1);
  if (!ref || !key || key.length > KEY_MAX) return null;
  return { ref, key };
}

async function supaFetch(auth: SupaAuth, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`https://${auth.ref}.supabase.co${path}`, {
    ...init,
    headers: {
      apikey: auth.key,
      Authorization: `Bearer ${auth.key}`,
      ...(init?.headers ?? {}),
    },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('supabase_unauthorized', 'Supabase rejected the project ref / service-role key pair');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw AppError.unavailable('supabase_api_rejected', `Supabase API failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return response.json();
}

export const supabaseAdapter: PluginAdapter = {
  id: 'supabase',
  name: 'Supabase',
  provider: 'supabase.com',
  version: '1.0.0',
  capabilities: [PluginCapability.DATABASE],
  oauth: null,
  actions: [
    {
      name: 'users.list',
      permission: PluginPermission.READ,
      scope: 'database:read',
      idempotent: true,
      description: 'Auth users in the project (service-role admin endpoint).',
      inputSchema: z.object({ limit: z.coerce.number().int().min(1).max(200).default(25) }),
    },
    {
      name: 'table.get',
      permission: PluginPermission.READ,
      scope: 'database:read',
      idempotent: true,
      description: 'Read rows from a PostgREST table (by name).',
      inputSchema: z.object({
        table: z.string().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(200).default(25),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!supaAuth(creds)) {
      throw AppError.badRequest('supabase_auth_invalid', 'Supabase connection requires a "project-ref:service-role-key" credential');
    }
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const auth = supaAuth(creds);
    if (!auth) throw AppError.badRequest('supabase_auth_invalid', 'Supabase connection requires a "project-ref:service-role-key" credential');
    try {
      const payload = (await supaFetch(auth, '/auth/v1/admin/users?per_page=1')) as { users?: unknown[] } | unknown[];
      const ok = Array.isArray(payload) || Boolean((payload as { users?: unknown[] })?.users);
      return { ok, latencyMs: Date.now() - start, detail: ok ? `supabase://${auth.ref}` : 'unexpected_response' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'supabase_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const auth = supaAuth(creds);
    if (!auth) throw AppError.badRequest('supabase_auth_invalid', 'Supabase connection requires a "project-ref:service-role-key" credential');
    switch (action.name) {
      case 'users.list':
        return { ok: true, data: await supaFetch(auth, `/auth/v1/admin/users?per_page=${Number(input.limit ?? 25)}`), latencyMs: Date.now() - start };
      case 'table.get':
        return {
          ok: true,
          data: await supaFetch(auth, `/rest/v1/${encodeURIComponent(String(input.table))}?limit=${Number(input.limit ?? 25)}`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Supabase action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};