/**
 * CodeConClave — P2 local workspace bridge.
 *
 * The single server-side path that lets the Web app drive REAL local files and
 * commands on a paired device. It does not touch the filesystem itself: every
 * operation is forwarded to the paired Local Agent over the existing command
 * protocol (`executeCommandResult`), which enforces the workspace scope,
 * capability grants, path containment and command policy on the device.
 *
 * Tenancy is structural: `executeCommandResult` resolves the socket by
 * `${userId}:${deviceId}`, so a user can only ever reach their OWN device.
 */
import { agentWs } from '../agent/ws.js';
import type { CommandExecResult } from '../agent/ws.js';
import { listDeviceStatus } from '../agent/service.js';
import { AppError } from '../../shared/errors.js';
import { AuditAction } from '@codeconclave/shared';

export interface LocalWorkspaceDescriptor {
  root: string;
  name: string;
  capabilities: string[];
}

async function runAgentCommand(
  userId: string,
  deviceId: string,
  cmd: Record<string, unknown>,
  timeoutMs?: number,
): Promise<CommandExecResult> {
  let result: CommandExecResult;
  try {
    result = await agentWs().executeCommandResult(userId, deviceId, cmd, timeoutMs);
  } catch (err) {
    // executeCommandResult rejects only when the device is offline.
    const message = err instanceof Error ? err.message : 'Local Agent is offline';
    throw AppError.unavailable('local_agent_offline', message);
  }
  if (!result.ok) {
    const reason = result.error ?? 'local_action_failed';
    if (/policy_denied/i.test(reason)) {
      throw AppError.forbidden('local_action_denied', `The Local Agent denied this action: ${reason}`);
    }
    if (/not granted|not covered|outside|traversal|no workspace/i.test(reason)) {
      throw AppError.forbidden('local_scope_denied', `Outside the granted local scope: ${reason}`);
    }
    throw AppError.badRequest('local_action_failed', reason);
  }
  return result;
}

function payloadOf(result: CommandExecResult): Record<string, unknown> {
  return result.payload ?? {};
}

/** Owned paired devices with honest online status. */
export async function listLocalDevices(userId: string) {
  const hub = agentWs();
  return listDeviceStatus(userId, (u, d) => hub.isOnline(u, d));
}

/** The workspace roots this device has been granted (never a secret path). */
export async function listLocalWorkspaces(userId: string, deviceId: string): Promise<LocalWorkspaceDescriptor[]> {
  const result = await runAgentCommand(userId, deviceId, { kind: 'workspaces.list' });
  const raw = payloadOf(result).workspaces;
  const workspaces = Array.isArray(raw) ? (raw as unknown[]) : [];
  return workspaces
    .filter((w): w is Record<string, unknown> => Boolean(w && typeof w === 'object'))
    .map((w) => ({
      root: String(w.root ?? ''),
      name: String(w.name ?? ''),
      capabilities: Array.isArray(w.capabilities) ? (w.capabilities as string[]) : [],
    }))
    .filter((w) => w.root.length > 0);
}

/** Browse one directory within the granted scope (agent enforces containment). */
export async function listLocalTree(userId: string, deviceId: string, path: string, limit = 200) {
  const result = await runAgentCommand(userId, deviceId, { kind: 'file.list', path, limit });
  return { root: String(payloadOf(result).root ?? ''), entries: (payloadOf(result).entries as unknown[]) ?? [] };
}

/** Read a real file + its metadata within the granted read scope. Audited. */
export async function readLocalFile(userId: string, deviceId: string, path: string) {
  const metadata = await runAgentCommand(userId, deviceId, { kind: 'file.metadata', path });
  const file = await runAgentCommand(userId, deviceId, { kind: 'file.read', path });
  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: AuditAction.LOCAL_FILE_READ,
    actorUserId: userId,
    scope: 'USER',
    resourceType: 'local_file',
    resourceId: path,
    detail: { deviceId, sha256: payloadOf(file).sha256 ?? null },
  });
  return { metadata: payloadOf(metadata), file: payloadOf(file) };
}

