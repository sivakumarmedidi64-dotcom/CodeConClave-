/**
 * CodeConClave — V4A Engineering Intelligence Route Tests.
 * Tests Express routes via a lightweight HTTP server to avoid
 * depending on Express internals (layer.handle is a dispatch wrapper).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';

// ─── Mock functions (hoisted) ──────────────────────────────────
const getArchitectureSummary = vi.hoisted(() => vi.fn());
const getDependencyGraph = vi.hoisted(() => vi.fn());
const analyzeImpact = vi.hoisted(() => vi.fn());
const detectArchitectureRisks = vi.hoisted(() => vi.fn());
const getArchitectureChangeHistory = vi.hoisted(() => vi.fn());
const analyzeTechnicalDebt = vi.hoisted(() => vi.fn());
const getDebtTrends = vi.hoisted(() => vi.fn());
const createDebtResolutionTask = vi.hoisted(() => vi.fn());
const proposeDebtResolution = vi.hoisted(() => vi.fn());
const generatePerformanceReport = vi.hoisted(() => vi.fn());
const detectPerformanceRegressions = vi.hoisted(() => vi.fn());
const searchSymbols = vi.hoisted(() => vi.fn());
const findImplementations = vi.hoisted(() => vi.fn());
const searchDependencies = vi.hoisted(() => vi.fn());
const getCallGraph = vi.hoisted(() => vi.fn());
const findSimilarCode = vi.hoisted(() => vi.fn());
const searchTodos = vi.hoisted(() => vi.fn());
const findDeadCode = vi.hoisted(() => vi.fn());
const analyzeRefactoringImpact = vi.hoisted(() => vi.fn());
const analyzeContextFlow = vi.hoisted(() => vi.fn());
const traceDataOrigin = vi.hoisted(() => vi.fn());
const traceDataDestination = vi.hoisted(() => vi.fn());
const createRefactoringPlan = vi.hoisted(() => vi.fn());
const executeRefactoringPlan = vi.hoisted(() => vi.fn());
const getRefactoringPlan = vi.hoisted(() => vi.fn());
const listRefactoringPlans = vi.hoisted(() => vi.fn());
const rollbackRefactoring = vi.hoisted(() => vi.fn());

const mockUserId = 'user-1';

const mockRequireAuth = vi.hoisted(() =>
  vi.fn((req: any, _res: any, next: () => void) => {
    req.ctx = { user: { id: mockUserId } };
    next();
  }),
);

// ─── Module mocks ──────────────────────────────────────────────
vi.mock('./architectureOracle.js', () => ({
  getArchitectureSummary, getDependencyGraph, analyzeImpact,
  detectArchitectureRisks, getArchitectureChangeHistory,
}));
vi.mock('./debtSlayer.js', () => ({
  analyzeTechnicalDebt, getDebtTrends, createDebtResolutionTask, proposeDebtResolution,
}));
vi.mock('./performanceOracle.js', () => ({
  generatePerformanceReport, detectPerformanceRegressions,
}));
vi.mock('./codeSearchOracle.js', () => ({
  searchSymbols, findImplementations, searchDependencies, getCallGraph,
  findSimilarCode, searchTodos, findDeadCode, analyzeRefactoringImpact,
}));
vi.mock('./contextFlowAnalyzer.js', () => ({
  analyzeContextFlow, traceDataOrigin, traceDataDestination,
}));
vi.mock('./refactoringWizard.js', () => ({
  createRefactoringPlan, executeRefactoringPlan, getRefactoringPlan,
  listRefactoringPlans, rollbackRefactoring,
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: mockRequireAuth,
}));
vi.mock('../../middleware/security.js', () => ({
  asyncRoute: vi.fn((fn: Function) => (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  }),
}));
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    badRequest: (code: string, msg: string) => Object.assign(new Error(msg), { status: 400, errorCode: code }),
    notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, errorCode: 'not_found' }),
    unauthorized: (code: string, msg: string) => Object.assign(new Error(msg), { status: 401, errorCode: code }),
  },
}));
vi.mock('../auth/schemas.js', () => ({
  jsonResult: (data: unknown) => data,
}));

// ─── Test helpers ──────────────────────────────────────────────
type TestResult = { status: number; body: any };

async function startServer(): Promise<{ server: http.Server; port: number }> {
  const { engineeringIntelligenceRoutes } = await import('./routes.js');
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/engineering', engineeringIntelligenceRoutes());
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = err.status || 500;
      res.status(status).json({ error: err.message, errorCode: err.errorCode });
    });
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as any;
      resolve({ server, port: addr.port });
    });
  });
}

function request(port: number, method: string, path: string, body?: any): Promise<TestResult> {
  return new Promise((resolve, reject) => {
    const options: any = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode!, body: parsed });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Test suite ────────────────────────────────────────────────
describe('V4A Engineering Intelligence — Routes', () => {
  let serverRef: http.Server | null = null;
  let portRef = 0;

  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    if (serverRef) {
      await new Promise<void>((resolve) => serverRef!.close(() => resolve()));
      serverRef = null;
    }
  });

  async function setup(server: http.Server, port: number) {
    serverRef = server;
    portRef = port;
  }

  // ── ARCHITECTURE ORACLE ──────────────────────────────────────
  describe('Architecture Oracle', () => {
    it('GET /engineering/architecture/summary returns summary', async () => {
      getArchitectureSummary.mockResolvedValue({ projectId: 'proj-1', modules: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/summary?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(getArchitectureSummary).toHaveBeenCalledWith('user-1', 'proj-1');
      expect(res.body).toEqual({ summary: { projectId: 'proj-1', modules: [] } });
    });

    it('GET /engineering/architecture/summary throws 401 without auth', async () => {
      mockRequireAuth.mockImplementationOnce((req: any, _res: any, next: () => void) => {
        req.ctx = { user: null };
        next();
      });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/summary?projectId=proj-1');
      expect(res.status).toBe(401);
    });

    it('GET /engineering/architecture/summary throws 400 without projectId', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/summary');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/architecture/dependencies returns graph', async () => {
      getDependencyGraph.mockResolvedValue({ nodes: [{ id: 'a' }], edges: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/dependencies?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ graph: { nodes: [{ id: 'a' }], edges: [] } });
    });

    it('GET /engineering/architecture/impact throws 400 without target', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/impact?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/architecture/impact calls with target', async () => {
      analyzeImpact.mockResolvedValue({ risk: 'HIGH' });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/impact?projectId=proj-1&target=auth');
      expect(res.status).toBe(200);
      expect(analyzeImpact).toHaveBeenCalledWith('user-1', 'proj-1', 'auth');
    });

    it('GET /engineering/architecture/risks returns risks', async () => {
      detectArchitectureRisks.mockResolvedValue({ risks: [{ name: 'circular' }] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/risks?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ risks: { risks: [{ name: 'circular' }] } });
    });

    it('GET /engineering/architecture/history returns history', async () => {
      getArchitectureChangeHistory.mockResolvedValue({ changes: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/architecture/history?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ history: { changes: [] } });
    });
  });

  // ── TECHNICAL DEBT SLAYER ────────────────────────────────────
  describe('Technical Debt Slayer', () => {
    it('GET /engineering/debt/analyze returns result', async () => {
      analyzeTechnicalDebt.mockResolvedValue({ items: [], totalScore: 0 });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/debt/analyze?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: { items: [], totalScore: 0 } });
    });

    it('GET /engineering/debt/trends defaults period to month', async () => {
      getDebtTrends.mockResolvedValue({ trend: 'improving' });
      const { server, port } = await startServer();
      await setup(server, port);

      await request(port, 'GET', '/engineering/debt/trends?projectId=proj-1');
      expect(getDebtTrends).toHaveBeenCalledWith('user-1', 'proj-1', 'month');
    });

    it('GET /engineering/debt/trends uses explicit period', async () => {
      getDebtTrends.mockResolvedValue({ trend: 'stable' });
      const { server, port } = await startServer();
      await setup(server, port);

      await request(port, 'GET', '/engineering/debt/trends?projectId=proj-1&period=quarter');
      expect(getDebtTrends).toHaveBeenCalledWith('user-1', 'proj-1', 'quarter');
    });

    it('POST /engineering/debt/:itemId/task creates task (201)', async () => {
      createDebtResolutionTask.mockResolvedValue({ id: 'task-1' });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/debt/d1/task?projectId=proj-1', { debtItem: { type: 'code_smell' } });
      expect(res.status).toBe(201);
      expect(createDebtResolutionTask).toHaveBeenCalledWith('user-1', 'proj-1', { type: 'code_smell' });
    });

    it('POST /engineering/debt/:itemId/task throws 400 without debtItem', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/debt/d1/task', {});
      expect(res.status).toBe(400);
    });

    it('POST /engineering/debt/:itemId/propose returns approvalId', async () => {
      proposeDebtResolution.mockResolvedValue('appr-1');
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/debt/d1/propose?projectId=proj-1', { debtItem: { type: 'dup' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ approvalId: 'appr-1' });
    });

    it('POST /engineering/debt/:itemId/propose throws 400 without debtItem', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/debt/d1/propose', {});
      expect(res.status).toBe(400);
    });
  });

  // ── PERFORMANCE ORACLE ───────────────────────────────────────
  describe('Performance Oracle', () => {
    it('GET /engineering/performance/report returns report', async () => {
      generatePerformanceReport.mockResolvedValue({ score: 85 });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/performance/report?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ report: { score: 85 } });
    });

    it('GET /engineering/performance/regressions uses default dates', async () => {
      detectPerformanceRegressions.mockResolvedValue({ regressions: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      await request(port, 'GET', '/engineering/performance/regressions?projectId=proj-1');
      expect(detectPerformanceRegressions).toHaveBeenCalledWith(
        'user-1', 'proj-1', expect.any(Date), expect.any(Date),
      );
    });

    it('GET /engineering/performance/regressions uses explicit dates', async () => {
      detectPerformanceRegressions.mockResolvedValue({ regressions: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      await request(port, 'GET', '/engineering/performance/regressions?projectId=proj-1&baseline=2025-01-01&current=2025-06-01');
      expect(detectPerformanceRegressions).toHaveBeenCalledWith(
        'user-1', 'proj-1', new Date('2025-01-01'), new Date('2025-06-01'),
      );
    });
  });

  // ── CODE SEARCH ORACLE ───────────────────────────────────────
  describe('Code Search Oracle', () => {
    it('GET /engineering/search/symbols searches with params', async () => {
      searchSymbols.mockResolvedValue({ symbols: [], total: 0 });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/symbols?projectId=proj-1&q=UserService');
      expect(res.status).toBe(200);
      expect(searchSymbols).toHaveBeenCalledWith('user-1', 'proj-1', 'UserService', expect.objectContaining({ limit: 50 }));
    });

    it('GET /engineering/search/implementations throws 400 without interface', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/implementations?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/search/implementations finds implementations', async () => {
      findImplementations.mockResolvedValue([{ file: 'a.ts' }]);
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/implementations?projectId=proj-1&interface=ILogger');
      expect(res.status).toBe(200);
      expect(findImplementations).toHaveBeenCalledWith('user-1', 'proj-1', 'ILogger');
    });

    it('GET /engineering/search/dependencies throws 400 without target', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/dependencies?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/search/call-graph throws 400 without root', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/call-graph?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/search/similar throws 400 without code', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/similar?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/search/dead-code returns result', async () => {
      findDeadCode.mockResolvedValue({ deadCode: ['old.ts'] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/dead-code?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: { deadCode: ['old.ts'] } });
    });

    it('GET /engineering/search/refactoring-impact throws 400 without target', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/refactoring-impact?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/search/todos returns results', async () => {
      searchTodos.mockResolvedValue({ todos: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/search/todos?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: { todos: [] } });
    });
  });

  // ── CONTEXT FLOW ANALYZER ────────────────────────────────────
  describe('Context Flow Analyzer', () => {
    it('GET /engineering/flow/analyze returns result', async () => {
      analyzeContextFlow.mockResolvedValue({ flows: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/flow/analyze?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: { flows: [] } });
    });

    it('GET /engineering/flow/origin throws 400 without variable and file', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/flow/origin?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/flow/origin traces origin', async () => {
      traceDataOrigin.mockResolvedValue({ origin: { file: 'db.ts' } });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/flow/origin?projectId=proj-1&variable=userId&file=auth.ts');
      expect(res.status).toBe(200);
      expect(traceDataOrigin).toHaveBeenCalledWith('user-1', 'proj-1', 'userId', 'auth.ts');
    });

    it('GET /engineering/flow/destination throws 400 without variable', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/flow/destination?projectId=proj-1');
      expect(res.status).toBe(400);
    });

    it('GET /engineering/flow/destination traces destinations', async () => {
      traceDataDestination.mockResolvedValue({ destinations: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/flow/destination?projectId=proj-1&variable=token');
      expect(res.status).toBe(200);
      expect(traceDataDestination).toHaveBeenCalledWith('user-1', 'proj-1', 'token');
    });
  });

  // ── REFACTORING WIZARD ───────────────────────────────────────
  describe('Refactoring Wizard', () => {
    it('POST /engineering/refactor/plan creates plan (201)', async () => {
      createRefactoringPlan.mockResolvedValue({ id: 'plan-1', steps: [] });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/refactor/plan?projectId=proj-1', { type: 'rename', target: { filePath: 'a.ts' } });
      expect(res.status).toBe(201);
      expect(createRefactoringPlan).toHaveBeenCalledWith('user-1', 'proj-1', 'rename', { filePath: 'a.ts' });
    });

    it('POST /engineering/refactor/plan throws 400 without type and target', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/refactor/plan?projectId=proj-1', {});
      expect(res.status).toBe(400);
    });

    it('POST /engineering/refactor/plan throws 400 without target.filePath', async () => {
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/refactor/plan?projectId=proj-1', { type: 'rename', target: {} });
      expect(res.status).toBe(400);
    });

    it('GET /engineering/refactor/plans returns list', async () => {
      listRefactoringPlans.mockResolvedValue([{ id: 'p1' }]);
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/refactor/plans?projectId=proj-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ plans: [{ id: 'p1' }] });
    });

    it('GET /engineering/refactor/:planId returns plan', async () => {
      getRefactoringPlan.mockResolvedValue({ id: 'plan-1', status: 'EXECUTED' });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'GET', '/engineering/refactor/plan-1');
      expect(res.status).toBe(200);
      expect(getRefactoringPlan).toHaveBeenCalledWith('user-1', 'plan-1');
    });

    it('POST /engineering/refactor/:planId/execute returns result', async () => {
      executeRefactoringPlan.mockResolvedValue({ success: true, filesChanged: 3 });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/refactor/plan-1/execute');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, filesChanged: 3 });
    });

    it('POST /engineering/refactor/:planId/rollback returns result', async () => {
      rollbackRefactoring.mockResolvedValue({ rolledBack: true });
      const { server, port } = await startServer();
      await setup(server, port);

      const res = await request(port, 'POST', '/engineering/refactor/plan-1/rollback');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: { rolledBack: true } });
    });
  });
});
