/**
 * CodeConClave — execution routes: tasks, approvals, coworker runs/artifacts.
 */
import { Router } from 'express';
import { withTenant } from '../../shared/db.js';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { createTask, listTasks, getTask, cancelTask, listAttempts, listSteps, retryTask, listDeadLettered, listTaskDependencies } from './tasks.js';
import { getCoworkerRunTaskId } from './coworkers.js';
import { decideApproval, listApprovals, getApproval, pendingApprovalCount, proposeApproval, executeApprovedAction } from './approvals.js';
import { getTaskTimeline } from './orchestrator.js';
import { listToolCalls } from './toolcalls.js';
import { listCoworkerRuns, listCoworkerArtifacts } from './coworkers.js';
import { COWORKERS } from './coworkers.js';

export const executionRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  // ---------------------------------------------------------------- tasks
  router.get(
    '/tasks',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      res.json(jsonResult({ tasks: await listTasks(req.ctx.user!.id, projectId) }));
    }),
  );

  router.post(
    '/tasks',
    asyncRoute(async (req, res) => {
      const { projectId, title, description, riskLevel, executionMode, coworkerPipeline, priority, dependsOn } = req.body ?? {};
      if (!projectId || !title) throw AppError.badRequest('invalid_input', 'projectId and title are required');
      if (riskLevel && !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(riskLevel)) {
        throw AppError.badRequest('invalid_risk', 'riskLevel must be LOW, MEDIUM, HIGH, or CRITICAL');
      }
      if (priority !== undefined && (typeof priority !== 'number' || priority < 0 || priority > 10)) {
        throw AppError.badRequest('invalid_priority', 'priority must be an integer 0..10');
      }
      if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string'))) {
        throw AppError.badRequest('invalid_dependencies', 'dependsOn must be an array of task ids');
      }
      const { createTaskFromChat } = await import('./orchestrator.js');
      const task = await createTaskFromChat({
        userId: req.ctx.user!.id,
        projectId,
        conversationId: req.body.conversationId ?? null,
        title,
        description: description ?? null,
        riskLevel,
        pipeline: coworkerPipeline,
        priority: priority ?? 0,
        dependsOn,
      });
      res.status(201).json(jsonResult({ task }));
    }),
  );

  router.get(
    '/tasks/dlq',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ deadLettered: await listDeadLettered(req.ctx.user!.id) }));
    }),
  );

  router.get(
    '/tasks/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await getTaskTimeline(req.ctx.user!.id, req.params.id!)));
    }),
  );

  // All task sub-resources assert ownership up front (same gate as GET /tasks/:id)
  // so a caller can never read or follow another user's task state.
  const assertTaskOwner = async (userId: string, taskId: string): Promise<void> => {
    await getTask(userId, taskId);
  };

  router.get(
    '/tasks/:id/plan',
    asyncRoute(async (req, res) => {
      await assertTaskOwner(req.ctx.user!.id, req.params.id!);
      const { getPlan } = await import('./planner.js');
      res.json(jsonResult({ plan: await getPlan(req.params.id!) }));
    }),
  );

  router.get(
    '/tasks/:id/dependencies',
    asyncRoute(async (req, res) => {
      await assertTaskOwner(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ dependencies: await listTaskDependencies(req.params.id!) }));
    }),
  );

  router.get(
    '/tasks/:id/artifacts',
    asyncRoute(async (req, res) => {
      await assertTaskOwner(req.ctx.user!.id, req.params.id!);
      const { listCoworkerRuns, listCoworkerArtifacts } = await import('./coworkers.js');
      const runs = await listCoworkerRuns(req.params.id!);
      const artifacts = (
        await Promise.all(runs.map((r) => listCoworkerArtifacts(r.id).then((a) => a.map((x) => ({ ...x, run: r.coworker_type })))))
      ).flat();
      res.json(jsonResult({ artifacts }));
    }),
  );

  router.post(
    '/tasks/:id/retry',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ task: await retryTask(req.ctx.user!.id, req.params.id!, req.body?.reason) }));
    }),
  );

  router.post(
    '/tasks/:id/cancel',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ task: await cancelTask(req.ctx.user!.id, req.params.id!, req.body?.reason) }));
    }),
  );

  router.get(
    '/tasks/:id/steps',
    asyncRoute(async (req, res) => {
      await assertTaskOwner(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ steps: await listSteps(req.params.id!) }));
    }),
  );

  router.get(
    '/tasks/:id/attempts',
    asyncRoute(async (req, res) => {
      await assertTaskOwner(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ attempts: await listAttempts(req.params.id!) }));
    }),
  );

  router.get(
    '/tasks/:id/tool-calls',
    asyncRoute(async (req, res) => {
      await assertTaskOwner(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ toolCalls: await listToolCalls(req.params.id!) }));
    }),
  );

  // ---------------------------------------------------------------- approvals
  router.post(
    '/approvals',
    asyncRoute(async (req, res) => {
      const { approvalProposeSchema } = await import('@codeconclave/shared');
      const parsed = approvalProposeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw AppError.badRequest('invalid_proposal', 'Invalid approval proposal', parsed.error.flatten());
      }
      const { riskLevel, ...rest } = parsed.data;
      const proposal: Parameters<typeof proposeApproval>[1] = {
        ...rest,
        riskLevel: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined,
      };
      res.status(201).json(jsonResult(await proposeApproval(req.ctx.user!.id, proposal)));
    }),
  );

  router.post(
    '/approvals/:id/execute',
    asyncRoute(async (req, res) => {
      const { approvalExecuteSchema } = await import('@codeconclave/shared');
      const parsed = approvalExecuteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw AppError.badRequest('invalid_execution', 'Invalid approval execution', parsed.error.flatten());
      }
      res.json(
        jsonResult({
          approval: await executeApprovedAction(req.ctx.user!.id, req.params.id!, parsed.data),
        }),
      );
    }),
  );

  router.get(
    '/approvals',
    asyncRoute(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      res.json(
        jsonResult({
          approvals: await listApprovals(req.ctx.user!.id, status),
          pendingCount: await pendingApprovalCount(req.ctx.user!.id),
        }),
      );
    }),
  );

  router.get(
    '/approvals/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ approval: await getApproval(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/approvals/:id/decide',
    asyncRoute(async (req, res) => {
      const decision = req.body?.decision;
      if (decision !== 'APPROVE' && decision !== 'REJECT') {
        throw AppError.badRequest('invalid_decision', 'decision must be APPROVE or REJECT');
      }
      const { withIdempotency, idempotencyKeyFrom } = await import('../idempotency/route.js');
      const result = await withIdempotency({
        op: 'approval.decide',
        key: idempotencyKeyFrom(req),
        userId: req.ctx.user!.id,
        payload: { approvalId: req.params.id, decision, reason: req.body?.reason ?? null },
        run: async () => ({ approval: await decideApproval(req.ctx.user!.id, req.params.id!, decision, req.body?.reason) }),
      });
      res.json(jsonResult(result.response));
    }),
  );

  // ---------------------------------------------------------------- coworkers
  router.get(
    '/coworkers',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      res.json(
        jsonResult({ coworkers: COWORKERS, runs: projectId ? await listCoworkerRunsForProject(req.ctx.user!.id, projectId) : [] }),
      );
    }),
  );

  router.get(
    '/coworkers/runs/:runId/artifacts',
    asyncRoute(async (req, res) => {
      const runId = req.params.runId!;
      const taskId = await getCoworkerRunTaskId(runId);
      if (!taskId) throw AppError.notFound('Coworker run');
      await assertTaskOwner(req.ctx.user!.id, taskId);
      res.json(jsonResult({ artifacts: await listCoworkerArtifacts(runId) }));
    }),
  );

  return router;
};

async function listCoworkerRunsForProject(userId: string, projectId: string): Promise<unknown[]> {
  const { withTenant } = await import('../../shared/db.js');
  return withTenant<unknown[]>(userId, async (q) =>
    (
      await q.query(
        `SELECT cr.*, t.title AS task_title
       FROM coworker_runs cr
       JOIN tasks t ON t.id = cr.task_id
      WHERE t.project_id = $1 AND t.owner_id = $2
      ORDER BY cr.created_at DESC LIMIT 50`,
        [projectId, userId],
      )
    ).rows,
  );
}

export { getTask };