/**
 * CodeConClave - GitLab adapter (user-supplied Personal Access Token).
 * Real GitLab REST API v4. Health via /user with PRIVATE-TOKEN; repo + issue
 * reads. Read-only by design.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const GITLAB_API = 'https://gitlab.com/api/v4';
const SLUG_MAX = 300;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function glFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${GITLAB_API}${path}`, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: outboundSignal(),
  });
  if (response.status === 401) {
    throw AppError.unauthorized('gitlab_unauthorized', 'GitLab rejected the token');
  }
  if (!response.ok) throw AppError.unavailable('gitlab_api_rejected', `GitLab API failed (${response.status})`);
  return response.json();
}

export const gitlabAdapter: PluginAdapter = {
  id: 'gitlab',
  name: 'GitLab',
  provider: 'gitlab.com',
  version: '1.0.0',
  capabilities: [PluginCapability.REPOSITORIES, PluginCapability.CONTENTS, PluginCapability.ISSUES],
  oauth: null,
  actions: [
    {
      name: 'user.get',
      permission: PluginPermission.READ,
      scope: 'repositories:read',
      idempotent: true,
      description: 'The GitLab user the token belongs to.',
      inputSchema: z.object({ timeoutMs: z.coerce.number().int().min(100).max(15_000).optional() }),
    },
    {
      name: 'projects.list',
      permission: PluginPermission.READ,
      scope: 'repositories:read',
      idempotent: true,
      description: 'Projects the token can access.',
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        membership: z.boolean().default(false),
      }),
    },
    {
      name: 'project.get',
      permission: PluginPermission.READ,
      scope: 'repositories:read',
      idempotent: true,
      description: 'One project by path (e.g. group/project).',
      inputSchema: z.object({ path: z.string().min(1).max(SLUG_MAX) }),
    },
    {
      name: 'issues.list',
      permission: PluginPermission.READ,
      scope: 'issues:read',
      idempotent: true,
      description: 'Issues for a project.',
      inputSchema: z.object({
        project: z.string().min(1).max(SLUG_MAX),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    if (!tokenFor(creds)) throw AppError.badRequest('gitlab_token_missing', 'GitLab connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('gitlab_token_missing', 'GitLab connection requires a token credential');
    try {
      const payload = (await glFetch(token, '/user')) as { username?: string; id?: number };
      if (!payload?.username) return { ok: false, latencyMs: Date.now() - start, detail: 'unexpected_response' };
      return { ok: true, latencyMs: Date.now() - start, detail: payload.username };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'gitlab_unreachable' };
    }
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('gitlab_token_missing', 'GitLab connection requires a token credential');
    switch (action.name) {
      case 'user.get':
        return { ok: true, data: await glFetch(token, '/user'), latencyMs: Date.now() - start };
      case 'projects.list': {
        const membership = input.membership === true ? 'true' : 'false';
        return {
          ok: true,
          data: await glFetch(token, `/projects?membership=${membership}&per_page=${Number(input.limit ?? 20)}`),
          latencyMs: Date.now() - start,
        };
      }
      case 'project.get':
        return { ok: true, data: await glFetch(token, `/projects/${encodeURIComponent(String(input.path))}`), latencyMs: Date.now() - start };
      case 'issues.list':
        return {
          ok: true,
          data: await glFetch(token, `/projects/${encodeURIComponent(String(input.project))}/issues?per_page=${Number(input.limit ?? 20)}`),
          latencyMs: Date.now() - start,
        };
      default:
        throw AppError.badRequest('plugin_action_unknown', `Unknown GitLab action: ${action.name}`);
    }
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};