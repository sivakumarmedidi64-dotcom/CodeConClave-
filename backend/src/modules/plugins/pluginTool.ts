/**
 * CodeConClave — plugin_action tool (Phase 10).
 * Registered tool so coworkers can request plugin actions through the typed
 * tool-call ledger: proposeToolCall → deterministic policy → approval if
 * required → execution. The caller identity MUST come from the execution
 * context (never from untrusted input); the engine re-validates ownership
 * against the connection row, so a spoofed userId can never execute another
 * tenant's connection.
 */
import { registerTool, type ToolExecutionContext } from '../execution/toolcalls.js';
import { executePluginAction } from './engine.js';
import { AppError } from '../../shared/errors.js';

export function registerPluginTools(): void {
  registerTool('plugin_action', async (input, ctx) => {
    const userId = String(ctx?.userId ?? '');
    if (!userId) {
      throw AppError.forbidden('plugin_caller_unknown', 'Plugin actions require an authenticated caller context');
    }
    const connectionId = String(input.connectionId ?? '');
    const action = String(input.action ?? '');
    if (!connectionId || !action) {
      throw AppError.badRequest('plugin_input_invalid', 'connectionId and action are required');
    }
    const outcome = await executePluginAction({
      userId,
      connectionId,
      action,
      input: (input.input as Record<string, unknown>) ?? {},
      taskId: typeof input.taskId === 'string' ? input.taskId : undefined,
      runId: typeof input.runId === 'string' ? input.runId : undefined,
      recordAsMemory: input.recordAsMemory === true,
    });
    return { ok: true, pluginType: outcome.pluginType, action: outcome.action, data: outcome.data, latencyMs: outcome.latencyMs };
  });
}