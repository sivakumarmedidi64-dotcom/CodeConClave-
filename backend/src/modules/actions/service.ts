/**
 * CodeConClave — P2 unified action runtime (service).
 *
 * Routes a single declarative action request to the real execution substrate:
 * CLOUD → the coworker pipeline, LOCAL/BROWSER/DESKTOP → a LOCAL task carrying
 * a server-validated instruction on a paired device. The runtime never executes
 * anything itself and never fabricates success — it reuses createTaskFromChat,
 * the same honest path the rest of the product uses, and audits the routing.
 *
 * Feature-gated by UNIFIED_ACTION_RUNTIME_ENABLED (default OFF).
 */
import { AppError } from '../../shared/errors.js';
import { AuditAction } from '@codeconclave/shared';
import {
  type ActionSurface,
  inferSurface,
  listActionSurfaceViews,
  surfaceEnabled,
  surfaceExecutionMode,
} from './contract.js';

export interface RouteActionInput {
  userId: string;
  projectId: string;
  title: string;
  description?: string | null;
  conversationId?: string | null;
  surface?: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  priority?: number;
  dependsOn?: string[];
  localInstruction?: unknown;
  deviceId?: string;
}

export interface RouteActionDeps {
  createTask?: (input: {
    userId: string;
    projectId: string;
    conversationId: string | null;
    title: string;
    description?: string | null;
    riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    executionMode?: 'CLOUD' | 'LOCAL' | 'HYBRID';
    localInstruction?: unknown;
    priority?: number;
    dependsOn?: string[];
  }) => Promise<{ id: string }>;
  assertDeviceOwned?: (userId: string, deviceId: string) => Promise<void>;
}

export interface RouteActionResult {
  surface: ActionSurface;
  executionMode: 'CLOUD' | 'LOCAL' | 'PREVIEW';
  instruction: unknown;
  task?: Record<string, unknown>;
  /** Present only for PREVIEW actions (the preview session after requesting a build). */
  session?: Record<string, unknown>;
}

async function assertDeviceOwned(userId: string, deviceId: string): Promise<void> {
  const { withTenant } = await import('../../shared/db.js');
  const owned = await withTenant<{ rows: { id: string }[] }>(userId, (q) =>
    q.query<{ id: string }>("SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND state = 'PAIRED'", [deviceId, userId]),
  );
  if (!owned.rows[0]) throw AppError.badRequest('device_not_paired', 'deviceId must reference one of your paired devices');
}

/** Validate + normalize the surface-specific instruction (deny-by-default). */
async function buildInstruction(
  surface: ActionSurface,
  localInstruction: unknown,
  deviceId: string | undefined,
): Promise<unknown> {
  if (surface === 'CLOUD') return undefined;
  if (localInstruction === undefined || localInstruction === null) {
    throw AppError.badRequest('local_instruction_required', 'A LOCAL/BROWSER/DESKTOP action requires a localInstruction');
  }
  if (surface === 'LOCAL') {
    const command = (localInstruction as { command?: unknown }).command;
    if (typeof command !== 'string' || command.length === 0) {
      throw AppError.badRequest('invalid_local_instruction', 'A LOCAL instruction requires a non-empty command');
    }
    return localInstruction;
  }
  if (surface === 'BROWSER') {
    const { parseBrowserInstruction, BROWSER_PERMISSION_MAX_LIFETIME_MS } = await import('../agent/browser-policy.js');
    const parsed = parseBrowserInstruction(localInstruction);
    if (!parsed.ok) throw AppError.badRequest('invalid_browser_instruction', `Invalid browser instruction: ${parsed.reason}`);
    const instruction = parsed.instruction as { grants: { lifetimeMs?: number }; pinnedDeviceId?: string };
    instruction.grants.lifetimeMs ??= BROWSER_PERMISSION_MAX_LIFETIME_MS;
    if (deviceId) instruction.pinnedDeviceId = deviceId;
    return instruction;
  }
  const { parseDesktopInstruction, DESKTOP_PERMISSION_MAX_LIFETIME_MS } = await import('../agent/desktop-policy.js');
  const parsed = parseDesktopInstruction(localInstruction);
  if (!parsed.ok) throw AppError.badRequest('invalid_desktop_instruction', `Invalid desktop instruction: ${parsed.reason}`);
  const instruction = parsed.instruction as { grants: { lifetimeMs?: number }; pinnedDeviceId?: string };
  instruction.grants.lifetimeMs ??= DESKTOP_PERMISSION_MAX_LIFETIME_MS;
  if (deviceId) instruction.pinnedDeviceId = deviceId;
  return instruction;
}

