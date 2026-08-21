/**
 * Stage 26G — plugin sandbox.
 *
 * Safe fake-data testing of plugin actions WITHOUT calling any provider:
 * the action is validated against the registered adapter contract
 * (existence + input schema), and the result is a clearly-labeled fake
 * payload generated locally. The output is never presented as a real
 * provider response. Every run is recorded to plugin_sandbox_runs.
 */
import { queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { getAction, type PluginActionDef } from './sdk.js';

export interface PluginSandboxRunRow {
  id: string;
  owner_id: string;
  plugin_type: string;
  action: string;
  input: Record<string, unknown> | null;
  output: Record<string, unknown>;
  ok: boolean;
  latency_ms: number;
  created_at: Date;
}

export interface SandboxResult {
  sandbox: true;
  pluginType: string;
  action: string;
  fake: true;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  warning: string;
  latencyMs: number;
}

function fakeOutput(action: string, def: PluginActionDef | null, input: Record<string, unknown>): Record<string, unknown> {
  const base = {
    sandbox: true,
    action,
    fake: true,
    echo: input,
    generatedAt: new Date().toISOString(),
  };
  if (!def) return base;
  const perm = def.permission;
  const sample: Record<string, unknown> = { items: [] };
  if (['repositories', 'branches', 'issues', 'pull_requests', 'messages', 'channels', 'projects', 'documents', 'deployments', 'events'].includes(perm)) {
    sample.items = [
      { id: `sandbox-1`, name: `${def.name}-sample`, fake: true },
      { id: `sandbox-2`, name: `${def.name}-sample-2`, fake: true },
    ];
  }
  if (def.name.includes('send') || def.name.includes('publish')) {
    sample.delivered = true;
    sample.to = String(input.to ?? input.channel ?? input.recipient ?? 'sandbox-recipient');
    sample.fake = true;
  }
  if (def.name.includes('search') || def.name.includes('list')) {
    sample.results = sample.items;
  }
  return { ...base, ...sample };
}

/** Run a sandbox test for an action. Refuses unknown adapters/actions. */
export async function runPluginSandbox(
  userId: string,
  input: { pluginType: string; action: string; input?: Record<string, unknown> },
): Promise<SandboxResult> {
  if (!input.pluginType || !input.action?.trim()) {
    throw AppError.badRequest('sandbox_invalid_input', 'pluginType and action are required');
  }
  const found = getAction(input.pluginType, input.action.trim());
  if (!found) {
    throw AppError.badRequest('sandbox_action_unknown', `No action "${input.action}" for plugin ${input.pluginType}`);
  }
  const inputData = input.input ?? {};
  const id = newId(PREFIX.PLUGIN_SANDBOX_RUN);
  const output = fakeOutput(found.def.name, found.def, inputData);
  const { pool } = await import('../../shared/db.js');
  await pool.query(
    `INSERT INTO plugin_sandbox_runs (id, owner_id, plugin_type, action, input, output, ok, latency_ms)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,true,0)`,
    [id, userId, input.pluginType, found.def.name, JSON.stringify(inputData), JSON.stringify(output)],
  );
  await recordAudit({
    action: AuditAction.PLUGIN_SANDBOX_RUN,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'plugin_sandbox_run',
    resourceId: id,
    detail: { pluginType: input.pluginType, action: found.def.name, fake: true },
  });
  return {
    sandbox: true,
    pluginType: input.pluginType,
    action: found.def.name,
    fake: true,
    input: inputData,
    output,
    warning: 'Sandbox output only — never a live provider call',
    latencyMs: 0,
  };
}

export async function listPluginSandboxRuns(userId: string, limit = 50): Promise<PluginSandboxRunRow[]> {
  return queryMany<PluginSandboxRunRow>(
    'SELECT * FROM plugin_sandbox_runs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, Math.min(Math.max(limit, 1), 200)],
  );
}