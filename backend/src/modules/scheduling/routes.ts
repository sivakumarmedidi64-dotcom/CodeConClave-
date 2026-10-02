/**
 * CodeConClave — scheduling + Goal Mode routes (Stage 26C).
 * Every action is server-authoritative: next-run previews, recurrence
 * validation, approval decisions and escalation decisions are all computed
 * server-side. The scheduler itself runs in the watchdog sweep.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  createSchedule,
  deleteSchedule,
  describeSchedule,
  getSchedule,
  listScheduleRuns,
  listSchedules,
  previewNextRuns,
  runNow,
  setScheduleEnabled,
  updateSchedule,
  type ScheduleInput,
} from './service.js';
import {
  cancelGoal,
  createEscalation,
  createGoal,
  decideEscalation,
  decideGoalApproval,
  executeGoal,
  generateGoalPlan,
  getGoal,
  listEscalations,
  listGoalActivities,
  listGoals,
  pauseGoal,
  refreshGoal,
  resumeGoal,
  startGoal,
  updateGoalPlan,
} from './goals.js';

const RECURRENCES = ['ONCE', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'CRON'];
const MODES = ['CLOUD', 'LOCAL_ONLY', 'HYBRID'];
const POLICIES = ['RUN_ON_RECOVERY', 'SKIP_STALE', 'RUN_ONCE'];

function scheduleBody(req: { body: Record<string, unknown> }): ScheduleInput {
  const b = req.body ?? {};
  const recurrence = String(b.recurrence ?? 'DAILY').toUpperCase();
  if (!RECURRENCES.includes(recurrence)) throw AppError.badRequest('invalid_recurrence', `recurrence must be one of ${RECURRENCES.join(', ')}`);
  const executionMode = String(b.executionMode ?? 'CLOUD').toUpperCase();
  if (!MODES.includes(executionMode)) throw AppError.badRequest('invalid_execution_mode', `executionMode must be one of ${MODES.join(', ')}`);
  const missedRunPolicy = String(b.missedRunPolicy ?? 'RUN_ON_RECOVERY').toUpperCase();
  if (!POLICIES.includes(missedRunPolicy)) throw AppError.badRequest('invalid_missed_policy', `missedRunPolicy must be one of ${POLICIES.join(', ')}`);
  return {
    projectId: b.projectId ? String(b.projectId) : null,
    agentId: String(b.agentId ?? ''),
    title: String(b.title ?? ''),
    description: b.description ? String(b.description) : null,
    recurrence: recurrence as ScheduleInput['recurrence'],
    cronExpression: b.cronExpression ? String(b.cronExpression) : null,
    timezone: b.timezone ? String(b.timezone) : undefined,
    runAt: b.runAt ? String(b.runAt) : undefined,
    runOnDays: Array.isArray(b.runOnDays) ? b.runOnDays.map(String) : undefined,
    executionMode: executionMode as ScheduleInput['executionMode'],
    missedRunPolicy: missedRunPolicy as ScheduleInput['missedRunPolicy'],
    requireApproval: typeof b.requireApproval === 'boolean' ? b.requireApproval : undefined,
    timeoutMs: typeof b.timeoutMs === 'number' ? b.timeoutMs : undefined,
    maxAttempts: typeof b.maxAttempts === 'number' ? b.maxAttempts : undefined,
    notifyOnCompletion: typeof b.notifyOnCompletion === 'boolean' ? b.notifyOnCompletion : undefined,
  };
}

export const schedulingRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  // ---------------------------------------------------------------- schedules

  router.get(
    '/schedules',
    asyncRoute(async (req, res) => {
      const includeDisabled = req.query.includeDisabled === '1';
      const items = await listSchedules(req.ctx.user!.id, includeDisabled);
      res.json(jsonResult({
        schedules: items.map((s) => ({ ...s, description: describeSchedule(s) })),
      }));
    }),
  );

  router.post(
    '/schedules',
    asyncRoute(async (req, res) => {
      const schedule = await createSchedule(req.ctx.user!.id, scheduleBody(req));
      res.status(201).json(jsonResult({ schedule }));
    }),
  );

  router.get(
    '/schedules/:id',
    asyncRoute(async (req, res) => {
      const schedule = await getSchedule(req.ctx.user!.id, req.params.id!);
      const preview = await previewNextRuns(req.ctx.user!.id, req.params.id!, 5);
      res.json(jsonResult({ schedule, preview }));
    }),
  );

  router.patch(
    '/schedules/:id',
    asyncRoute(async (req, res) => {
      const schedule = await updateSchedule(req.ctx.user!.id, req.params.id!, scheduleBody(req));
      res.json(jsonResult({ schedule }));
    }),
  );

  router.delete(
    '/schedules/:id',
    asyncRoute(async (req, res) => {
      await deleteSchedule(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/schedules/:id/pause',
    asyncRoute(async (req, res) => res.json(jsonResult({ schedule: await setScheduleEnabled(req.ctx.user!.id, req.params.id!, false) }))),
  );

  router.post(
    '/schedules/:id/resume',
    asyncRoute(async (req, res) => res.json(jsonResult({ schedule: await setScheduleEnabled(req.ctx.user!.id, req.params.id!, true) }))),
  );

  router.post(
    '/schedules/:id/run-now',
    asyncRoute(async (req, res) => {
      const run = await runNow(req.ctx.user!.id, req.params.id!);
      res.status(202).json(jsonResult({ run }));
    }),
  );

  router.get(
    '/schedules/:id/preview',
    asyncRoute(async (req, res) => {
      const count = Math.min(Math.max(Number(req.query.count ?? 5), 1), 20);
      res.json(jsonResult(await previewNextRuns(req.ctx.user!.id, req.params.id!, count)));
    }),
  );

  router.get(
    '/schedules/:id/runs',
    asyncRoute(async (req, res) => {
      const limit = Number(req.query.limit ?? 20);
      res.json(jsonResult({ runs: await listScheduleRuns(req.ctx.user!.id, req.params.id!, limit) }));
    }),
  );

  // ---------------------------------------------------------------- goals

  router.get(
    '/goals',
    asyncRoute(async (req, res) => {
      const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
      res.json(jsonResult({ goals: await listGoals(req.ctx.user!.id, status as never) }));
    }),
  );

  router.post(
    '/goals',
    asyncRoute(async (req, res) => {
      const b = req.body ?? {};
      const goal = await createGoal(req.ctx.user!.id, {
        title: String(b.title ?? ''),
        objective: String(b.objective ?? ''),
        successCriteria: Array.isArray(b.successCriteria) ? b.successCriteria.map(String) : undefined,
        constraints: Array.isArray(b.constraints) ? b.constraints.map(String) : undefined,
        projectId: b.projectId ? String(b.projectId) : null,
        budgetUsd: typeof b.budgetUsd === 'number' ? b.budgetUsd : undefined,
        deadlineAt: b.deadlineAt ? String(b.deadlineAt) : null,
        requireApproval: typeof b.requireApproval === 'boolean' ? b.requireApproval : undefined,
      });
      res.status(201).json(jsonResult({ goal }));
    }),
  );

  router.get(
    '/goals/:id',
    asyncRoute(async (req, res) => res.json(jsonResult({ goal: await getGoal(req.ctx.user!.id, req.params.id!) }))),
  );

  router.get(
    '/goals/:id/refresh',
    asyncRoute(async (req, res) => res.json(jsonResult({ goal: await refreshGoal(req.ctx.user!.id, req.params.id!) }))),
  );

  router.get(
    '/goals/:id/activities',
    asyncRoute(async (req, res) => res.json(jsonResult({ activities: await listGoalActivities(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/goals/:id/plan',
    asyncRoute(async (req, res) => res.json(jsonResult({ goal: await generateGoalPlan(req.ctx.user!.id, req.params.id!) }))),
  );

  router.put(
    '/goals/:id/plan',
    asyncRoute(async (req, res) => {
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      res.json(jsonResult({ goal: await updateGoalPlan(req.ctx.user!.id, req.params.id!, entries) }));
    }),
  );

  router.post(
    '/goals/:id/start',
    asyncRoute(async (req, res) => res.json(jsonResult({ goal: await startGoal(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/goals/:id/execute',
    asyncRoute(async (req, res) => res.json(jsonResult({ goal: await executeGoal(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/goals/:id/approve',
    asyncRoute(async (req, res) => {
      const b = req.body ?? {};
      const decision = String(b.decision ?? '').toUpperCase();
      if (!['APPROVE', 'REJECT'].includes(decision)) throw AppError.badRequest('invalid_decision', 'decision must be APPROVE or REJECT');
      res.json(jsonResult({ goal: await decideGoalApproval(req.ctx.user!.id, req.params.id!, decision as 'APPROVE' | 'REJECT', b.reason ? String(b.reason) : undefined) }));
    }),
  );

  router.post(
    '/goals/:id/pause',
    asyncRoute(async (req, res) => res.json(jsonResult({ goal: await pauseGoal(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/goals/:id/resume',
    asyncRoute(async (req, res) => res.json(jsonResult({ goal: await resumeGoal(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/goals/:id/cancel',
    asyncRoute(async (req, res) => {
      const b = req.body ?? {};
      res.json(jsonResult({ goal: await cancelGoal(req.ctx.user!.id, req.params.id!, b.reason ? String(b.reason) : undefined) }));
    }),
  );

  // ---------------------------------------------------------------- escalations

  router.get(
    '/escalations',
    asyncRoute(async (req, res) => {
      const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
      res.json(jsonResult({ escalations: await listEscalations(req.ctx.user!.id, status) }));
    }),
  );

  router.post(
    '/escalations',
    asyncRoute(async (req, res) => {
      const b = req.body ?? {};
      const escalation = await createEscalation(req.ctx.user!.id, {
        goalId: b.goalId ? String(b.goalId) : undefined,
        scheduleId: b.scheduleId ? String(b.scheduleId) : undefined,
        issue: String(b.issue ?? ''),
        evidence: Array.isArray(b.evidence) ? b.evidence : undefined,
        attemptedActions: Array.isArray(b.attemptedActions) ? b.attemptedActions.map(String) : undefined,
        options: Array.isArray(b.options) ? b.options.map(String) : undefined,
        recommendation: b.recommendation ? String(b.recommendation) : undefined,
        risk: b.risk ? String(b.risk) : undefined,
      });
      res.status(201).json(jsonResult({ escalation }));
    }),
  );

  router.post(
    '/escalations/:id/decide',
    asyncRoute(async (req, res) => {
      const b = req.body ?? {};
      const decision = String(b.decision ?? '').toUpperCase();
      const valid = ['APPROVE', 'REJECT', 'EDIT_PLAN', 'RETRY', 'PAUSE', 'CANCEL'];
      if (!valid.includes(decision)) throw AppError.badRequest('invalid_decision', `decision must be one of ${valid.join(', ')}`);
      res.json(jsonResult({ escalation: await decideEscalation(req.ctx.user!.id, req.params.id!, decision as never, b.note ? String(b.note) : undefined) }));
    }),
  );

  return router;
};