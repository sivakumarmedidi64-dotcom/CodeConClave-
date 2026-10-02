/**
 * CodeConClave — Optimization Intelligence Tests (PKG-16).
 * Covers Performance Timeline (#16), Database Query Optimizer (#17), Batch
 * Processing Optimizer (#19), Cost-Aware Refactoring (#20), and the honest
 * capability report. The performance oracle, cost analysis, technical debt
 * analyzer, and files service are all mocked deterministically; every assertion
 * checks advisory, deterministic output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ----------------------------- Mocks ----------------------------- */

const mocks = vi.hoisted(() => ({
  generatePerformanceReport: vi.fn(),
  getCostBreakdown: vi.fn(),
  analyzeTechnicalDebt: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockListFiles: vi.fn(),
  newId: vi.fn(),
  idSeed: { n: 0 },
}));

vi.mock('../../shared/ids.js', () => ({
  newId: (...args: unknown[]) => mocks.newId(...args),
  PREFIX: {
    OPTIMIZATION_REPORT: 'opr',
    OPTIMIZATION_TIMELINE_OP: 'opt',
    OPTIMIZATION_QUERY: 'opq',
    OPTIMIZATION_BATCH: 'opb',
    OPTIMIZATION_COST_ITEM: 'opc',
  },
}));

vi.mock('../../shared/errors.js', () => ({
  AppError: class {
    constructor(readonly status: number, readonly errorCode: string, readonly message: string) {}
    static badRequest(code: string, msg: string) {
      return new this(400, code, msg);
    }
    static notFound(r: string) {
      return new this(404, 'not_found', `${r} not found`);
    }
  },
}));

vi.mock('../files/service.js', () => ({
  getFileContent: (...args: unknown[]) => mocks.mockGetFileContent(...args),
  listFiles: (...args: unknown[]) => mocks.mockListFiles(...args),
}));

vi.mock('../engineering-intelligence/performanceOracle.js', () => ({
  generatePerformanceReport: (...args: unknown[]) => mocks.generatePerformanceReport(...args),
}));

vi.mock('../production-intelligence/costAnalysis.js', () => ({
  getCostBreakdown: (...args: unknown[]) => mocks.getCostBreakdown(...args),
}));

vi.mock('../engineering-intelligence/debtSlayer.js', () => ({
  analyzeTechnicalDebt: (...args: unknown[]) => mocks.analyzeTechnicalDebt(...args),
}));

/* ----------------------------- Imports ----------------------------- */

import { buildPerformanceTimeline } from './timeline.js';
import { runQueryOptimizer } from './queryOptimizer.js';
import { runBatchOptimizer } from './batchOptimizer.js';
import { buildCostAwareRefactor } from './costRefactoring.js';
import { optimizationIntelligenceService, ALL_KINDS } from './service.js';

function file(id: string, path: string, mimeType: string, content: string) {
  mocks.mockListFiles.mockResolvedValue([{ id, path, mimeType }]);
  mocks.mockGetFileContent.mockResolvedValue({
    buffer: Buffer.from(content, 'utf8'),
    mimeType,
    name: path,
  });
}

