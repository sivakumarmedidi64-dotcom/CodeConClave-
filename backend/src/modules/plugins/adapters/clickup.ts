/**
 * CodeConClave - ClickUp adapter (user-supplied Personal Access Token).
 * Real ClickUp REST v2. Health via /user; teams/lists/tasks reads.
 * Read-only by design.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const CU_API = 'https://api.clickup.com/api/v2';
const ID_MAX = 64;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function cuFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${CU_API}${path}`, {
    headers: { Authorization: token },
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('clickup_unauthorized', 'ClickUp rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('clickup_api_rejected', `ClickUp API failed (${response.status})`);
  return response.json();
}

export const clickupAdapter: PluginAdapter = {
  id: 'clickup',
  name: 'ClickUp',
  provider: 'clickup.com',
  version: '1.0.0',
  capabilities: [PluginCapability.PROJECTS],
  oauth: null,
  actions: [
    {
      name: 'user.get',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'The ClickUp user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'teams.get',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Workspaces the token can access.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'tasks.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'Tasks in a list.',
      inputSchema: z.object({ list_id: z.string().min(1).max(ID_MAX) }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('clickup_token_missing', 'ClickUp connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('clickup_token_missing', 'ClickUp connection requires a token credential');
    try {
      const payload = (await cuFetch(token, '/user')) as { user?: { id?: number } };
      if (!payload?.user?.id) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'clickup_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('clickup_token_missing', 'ClickUp connection requires a token credential');
    switch (action.name) {
      case 'user.get':
        return { ok: true, data: await cuFetch(token, '/user'), latencyMs: Date.now() - start };
      case 'teams.get':
        return { ok: true, data: await cuFetch(token, '/team'), latencyMs: Date.now() - start };
      case 'tasks.list':
        return {
          ok: true,
          data: await cuFetch(token, `/list/${encodeURIComponent(String(input.list_id))}/task`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown ClickUp action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};