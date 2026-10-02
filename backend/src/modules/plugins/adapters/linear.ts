/**
 * CodeConClave — Linear adapter (Stage 25.5).
 * Real Linear GraphQL API (https://api.linear.app/graphql): viewer query for
 * health, issues list/read, issue create. Typed actions; create actions are
 * approval-gated by the shared policy. Token comes from encrypted credentials.
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { outboundSignal } from '../../../shared/http-timeout.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const LINEAR_API = 'https://api.linear.app/graphql';
const TEXT_MAX = 2000;

function tokenFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
    signal: outboundSignal(),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: Record<string, unknown>;
    errors?: { message?: string }[];
  };
  if (!response.ok || payload.errors?.length) {
    const reason = payload.errors?.[0]?.message ?? `HTTP ${response.status}`;
    throw AppError.unavailable('linear_api_rejected', `Linear API failed: ${reason}`);
  }
  return payload.data ?? {};
}

export const linearAdapter: PluginAdapter = {
  id: 'linear',
  name: 'Linear',
  provider: 'linear.app',
  version: '1.0.0',
  capabilities: [PluginCapability.ISSUES, PluginCapability.PROJECTS],
  oauth: null,
  actions: [
    {
      name: 'issues.list',
      permission: PluginPermission.READ,
      scope: 'issues:read',
      idempotent: true,
      description: 'List Linear issues (optionally filtered by team).',
      inputSchema: z.object({
        team: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10),
        timeoutMs: z.coerce.number().int().min(100).max(15_000).optional(),
      }),
    },
    {
      name: 'issues.create',
      permission: PluginPermission.CREATE,
      scope: 'issues:create',
      idempotent: true,
      description: 'Create a Linear issue.',
      inputSchema: z.object({
        title: z.string().min(1).max(TEXT_MAX),
        description: z.string().max(10_000).optional(),
        teamId: z.string().min(1).max(200),
        priority: z.coerce.number().int().min(0).max(4).optional(),
        timeoutMs: z.coerce.number().int().min(100).max(15_000).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('linear_token_missing', 'Linear connection requires a token credential');
  },
  healthCheck: async (_ctx, creds) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('linear_token_missing', 'Linear connection requires a token credential');
    await graphql(token, 'query { viewer { id } }', {});
    return { ok: true, latencyMs: Date.now() - start, detail: 'viewer query ok' };
  },
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    const token = tokenFor(creds);
    if (!token) throw AppError.badRequest('linear_token_missing', 'Linear connection requires a token credential');
    if (action.name === 'issues.list') {
      const team = input.team ? `, filter: { team: { id: { eq: "${String(input.team).replace(/"/g, '')}" } } }` : '';
      const data = await graphql(
        token,
        `query Issues($limit: Int!) { issues(first: $limit${team}) { nodes { id identifier title description state { name } } } }`,
        { limit: Number(input.limit ?? 10) },
      );
      return { ok: true, data: data.issues ?? [], latencyMs: Date.now() - start };
    }
    if (action.name === 'issues.create') {
      const data = await graphql(
        token,
        `mutation CreateIssue($title: String!, $description: String, $teamId: String!, $priority: Int) {
           issueCreate(input: { title: $title, description: $description, teamId: $teamId, priority: $priority }) { success issue { id identifier } } }`,
        {
          title: String(input.title),
          description: input.description ? String(input.description) : null,
          teamId: String(input.teamId),
          priority: input.priority !== undefined ? Number(input.priority) : null,
        },
      );
      return { ok: true, data, latencyMs: Date.now() - start };
    }
    throw AppError.badRequest('plugin_action_unknown', `Unknown Linear action: ${action.name}`);
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};