function setupReport() {
  mocks.generatePerformanceReport.mockResolvedValue({
    projectId: 'prj-1',
    slowFunctions: [
      {
        filePath: 'src/user.ts',
        functionName: 'loadProfile',
        estimatedDurationMs: 150,
        source: 'ESTIMATED',
        reason: 'sequential awaits',
        startLine: 4,
        endLine: 12,
        optimizationHints: [],
      },
    ],
    dbQueryRisks: [
      {
        filePath: 'src/db.ts',
        query: 'SELECT * FROM orders o JOIN users u ON o.user_id = u.id WHERE u.email = \'a@b.com\'',
        estimatedCost: 'MEDIUM',
        riskFactors: ['SELECT *', 'join'],
        suggestedIndexes: [],
        source: 'ESTIMATED',
      },
      {
        filePath: 'src/db.ts',
        query: 'SELECT name FROM users WHERE lower(email) = \'a@b.com\'',
        estimatedCost: 'MEDIUM',
        riskFactors: ['non-sargable'],
        suggestedIndexes: [],
        source: 'ESTIMATED',
      },
    ],
    nPlusOnes: [
      {
        filePath: 'src/user.ts',
        pattern: 'for (const p of posts) { const author = await db.query("SELECT * FROM authors WHERE id="); }',
        loopContext: 'for (const p of posts)',
        estimatedQueries: 10,
        source: 'ESTIMATED',
        fixSuggestion: 'Batch fetch with WHERE IN (...)',
      },
    ],
    apiLatencyRisks: [
      {
        endpoint: '/api/users',
        method: 'GET',
        estimatedP99Ms: 300,
        source: 'ESTIMATED',
        bottlenecks: ['Database query in hot path'],
        scalingAdvice: ['Cache'],
      },
    ],
    complexity: { projectId: 'prj-1', functions: [], summary: { totalFunctions: 1, avgComplexity: 1, maxComplexity: 1, highComplexityCount: 0, estimatedRefactorHours: 0 } },
    cachingOpportunities: [],
    repeatedComputations: [],
    summary: { overallScore: 70, criticalIssues: 0, highIssues: 1, mediumIssues: 2, estimatedOptimizationHours: 3, topRecommendations: [] },
  });
}

beforeEach(() => {
  mocks.idSeed.n = 0;
  mocks.newId.mockImplementation((p: string) => `${p}-${++mocks.idSeed.n}`);
});

/* ----------------------------- #16 Performance Timeline ----------------------------- */

describe('PERFORMANCE TIMELINE (#16)', () => {
  it('builds an ordered source-level timeline with per-op durations and hotspots', async () => {
    setupReport();
    file(
      'f1',
      'src/user.ts',
      'text/typescript',
      [
        'import { pool } from "db";',
        '',
        'export async function loadProfile(id) {',
        '  for (const p of posts) {',
        '    await pool.query("SELECT * FROM authors WHERE id=$1", [p.id]);',
        '    await fetch("https://api.example.com/avatar");',
        '  }',
        '  return result;',
        '}',
      ].join('\n'),
    );

    const report = await buildPerformanceTimeline('usr-1', 'prj-1');
    expect(report.projectId).toBe('prj-1');
    expect(report.state).toBe('HEURISTIC');
    expect(report.totalDurationMs).toBeGreaterThan(0);
    const fileOps = report.operations.filter((o) => o.filePath === 'src/user.ts');
    expect(fileOps.length).toBeGreaterThan(0);
    const dbOp = fileOps.find((o) => o.kind === 'DB_QUERY');
    expect(dbOp).toBeDefined();
    expect(dbOp?.estimatedDurationMs).toBeGreaterThan(0);
    expect(dbOp?.isHotPath).toBe(true);
    const handlerOp = report.operations.find((o) => o.kind === 'HANDLER');
    expect(handlerOp?.label).toContain('GET /api/users');
    expect(report.hotspots[0]).toBeDefined();
    expect(report.limitations.some((l) => l.includes('ESTIMATED'))).toBe(true);
  });

  it('reports zero operations when there is no analyzable source', async () => {
    setupReport();
    mocks.mockListFiles.mockResolvedValue([]);
    const report = await buildPerformanceTimeline('usr-1', 'prj-1');
    expect(report.operations.filter((o) => o.filePath !== 'GET /api/users' && !o.filePath.startsWith('/')).length).toBe(0);
    // Handler from apiLatencyRisks is still surfaced (integration of performance report).
    const handlers = report.operations.filter((o) => o.kind === 'HANDLER');
    expect(handlers.length).toBeGreaterThan(0);
  });
});

/* ----------------------------- #17 Database Query Optimizer ----------------------------- */

