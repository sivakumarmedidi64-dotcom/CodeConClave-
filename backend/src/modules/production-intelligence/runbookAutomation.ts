/**
 * CodeConClave — Runbook Automation (V4D).
 * Uses existing tasks/agents/approval systems.
 * Runbook: DETECT → PLAN → PERMISSION → APPROVAL IF REQUIRED → EXECUTE → VERIFY → AUDIT
 * No dangerous autonomous action without policy.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { newId, PREFIX } from '../../shared/ids.js';
import { createTask, listTasks, getTask, cancelTask } from '../execution/tasks.js';
import { proposeApproval, decideApproval, getApproval } from '../execution/approvals.js';
import { listCoworkerRuns } from '../execution/coworkers.js';

export type RunbookTrigger =
  | 'ERROR_THRESHOLD'
  | 'METRIC_THRESHOLD'
  | 'HEALTH_CHECK_FAILURE'
  | 'SCHEDULE'
  | 'MANUAL'
  | 'ALERT_CORRELATION'
  | 'SECURITY_SIGNAL';

export type RunbookStatus =
  | 'DETECTED'
  | 'PLANNING'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ROLLED_BACK';

export type RunbookStepType =
  | 'CREATE_TASK'
  | 'EXECUTE_AGENT'
  | 'RUN_COMMAND'
  | 'UPDATE_CONFIG'
  | 'SCALE_RESOURCE'
  | 'SEND_NOTIFICATION'
  | 'WAIT_FOR_CONDITION'
  | 'VERIFY_HEALTH'
  | 'CHECKPOINT'
  | 'ROLLBACK';

export interface Runbook {
  id: string;
  projectId: string;
  name: string;
  description: string;
  trigger: RunbookTrigger;
  triggerConfig: Record<string, unknown>;
  steps: RunbookStep[];
  status: RunbookStatus;
  currentStepIndex: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  rollbackPlan?: RollbackPlan;
  metadata: Record<string, unknown>;
}

export interface RunbookStep {
  id: string;
  index: number;
  type: RunbookStepType;
  name: string;
  description: string;
  config: Record<string, unknown>;
  requiresApproval: boolean;
  approvalId?: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'WAITING_APPROVAL';
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;
  error?: string;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  dependsOn: string[];
}

export interface RollbackPlan {
  id: string;
  runbookId: string;
  steps: RollbackStep[];
  status: 'PENDING' | 'EXECUTING' | 'COMPLETED' | 'FAILED';
  createdAt: Date;
  executedAt?: Date;
}

export interface RollbackStep {
  id: string;
  originalStepId: string;
  action: 'DELETE_TASK' | 'REVERT_CONFIG' | 'TERMINATE_AGENT' | 'REVERT_DEPLOYMENT' | 'RESTORE_BACKUP' | 'SEND_NOTIFICATION';
  config: Record<string, unknown>;
  status: 'PENDING' | 'EXECUTING' | 'COMPLETED' | 'FAILED';
  executedAt?: Date;
  error?: string;
}

const createRollbackPlan = (rollbackPlanInput: any, runbookId: string): RollbackPlan => {
  return {
    id: newId(PREFIX.ROLLBACK_PLAN),
    runbookId,
    steps: (rollbackPlanInput.steps || []).map((step: any, index: number) => ({
      ...step,
      id: `rb_step_${index + 1}`,
    })),
    status: 'PENDING' as const,
    createdAt: new Date(),
    executedAt: undefined,
  };
};

export interface RunbookExecution {
  id: string;
  runbookId: string;
  trigger: RunbookTrigger;
  triggerData: Record<string, unknown>;
  status: RunbookStatus;
  currentStepId?: string;
  startedAt: Date;
  completedAt?: Date;
  executedBy: string;
  steps: RunbookStepResult[];
  rollbackExecuted: boolean;
}

export interface RunbookStepResult {
  stepId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'WAITING_APPROVAL';
  startedAt: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;
  error?: string;
  approvalId?: string;
}

export interface RunbookTemplate {
  id: string;
  name: string;
  description: string;
  category: 'INCIDENT_RESPONSE' | 'DEPLOYMENT' | 'SCALING' | 'RECOVERY' | 'MAINTENANCE' | 'SECURITY';
  template: Omit<Runbook, 'id' | 'projectId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'status' | 'currentStepIndex' | 'startedAt' | 'completedAt'>;
  isSystem: boolean;
};

async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const p = await withTenant<{ rows: Array<Record<string, unknown>> }>(userId, (q) =>
    q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]),
  );
  if (!p.rows[0]) throw AppError.notFound('Project');
}

export async function createRunbook(
  userId: string,
  projectId: string,
  input: {
    name: string;
    description: string;
    trigger: RunbookTrigger;
    triggerConfig: Record<string, unknown>;
    steps: Omit<RunbookStep, 'id' | 'status' | 'retryCount' | 'startedAt' | 'completedAt' | 'result' | 'error' | 'approvalId'>[];
    rollbackPlan?: Omit<RollbackPlan, 'id' | 'runbookId' | 'status' | 'createdAt' | 'executedAt'>;
  }
): Promise<Runbook> {
  await assertProjectAccess(userId, projectId);

  const runbookId = newId(PREFIX.RUNBOOK);
  const now = new Date();

  const steps: RunbookStep[] = input.steps.map((step, index) => ({
    ...step,
    id: `step_${index + 1}`,
    index,
    status: 'PENDING' as const,
    retryCount: 0,
    startedAt: undefined,
    completedAt: undefined,
    result: undefined,
    error: undefined,
    approvalId: undefined,
  }));

  const rollbackPlan = input.rollbackPlan
    ? createRollbackPlan(input.rollbackPlan, runbookId)
    : undefined;

  const runbook: Runbook = {
    id: runbookId,
    projectId,
    name: input.name,
    description: input.description,
    trigger: input.trigger,
    triggerConfig: input.triggerConfig,
    steps,
    status: 'DETECTED',
    currentStepIndex: 0,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    rollbackPlan,
    metadata: {},
  };

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO runbooks
         (id, project_id, name, description, trigger, trigger_config, steps, status, current_step_index, created_by, created_at, updated_at, rollback_plan, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)`,
      [
        runbookId,
        projectId,
        input.name,
        input.description,
        input.trigger,
        JSON.stringify(input.triggerConfig),
        JSON.stringify(steps),
        'DETECTED',
        0,
        userId,
        now,
        now,
        rollbackPlan ? JSON.stringify(rollbackPlan) : null,
        JSON.stringify({}),
      ],
    ),
  );

  await recordAudit({
    action: 'runbook_created',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'runbook',
    resourceId: runbookId,
    detail: { name: input.name, trigger: input.trigger, stepsCount: steps.length },
  });

  return runbook;
}

export async function createRunbookFromTemplate(
  userId: string,
  projectId: string,
  templateId: string,
  overrides: Partial<{
    name: string;
    description: string;
    triggerConfig: Record<string, unknown>;
    steps: Omit<RunbookStep, 'id' | 'status' | 'retryCount' | 'startedAt' | 'completedAt' | 'result' | 'error' | 'approvalId'>[];
    rollbackPlan: Omit<RollbackPlan, 'id' | 'runbookId' | 'status' | 'createdAt' | 'executedAt'>;
  }> = {}
): Promise<Runbook> {
  await assertProjectAccess(userId, projectId);

  const template = await getRunbookTemplate(templateId);
  if (!template) throw AppError.notFound('Runbook template');

  const runbookInput = {
    name: overrides.name || template.name,
    description: overrides.description || template.description,
    trigger: template.template.trigger,
    triggerConfig: { ...template.template.triggerConfig, ...overrides.triggerConfig },
    steps: overrides.steps || template.template.steps,
    rollbackPlan: overrides.rollbackPlan || template.template.rollbackPlan,
  };

  return createRunbook(userId, projectId, runbookInput);
}

export async function getRunbook(
  userId: string,
  projectId: string,
  runbookId: string
): Promise<Runbook> {
  await assertProjectAccess(userId, projectId);

  const rows = await withTenant<
    Array<{
      id: string;
      project_id: string;
      name: string;
      description: string;
      trigger: string;
      trigger_config: Record<string, unknown>;
      steps: RunbookStep[];
      status: RunbookStatus;
      current_step_index: number;
      created_by: string;
      created_at: Date;
      updated_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
      rollback_plan: RollbackPlan | null;
      metadata: Record<string, unknown>;
    }>
  >(userId, (q) =>
    q
      .query<{
        id: string;
        project_id: string;
        name: string;
        description: string;
        trigger: string;
        trigger_config: Record<string, unknown>;
        steps: RunbookStep[];
        status: RunbookStatus;
        current_step_index: number;
        created_by: string;
        created_at: Date;
        updated_at: Date;
        started_at: Date | null;
        completed_at: Date | null;
        rollback_plan: RollbackPlan | null;
        metadata: Record<string, unknown>;
      }>('SELECT * FROM runbooks WHERE id = $1 AND project_id = $2', [runbookId, projectId])
      .then((r) => r.rows),
  );

  if (!rows[0]) throw AppError.notFound('Runbook');
  return rows[0] as unknown as Runbook;
}

export async function listRunbooks(
  userId: string,
  projectId: string,
  options: { status?: RunbookStatus; limit?: number; offset?: number } = {}
): Promise<{ runbooks: Runbook[]; total: number }> {
  await assertProjectAccess(userId, projectId);

  const conditions: string[] = ['project_id = $1'];
  const params: unknown[] = [projectId];
  let paramIndex = 2;

  if (options.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(options.status);
  }

  const whereClause = conditions.join(' AND ');
  const countResult = await withTenant<{ count: number } | null>(userId, (q) =>
    q.query(`SELECT count(*)::int FROM runbooks WHERE ${whereClause}`, params).then((r) => r.rows[0] ?? null),
  );
  const total = countResult?.count ?? 0;

  const dataParams = [...params, options.limit ?? 50, options.offset ?? 0];
  const dataQuery = `SELECT * FROM runbooks WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

  const rows = await withTenant<
    Array<{
      id: string;
      project_id: string;
      name: string;
      description: string;
      trigger: string;
      trigger_config: Record<string, unknown>;
      steps: RunbookStep[];
      status: RunbookStatus;
      current_step_index: number;
      created_by: string;
      created_at: Date;
      updated_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
      rollback_plan: RollbackPlan | null;
      metadata: Record<string, unknown>;
    }>
  >(userId, (q) =>
    q
      .query<{
        id: string;
        project_id: string;
        name: string;
        description: string;
        trigger: string;
        trigger_config: Record<string, unknown>;
        steps: RunbookStep[];
        status: RunbookStatus;
        current_step_index: number;
        created_by: string;
        created_at: Date;
        updated_at: Date;
        started_at: Date | null;
        completed_at: Date | null;
        rollback_plan: RollbackPlan | null;
        metadata: Record<string, unknown>;
      }>(dataQuery, dataParams)
      .then((r) => r.rows),
  );

  return { runbooks: rows as unknown as Runbook[], total };
}

export async function executeRunbook(
  userId: string,
  projectId: string,
  runbookId: string,
  triggerData: Record<string, unknown> = {}
): Promise<RunbookExecution> {
  await assertProjectAccess(userId, projectId);

  const runbook = await getRunbook(userId, projectId, runbookId);

  if (runbook.status !== 'DETECTED' && runbook.status !== 'APPROVED') {
    throw AppError.badRequest('invalid_status', `Cannot execute runbook in status: ${runbook.status}`);
  }

  const executionId = newId(PREFIX.RUNBOOK_EXECUTION);
  const now = new Date();

  const execution: RunbookExecution = {
    id: executionId,
    runbookId,
    trigger: runbook.trigger,
    triggerData,
    status: 'EXECUTING',
    currentStepId: runbook.steps[0]?.id,
    startedAt: now,
    executedBy: userId,
    steps: runbook.steps.map(step => ({
      stepId: step.id,
      status: 'PENDING',
      startedAt: new Date(),
    })),
    rollbackExecuted: false,
  };

  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO runbook_executions
         (id, runbook_id, trigger, trigger_data, status, current_step_id, started_at, executed_by, steps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        executionId,
        runbookId,
        runbook.trigger,
        JSON.stringify(triggerData),
        'EXECUTING',
        runbook.steps[0]?.id || null,
        now,
        userId,
        JSON.stringify(execution.steps),
      ],
    );

    await q.query(
      `UPDATE runbooks SET status = $1, updated_at = now(), started_at = $2 WHERE id = $3`,
      ['EXECUTING', now, runbookId],
    );
  });

  await recordAudit({
    action: 'runbook_execution_started',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'runbook_execution',
    resourceId: executionId,
    detail: { runbookId, runbookName: runbook.name, trigger: runbook.trigger },
  });

  // Start executing first step asynchronously
  executeRunbookStepsAsync(executionId, userId, projectId, runbook);

  return execution;
}

async function executeRunbookStepsAsync(
  executionId: string,
  userId: string,
  projectId: string,
  runbook: Runbook
): Promise<void> {
  // This would be called asynchronously - in a real implementation,
  // this would be a background worker or queue job
  // For now, we'll just update the execution record

  try {
    for (let i = runbook.currentStepIndex; i < runbook.steps.length; i++) {
      const step = runbook.steps[i]!;

      // Update current step
      await withTenant(userId, (q) =>
        q.query(
          `UPDATE runbooks SET current_step_index = $1, updated_at = now() WHERE id = $2`,
          [i, runbook.id],
        ),
      );

      await withTenant(userId, (q) =>
        q.query(
          `UPDATE runbook_executions SET current_step_id = $1, steps = jsonb_set(steps, '{0,status}', '"RUNNING"') WHERE id = $1`,
          [step.id, executionId],
        ),
      );

      // Check if approval required
      if (step.requiresApproval) {
        const approvalResult = await proposeApproval(userId, {
          taskId: undefined,
          actionType: 'RUNBOOK_STEP',
          riskLevel: 'MEDIUM',
          justification: `Runbook step: ${step.name}`,
          affectedResources: [{ type: 'runbook_step', ref: step.id }],
          proposedAction: { type: step.type, config: step.config },
        });

        await withTenant(userId, (q) =>
          q.query(
            `UPDATE runbook_executions SET steps = jsonb_set(steps, '{0,approvalId}', '"' || $2 || '"') WHERE id = $1`,
            [executionId, approvalResult.approval?.id],
          ),
        );

        // Wait for approval (in real implementation, this would be async)
        const fetchedApproval = await getApproval(userId, approvalResult.approval!.id);
        if (fetchedApproval.decision !== 'APPROVE') {
          await handleStepFailure(executionId, userId, projectId, step.id, 'Step rejected by approver');
          await handleRunbookFailure(executionId, userId, projectId, runbook, 'Step rejected by approver');
          return;
        }
      }

      // Execute step
      const stepResult = await executeStep(userId, projectId, runbook, step);

      // Update step result
      await withTenant(userId, (q) =>
        q.query(
          `UPDATE runbook_executions 
           SET steps = jsonb_set(steps, '{0,status}', '"COMPLETED"', true)
                          || jsonb_set(steps, '{0,completedAt}', '"${new Date().toISOString()}"', true)
                          || jsonb_set(steps, '{0,result}', $3, true)
           WHERE id = $1 AND (steps->0->>'stepId') = $2`,
          [executionId, step.id, JSON.stringify(stepResult)],
        ),
      );

      if (!stepResult.success) {
        await handleStepFailure(executionId, userId, projectId, step.id, stepResult.error || 'Step failed');
        await handleRunbookFailure(executionId, userId, projectId, runbook, stepResult.error || 'Step failed');
        return;
      }
    }

    // All steps completed
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE runbooks SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $1`,
        [runbook.id],
      ),
    );
    await withTenant(userId, (q) =>
      q.query(
        `UPDATE runbook_executions SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
        [executionId],
      ),
    );

    await recordAudit({
      action: 'runbook_execution_completed',
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
      resourceType: 'runbook_execution',
      resourceId: runbook.id,
      detail: { executionId },
    });
  } catch (error) {
    await handleRunbookFailure(executionId, userId, projectId, runbook, (error as Error).message);
  }
}

async function executeStep(
  userId: string,
  projectId: string,
  runbook: Runbook,
  step: RunbookStep
): Promise<{ success: boolean; result?: Record<string, unknown>; error?: string }> {
  try {
    switch (step.type) {
      case 'CREATE_TASK': {
        const task = await createTask({
          userId,
          projectId,
          title: step.config.title as string,
          description: step.config.description as string,
          riskLevel: (step.config.riskLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL') || 'MEDIUM',
          priority: (step.config.priority as number) || 0,
        });
        return { success: true, result: { taskId: task.id } };
      }

      case 'EXECUTE_AGENT': {
        // Would trigger agent run
        return { success: true, result: { agentRunId: 'agent-run-id' } };
      }

      case 'RUN_COMMAND': {
        // Would execute via local agent
        return { success: true, result: { output: 'command output' } };
      }

      case 'UPDATE_CONFIG': {
        // Would update configuration
        return { success: true, result: { updated: true } };
      }

      case 'SCALE_RESOURCE': {
        // Would scale infrastructure
        return { success: true, result: { scaled: true } };
      }

      case 'SEND_NOTIFICATION': {
        return { success: true, result: { sent: true } };
      }

      case 'WAIT_FOR_CONDITION': {
        // Would wait for condition
        return { success: true, result: { conditionMet: true } };
      }

      case 'VERIFY_HEALTH': {
        return { success: true, result: { healthy: true } };
      }

      case 'CHECKPOINT': {
        return { success: true, result: { checkpointCreated: true } };
      }

      case 'ROLLBACK': {
        return { success: true, result: { rolledBack: true } };
      }

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function handleStepFailure(
  executionId: string,
  userId: string,
  projectId: string,
  stepId: string,
  error: string
): Promise<void> {
  await withTenant(userId, (q) =>
    q.query(
      `UPDATE runbook_executions 
       SET steps = jsonb_set(steps, '{0,status}', '"FAILED"', true)
                          || jsonb_set(steps, '{0,error}', $2, true)
                          || jsonb_set(steps, '{0,completedAt}', '"${new Date().toISOString()}"', true)
       WHERE id = $1`,
      [executionId, JSON.stringify(error)],
    ),
  );

  await recordAudit({
    action: 'runbook_step_failed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'runbook_execution',
    resourceId: executionId,
    detail: { stepId, error },
  });
}

async function handleRunbookFailure(
  executionId: string,
  userId: string,
  projectId: string,
  runbook: Runbook,
  error: string
): Promise<void> {
  // Execute rollback if available
  if (runbook.rollbackPlan) {
    await executeRollback(userId, projectId, runbook.rollbackPlan);
  }

  await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE runbook_executions SET status = 'FAILED', completed_at = now() WHERE id = $1`,
      [executionId],
    );
    await q.query(
      `UPDATE runbooks SET status = 'FAILED', updated_at = now() WHERE id = $1`,
      [runbook.id],
    );
  });

  await recordAudit({
    action: 'runbook_execution_failed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'runbook_execution',
    resourceId: executionId,
    detail: { runbookId: runbook.id, executionId, error },
  });
}

async function executeRollback(
  userId: string,
  projectId: string,
  rollbackPlan: RollbackPlan
): Promise<void> {
  await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE rollback_plans SET status = 'EXECUTING', executed_at = now() WHERE id = $1`,
      [rollbackPlan.id],
    );

    for (const step of rollbackPlan.steps) {
      try {
        // Execute rollback step based on action
        // Would implement specific rollback actions
        await q.query(
          `UPDATE rollback_plans SET steps = jsonb_set(steps, '{${step.id},status}', '"COMPLETED"') WHERE id = $1`,
          [rollbackPlan.id],
        );
      } catch (error) {
        await q.query(
          `UPDATE rollback_plans SET steps = jsonb_set(steps, '{${step.id},status}', '"FAILED"') WHERE id = $1`,
          [rollbackPlan.id],
        );
      }
    }

    await q.query(
      `UPDATE rollback_plans SET status = 'COMPLETED' WHERE id = $1`,
      [rollbackPlan.id],
    );
  });

  await recordAudit({
    action: 'rollback_executed',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'rollback_plan',
    resourceId: rollbackPlan.id,
    detail: { runbookId: '', rollbackPlanId: rollbackPlan.id },
  });
}

export async function createRunbookTemplate(
  userId: string,
  projectId: string,
  template: Omit<RunbookTemplate, 'id' | 'isSystem'>
): Promise<RunbookTemplate> {
  await assertProjectAccess(userId, projectId);

  const templateId = newId(PREFIX.RUNBOOK_TEMPLATE);
  const templateData: RunbookTemplate = {
    id: templateId,
    ...template,
    isSystem: false,
  };

  await withTenant(userId, (q) =>
    q.query(
      `INSERT INTO runbook_templates (id, name, description, category, template, is_system)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [templateId, template.name, template.description, template.category, JSON.stringify(template.template), false],
    ),
  );

  return templateData;
}

export async function getRunbookTemplates(
  userId: string,
  projectId: string,
  options: { category?: string; isSystem?: boolean } = {}
): Promise<RunbookTemplate[]> {
  await assertProjectAccess(userId, projectId);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.category) {
    params.push(options.category);
    conditions.push(`category = $${paramIndex++}`);
  }
  if (options.isSystem !== undefined) {
    params.push(options.isSystem);
    conditions.push(`is_system = $${paramIndex++}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await withSystem<Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    template: any;
    is_system: boolean;
  }>>((q) =>
    q
      .query<{
        id: string;
        name: string;
        description: string;
        category: string;
        template: any;
        is_system: boolean;
      }>(`SELECT * FROM runbook_templates ${whereClause} ORDER BY created_at DESC`, params)
      .then((r) => r.rows),
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category as RunbookTemplate['category'],
    template: row.template,
    isSystem: row.is_system,
  }));
}

export async function getRunbookExecution(
  userId: string,
  projectId: string,
  executionId: string
): Promise<RunbookExecution> {
  await assertProjectAccess(userId, projectId);

  const rows = await withTenant<
    Array<{
      id: string;
      runbook_id: string;
      trigger: string;
      trigger_data: Record<string, unknown>;
      status: RunbookStatus;
      current_step_id: string | null;
      started_at: Date;
      completed_at: Date | null;
      executed_by: string;
      steps: RunbookStepResult[];
      rollback_executed: boolean;
    }>
  >(userId, (q) =>
    q
      .query<{
        id: string;
        runbook_id: string;
        trigger: string;
        trigger_data: Record<string, unknown>;
        status: RunbookStatus;
        current_step_id: string | null;
        started_at: Date;
        completed_at: Date | null;
        executed_by: string;
        steps: RunbookStepResult[];
        rollback_executed: boolean;
      }>('SELECT * FROM runbook_executions WHERE id = $1', [executionId])
      .then((r) => r.rows),
  );

  if (!rows[0]) throw AppError.notFound('Runbook execution');
  return rows[0] as unknown as RunbookExecution;
}

export async function listRunbookExecutions(
  userId: string,
  projectId: string,
  options: { runbookId?: string; status?: RunbookStatus; limit?: number; offset?: number } = {}
): Promise<{ executions: RunbookExecution[]; total: number }> {
  await assertProjectAccess(userId, projectId);

  const conditions: string[] = ['re.project_id = $1'];
  const params: unknown[] = [projectId];
  let paramIndex = 2;

  if (options.runbookId) {
    conditions.push(`re.runbook_id = $${paramIndex++}`);
    params.push(options.runbookId);
  }
  if (options.status) {
    conditions.push(`re.status = $${paramIndex++}`);
    params.push(options.status);
  }

  const whereClause = conditions.join(' AND ');
  const countResult = await withTenant<{ count: number } | null>(userId, (q) =>
    q
      .query(`SELECT count(*)::int FROM runbook_executions re WHERE ${whereClause}`, params)
      .then((r) => r.rows[0] ?? null),
  );
  const total = countResult?.count ?? 0;

  const dataParams = [...params, options.limit ?? 50, options.offset ?? 0];
  const dataQuery = `SELECT re.* FROM runbook_executions re WHERE ${whereClause} ORDER BY re.started_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

  const rows = await withTenant<
    Array<{
      id: string;
      runbook_id: string;
      trigger: string;
      trigger_data: Record<string, unknown>;
      status: RunbookStatus;
      current_step_id: string | null;
      started_at: Date;
      completed_at: Date | null;
      executed_by: string;
      steps: RunbookStepResult[];
      rollback_executed: boolean;
    }>
  >(userId, (q) =>
    q
      .query<{
        id: string;
        runbook_id: string;
        trigger: string;
        trigger_data: Record<string, unknown>;
        status: RunbookStatus;
        current_step_id: string | null;
        started_at: Date;
        completed_at: Date | null;
        executed_by: string;
        steps: RunbookStepResult[];
        rollback_executed: boolean;
      }>(dataQuery, dataParams)
      .then((r) => r.rows),
  );

  return { executions: rows as unknown as RunbookExecution[], total };
}

async function getRunbookTemplate(templateId: string): Promise<RunbookTemplate | null> {
  const rows = await withSystem<Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    template: any;
    is_system: boolean;
  }>>((q) =>
    q
      .query<{
        id: string;
        name: string;
        description: string;
        category: string;
        template: any;
        is_system: boolean;
      }>('SELECT * FROM runbook_templates WHERE id = $1', [templateId])
      .then((r) => r.rows),
  );

  if (!rows[0]) return null;
  const r = rows[0];
  return { id: r.id, name: r.name, description: r.description, category: r.category as RunbookTemplate['category'], template: r.template, isSystem: r.is_system };
}

export async function getSystemRunbookTemplates(): Promise<RunbookTemplate[]> {
  const rows = await withSystem<Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    template: any;
    is_system: boolean;
  }>>((q) =>
    q
      .query<{
        id: string;
        name: string;
        description: string;
        category: string;
        template: any;
        is_system: boolean;
      }>('SELECT * FROM runbook_templates WHERE is_system = true ORDER BY created_at DESC', [])
      .then((r) => r.rows),
  );

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category as RunbookTemplate['category'],
    template: row.template,
    isSystem: row.is_system,
  }));
}