/** Route one action to the correct real execution surface. */
export async function routeAction(input: RouteActionInput, deps: RouteActionDeps = {}): Promise<RouteActionResult> {
  const { unifiedActionRuntimeEnabled } = await import('./contract.js');
  if (!unifiedActionRuntimeEnabled()) {
    throw AppError.unavailable('unified_action_runtime_disabled', 'The unified action runtime is disabled on this deployment');
  }
  if (!input.projectId || !input.title) throw AppError.badRequest('invalid_input', 'projectId and title are required');

  const surface = inferSurface(input.surface, input.localInstruction);
  if (!surfaceEnabled(surface)) {
    throw AppError.unavailable(`${surface.toLowerCase()}_surface_disabled`, `The ${surface} execution surface is disabled on this deployment`);
  }

  // PREVIEW does not run on the task fabric: it requests a real build from
  // the existing preview service (validated project configuration, honest
  // NOT_CONFIGURED/ERROR states). No localInstruction applies — a preview
  // build never executes an ad-hoc command.
  if (surface === 'PREVIEW') {
    if (input.localInstruction !== undefined && input.localInstruction !== null) {
      throw AppError.badRequest('invalid_preview_action', 'A PREVIEW action takes no localInstruction; the build uses the project\'s validated configuration');
    }
    if (input.deviceId) {
      throw AppError.badRequest('invalid_preview_action', 'A PREVIEW action takes no deviceId; builds run on the preview host');
    }
    const { requestBuild } = await import('../preview/service.js');
    const session = await requestBuild(input.userId, input.projectId);
    const { recordAudit } = await import('../audit/service.js');
    await recordAudit({
      action: AuditAction.UNIFIED_ACTION_ROUTED,
      actorUserId: input.userId,
      scope: 'USER',
      resourceType: 'preview_session',
      resourceId: String((session as { id?: unknown }).id ?? input.projectId),
      detail: { surface, executionMode: 'PREVIEW', kind: 'preview', state: (session as { state?: unknown }).state ?? null },
    });
    return { surface, executionMode: 'PREVIEW', instruction: undefined, session: session as unknown as Record<string, unknown> };
  }

  const instruction = await buildInstruction(surface, input.localInstruction, input.deviceId);
  if (deviceIdPinned(instruction) && input.deviceId) {
    await (deps.assertDeviceOwned ?? assertDeviceOwned)(input.userId, input.deviceId);
  }

  const createTask = deps.createTask ?? (await import('../execution/orchestrator.js')).createTaskFromChat;
  const executionMode = surfaceExecutionMode(surface);
  const task = await createTask({
    userId: input.userId,
    projectId: input.projectId,
    conversationId: input.conversationId ?? null,
    title: input.title,
    description: input.description ?? null,
    riskLevel: input.riskLevel,
    executionMode,
    localInstruction: instruction,
    priority: input.priority ?? 0,
    dependsOn: input.dependsOn,
  });

  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: AuditAction.UNIFIED_ACTION_ROUTED,
    actorUserId: input.userId,
    scope: 'USER',
    resourceType: 'task',
    resourceId: task.id,
    detail: { surface, executionMode, kind: (input.localInstruction as { type?: string } | null)?.type ?? 'cloud' },
  });

  return { surface, executionMode, instruction, task: task as unknown as Record<string, unknown> };
}

function deviceIdPinned(instruction: unknown): boolean {
  return typeof (instruction as { pinnedDeviceId?: unknown } | null)?.pinnedDeviceId === 'string';
}

