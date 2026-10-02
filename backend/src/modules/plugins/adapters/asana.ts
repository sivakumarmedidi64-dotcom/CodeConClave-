/**
 * CodeConClave - Asana adapter (user-supplied Personal Access Token).
 * Real Asana API v1 (https://app.asana.com/api/1.0): user identity for health,
 * projects/tasks listing and task creation. Write action is approval-gated.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const ASANA_API = 'https://app.asana.com/api/1.0';
const ID_MAX = 64;
const TEXT_MAX = 2000;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function asanaFetch(token: string, path: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(`${ASANA_API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('asana_unauthorized', 'Asana rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('asana_api_rejected', `Asana API failed (${response.status})`);
  return response.json();
}

export const asanaAdapter: PluginAdapter = {
  id: 'asana',
  name: 'Asana',
  provider: 'asana.com',
  version: '1.0.0',
  capabilities: [PluginCapability.PROJECTS],
  oauth: null,
  actions: [
    {
      name: 'users.me',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'The Asana user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'projects.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'List projects accessible with the token.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        workspace: z.string().max(ID_MAX).optional(),
      }),
    },
    {
      name: 'tasks.list',
      permission: PluginPermission.READ,
      scope: 'projects:read',
      idempotent: true,
      description: 'List tasks in a project.',
      inputSchema: z.object({
        project: z.string().min(1).max(ID_MAX),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
    {
      name: 'task.create',
      permission: PluginPermission.CREATE,
      scope: 'projects:create',
      idempotent: false,
      description: 'Create a task (write; approval required).',
      inputSchema: z.object({
        workspace: z.string().min(1).max(ID_MAX),
        projects: z.array(z.string().min(1).max(ID_MAX)),
        name: z.string().min(1).max(TEXT_MAX),
        notes: z.string().max(TEXT_MAX).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('asana_token_missing', 'Asana connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('asana_token_missing', 'Asana connection requires a token credential');
    try {
      const payload = (await asanaFetch(token, '/users/me')) as { data?: { name?: string; email?: string } };
      if (!payload?.data?.email) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.data.name ?? payload.data.email };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'asana_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('asana_token_missing', 'Asana connection requires a token credential');
    switch (action.name) {
      case 'users.me':
        return { ok: true, data: await asanaFetch(token, '/users/me'), latencyMs: Date.now() - start };
      case 'projects.list':
        return {
          ok: true,
          data: await asanaFetch(
            token,
            `/projects?limit=${Number(input.limit ?? 20)}${input.workspace ? `&workspace=${encodeURIComponent(String(input.workspace))}` : ''}`,
          ),
          latencyMs: Date.now() - start,
        };
      case 'tasks.list':
        return {
          ok: true,
          data: await asanaFetch(token, `/tasks?project=${encodeURIComponent(String(input.project))}&limit=${Number(input.limit ?? 20)}`),
          latencyMs: Date.now() - start,
        };
      case 'task.create':
        return {
          ok: true,
          data: await asanaFetch(token, '/tasks', {
            method: 'POST',
            body: {
              data: {
                workspace: String(input.workspace),
                projects: (input.projects as string[]) ?? [],
                name: String(input.name),
                ...(input.notes ? { notes: String(input.notes) } : {}),
              },
            },
          }),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown Asana action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};