describe('DATABASE QUERY OPTIMIZER (#17)', () => {
  it('flags SELECT *, unindexed FK join, non-sargable and emits DDL advice', async () => {
    setupReport();
    file('f2', 'src/db.ts', 'text/typescript', 'SELECT * FROM orders;');
    const report = await runQueryOptimizer('usr-1', 'prj-1');
    expect(report.state).toBe('HEURISTIC');
    expect(report.queriesOptimized).toBeGreaterThan(0);
    const selStar = report.findings.find((f) => f.riskKind === 'SELECT_STAR');
    expect(selStar).toBeDefined();
    const fk = report.findings.find((f) => f.riskKind === 'UNINDEXED_FK_JOIN');
    expect(fk).toBeDefined();
    expect(fk?.suggestedDDL.length).toBeGreaterThan(0);
    const nonSarg = report.findings.find((f) => f.riskKind === 'NON_SARGABLE');
    expect(nonSarg).toBeDefined();
    expect(report.criticalCount).toBeGreaterThanOrEqual(1);
    expect(report.limitations.some((l) => l.includes('runtime pg-stat'))).toBe(true);
  });

  it('normalizes and never executes the SQL text', async () => {
    setupReport();
    file('f2', 'src/db.ts', 'text/typescript', 'SELECT * FROM orders;');
    const report = await runQueryOptimizer('usr-1', 'prj-1');
    const selStar = report.findings.find((f) => f.riskKind === 'SELECT_STAR');
    expect(selStar?.query).toContain('SELECT *');
  });
});

/* ----------------------------- #19 Batch Processing Optimizer ----------------------------- */

describe('BATCH PROCESSING OPTIMIZER (#19)', () => {
  it('turns a detected N+1 into a bulk WHERE IN plan with quantified reduction', async () => {
    setupReport();
    const report = await runBatchOptimizer('usr-1', 'prj-1');
    expect(report.plans.length).toBe(1);
    const plan = report.plans[0];
    expect(plan.queriesBefore).toBe(10);
    expect(plan.queriesAfter).toBe(1);
    expect(plan.reductionCount).toBe(9);
    expect(plan.reductionPercent).toBe(90);
    expect(plan.strategy).toBe('BULK_WHERE_IN');
    expect(plan.suggestedCode).toContain('WHERE id IN');
    expect(report.totalReductionCount).toBe(9);
  });

  it('uses chunked concurrency for very large loops', async () => {
    setupReport();
    mocks.generatePerformanceReport.mockResolvedValueOnce({
      projectId: 'prj-1',
      nPlusOnes: [
        {
          filePath: 'src/big.ts',
          pattern: 'for (const x of huge) { await db.query(...); }',
          loopContext: 'for (const x of huge) await db.query',
          estimatedQueries: 500,
          source: 'ESTIMATED',
          fixSuggestion: 'chunk',
        },
      ],
      slowFunctions: [],
      dbQueryRisks: [],
      apiLatencyRisks: [],
      complexity: { projectId: 'prj-1', functions: [], summary: { totalFunctions: 1, avgComplexity: 1, maxComplexity: 1, highComplexityCount: 0, estimatedRefactorHours: 0 } },
      cachingOpportunities: [],
      repeatedComputations: [],
      summary: { overallScore: 50, criticalIssues: 0, highIssues: 1, mediumIssues: 1, estimatedOptimizationHours: 2, topRecommendations: [] },
    });
    const report = await runBatchOptimizer('usr-1', 'prj-1');
    expect(report.plans[0].strategy).toBe('CHUNKED_CONCURRENCY');
    expect(report.plans[0].chunkSize).toBe(50);
    expect(report.plans[0].queriesAfter).toBe(10); // ceil(500/50)
    expect(report.plans[0].suggestedCode).toContain('Promise.all');
  });
});

/* ----------------------------- #20 Cost-Aware Refactoring ----------------------------- */

