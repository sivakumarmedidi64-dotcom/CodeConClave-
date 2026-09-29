/**
 * CodeConClave — PKG-25 — 24/7 autonomous project provisioning.
 *
 * When autonomy is ENABLED (AIOS_P2_AUTONOMY=true) a new project is wired for
 * continuous AI work: a default caretaker agent is created and a recurring
 * daily schedule is attached so the engine keeps working on the project around
 * the clock. When autonomy is disabled, provisioning is a no-op (inert) — it
 * never blocks project creation and never performs DB work.
 *
 * Respects the kill switch (SCHEDULES scope) and plan agent limits; each is
 * checked and recorded honestly rather than silently skipped.
 */
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { autonomyEnabled, AUTONOMY_CARETAKER_ROLE, AUTONOMY_CARETAKER_TASK_TITLE } from './config.js';
import { killSwitchActive } from '../control/killSwitch.js';
import { createAgent, listAgents } from '../agents/service.js';
import { createSchedule } from '../scheduling/service.js';
import { withTenant, queryMany } from '../../shared/db.js';

export interface ProvisionResult {
  provisioned: boolean;
  reason: 'autonomy_disabled' | 'kill_switch_suspended' | 'agent_limit_reached' | 'provisioned';
  scheduleId?: string;
  agentId?: string;
}

/**
 * Wire a fresh project for 24/7 autonomous work. Fire-and-forget style: any
 * unexpected failure is caught and surfaced via audit (never thrown into the
 * project-creation path). Returns the outcome for the caller / tests.
 */
export async function provisionAutonomousProject(
  userId: string,
  projectId: string,
  projectName: string,
): Promise<ProvisionResult> {
  if (!autonomyEnabled()) {
    await recordAudit({
      action: 'project.autonomy_provision_skipped',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'project',
      resourceId: projectId,
      detail: { reason: 'autonomy_disabled' },
    }).catch(() => undefined);
    return { provisioned: false, reason: 'autonomy_disabled' };
  }

  const suspended = await killSwitchActive(userId, 'SCHEDULES');
  if (suspended) {
    await recordAudit({
      action: 'project.autonomy_provision_skipped',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'project',
      resourceId: projectId,
      detail: { reason: 'kill_switch_suspended' },
    }).catch(() => undefined);
    return { provisioned: false, reason: 'kill_switch_suspended' };
  }

  try {
    const agents = await listAgents(userId);
    const caretaker = agents.find((a) => a.role === AUTONOMY_CARETAKER_ROLE && a.name === `${projectName} caretaker`);
    let agentId = caretaker?.id;

    if (!agentId) {
      try {
        const created = await createAgent(userId, {
          name: `${projectName} caretaker`,
          role: AUTONOMY_CARETAKER_ROLE,
          objective: `Keep working autonomously on the project "${projectName}" (${projectId}) — continuously improve it, surface findings, and complete tracked tasks around the clock.`,
          maxTasksPerRun: 3,
          maxRetries: 1,
          trustLevel: 'L1',
        });
        agentId = created.id;
      } catch (err) {
        if (isAgentLimitError(err)) {
          await recordAudit({
            action: 'project.autonomy_provision_skipped',
            actorUserId: userId,
            scope: 'USER',
            tenantId: userId,
            resourceType: 'project',
            resourceId: projectId,
            detail: { reason: 'agent_limit_reached' },
          }).catch(() => undefined);
          return { provisioned: false, reason: 'agent_limit_reached' };
        }
        throw err;
      }
    }

    const schedule = await createSchedule(userId, {
      projectId,
      agentId: agentId!,
      title: `${projectName} — 24/7 autonomous upkeep`,
      description: `Automatic recurring work on "${projectName}" so the project always has active AI progress.`,
      recurrence: 'DAILY',
      runAt: '02:00',
      executionMode: 'CLOUD',
      requireApproval: true,
      notifyOnCompletion: true,
    });

    await recordAudit({
      action: 'project.autonomy_provisioned',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'project',
      resourceId: projectId,
      detail: { scheduleId: schedule.id, agentId: agentId!, reason: 'provisioned' },
    }).catch(() => undefined);

    return { provisioned: true, reason: 'provisioned', scheduleId: schedule.id, agentId: agentId! };
  } catch (err) {
    const reason = mapErrorReason(err);
    await recordAudit({
      action: 'project.autonomy_provision_failed',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'project',
      resourceId: projectId,
      detail: { error: (err as Error).message, reason },
    }).catch(() => undefined);
    return { provisioned: false, reason };
  }
}

function isAgentLimitError(err: unknown): boolean {
  return err instanceof AppError && err.errorCode === 'agent_limit_reached';
}

function mapErrorReason(err: unknown): ProvisionResult['reason'] {
  const code = err instanceof AppError ? err.errorCode : (err as { errorCode?: string }).errorCode;
  if (code === 'agent_limit_reached') return 'agent_limit_reached';
  if (code === 'autonomy_suspended') return 'kill_switch_suspended';
  return 'autonomy_disabled';
}

/** Owner-side introspection of what autonomy provisioning has wired up. */
export async function listProjectAutonomyStatus(userId: string, projectId: string): Promise<{
  schedules: Array<{ id: string; title: string; enabled: boolean; nextRunAt: Date | null; idle: boolean }>;
}> {
  const rows = await withTenant<{ id: string; title: string; enabled: boolean; next_run_at: Date | null; last_run_at: Date | null }[]>(
    userId,
    async (q) =>
      (
        await q.query<{ id: string; title: string; enabled: boolean; next_run_at: Date | null; last_run_at: Date | null }>(
          `SELECT id, title, enabled, next_run_at, last_run_at
           FROM scheduled_tasks WHERE owner_id = $1 AND project_id = $2 ORDER BY created_at ASC`,
          [userId, projectId],
        )
      ).rows,
  );
  return {
    schedules: rows.map((r) => ({
      id: r.id,
      title: r.title,
      enabled: r.enabled,
      nextRunAt: r.next_run_at,
      idle: r.last_run_at === null,
    })),
  };
}