/**
 * Authorized write: compute the real diff first, then apply. Both steps run on
 * the agent, which refuses without the `file_write` capability. State-changing,
 * so it is audited.
 */
export async function writeLocalFile(userId: string, deviceId: string, path: string, content: string) {
  const proposal = await runAgentCommand(userId, deviceId, { kind: 'file.diff', path, content });
  const applied = await runAgentCommand(userId, deviceId, { kind: 'file.write', path, content });
  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: AuditAction.LOCAL_FILE_WRITTEN,
    actorUserId: userId,
    scope: 'USER',
    resourceType: 'local_file',
    resourceId: path,
    detail: { deviceId, beforeHash: payloadOf(applied).beforeHash ?? null, afterHash: payloadOf(applied).afterHash ?? null },
  });
  return { diff: String(payloadOf(proposal).diff ?? ''), ...payloadOf(applied) };
}

/**
 * Run a permitted command on the device. The agent applies the existing command
 * policy (deny-by-default), working-directory constraint and risk gate; this
 * bridge never assembles a shell string of its own. Audited.
 */
export async function runLocalCommand(
  userId: string,
  deviceId: string,
  command: string,
  cwd?: string,
): Promise<{ output: string; payload: Record<string, unknown> | null }> {
  const result = await runAgentCommand(userId, deviceId, { kind: 'terminal.exec', command, cwd }, 300_000);
  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: AuditAction.LOCAL_COMMAND_EXECUTED,
    actorUserId: userId,
    scope: 'USER',
    resourceType: 'local_command',
    resourceId: command.slice(0, 200),
    detail: { deviceId, cwd: cwd ?? null },
  });
  return { output: String(payloadOf(result).output ?? ''), payload: (payloadOf(result).payload as Record<string, unknown> | null) ?? null };
}

/**
 * Structural scan of a granted workspace on the device (import graph,
 * cycles, dead files). Read-only like tree/read: the agent enforces scope
 * and bounds; the bridge forwards and audits the completed scan with its
 * real counts (never the graph bytes — those stay device-side in payload).
 */
export async function scanLocalProject(userId: string, deviceId: string, path: string) {
  const result = await runAgentCommand(userId, deviceId, { kind: 'project.scan', path });
  const payload = payloadOf(result);
  const countOf = (key: string): number => (Array.isArray(payload[key]) ? (payload[key] as unknown[]).length : 0);
  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: AuditAction.LOCAL_PROJECT_SCANNED,
    actorUserId: userId,
    scope: 'USER',
    resourceType: 'local_scan',
    resourceId: path,
    detail: {
      deviceId,
      files: typeof payload.fileCount === 'number' ? payload.fileCount : null,
      nodes: countOf('nodes'),
      edges: countOf('edges'),
      cycles: countOf('cycles'),
      deadFiles: countOf('deadFiles'),
      truncated: payload.truncated ?? null,
    },
  });
  return payload;
}

/**
 * Sync a cloud chat transcript into the device's CodeConClave/chats/ folder
 * so history lives as local files the user and the AI can both read. The
 * agent validates shape/bounds and writes markdown idempotently per
 * conversation; the bridge forwards, audits, and never fabricates.
 */
export async function syncMemoryTranscript(
  userId: string,
  deviceId: string,
  input: { path?: string; conversationId: string; updatedAt?: string; turns: Array<{ role: string; content: string; at?: string }> },
) {
  if (!input.conversationId || !Array.isArray(input.turns) || input.turns.length === 0 || input.turns.length > 200) {
    throw AppError.badRequest('invalid_input', 'conversationId and 1-200 turns are required');
  }
  const result = await runAgentCommand(userId, deviceId, {
    kind: 'memory.sync',
    path: input.path ?? '/',
    conversationId: input.conversationId,
    updatedAt: input.updatedAt,
    turns: input.turns,
  });
  const payload = payloadOf(result);
  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: AuditAction.LOCAL_FILE_WRITTEN,
    actorUserId: userId,
    scope: 'USER',
    resourceType: 'local_memory_sync',
    resourceId: input.conversationId,
    detail: { deviceId, turns: typeof payload.turns === 'number' ? payload.turns : null },
  });
  return payload;
}