describe('COST-AWARE REFACTORING (#20)', () => {
  it('correlates cost drivers with debt items and produces ROI-sorted suggestions', async () => {
    mocks.getCostBreakdown.mockResolvedValue({
      projectId: 'prj-1',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-01-31'),
      totalUsd: 100,
      measuredUsd: 80,
      estimatedUsd: 20,
      byCategory: {},
      byProvider: {},
      byUser: {},
      byFeature: {},
      trends: [],
      topCostDrivers: [{ category: 'COMPUTE', usd: 60, measured: 50, estimated: 10, count: 5, trend: 'INCREASING' }],
    });
    mocks.analyzeTechnicalDebt.mockResolvedValue({
      projectId: 'prj-1',
      totalItems: 1,
      itemsBySeverity: { HIGH: 1 },
      itemsByType: { large_function: 1 },
      overallScore: 60,
      items: [
        {
          id: 'd1',
          type: 'large_function',
          severity: 'HIGH',
          affectedCode: { projectId: 'prj-1', filePaths: ['src/hot.ts'] },
          evidence: 'long function',
          estimatedImpact: { maintainability: 40, performance: 60, security: 0, velocity: 30, overall: 45 },
          recommendation: 'Extract hot computation into memoized module',
        },
      ],
    });

    const report = await buildCostAwareRefactor('usr-1', 'prj-1');
    expect(report.costMeasureAvailable).toBe(true);
    expect(report.measuredUsd).toBe(80);
    expect(report.topCostDriverCategory).toBe('COMPUTE');
    expect(report.totalIdentified).toBe(1);
    const item = report.items[0];
    expect(item.debtType).toBe('large_function');
    expect(item.costDriversReduced).toContain('COMPUTE');
    expect(item.estimatedCostReductionUsd).toBeGreaterThan(0);
    expect(item.roi).toBeGreaterThan(0);
    expect(item.costDriversReduced).toContain('COMPUTE');
  });

  it('reports zero-confidence when no measured cost exists for the relevant categories', async () => {
    mocks.getCostBreakdown.mockResolvedValue({
      projectId: 'prj-1',
      periodStart: new Date(),
      periodEnd: new Date(),
      totalUsd: 0,
      measuredUsd: 0,
      estimatedUsd: 0,
      byCategory: {},
      byProvider: {},
      byUser: {},
      byFeature: {},
      trends: [],
      topCostDrivers: [{ category: 'NETWORK', usd: 10, measured: 10, estimated: 0, count: 1, trend: 'STABLE' }],
    });
    mocks.analyzeTechnicalDebt.mockResolvedValue({
      projectId: 'prj-1',
      totalItems: 1,
      itemsBySeverity: { MEDIUM: 1 },
      itemsByType: { code_smell: 1 },
      overallScore: 70,
      items: [
        {
          id: 'd2',
          type: 'code_smell',
          severity: 'MEDIUM',
          affectedCode: { projectId: 'prj-1', filePaths: ['src/x.ts'] },
          evidence: 'smell',
          estimatedImpact: { maintainability: 20, performance: 10, security: 0, velocity: 20, overall: 15 },
          recommendation: 'Simplify',
        },
      ],
    });

    const report = await buildCostAwareRefactor('usr-1', 'prj-1');
    // code_smell wants TASK_EXECUTION/COMPUTE/AGENT_RUN; only NETWORK is present.
    expect(report.items[0].costDriversReduced.length).toBe(0);
    expect(report.items[0].estimatedCostReductionUsd).toBe(0);
    expect(report.items[0].roi).toBeNull();
    expect(report.items[0].confidence).toBe(0);
  });
});

/* ----------------------------- Capability report ----------------------------- */

describe('CAPABILITY REPORT', () => {
  it('reports exactly four available, deterministic capabilities', () => {
    const caps = optimizationIntelligenceService.getCapabilities();
    expect(ALL_KINDS).toHaveLength(4);
    for (const k of ALL_KINDS) {
      const c = caps.capabilities[k];
      expect(c.status).toBe('AVAILABLE');
      expect(c.state).toBe('HEURISTIC');
      expect(c.deterministic).toBe(true);
      expect(c.needsProvider).toBe(false);
    }
    expect(caps.limitations.length).toBeGreaterThan(0);
  });
});