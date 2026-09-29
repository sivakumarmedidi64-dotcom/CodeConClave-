/**
 * CodeConClave — Production Intelligence Routes (V4D).
 * Log Analysis, Error Correlation, Request Tracing, DB Performance,
 * Monitoring Autopilot, Runbook Automation, Cost Analysis.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  analyzeLogs,
} from './logAnalysis.js';
import {
  traceCorrelation,
} from './errorCorrelation.js';
import {
  traceRequest,
  getRequestTrace,
  getRequestTraceStats,
} from './requestTracing.js';
import {
  generateDbPerformanceReport,
  getDbPerformanceReport,
} from './dbPerformance.js';
import {
  runMonitoringAutopilot,
  getMonitoringConfig,
  updateMonitoringConfig,
  getAlertHistory,
  addSuppressionRule,
  getSuppressionRules,
} from './monitoringAutopilot.js';
import {
  createRunbook,
  createRunbookFromTemplate,
  getRunbook,
  listRunbooks,
  executeRunbook,
  getRunbookExecution,
  listRunbookExecutions,
  createRunbookTemplate,
  getRunbookTemplates,
  getSystemRunbookTemplates,
} from './runbookAutomation.js';
import type { RunbookStatus } from './runbookAutomation.js';
import {
  recordCost,
  recordAICost,
  recordTaskCost,
  getCostBreakdown,
  getProviderCosts,
  getCostTrends,
  getTopCostDrivers,
  createBudget,
  getBudgets,
  updateBudget,
  checkBudgetAlerts,
  acknowledgeBudgetAlert,
  getCostAlerts,
} from './costAnalysis.js';

export const productionIntelligenceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const userId = (req: { ctx?: { user?: { id?: string } | null } }): string => {
    const id = req.ctx?.user?.id;
    if (!id) throw AppError.unauthorized('authentication_required', 'Authentication required');
    return id;
  };

  const pid = (req: { params?: Record<string, string>; query?: Record<string, any> }): string => {
    const qp = req.query?.projectId;
    const id = req.params?.projectId ?? (Array.isArray(qp) ? qp[0] : qp);
    if (!id) throw AppError.badRequest('project_required', 'projectId is required');
    return String(id);
  };

  const rid = (v: string | undefined): string => {
    if (!v) throw AppError.badRequest('missing_id', 'Resource id is required');
    return v;
  };

  // ============================================================ LOG ANALYSIS
  router.post(
    '/logs/analyze',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const result = await analyzeLogs(userId(req), projectId, options);
      res.json(jsonResult({ result }));
    }),
  );

  // ============================================================ ERROR CORRELATION
  router.get(
    '/errors/correlate',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = {
        correlationId: req.query.correlationId as string,
        requestId: req.query.requestId as string,
        userId: req.query.userId as string,
        taskId: req.query.taskId as string,
        agentId: req.query.agentId as string,
        commitSha: req.query.commitSha as string,
        deploymentId: req.query.deploymentId as string,
        timeWindowMs: req.query.timeWindowMs ? parseInt(String(req.query.timeWindowMs), 10) : undefined,
        includeChildren: req.query.includeChildren === 'true',
      };
      const result = await traceCorrelation(userId(req), projectId, options);
      res.json(jsonResult({ result }));
    }),
  );

  // ============================================================ REQUEST TRACING
  router.get(
    '/traces',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = {
        requestId: req.query.requestId as string,
        correlationId: req.query.correlationId as string,
        userId: req.query.userId as string,
        method: req.query.method as string,
        path: req.query.path as string,
        status: req.query.status as string,
        since: req.query.since ? new Date(String(req.query.since)) : undefined,
        until: req.query.until ? new Date(String(req.query.until)) : undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 50,
        offset: req.query.offset ? parseInt(String(req.query.offset), 10) : 0,
      };
      const result = await traceRequest(userId(req), projectId, options);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/traces/:traceId',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const traceId = req.params.traceId;
      const trace = await getRequestTrace(userId(req), projectId, req.params.traceId!);
      if (!trace) throw AppError.notFound('Request trace');
      res.json(jsonResult({ trace }));
    }),
  );

  router.get(
    '/traces/stats',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const since = req.query.since ? new Date(String(req.query.since)) : undefined;
      const until = req.query.until ? new Date(String(req.query.until)) : undefined;
      const stats = await getRequestTraceStats(userId(req), projectId, { since, until });
      res.json(jsonResult({ stats }));
    }),
  );

  // ============================================================ DB PERFORMANCE
  router.post(
    '/db/performance-report',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const report = await generateDbPerformanceReport(userId(req), projectId, options);
      res.json(jsonResult({ report }));
    }),
  );

  router.get(
    '/db/performance-report',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const timeWindowMs = req.query.timeWindowMs ? parseInt(String(req.query.timeWindowMs), 10) : undefined;
      const report = await getDbPerformanceReport(userId(req), projectId, { timeWindowMs });
      res.json(jsonResult({ report }));
    }),
  );

  // ============================================================ MONITORING AUTOPILOT
  router.post(
    '/monitoring/check',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const result = await runMonitoringAutopilot(userId(req), projectId);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/monitoring/config',
    asyncRoute(async (req, res) => {
      const config = await getMonitoringConfig();
      res.json(jsonResult({ config }));
    }),
  );

  router.patch(
    '/monitoring/config',
    asyncRoute(async (req, res) => {
      const config = req.body?.config ?? {};
      const updated = await updateMonitoringConfig(config);
      res.json(jsonResult({ config: updated }));
    }),
  );

  router.get(
    '/monitoring/alerts/history',
    asyncRoute(async (req, res) => {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
      const history = await getAlertHistory(limit);
      res.json(jsonResult({ history }));
    }),
  );

  router.post(
    '/monitoring/suppression-rules',
    asyncRoute(async (req, res) => {
      const rule = req.body?.rule;
      if (!rule) throw AppError.badRequest('rule_required', 'rule is required');
      await addSuppressionRule(rule);
      res.json(jsonResult({ added: true }));
    }),
  );

  router.get(
    '/monitoring/suppression-rules',
    asyncRoute(async (req, res) => {
      const rules = await getSuppressionRules();
      res.json(jsonResult({ rules }));
    }),
  );

  // ============================================================ RUNBOOK AUTOMATION
  router.post(
    '/runbooks',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const body = req.body ?? {};
      const runbook = await createRunbook(userId(req), projectId, {
        name: body.name,
        description: body.description,
        trigger: body.trigger,
        triggerConfig: body.triggerConfig ?? {},
        steps: body.steps ?? [],
        rollbackPlan: body.rollbackPlan,
      });
      res.status(201).json(jsonResult({ runbook }));
    }),
  );

  router.post(
    '/runbooks/from-template',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const { templateId, overrides } = req.body ?? {};
      if (!templateId) throw AppError.badRequest('template_required', 'templateId is required');
      const runbook = await createRunbookFromTemplate(userId(req), projectId, templateId, overrides);
      res.status(201).json(jsonResult({ runbook }));
    }),
  );

  router.get(
    '/runbooks',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const status = req.query.status as RunbookStatus | undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const result = await listRunbooks(userId(req), projectId, { status, limit, offset });
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/runbooks/:id',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const runbook = await getRunbook(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ runbook }));
    }),
  );

  router.post(
    '/runbooks/:id/execute',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const triggerData = req.body?.triggerData ?? {};
      const execution = await executeRunbook(userId(req), projectId, req.params.id!, triggerData);
      res.status(201).json(jsonResult({ execution }));
    }),
  );

  router.get(
    '/runbooks/:id/executions',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const status = req.query.status as string;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const result = await listRunbookExecutions(userId(req), projectId, {
        runbookId: req.params.id,
        status: req.query.status as RunbookStatus | undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 50,
        offset: req.query.offset ? parseInt(String(req.query.offset), 10) : 0,
      });
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/runbooks/executions/:executionId',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const execution = await getRunbookExecution(userId(req), projectId, req.params.executionId!);
      res.json(jsonResult({ execution }));
    }),
  );

  router.post(
    '/runbooks/templates',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const template = await createRunbookTemplate(userId(req), projectId, req.body);
      res.status(201).json(jsonResult({ template }));
    }),
  );

  router.get(
    '/runbooks/templates',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const category = req.query.category as string;
      const isSystem = req.query.isSystem === 'true';
      const templates = await getRunbookTemplates(userId(req), projectId, { category, isSystem });
      res.json(jsonResult({ templates }));
    }),
  );

  router.get(
    '/runbooks/templates/system',
    asyncRoute(async (req, res) => {
      const templates = await getSystemRunbookTemplates();
      res.json(jsonResult({ templates }));
    }),
  );

  // ============================================================ COST ANALYSIS
  router.post(
    '/costs/record',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const body = req.body ?? {};
      const entry = await recordCost(userId(req), projectId, body);
      res.status(201).json(jsonResult({ entry }));
    }),
  );

  router.post(
    '/costs/ai',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const entry = await recordAICost(userId(req), projectId, req.body);
      res.status(201).json(jsonResult({ entry }));
    }),
  );

  router.post(
    '/costs/task',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const entry = await recordTaskCost(userId(req), projectId, req.body);
      res.status(201).json(jsonResult({ entry }));
    }),
  );

  router.get(
    '/costs/breakdown',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const periodStart = req.query.periodStart ? new Date(String(req.query.periodStart)) : undefined;
      const periodEnd = req.query.periodEnd ? new Date(String(req.query.periodEnd)) : undefined;
      const category = req.query.category as string;
      const breakdown = await getCostBreakdown(userId(req), projectId, {
        periodStart,
        periodEnd,
        category: category as any,
      });
      res.json(jsonResult({ breakdown }));
    }),
  );

  router.get(
    '/costs/providers',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const periodStart = req.query.periodStart ? new Date(String(req.query.periodStart)) : undefined;
      const periodEnd = req.query.periodEnd ? new Date(String(req.query.periodEnd)) : undefined;
      const providers = await getProviderCosts(userId(req), projectId, { periodStart, periodEnd });
      res.json(jsonResult({ providers }));
    }),
  );

  router.get(
    '/costs/trends',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const periodStart = req.query.periodStart ? new Date(String(req.query.periodStart)) : undefined;
      const periodEnd = req.query.periodEnd ? new Date(String(req.query.periodEnd)) : undefined;
      const granularity = req.query.granularity as 'DAY' | 'WEEK' | 'MONTH';
      const trends = await getCostTrends(userId(req), projectId, { periodStart, periodEnd, granularity });
      res.json(jsonResult({ trends }));
    }),
  );

  router.get(
    '/costs/drivers',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const periodStart = req.query.periodStart ? new Date(String(req.query.periodStart)) : undefined;
      const periodEnd = req.query.periodEnd ? new Date(String(req.query.periodEnd)) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;
      const drivers = await getTopCostDrivers(userId(req), projectId, { limit: 10 });
      res.json(jsonResult({ drivers }));
    }),
  );

  router.post(
    '/budgets',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const budget = await createBudget(userId(req), projectId, req.body);
      res.status(201).json(jsonResult({ budget }));
    }),
  );

  router.get(
    '/budgets',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const budgets = await getBudgets(userId(req), projectId);
      res.json(jsonResult({ budgets }));
    }),
  );

  router.patch(
    '/budgets/:id',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const budget = await updateBudget(userId(req), projectId, req.params.id!, req.body);
      res.json(jsonResult({ budget }));
    }),
  );

  router.get(
    '/costs/alerts',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const acknowledged = req.query.acknowledged === 'true' ? true : req.query.acknowledged === 'false' ? false : undefined;
      const severity = req.query.severity as string;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const alerts = await getCostAlerts(userId(req), projectId, { acknowledged, severity, limit });
      res.json(jsonResult({ alerts }));
    }),
  );

  router.post(
    '/costs/alerts/:id/acknowledge',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      await acknowledgeBudgetAlert(userId(req), projectId, req.params.id!);
      res.json(jsonResult({ acknowledged: true }));
    }),
  );

  return router;
};