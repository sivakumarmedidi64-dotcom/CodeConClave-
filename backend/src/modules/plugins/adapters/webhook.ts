/**
 * CodeConClave — generic webhook/API adapter (Phase 10).
 * Controlled integration: HTTP method + URL allowlist + headers from secure
 * credentials + typed request body + timeout/retry/circuit breaker (shared
 * engine) + response validation + audit. Arbitrary URLs from AI prompts are
 * never accepted — the destination must pass the deterministic host
 * allowlist (env PLUGIN_WEBHOOK_ALLOWED_HOSTS, extendable at runtime).
 */
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../shared/errors.js';
import type { PluginAdapter, PluginCredentials } from '../sdk.js';
import { PluginCapability, PluginPermission } from '@codeconclave/shared';

const str = z.string().min(1).max(2000);

let runtimeAllowedHosts = new Set<string>();

/** Deterministic allowlist check — the ONLY way a destination is accepted. */
export function webhookHostAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  return runtimeAllowedHosts.has(host) || envAllowlist().has(host);
}

/** Runtime extension of the allowlist (deterministic policy; not prompt-driven). */
export function registerWebhookHosts(hosts: string[]): void {
  for (const h of hosts) runtimeAllowedHosts.add(h.toLowerCase());
}

export function resetWebhookAllowlist(): void {
  runtimeAllowedHosts = new Set<string>();
}

function envAllowlist(): Set<string> {
  return new Set(
    (env.PLUGIN_WEBHOOK_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function bearerFor(creds: PluginCredentials): string | undefined {
  return creds.kinds['token'] ?? creds.kinds['api_key'];
}

export const webhookAdapter: PluginAdapter = {
  id: 'webhook',
  name: 'Generic API / Webhook',
  provider: 'http',
  version: '1.0.0',
  capabilities: [PluginCapability.WEBHOOK],
  oauth: null,
  actions: [
    {
      name: 'http.request',
      permission: PluginPermission.WRITE,
      scope: 'webhook:request',
      idempotent: false,
      description: 'Call an allowlisted HTTP endpoint (GET/POST/PUT/PATCH/DELETE).',
      inputSchema: z.object({
        url: str,
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('POST'),
        headers: z.record(str, str).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        timeoutMs: z.coerce.number().int().min(100).max(15_000).optional(),
      }),
    },
  ],
  authenticate: async (_ctx, creds) => {
    // Token-less connections are allowed ONLY when the destination is
    // allowlisted; a stored token is optional for protected endpoints.
    void creds;
  },
  healthCheck: async () => ({ ok: true, latencyMs: 0, detail: 'allowlist_only' }),
  execute: async (_ctx, creds, action, input) => {
    const start = Date.now();
    if (action.name !== 'http.request') {
      throw AppError.badRequest('plugin_action_unknown', `Unknown webhook action: ${action.name}`);
    }
    const url = String(input.url);
    if (!webhookHostAllowed(url)) {
      throw AppError.forbidden('plugin_url_not_allowed', 'The destination host is not on the plugin allowlist');
    }
    const method = String(input.method ?? 'POST');
    const token = bearerFor(creds);
    const headers: Record<string, string> = {
      ...(input.headers as Record<string, string> | undefined),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(input.body ?? {}),
    });
    const body = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* non-JSON responses are valid */
    }
    if (!response.ok) {
      throw AppError.unavailable('webhook_response_rejected', `Endpoint responded ${response.status}`);
    }
    return { ok: true, data: { status: response.status, body: parsed }, latencyMs: Date.now() - start };
  },
  validateResponse: (result) => result !== null && typeof result === 'object',
};