export interface StopAllInput {
  userId: string;
  /** When set, also cancel cancellable CLOUD tasks in this project. */
  projectId?: string;
  reason?: string;
}

export interface StopAllDeps {
  listActiveAssignments?: (userId: string) => Promise<Array<{ id: string; task_id: string }>>;
  cancelAssignmentById?: (assignmentId: string, reason: string) => Promise<void>;
  listProjectTasks?: (userId: string, projectId: string) => Promise<Array<{ id: string; status: string }>>;
  cancelTaskById?: (userId: string, taskId: string, reason: string) => Promise<unknown>;
}

export interface StopAllResult {
  assignmentsCancelled: string[];
  assignmentsFailed: Array<{ id: string; error: string }>;
  tasksCancelled: string[];
  tasksSkipped: string[];
}

const CANCELLABLE_TASK: ReadonlySet<string> = new Set([
  'CREATED',
  'PLANNED',
  'QUEUED',
  'WAITING_FOR_LOCAL_AGENT',
  'EXECUTING',
  'RUNNING',
  'VERIFYING',
]);

/**
 * Stop-all control: cancel every active LOCAL assignment owned by the user
 * (real ledger cancellation via cancelAssignment — the agent's in-flight work
 * is fenced by attempt ownership and the task row flips to CANCELLED) and,
 * when a projectId is given, every cancellable task in that project via the
 * real task cancel path (cooperative: the pipeline re-checks before further
 * side effects). Bounded, audited, never silent about items it could not stop.
 */
export async function stopAllWork(input: StopAllInput, deps: StopAllDeps = {}): Promise<StopAllResult> {
  const { unifiedActionRuntimeEnabled } = await import('./contract.js');
  if (!unifiedActionRuntimeEnabled()) {
    throw AppError.unavailable('unified_action_runtime_disabled', 'The unified action runtime is disabled on this deployment');
  }
  const reason = input.reason?.slice(0, 200) || 'stop_all_by_user';
  const result: StopAllResult = { assignmentsCancelled: [], assignmentsFailed: [], tasksCancelled: [], tasksSkipped: [] };

  const listActive = deps.listActiveAssignments ?? (await import('../agent/dispatch.js')).listActiveAssignmentsForUser;
  const cancelOne = deps.cancelAssignmentById ?? (await import('../agent/dispatch.js')).cancelAssignment;
  for (const assignment of await listActive(input.userId)) {
    try {
      await cancelOne(assignment.id, reason);
      result.assignmentsCancelled.push(assignment.id);
    } catch (err) {
      result.assignmentsFailed.push({ id: assignment.id, error: err instanceof Error ? err.message.slice(0, 200) : 'cancel failed' });
    }
  }

  if (input.projectId) {
    const listTasks = deps.listProjectTasks ?? (await import('../execution/tasks.js')).listTasks;
    const cancelTask = deps.cancelTaskById ?? (await import('../execution/tasks.js')).cancelTask;
    for (const task of (await listTasks(input.userId, input.projectId)).slice(0, 50)) {
      if (!CANCELLABLE_TASK.has(task.status)) {
        result.tasksSkipped.push(task.id);
        continue;
      }
      try {
        await cancelTask(input.userId, task.id, reason);
        result.tasksCancelled.push(task.id);
      } catch {
        // A concurrent transition (completed/cancelled raced us) is honestly
        // reported as skipped, never as a failure of this control.
        result.tasksSkipped.push(task.id);
      }
    }
  }

  const { recordAudit } = await import('../audit/service.js');
  await recordAudit({
    action: AuditAction.UNIFIED_ACTION_STOP_ALL,
    actorUserId: input.userId,
    scope: 'USER',
    resourceType: 'project',
    resourceId: input.projectId ?? input.userId,
    detail: {
      reason,
      assignmentsCancelled: result.assignmentsCancelled.length,
      assignmentsFailed: result.assignmentsFailed.length,
      tasksCancelled: result.tasksCancelled.length,
      tasksSkipped: result.tasksSkipped.length,
    },
  });
  return result;
}

export function listActionSurfaces() {
  return listActionSurfaceViews();
}
