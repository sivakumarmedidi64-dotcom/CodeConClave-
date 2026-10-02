/**
 * CodeConClave — GitHub adapter (Phase 10).
 * Uses the existing CodeConClave Pro GitHub App configuration (GITHUB_APP_*)
 * or a user-supplied encrypted token. Only genuinely implemented capabilities
 * are declared: repositories, contents, branches, issues, pull_requests,
 * checks. Webhooks are NOT declared — when GITHUB_WEBHOOK_* are unset the
 * integration stays disabled and no webhook event is faked.
 */
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const BASE_URL = 'https://api.github.com';

const str = z.string().min(1).max(500);

async function githubFetch(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CodeConClave-Pro',
    },
    signal: outboundSignal(),
  });
  if (response.status === 401 || response.status === 403) {
    throw AppError.unauthorized('github_unauthorized', 'GitHub rejected the token');
  }
  if (response.status === 404) {
    throw AppError.notFound('Repository', 'github_not_found');
  }
  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status})`);
  }
  return response.json();
}

/**
 * Resolve the token for a connection: stored credential first; otherwise the
 * GitHub App installation flow (JWT → installation access token) when the App
 * is configured. Never invented: without either, authentication fails.
 */
async function tokenFor(ctx: { id: string }, creds: PluginCredentials): Promise<string> {
  const stored = creds.kinds['token'];
  if (stored) return stored;
  if (env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY) {
    const { createSign } = await import('node:crypto');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 60 * 9, iss: env.GITHUB_APP_ID }),
    ).toString('base64url');
    const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(env.GITHUB_PRIVATE_KEY);
    const jwt = `${header}.${body}.${signature.toString('base64url')}`;
    const installations = await fetch(`${BASE_URL}/app/installations`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'CodeConClave-Pro' },
      signal: outboundSignal(),
    });
    if (!installations.ok) throw AppError.unavailable('github_app_installations_failed', 'GitHub App is not installed');
    const list = (await installations.json()) as { id: number }[];
    if (list.length === 0) throw AppError.unavailable('github_app_not_installed', 'CodeConClave Pro App is not installed on any account');
    const tokenRes = await fetch(`${BASE_URL}/app/installations/${list[0]!.id}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'CodeConClave-Pro' },
      signal: outboundSignal(),
    });
    if (!tokenRes.ok) throw AppError.unauthorized('github_unauthorized', 'Failed to exchange the App token');
    const payload = (await tokenRes.json()) as { token: string };
    return payload.token;
  }
  throw AppError.badRequest('credentials_missing', 'GitHub token is required (store one on connect)');
}

export const githubAdapter: PluginAdapter = {
  id: 'github',
  name: 'GitHub',
  provider: 'github.com',
  version: '1.0.0',
  capabilities: [
    PluginCapability.REPOSITORIES,
    PluginCapability.CONTENTS,
    PluginCapability.BRANCHES,
    PluginCapability.ISSUES,
    PluginCapability.PULL_REQUESTS,
    PluginCapability.CHECKS,
  ],
  oauth: null,
  actions: [
    {
      name: 'repositories.list',
      permission: PluginPermission.READ,
      scope: 'repositories:read',
      idempotent: true,
      description: 'List repositories the token can access (GitHub App: installed repositories).',
      inputSchema: z.object({ perPage: z.coerce.number().int().min(1).max(100).optional() }),
    },
    {
      name: 'repositories.get',
      permission: PluginPermission.READ,
      scope: 'repositories:read',
      idempotent: true,
      description: 'Repository metadata for one repo.',
      inputSchema: z.object({ owner: str, repo: str }),
    },
    {
      name: 'repositories.contents',
      permission: PluginPermission.READ,
      scope: 'contents:read',
      idempotent: true,
      description: 'Read a file or directory listing from the default branch.',
      inputSchema: z.object({ owner: str, repo: str, path: z.string().max(500).default(''), ref: str.optional() }),
    },
    {
      name: 'repositories.branches',
      permission: PluginPermission.READ,
      scope: 'branches:read',
      idempotent: true,
      description: 'List branches of a repository.',
      inputSchema: z.object({ owner: str, repo: str }),
    },
    {
      name: 'issues.list',
      permission: PluginPermission.READ,
      scope: 'issues:read',
      idempotent: true,
      description: 'List issues (foundation; read-only).',
      inputSchema: z.object({ owner: str, repo: str, state: z.enum(['open', 'closed', 'all']).optional(), perPage: z.coerce.number().int().min(1).max(100).optional() }),
    },
    {
      name: 'pulls.list',
      permission: PluginPermission.READ,
      scope: 'pull_requests:read',
      idempotent: true,
      description: 'List pull requests (foundation; read-only).',
      inputSchema: z.object({ owner: str, repo: str, state: z.enum(['open', 'closed', 'all']).optional(), perPage: z.coerce.number().int().min(1).max(100).optional() }),
    },
    {
      name: 'checks.list',
      permission: PluginPermission.READ,
      scope: 'checks:read',
      idempotent: true,
      description: 'Check runs for a commit (checks/status foundation).',
      inputSchema: z.object({ owner: str, repo: str, ref: str, perPage: z.coerce.number().int().min(1).max(100).optional() }),
    },
  ],
  authenticate: async (ctx, creds) => {
    await tokenFor(ctx, creds);
  },
  healthCheck: async (ctx, creds) => {
    const start = Date.now();
    try {
      const token = await tokenFor(ctx, creds);
      await githubFetch(token, '/user');
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start, detail: 'github_unreachable' };
    }
  },
  execute: async (ctx, creds, action, input) => {
    const start = Date.now();
    const token = await tokenFor(ctx, creds);
    const path = actionNameToPath(action.name, input);
    const data = await githubFetch(token, path);
    return { ok: true, data, latencyMs: Date.now() - start };
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};

function actionNameToPath(action: string, input: Record<string, unknown>): string {
  const owner = String(input.owner ?? '');
  const repo = String(input.repo ?? '');
  const ref = input.ref ? String(input.ref) : undefined;
  const perPage = input.perPage ? Number(input.perPage) : undefined;
  const state = input.state ? String(input.state) : undefined;
  const qs = (p: Record<string, string>) => {
    const entries = Object.entries(p).filter(([, v]) => v !== undefined);
    return entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : '';
  };
  switch (action) {
    case 'repositories.list':
      return `/user/repos${qs({ per_page: perPage !== undefined ? String(perPage) : '30' })}`;
    case 'repositories.get':
      return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    case 'repositories.contents': {
      const path = String(input.path ?? '');
      return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}${qs({ ref: ref ?? '' })}`;
    }
    case 'repositories.branches':
      return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches${qs({ per_page: perPage !== undefined ? String(perPage) : '30' })}`;
    case 'issues.list':
      return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${qs({ state: state ?? '', per_page: perPage !== undefined ? String(perPage) : '30' })}`;
    case 'pulls.list':
      return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${qs({ state: state ?? '', per_page: perPage !== undefined ? String(perPage) : '30' })}`;
    case 'checks.list': {
      const commitRef = ref ?? '';
      return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(commitRef)}/check-runs${qs({ per_page: perPage !== undefined ? String(perPage) : '30' })}`;
    }
    default:
      throw AppError.badRequest('plugin_action_unknown', `Unknown GitHub action: ${action}`);
  }
}