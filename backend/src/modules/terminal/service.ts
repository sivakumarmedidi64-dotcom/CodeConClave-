/**
 * CodeConClave — terminal session service (Phase 4B).
 * Creates/replays terminal sessions against a paired local agent. Every
 * dispatch passes the deterministic policy engine; RUNNING is only ever
 * mirrored from agent-reported real process evidence (pid). Interactive input
 * is limited to low-risk commands: anything requiring approval must go through
 * the task approval flow and is refused here, never bypassed.
 */
import { AuditAction, type TerminalCreateInput } from '@codeconclave/shared';
import { agentWs } from '../agent/ws.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { evaluateToolCall, policyDeniedError } from '../execution/policy.js';
import { requireAgentOnline, requirePairedDevice, requireRemoteSession } from '../agent/service.js';
import {
  getTerminalSession,
  insertTerminalSession,
  listTerminalSessions,
  searchTerminalHistory,
  terminalHistoryLines,
  terminalLogs,
  terminalSessionOwner,
} from './store.js';

export async function createTerminalSession(userId: string, input: TerminalCreateInput) {
  const device = await requirePairedDevice(userId, input.deviceId);
  const hub = agentWs();
  requireAgentOnline(userId, input.deviceId, (u, d) => hub.isOnline(u, d));
  await requireRemoteSession(userId, input.deviceId);

  const decision = evaluateToolCall({ tool: 'terminal_exec', input: { command: input.shell }, userId });
  if (!decision.allowed) throw policyDeniedError(decision);

  const id = newId(PREFIX.TERMINAL_SESSION);
  await insertTerminalSession({
    id,
    ownerId: userId,
    deviceId: input.deviceId,
    tabId: id,
    shell: input.shell,
    cwd: input.cwd ?? null,
    timeoutMs: input.timeoutMs ?? null,
  });
  hub.requestToDevice(
    userId,
    input.deviceId,
    { kind: 'terminal.start', tabId: id, shell: input.shell, cwd: input.cwd ?? '', timeoutMs: input.timeoutMs ?? null },
    null,
    30_000,
  );
  await recordAudit({
    action: AuditAction.TERMINAL_SESSION_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'terminal_session',
    resourceId: id,
    detail: { deviceId: input.deviceId, shell: input.shell },
  });
  return toSessionJson({ id, deviceId: input.deviceId, deviceName: device.name, shell: input.shell, cwd: input.cwd ?? null, timeoutMs: input.timeoutMs ?? null });
}

export async function listSessions(userId: string, limit: number) {
  const rows = await listTerminalSessions(userId, limit);
  return Promise.all(
    rows.map(async (row) => {
      const device = await requirePairedDevice(userId, row.device_id).catch(() => null);
      return toSessionJson({
        id: row.id,
        deviceId: row.device_id,
        deviceName: device?.name ?? row.device_id,
        shell: row.shell,
        cwd: row.cwd,
        timeoutMs: row.timeout_ms,
        status: row.status,
        pid: row.pid,
        exitCode: row.exit_code,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        createdAt: row.created_at,
      });
    }),
  );
}

export async function getSession(userId: string, sessionId: string) {
  const row = await getTerminalSession(userId, sessionId);
  if (!row) throw AppError.notFound('TerminalSession');
  const device = await requirePairedDevice(userId, row.device_id).catch(() => null);
  return {
    session: toSessionJson({
      id: row.id,
      deviceId: row.device_id,
      deviceName: device?.name ?? row.device_id,
      shell: row.shell,
      cwd: row.cwd,
      timeoutMs: row.timeout_ms,
      status: row.status,
      pid: row.pid,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    }),
    history: await terminalHistoryLines(userId, sessionId, 200),
  };
}

export async function sendInput(userId: string, sessionId: string, input: string): Promise<void> {
  const session = await terminalSessionOwner(userId, sessionId);
  if (!session) throw AppError.notFound('TerminalSession');
  const hub = agentWs();
  requireAgentOnline(userId, session.device_id, (u, d) => hub.isOnline(u, d));
  await requireRemoteSession(userId, session.device_id);

  const decision = evaluateToolCall({ tool: 'terminal_exec', input: { command: input }, userId });
  if (!decision.allowed) throw policyDeniedError(decision);
  if (decision.requiresApproval) {
    throw AppError.forbidden(
      'approval_required',
      'This command requires approval; interactive terminal input is limited to low-risk commands (approve through task approvals)',
    );
  }
  hub.requestToDevice(userId, session.device_id, { kind: 'terminal.input', tabId: sessionId, data: input }, null, 10_000);
}

export async function killSession(userId: string, sessionId: string): Promise<void> {
  const session = await terminalSessionOwner(userId, sessionId);
  if (!session) throw AppError.notFound('TerminalSession');
  const hub = agentWs();
  requireAgentOnline(userId, session.device_id, (u, d) => hub.isOnline(u, d));
  await requireRemoteSession(userId, session.device_id);
  hub.requestToDevice(userId, session.device_id, { kind: 'terminal.stop', tabId: sessionId }, null, 15_000);
  await recordAudit({
    action: AuditAction.TERMINAL_SESSION_KILLED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'terminal_session',
    resourceId: sessionId,
  });
}

export async function restartSession(userId: string, sessionId: string): Promise<void> {
  const session = await terminalSessionOwner(userId, sessionId);
  if (!session) throw AppError.notFound('TerminalSession');
  const hub = agentWs();
  requireAgentOnline(userId, session.device_id, (u, d) => hub.isOnline(u, d));
  await requireRemoteSession(userId, session.device_id);
  hub.requestToDevice(userId, session.device_id, { kind: 'terminal.restart', tabId: sessionId }, null, 15_000);
}

export async function downloadLogs(userId: string, sessionId: string): Promise<string> {
  const session = await terminalSessionOwner(userId, sessionId);
  if (!session) throw AppError.notFound('TerminalSession');
  return terminalLogs(userId, sessionId);
}

export async function searchHistory(userId: string, q: string, limit: number) {
  return searchTerminalHistory(userId, q, limit);
}

function toSessionJson(input: {
  id: string;
  deviceId: string;
  deviceName: string;
  shell: string;
  cwd: string | null;
  timeoutMs: number | null;
  status?: string;
  pid?: number | null;
  exitCode?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt?: string | null;
}) {
  return {
    id: input.id,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    shell: input.shell,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    status: input.status ?? 'PLANNED',
    pid: input.pid ?? null,
    exitCode: input.exitCode ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    createdAt: input.createdAt ?? null,
  };
}