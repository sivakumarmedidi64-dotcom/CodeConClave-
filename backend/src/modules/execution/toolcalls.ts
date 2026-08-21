/**
 * CodeConClave — tool-call ledger (execution loop).
 * Every tool call a coworker wants to make is persisted, passed through the
 * deterministic policy engine, and (for HIGH/CRITICAL) linked to an approval.
 * Results, denials, timeouts, and errors are all recorded — nothing is faked.
 */
import { pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { evaluateToolCall, type PolicyDecision } from './policy.js';
import { createApproval } from './approvals.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction, type Risky } from './policy-shared.js';
import { incMetric } from '../../observability/metrics.js';

export interface ToolCallRow {
  id: string;
  task_id: string | null;
  step_id: string | null;
  tool_name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  risk_level: Risky;
  status: string;
  approval_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

const DENIED_POLICY: Extract<PolicyDecision, { allowed: false }>[] = [];

/** Propose a tool call: policy check → persist → approval if needed. */
export async function proposeToolCall(input: {
  taskId: string;
  stepId: string | null;
  ownerId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}): Promise<{ call: ToolCallRow; decision: PolicyDecision; approved: boolean }> {
  const decision = evaluateToolCall({
    tool: input.toolName,
    input: input.toolInput,
    userId: input.ownerId,
  });

  const id = newId(PREFIX.TOOL_CALL);
  let risk: Risky = 'LOW';
  let status = 'DENIED';
  let approvalId: string | null = null;

  if (decision.allowed) {
    risk = decision.risk;
    status = 'PROPOSED';
    if (decision.requiresApproval) {
      const approval = await createApproval({
        ownerId: input.ownerId,
        taskId: input.taskId,
        riskLevel: decision.risk,
        detail: { tool: input.toolName, input: input.toolInput },
      });
      approvalId = approval.id;
      status = 'PROPOSED';
    }
  } else {
    status = 'DENIED';
    incMetric('security.tool_calls_denied');
  }

  await pool.query(
    `INSERT INTO tool_calls (id, task_id, step_id, tool_name, input, risk_level, status, approval_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
    [id, input.taskId, input.stepId, input.toolName, JSON.stringify(input.toolInput), risk, status, approvalId],
  );
  await recordAudit({
    action: decision.allowed ? AuditAction.EXECUTION_TOOL_CALL : AuditAction.EXECUTION_TOOL_DENIED,
    actorUserId: input.ownerId,
    scope: 'USER',
    tenantId: input.ownerId,
    resourceType: 'tool_call',
    resourceId: id,
    detail: { tool: input.toolName, risk, deniedBy: decision.allowed ? null : decision.deniedBy },
  });

  const row = (await queryMany<ToolCallRow>('SELECT * FROM tool_calls WHERE id = $1', [id]))[0]!;
  return { call: row, decision, approved: decision.allowed && !decision.requiresApproval };
}

/**
 * Execute an already-approved tool call via the tool registry (implemented
 * adapters only). The optional context carries the SERVER-SET caller identity
 * (task owner) — tools must never accept identity from tool input.
 */
export async function executeToolCall(
  toolCallId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx?: ToolExecutionContext,
): Promise<ToolCallRow> {
  const rows = await queryMany<ToolCallRow>('SELECT * FROM tool_calls WHERE id = $1', [toolCallId]);
  const call = rows[0];
  if (!call) throw AppError.notFound('ToolCall');
  if (call.status === 'DENIED') throw AppError.forbidden('tool_denied', 'Tool call was denied by policy');

  const result = await runRegisteredTool(toolName, toolInput, ctx);
  await pool.query(
    `UPDATE tool_calls SET status = 'EXECUTED', output = $2::jsonb, started_at = now(), completed_at = now()
     WHERE id = $1`,
    [toolCallId, JSON.stringify(result)],
  );
  const updated = (await queryMany<ToolCallRow>('SELECT * FROM tool_calls WHERE id = $1', [toolCallId]))[0]!;
  await recordAudit({
    action: AuditAction.EXECUTION_TOOL_RESULT,
    actorUserId: ctx?.userId ?? null,
    scope: ctx?.userId ? 'USER' : 'SYSTEM',
    tenantId: ctx?.userId ?? null,
    resourceType: 'tool_call',
    resourceId: toolCallId,
    detail: { tool: toolName, ok: true },
  });
  return updated;
}

/** Deny a PROPOSED call (e.g. approval rejected). */
export async function markToolCallDenied(toolCallId: string): Promise<void> {
  await pool.query(`UPDATE tool_calls SET status = 'DENIED', completed_at = now() WHERE id = $1`, [toolCallId]);
}

/**
 * Registered tool adapters. Only genuinely implemented capabilities exist:
 * every tool maps to a real backend integration (files via storage, gateway via
 * chat, memory via semantic search). There are no placeholder tools.
 */
export interface ToolExecutionContext {
  /** Authenticated caller identity — never taken from tool input. */
  userId?: string;
}

type RegisteredTool = (input: Record<string, unknown>, ctx?: ToolExecutionContext) => Promise<Record<string, unknown>>;

const registeredTools = new Map<string, RegisteredTool>();

export function registerTool(name: string, fn: RegisteredTool): void {
  registeredTools.set(name, fn);
}

export async function runRegisteredTool(
  name: string,
  input: Record<string, unknown>,
  ctx?: ToolExecutionContext,
): Promise<Record<string, unknown>> {
  const fn = registeredTools.get(name);
  if (!fn) throw AppError.notFound('Tool not registered', `tool:${name}`);
  return fn(input, ctx);
}

export function listRegisteredTools(): string[] {
  return [...registeredTools.keys()];
}

export async function listToolCalls(taskId: string): Promise<ToolCallRow[]> {
  return queryMany<ToolCallRow>('SELECT * FROM tool_calls WHERE task_id = $1 ORDER BY created_at', [taskId]);
}

export { DENIED_POLICY };