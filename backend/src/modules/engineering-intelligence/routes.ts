/**
 * CodeConClave — Engineering Intelligence Routes (V4A).
 * Architecture Oracle, Technical Debt Slayer, Performance Oracle,
 * Code Search Oracle, Context Flow Analyzer, Refactoring Wizard.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  getArchitectureSummary,
  getDependencyGraph,
  analyzeImpact,
  detectArchitectureRisks,
  getArchitectureChangeHistory,
} from './architectureOracle.js';
import {
  analyzeTechnicalDebt,
  getDebtTrends,
  createDebtResolutionTask,
  proposeDebtResolution,
} from './debtSlayer.js';
import {
  generatePerformanceReport,
  detectPerformanceRegressions,
} from './performanceOracle.js';
import {
  searchSymbols,
  findImplementations,
  searchDependencies,
  getCallGraph,
  findSimilarCode,
  searchTodos,
  findDeadCode,
  analyzeRefactoringImpact,
} from './codeSearchOracle.js';
import {
  analyzeContextFlow,
  traceDataOrigin,
  traceDataDestination,
} from './contextFlowAnalyzer.js';
import {
  createRefactoringPlan,
  executeRefactoringPlan,
  getRefactoringPlan,
  listRefactoringPlans,
  rollbackRefactoring,
} from './refactoringWizard.js';

export const engineeringIntelligenceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const userId = (req: { ctx?: { user?: { id?: string } | null } }): string => {
    const id = req.ctx?.user?.id;
    if (!id) throw AppError.unauthorized('authentication_required', 'Authentication required');
    return id;
  };

  const pid = (req: { params?: Record<string, string | undefined>; query?: Record<string, any> }): string => {
    const id = req.params?.projectId ?? req.query?.projectId;
    if (!id) throw AppError.badRequest('project_required', 'projectId is required');
    return String(id);
  };

  const rid = (v: string | undefined): string => {
    if (!v) throw AppError.badRequest('missing_id', 'Resource id is required');
    return v;
  };

  // ============================================================ ARCHITECTURE ORACLE
  router.get(
    '/architecture/summary',
    asyncRoute(async (req, res) => {
      const summary = await getArchitectureSummary(userId(req), pid(req));
      res.json(jsonResult({ summary }));
    }),
  );

  router.get(
    '/architecture/dependencies',
    asyncRoute(async (req, res) => {
      const graph = await getDependencyGraph(userId(req), pid(req));
      res.json(jsonResult({ graph }));
    }),
  );

  router.get(
    '/architecture/impact',
    asyncRoute(async (req, res) => {
      const target = String(req.query.target ?? '');
      if (!target) throw AppError.badRequest('target_required', 'target module is required');
      const analysis = await analyzeImpact(userId(req), pid(req), target);
      res.json(jsonResult({ analysis }));
    }),
  );

  router.get(
    '/architecture/risks',
    asyncRoute(async (req, res) => {
      const risks = await detectArchitectureRisks(userId(req), pid(req));
      res.json(jsonResult({ risks }));
    }),
  );

  router.get(
    '/architecture/history',
    asyncRoute(async (req, res) => {
      const history = await getArchitectureChangeHistory(userId(req), pid(req));
      res.json(jsonResult({ history }));
    }),
  );

  // ============================================================ TECHNICAL DEBT SLAYER
  router.get(
    '/debt/analyze',
    asyncRoute(async (req, res) => {
      const result = await analyzeTechnicalDebt(userId(req), pid(req));
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/debt/trends',
    asyncRoute(async (req, res) => {
      const period = (req.query.period as 'week' | 'month' | 'quarter') ?? 'month';
      const trends = await getDebtTrends(userId(req), pid(req), period);
      res.json(jsonResult({ trends }));
    }),
  );

  router.post(
    '/debt/:itemId/task',
    asyncRoute(async (req, res) => {
      const itemId = rid(req.params.itemId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const debtItem = body.debtItem as any;
      if (!debtItem) throw AppError.badRequest('debt_item_required', 'debtItem is required in body');
      const task = await createDebtResolutionTask(userId(req), pid(req), debtItem);
      res.status(201).json(jsonResult({ task }));
    }),
  );

  router.post(
    '/debt/:itemId/propose',
    asyncRoute(async (req, res) => {
      const itemId = rid(req.params.itemId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const debtItem = body.debtItem as any;
      if (!debtItem) throw AppError.badRequest('debt_item_required', 'debtItem is required in body');
      const approvalId = await proposeDebtResolution(userId(req), pid(req), debtItem);
      res.json(jsonResult({ approvalId }));
    }),
  );

  // ============================================================ PERFORMANCE ORACLE
  router.get(
    '/performance/report',
    asyncRoute(async (req, res) => {
      const report = await generatePerformanceReport(userId(req), pid(req));
      res.json(jsonResult({ report }));
    }),
  );

  router.get(
    '/performance/regressions',
    asyncRoute(async (req, res) => {
      const baseline = req.query.baseline ? new Date(String(req.query.baseline)) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const current = req.query.current ? new Date(String(req.query.current)) : new Date();
      const regressions = await detectPerformanceRegressions(userId(req), pid(req), baseline, current);
      res.json(jsonResult({ regressions }));
    }),
  );

  // ============================================================ CODE SEARCH ORACLE
  router.get(
    '/search/symbols',
    asyncRoute(async (req, res) => {
      const query = String(req.query.q ?? '');
      const type = req.query.type as any;
      const includeRefs = req.query.includeRefs === 'true';
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const result = await searchSymbols(userId(req), pid(req), query, { type, includeReferences: includeRefs, limit });
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/search/implementations',
    asyncRoute(async (req, res) => {
      const interfaceName = String(req.query.interface ?? '');
      if (!interfaceName) throw AppError.badRequest('interface_required', 'interface query param required');
      const result = await findImplementations(userId(req), pid(req), interfaceName);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/search/dependencies',
    asyncRoute(async (req, res) => {
      const target = String(req.query.target ?? '');
      if (!target) throw AppError.badRequest('target_required', 'target query param required');
      const direction = (req.query.direction as 'dependents' | 'dependencies' | 'both') ?? 'both';
      const result = await searchDependencies(userId(req), pid(req), target, direction);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/search/call-graph',
    asyncRoute(async (req, res) => {
      const root = String(req.query.root ?? '');
      if (!root) throw AppError.badRequest('root_required', 'root symbol query param required');
      const maxDepth = req.query.maxDepth ? parseInt(String(req.query.maxDepth), 10) : 3;
      const result = await getCallGraph(userId(req), pid(req), root, maxDepth);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/search/similar',
    asyncRoute(async (req, res) => {
      const code = String(req.query.code ?? '');
      if (!code) throw AppError.badRequest('code_required', 'code query param required');
      const threshold = req.query.threshold ? parseFloat(String(req.query.threshold)) : 0.6;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;
      const result = await findSimilarCode(userId(req), pid(req), code, { threshold, limit });
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/search/todos',
    asyncRoute(async (req, res) => {
      const type = req.query.type as any;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
      const result = await searchTodos(userId(req), pid(req), { type, limit });
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/search/dead-code',
    asyncRoute(async (req, res) => {
      const result = await findDeadCode(userId(req), pid(req));
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/search/refactoring-impact',
    asyncRoute(async (req, res) => {
      const target = String(req.query.target ?? '');
      if (!target) throw AppError.badRequest('target_required', 'target symbol query param required');
      const result = await analyzeRefactoringImpact(userId(req), pid(req), target);
      res.json(jsonResult({ result }));
    }),
  );

  // ============================================================ CONTEXT FLOW ANALYZER
  router.get(
    '/flow/analyze',
    asyncRoute(async (req, res) => {
      const result = await analyzeContextFlow(userId(req), pid(req));
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/flow/origin',
    asyncRoute(async (req, res) => {
      const variable = String(req.query.variable ?? '');
      const file = String(req.query.file ?? '');
      if (!variable || !file) throw AppError.badRequest('params_required', 'variable and file query params required');
      const origin = await traceDataOrigin(userId(req), pid(req), variable, file);
      res.json(jsonResult({ origin }));
    }),
  );

  router.get(
    '/flow/destination',
    asyncRoute(async (req, res) => {
      const variable = String(req.query.variable ?? '');
      if (!variable) throw AppError.badRequest('variable_required', 'variable query param required');
      const destinations = await traceDataDestination(userId(req), pid(req), variable);
      res.json(jsonResult({ destinations }));
    }),
  );

  // ============================================================ REFACTORING WIZARD
  router.post(
    '/refactor/plan',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const type = body.type as RefactoringType;
      const target = body.target as any;
      if (!type || !target?.filePath) {
        throw AppError.badRequest('invalid_input', 'type and target.filePath are required');
      }
      const plan = await createRefactoringPlan(userId(req), pid(req), type, target);
      res.status(201).json(jsonResult({ plan }));
    }),
  );

  router.get(
    '/refactor/plans',
    asyncRoute(async (req, res) => {
      const plans = await listRefactoringPlans(userId(req), pid(req));
      res.json(jsonResult({ plans }));
    }),
  );

  router.post(
    '/refactor/:planId/execute',
    asyncRoute(async (req, res) => {
      const planId = rid(req.params.planId);
      const result = await executeRefactoringPlan(userId(req), planId);
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/refactor/:planId',
    asyncRoute(async (req, res) => {
      const planId = rid(req.params.planId);
      const plan = await getRefactoringPlan(userId(req), planId);
      res.json(jsonResult({ plan }));
    }),
  );

  router.post(
    '/refactor/:planId/rollback',
    asyncRoute(async (req, res) => {
      const planId = rid(req.params.planId);
      const result = await rollbackRefactoring(userId(req), planId);
      res.json(jsonResult({ result }));
    }),
  );

  return router;
};

type RefactoringType =
  | 'extract_function'
  | 'rename'
  | 'move_code'
  | 'remove_duplication'
  | 'simplify_complexity'
  | 'modernization'
  | 'type_improvement'
  | 'safe_async_conversion';