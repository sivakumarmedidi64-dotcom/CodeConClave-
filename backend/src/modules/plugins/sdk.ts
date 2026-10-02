/**
 * CodeConClave — plugin SDK contract (Phase 10).
 * Every adapter implements the same surface: metadata, authenticate,
 * authorize (scope), healthCheck, execute, validateResponse, revoke,
 * reconnect. Provider-specific code stays inside adapters; the engine only
 * talks to this interface. Future plugins are added by registering a new
 * adapter — no core module changes.
 */
import { z } from 'zod';
import type { PluginPermission, PluginType } from '@codeconclave/shared';

export interface PluginActionDef {
  /** Unique action name, e.g. 'repositories.list'. */
  name: string;
  /** Plugin permission required (read/write/send/publish/create/update/delete). */
  permission: PluginPermission;
  /** Grant scope key required, e.g. 'repositories:read'. */
  scope: string;
  /** Provider OAuth scope required (when the adapter is OAuth-based). */
  oauthScope?: string;
  /** True only for naturally idempotent actions — retried on timeout. */
  idempotent: boolean;
  description: string;
  /** Typed tool schema — all plugin actions must be typed tool calls. */
  inputSchema: z.ZodType;
}

export interface PluginCredentials {
  /** Decrypted server-side values by kind (token, api_key, refresh_token…). */
  kinds: Record<string, string>;
}

export interface PluginConnectionCtx {
  id: string;
  owner_id: string;
  plugin_type: PluginType;
  scopes: string[];
}

export interface PluginHealthResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface PluginExecuteResult {
  ok: boolean;
  data: unknown;
  latencyMs: number;
  error?: string;
}

export interface PluginAdapter {
  id: PluginType;
  name: string;
  provider: string;
  version: string;
  /** Capabilities the adapter genuinely implements (never invented). */
  capabilities: string[];
  oauth: {
    required: boolean;
    scopes: string[];
  } | null;
  actions: PluginActionDef[];
  /** Verify the stored credentials against the provider (throws on failure). */
  authenticate(ctx: PluginConnectionCtx, creds: PluginCredentials): Promise<void>;
  healthCheck(ctx: PluginConnectionCtx, creds: PluginCredentials): Promise<PluginHealthResult>;
  execute(
    ctx: PluginConnectionCtx,
    creds: PluginCredentials,
    action: PluginActionDef,
    input: Record<string, unknown>,
  ): Promise<PluginExecuteResult>;
  /** Adapter-level response validation (shape sanity — never fabricated). */
  validateResponse(result: unknown): boolean;
  revoke?(ctx: PluginConnectionCtx): Promise<void>;
  reconnect?(ctx: PluginConnectionCtx, creds: PluginCredentials): Promise<{ authUrl?: string } | void>;
}

const adapters = new Map<PluginType, PluginAdapter>();

export function registerAdapter(adapter: PluginAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getAdapter(type: string): PluginAdapter | null {
  return adapters.get(type as PluginType) ?? null;
}

export function listAdapters(): PluginAdapter[] {
  return [...adapters.values()];
}

export function getAction(type: string, actionName: string): { adapter: PluginAdapter; def: PluginActionDef } | null {
  const adapter = getAdapter(type);
  if (!adapter) return null;
  const def = adapter.actions.find((a) => a.name === actionName);
  if (!def) return null;
  return { adapter, def };
}

export function adapterForType(type: string): PluginAdapter | null {
  return getAdapter(type);
}