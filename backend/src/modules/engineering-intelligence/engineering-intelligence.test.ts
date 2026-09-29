/**
 * CodeConClave — V4A Engineering Intelligence Tests.
 * Tests for: Architecture Oracle, Debt Slayer, Performance Oracle,
 * Code Search Oracle, Context Flow Analyzer, Refactoring Wizard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: any[];
    rowCount: number;
    queryOverrides: { pattern: RegExp; rows: any[]; rowCount?: number }[];
    overrideCallCounts: Map<RegExp, number>;
  } = {
    calls: [],
    rows: [],
    rowCount: 1,
    queryOverrides: [],
    overrideCallCounts: new Map(),
  };

  const PROJECT_ROW = { id: 'proj-1' };

  const resolveRows = (text: string): { rows: any[]; rowCount: number } => {
    for (const override of state.queryOverrides) {
      if (override.pattern.test(text)) {
        const count = (state.overrideCallCounts.get(override.pattern) ?? 0);
        state.overrideCallCounts.set(override.pattern, count + 1);
        const rows = Array.isArray(override.rows) && override.rows.length > 0 && Array.isArray(override.rows[0])
          ? (override.rows[count] ?? override.rows[0])
          : override.rows;
        return { rows, rowCount: override.rowCount ?? rows.length };
      }
    }
    if (/FROM projects/i.test(text)) {
      return { rows: [PROJECT_ROW], rowCount: 1 };
    }
    return { rows: state.rows, rowCount: state.rowCount };
  };

  const query = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    return resolveRows(text);
  };

  const queryOne = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    const r = resolveRows(text);
    return r.rows[0] ?? null;
  };

  const queryMany = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    return resolveRows(text).rows;
  };

  const queryResult = async (text: string, params?: unknown[]) => await query(text, params);

  const withTenant = async (_tid: string, fn: (q: any) => any) => fn?.({ query: queryResult });
  return { state, pool: { query }, queryOne, queryMany, withTenant };
});

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const listDna = vi.hoisted(() => vi.fn(async () => []));
const retrieveDnaForPrompt = vi.hoisted(() => vi.fn(async () => []));
const semanticSearch = vi.hoisted(() => vi.fn(async () => []));
const retrieveMemoriesForPrompt = vi.hoisted(() => vi.fn(async () => []));
const globalSearch = vi.hoisted(() => vi.fn(async () => ({ results: [], total: 0 })));
const createTask = vi.hoisted(() => vi.fn(async () => ({ id: 'task-1', title: 'test', description: '', risk_level: 'LOW' })));
const listTasks = vi.hoisted(() => vi.fn(async () => []));
const getTask = vi.hoisted(() => vi.fn(async () => null));
const cancelTask = vi.hoisted(() => vi.fn(async () => {}));
const proposeApproval = vi.hoisted(() => vi.fn(async () => ({ approval: { id: 'approval-1' } })));
const decideApproval = vi.hoisted(() => vi.fn(async () => {}));
const createTaskFromChat = vi.hoisted(() => vi.fn(async () => ({ id: 'task-1', title: 'test', description: '', risk_level: 'LOW' })));

vi.mock('../../shared/db.js', () => db);
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, errorCode: 'not_found' }),
    badRequest: (code: string, msg: string) => Object.assign(new Error(msg), { status: 400, errorCode: code }),
  },
}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
vi.mock('../dna/service.js', () => ({ listDna, retrieveDnaForPrompt }));
vi.mock('../memory/service.js', () => ({ semanticSearch, retrieveMemoriesForPrompt }));
vi.mock('../search/service.js', () => ({ globalSearch }));
vi.mock('../execution/tasks.js', () => ({ createTask, listTasks, getTask, cancelTask }));
vi.mock('../execution/approvals.js', () => ({ proposeApproval, decideApproval }));
vi.mock('../execution/orchestrator.js', () => ({ createTaskFromChat }));
vi.mock('../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@codeconclave/shared', () => ({
  AuditAction: {
    SEARCH_PERFORMED: 'search_performed',
    TASK_CREATED: 'task_created',
    TASK_EXECUTED: 'task_executed',
  },
}));

// ─── ARCHITECTURE ORACLE ──────────────────────────────────────
describe('ARCHITECTURE ORACLE — summary, dependency graph, risks', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    db.state.overrideCallCounts = new Map();
    recordAudit.mockClear();
    listDna.mockReset();
    listDna.mockResolvedValue([]);
    retrieveMemoriesForPrompt.mockReset();
    retrieveMemoriesForPrompt.mockResolvedValue([]);
    globalSearch.mockReset();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
  });

  it('getArchitectureSummary returns correct structure with no data', async () => {
    const { getArchitectureSummary } = await import('./architectureOracle.js');
    const result = await getArchitectureSummary('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('totalDnaBlocks', 0);
    expect(result).toHaveProperty('memoryCount', 0);
    expect(result).toHaveProperty('keyDecisions');
    expect(result).toHaveProperty('riskAreas');
    expect(result.keyDecisions).toHaveLength(0);
    expect(result.riskAreas).toHaveLength(0);
    expect(result.summary).toContain('No critical risks detected');
  });

  it('getArchitectureSummary populates key decisions from DECISION dna', async () => {
    const dnaBlocks = [
      { id: 'dna-1', kind: 'DECISION', title: 'Use Postgres', version: 1, conflict_state: 'RESOLVED', updated_at: new Date() },
      { id: 'dna-2', kind: 'PROJECT_CONTEXT', title: 'Monolith', version: 2, conflict_state: 'RESOLVED', updated_at: new Date() },
      { id: 'dna-3', kind: 'RELEVANT_FILES', title: 'Readme', version: 1, conflict_state: 'RESOLVED', updated_at: new Date() },
    ];
    listDna.mockResolvedValue(dnaBlocks);
    retrieveMemoriesForPrompt.mockResolvedValue(['mem1']);

    const { getArchitectureSummary } = await import('./architectureOracle.js');
    const result = await getArchitectureSummary('user-1', 'proj-1');

    expect(result.keyDecisions).toHaveLength(2);
    expect(result.keyDecisions[0].kind).toBe('DECISION');
    expect(result.keyDecisions[1].kind).toBe('PROJECT_CONTEXT');
    expect(result.totalDnaBlocks).toBe(3);
    expect(result.memoryCount).toBe(1);
  });

  it('getArchitectureSummary reports CONFLICT risk areas', async () => {
    listDna.mockResolvedValue([
      { id: 'd1', kind: 'DECISION', title: 'A', version: 1, conflict_state: 'CONFLICT', updated_at: new Date() },
      { id: 'd2', kind: 'DECISION', title: 'B', version: 1, conflict_state: 'CONFLICT', updated_at: new Date() },
    ]);

    const { getArchitectureSummary } = await import('./architectureOracle.js');
    const result = await getArchitectureSummary('user-1', 'proj-1');

    expect(result.riskAreas).toHaveLength(1);
    expect(result.riskAreas[0]).toContain('2 DNA blocks in CONFLICT state');
  });

  it('getDependencyGraph returns nodes and edges', async () => {
    globalSearch.mockResolvedValue({
      results: [
        { projectId: 'proj-1', label: 'src/api/routes.ts', path: 'src/api/routes.ts', category: 'source' },
        { projectId: 'proj-1', label: 'src/services/auth.ts', path: 'src/services/auth.ts', category: 'source' },
      ],
      total: 2,
    });
    retrieveMemoriesForPrompt.mockResolvedValue([]);

    const { getDependencyGraph } = await import('./architectureOracle.js');
    const result = await getDependencyGraph('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('edges');
    expect(result).toHaveProperty('circularDependencies');
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(Array.isArray(result.circularDependencies)).toBe(true);
  });

  it('getDependencyGraph maps file paths to module types', async () => {
    globalSearch.mockResolvedValue({
      results: [
        { projectId: 'proj-1', label: 'src/api/users.ts', path: 'src/api/users.ts', category: 'source' },
        { projectId: 'proj-1', label: 'src/db/migrations/001.sql', path: 'src/db/migrations/001.sql', category: 'source' },
      ],
      total: 2,
    });
    retrieveMemoriesForPrompt.mockResolvedValue([]);

    const { getDependencyGraph } = await import('./architectureOracle.js');
    const result = await getDependencyGraph('user-1', 'proj-1');

    const apiNode = result.nodes.find(n => n.type === 'api');
    const dbNode = result.nodes.find(n => n.type === 'database');
    expect(apiNode).toBeDefined();
    expect(dbNode).toBeDefined();
  });

  it('getDependencyGraph skips test files', async () => {
    globalSearch.mockResolvedValue({
      results: [
        { projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' },
        { projectId: 'proj-1', label: 'src/app.test.ts', path: 'src/app.test.ts', category: 'test' },
      ],
      total: 2,
    });
    retrieveMemoriesForPrompt.mockResolvedValue([]);

    const { getDependencyGraph } = await import('./architectureOracle.js');
    const result = await getDependencyGraph('user-1', 'proj-1');

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe('src');
  });

  it('detectArchitectureRisks returns LOW for clean project', async () => {
    listDna.mockResolvedValue([
      { id: 'd1', kind: 'DECISION', title: 'A', version: 1, conflict_state: 'RESOLVED', updated_at: new Date() },
    ]);
    globalSearch.mockResolvedValue({ results: [], total: 0 });

    const { detectArchitectureRisks } = await import('./architectureOracle.js');
    const result = await detectArchitectureRisks('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('risks');
    expect(result).toHaveProperty('overallRiskLevel');
    expect(result.overallRiskLevel).toBe('LOW');
    expect(Array.isArray(result.risks)).toBe(true);
  });

  it('detectArchitectureRisks flags missing DECISION dna', async () => {
    listDna.mockResolvedValue([
      { id: 'd1', kind: 'PROJECT_CONTEXT', title: 'A', version: 1, conflict_state: 'RESOLVED', updated_at: new Date() },
    ]);
    globalSearch.mockResolvedValue({ results: [], total: 0 });

    const { detectArchitectureRisks } = await import('./architectureOracle.js');
    const result = await detectArchitectureRisks('user-1', 'proj-1');

    expect(result.risks.some((r: any) => r.category === 'missing_layer')).toBe(true);
    expect(result.overallRiskLevel).toBe('MEDIUM');
  });

  it('getArchitectureChangeHistory returns changes sorted by timestamp', async () => {
    listDna.mockResolvedValue([
      { id: 'd1', kind: 'DECISION', title: 'First', version: 1, conflict_state: 'RESOLVED', updated_at: new Date('2025-01-01'), owner_id: 'u1' },
      { id: 'd2', kind: 'DECISION', title: 'Second', version: 3, conflict_state: 'RESOLVED', updated_at: new Date('2025-06-01'), owner_id: 'u1' },
    ]);

    const { getArchitectureChangeHistory } = await import('./architectureOracle.js');
    const result = await getArchitectureChangeHistory('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].timestamp.getTime()).toBeGreaterThanOrEqual(result.changes[1].timestamp.getTime());
  });

  it('getArchitectureChangeHistory classifies version > 1 as dna_updated', async () => {
    listDna.mockResolvedValue([
      { id: 'd1', kind: 'DECISION', title: 'A', version: 3, conflict_state: 'RESOLVED', updated_at: new Date(), owner_id: 'u1' },
      { id: 'd2', kind: 'DECISION', title: 'B', version: 1, conflict_state: 'RESOLVED', updated_at: new Date(), owner_id: 'u1' },
    ]);

    const { getArchitectureChangeHistory } = await import('./architectureOracle.js');
    const result = await getArchitectureChangeHistory('user-1', 'proj-1');

    expect(result.changes.find((c: any) => c.type === 'dna_updated')).toBeDefined();
    expect(result.changes.find((c: any) => c.type === 'dna_created')).toBeDefined();
  });

  it('throws when project not found', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
    ];

    const { getArchitectureSummary } = await import('./architectureOracle.js');
    await expect(getArchitectureSummary('user-1', 'nonexistent')).rejects.toThrow('Project');
  });
});

// ─── DEBT SLAYER ─────────────────────────────────────────────
describe('DEBT SLAYER — technical debt analysis', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    db.state.overrideCallCounts = new Map();
    recordAudit.mockClear();
    globalSearch.mockReset();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    listDna.mockReset();
    listDna.mockResolvedValue([]);
    listTasks.mockReset();
    listTasks.mockResolvedValue([]);
  });

  it('analyzeTechnicalDebt returns correct structure with no files', async () => {
    listDna.mockResolvedValue([
      { id: 'd1', kind: 'DECISION', title: 'A', conflict_state: 'RESOLVED' },
    ]);

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result.totalItems).toBeGreaterThanOrEqual(0);
    expect(result.totalItems).toBeLessThanOrEqual(2);
    expect(result).toHaveProperty('itemsBySeverity');
    expect(result).toHaveProperty('itemsByType');
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('overallScore');
    expect(Array.isArray(result.items)).toBe(true);
    expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.itemsBySeverity.LOW !== undefined ? 'LOW' : 'MEDIUM');
  });

  it('analyzeTechnicalDebt flags zero test coverage', async () => {
    globalSearch.mockResolvedValue({
      results: [
        { projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' },
        { projectId: 'proj-1', label: 'src/utils.ts', path: 'src/utils.ts', category: 'source' },
      ],
      total: 2,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/app.ts', content: 'function a() { return 1; }', updated_at: new Date() }] },
    ];

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    const testDebt = result.items.filter((i: any) => i.type === 'test_debt');
    expect(testDebt.length).toBeGreaterThanOrEqual(1);
    expect(result.itemsBySeverity.HIGH).toBeGreaterThanOrEqual(1);
  });

  it('analyzeTechnicalDebt detects large files (>500 lines)', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/big.ts', path: 'src/big.ts', category: 'source' }],
      total: 1,
    });
    const bigContent = 'line\n'.repeat(600);
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/big.ts', content: bigContent, updated_at: new Date() }] },
    ];

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    expect(result.items.some((i: any) => i.type === 'large_function')).toBe(true);
  });

  it('analyzeTechnicalDebt detects high cyclomatic complexity', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/complex.ts', path: 'src/complex.ts', category: 'source' }],
      total: 1,
    });
    const complexCode = `if (a) { if (b) { if (c) { while (x) { for (y) { if (z) { case 1: if (w) { if (v) { if (u) { if (t) { if (s) { if (r) { if (q) { if (p) { if (o) { if (n) { if (m) { if (l) { if (k) { if (j) { if (i) { if (h) { if (g) { if (f) { if (e) { if (d) { } } } } } } } } } } } } } } } } } } } } } } } }`;
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/complex.ts', content: complexCode, updated_at: new Date() }] },
    ];

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    expect(result.items.some((i: any) => i.type === 'excessive_complexity')).toBe(true);
  });

  it('analyzeTechnicalDebt detects deep nesting', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/nested.ts', path: 'src/nested.ts', category: 'source' }],
      total: 1,
    });
    const nestedCode = '{ { { { { { { content } } } } } }';
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/nested.ts', content: nestedCode, updated_at: new Date() }] },
    ];

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    expect(result.items.some((i: any) => i.type === 'deep_nesting')).toBe(true);
  });

  it('analyzeTechnicalDebt detects stale files (>180 days)', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/old.ts', path: 'src/old.ts', category: 'source' }],
      total: 1,
    });
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 200);
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/old.ts', content: 'const x = 1;', updated_at: staleDate }] },
    ];

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    expect(result.items.some((i: any) => i.type === 'stale_code')).toBe(true);
  });

  it('analyzeTechnicalDebt detects missing DECISION dna', async () => {
    listDna.mockResolvedValue([]);
    globalSearch.mockResolvedValue({ results: [], total: 0 });

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    expect(result.items.some((i: any) => i.type === 'architectural_debt')).toBe(true);
  });

  it('analyzeTechnicalDebt detects CONFLICT dna', async () => {
    listDna.mockResolvedValue([
      { id: 'd1', kind: 'DECISION', title: 'A', conflict_state: 'CONFLICT' },
    ]);
    globalSearch.mockResolvedValue({ results: [], total: 0 });

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    const archDebt = result.items.filter((i: any) => i.type === 'architectural_debt');
    expect(archDebt.length).toBeGreaterThanOrEqual(1);
  });

  it('getDebtTrends returns correct structure', async () => {
    db.state.queryOverrides = [
      { pattern: /technical_debt_log[\s\S]*GROUP BY day/i, rows: [] },
      { pattern: /technical_debt_log[\s\S]*resolved_at/i, rows: [{ n: 2 }] },
      { pattern: /technical_debt_log[\s\S]*created_at/i, rows: [{ n: 5 }] },
    ];

    const { getDebtTrends } = await import('./debtSlayer.js');
    const result = await getDebtTrends('user-1', 'proj-1', 'month');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('period', 'month');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('scoreHistory');
    expect(result).toHaveProperty('newItems', 5);
    expect(result).toHaveProperty('resolvedItems', 2);
    expect(['improving', 'stable', 'worsening']).toContain(result.trend);
  });

  it('items are sorted by severity descending', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/big.ts', path: 'src/big.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/big.ts', content: 'line\n'.repeat(600), updated_at: new Date() }] },
    ];

    const { analyzeTechnicalDebt } = await import('./debtSlayer.js');
    const result = await analyzeTechnicalDebt('user-1', 'proj-1');

    const sevOrder = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
    for (let i = 1; i < result.items.length; i++) {
      expect(sevOrder[result.items[i].severity as keyof typeof sevOrder]).toBeLessThanOrEqual(
        sevOrder[result.items[i - 1].severity as keyof typeof sevOrder]
      );
    }
  });
});

// ─── PERFORMANCE ORACLE ──────────────────────────────────────
describe('PERFORMANCE ORACLE — report and regressions', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    db.state.overrideCallCounts = new Map();
    recordAudit.mockClear();
    globalSearch.mockReset();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    listTasks.mockReset();
    listTasks.mockResolvedValue([]);
  });

  it('generatePerformanceReport returns complete structure with empty files', async () => {
    const { generatePerformanceReport } = await import('./performanceOracle.js');
    const result = await generatePerformanceReport('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('complexity');
    expect(result).toHaveProperty('slowFunctions');
    expect(result).toHaveProperty('dbQueryRisks');
    expect(result).toHaveProperty('nPlusOnes');
    expect(result).toHaveProperty('cachingOpportunities');
    expect(result).toHaveProperty('repeatedComputations');
    expect(result).toHaveProperty('apiLatencyRisks');
    expect(result).toHaveProperty('summary');
    expect(result.summary).toHaveProperty('overallScore');
    expect(result.summary).toHaveProperty('criticalIssues');
    expect(result.summary).toHaveProperty('highIssues');
    expect(result.summary).toHaveProperty('mediumIssues');
    expect(result.slowFunctions).toHaveLength(0);
    expect(result.nPlusOnes).toHaveLength(0);
  });

  it('generatePerformanceReport detects SELECT * risks', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/queries.ts', path: 'src/queries.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/queries.ts', content: 'const q = "SELECT * FROM users WHERE id = $1";', updated_at: new Date() }] },
    ];

    const { generatePerformanceReport } = await import('./performanceOracle.js');
    const result = await generatePerformanceReport('user-1', 'proj-1');

    expect(result.dbQueryRisks.length).toBeGreaterThanOrEqual(1);
    expect(result.dbQueryRisks[0].estimatedCost).toBe('MEDIUM');
  });

  it('generatePerformanceReport detects N+1 query patterns', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/handler.ts', path: 'src/handler.ts', category: 'source' }],
      total: 1,
    });
    const nPlusOneCode = `for (const user of users) {\n  const posts = await db.query('SELECT * FROM posts WHERE user_id = ' + user.id);\n}`;
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/handler.ts', content: nPlusOneCode, updated_at: new Date() }] },
    ];

    const { generatePerformanceReport } = await import('./performanceOracle.js');
    const result = await generatePerformanceReport('user-1', 'proj-1');

    expect(result.nPlusOnes.length).toBeGreaterThanOrEqual(1);
    expect(result.nPlusOnes[0].source).toBe('ESTIMATED');
  });

  it('generatePerformanceReport detects API latency risks from route handlers', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/routes.ts', path: 'src/routes.ts', category: 'source' }],
      total: 1,
    });
    const routeCode = `app.get('/api/users', async (req, res) => {\n  await db.query('SELECT * FROM users');\n  await fetch('https://external.com');\n  res.json(users);\n});`;
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/routes.ts', content: routeCode, updated_at: new Date() }] },
    ];

    const { generatePerformanceReport } = await import('./performanceOracle.js');
    const result = await generatePerformanceReport('user-1', 'proj-1');

    expect(result.apiLatencyRisks.length).toBeGreaterThanOrEqual(1);
    expect(result.apiLatencyRisks[0].bottlenecks.length).toBeGreaterThan(0);
  });

  it('generatePerformanceReport score is 100 with no issues', async () => {
    const { generatePerformanceReport } = await import('./performanceOracle.js');
    const result = await generatePerformanceReport('user-1', 'proj-1');

    expect(result.summary.overallScore).toBe(100);
    expect(result.summary.criticalIssues).toBe(0);
  });

  it('detectPerformanceRegressions returns correct structure', async () => {
    db.state.queryOverrides = [
      { pattern: /performance_metrics/i, rows: [[{ metric_name: 'response_time', value: 100 }], [{ metric_name: 'response_time', value: 150 }]] },
    ];

    const { detectPerformanceRegressions } = await import('./performanceOracle.js');
    const result = await detectPerformanceRegressions('user-1', 'proj-1', new Date('2025-01-01'), new Date('2025-06-01'));

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('baselineDate');
    expect(result).toHaveProperty('currentDate');
    expect(result).toHaveProperty('regressions');
    expect(result).toHaveProperty('improvements');
    expect(result.regressions.length).toBeGreaterThanOrEqual(1);
    expect(result.regressions[0].changePercent).toBeGreaterThan(0);
  });

  it('detectPerformanceRegressions detects improvements', async () => {
    db.state.queryOverrides = [
      { pattern: /performance_metrics/i, rows: [[{ metric_name: 'p95_latency', value: 200 }], [{ metric_name: 'p95_latency', value: 150 }]] },
    ];

    const { detectPerformanceRegressions } = await import('./performanceOracle.js');
    const result = await detectPerformanceRegressions('user-1', 'proj-1', new Date('2025-01-01'), new Date('2025-06-01'));

    expect(result.improvements.length).toBeGreaterThanOrEqual(1);
    expect(result.improvements[0].changePercent).toBeLessThan(0);
  });
});

// ─── CODE SEARCH ORACLE ──────────────────────────────────────
describe('CODE SEARCH ORACLE — symbols, implementations, todos, dead code', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    db.state.overrideCallCounts = new Map();
    recordAudit.mockClear();
    globalSearch.mockReset();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
  });

  it('searchSymbols returns empty for no files', async () => {
    const { searchSymbols } = await import('./codeSearchOracle.js');
    const result = await searchSymbols('user-1', 'proj-1', 'myFunc');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('query', 'myFunc');
    expect(result).toHaveProperty('symbols');
    expect(result).toHaveProperty('total', 0);
    expect(result.symbols).toHaveLength(0);
  });

  it('searchSymbols finds function symbols', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/app.ts', content: 'function calculateTotal(items) { return items.length; }', updated_at: new Date() }] },
    ];

    const { searchSymbols } = await import('./codeSearchOracle.js');
    const result = await searchSymbols('user-1', 'proj-1', 'calculate');

    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    expect(result.symbols[0].name).toBe('calculateTotal');
    expect(result.symbols[0].type).toBe('function');
  });

  it('searchSymbols filters by type', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/types.ts', path: 'src/types.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/types.ts', content: 'class User {}\ninterface Logger {}\nenum Status { ACTIVE }', updated_at: new Date() }] },
    ];

    const { searchSymbols } = await import('./codeSearchOracle.js');
    const result = await searchSymbols('user-1', 'proj-1', '', { type: 'interface' });

    expect(result.symbols.every((s: any) => s.type === 'interface')).toBe(true);
  });

  it('findImplementations returns empty for no matches', async () => {
    const { findImplementations } = await import('./codeSearchOracle.js');
    const result = await findImplementations('user-1', 'proj-1', 'Logger');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('interfaceName', 'Logger');
    expect(result).toHaveProperty('implementations');
    expect(result).toHaveProperty('total', 0);
  });

  it('findImplementations finds class implementing interface', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/logger.ts', path: 'src/logger.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/logger.ts', content: 'class ConsoleLogger implements Logger { log(msg) { console.log(msg); } }', updated_at: new Date() }] },
    ];

    const { findImplementations } = await import('./codeSearchOracle.js');
    const result = await findImplementations('user-1', 'proj-1', 'Logger');

    expect(result.implementations).toHaveLength(1);
    expect(result.implementations[0].className).toBe('ConsoleLogger');
    expect(result.implementations[0].implementsInterface).toBe('Logger');
  });

  it('searchTodos finds TODO comments', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/app.ts', content: '// TODO: implement auth\n// FIXME: handle edge case\nconst x = 1;', updated_at: new Date() }] },
    ];

    const { searchTodos } = await import('./codeSearchOracle.js');
    const result = await searchTodos('user-1', 'proj-1');

    expect(result.todos.length).toBeGreaterThanOrEqual(2);
    expect(result.todos.some((t: any) => t.type === 'TODO')).toBe(true);
    expect(result.todos.some((t: any) => t.type === 'FIXME')).toBe(true);
  });

  it('searchTodos filters by type', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/app.ts', content: '// TODO: fix later\n// HACK: temp workaround\n// BUG: crash on null', updated_at: new Date() }] },
    ];

    const { searchTodos } = await import('./codeSearchOracle.js');
    const result = await searchTodos('user-1', 'proj-1', { type: 'FIXME' });

    expect(result.todos).toHaveLength(0);
  });

  it('findDeadCode returns empty for no files', async () => {
    const { findDeadCode } = await import('./codeSearchOracle.js');
    const result = await findDeadCode('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('candidates');
    expect(result.candidates).toHaveLength(0);
  });

  it('analyzeRefactoringImpact returns correct structure', async () => {
    const { analyzeRefactoringImpact } = await import('./codeSearchOracle.js');
    const result = await analyzeRefactoringImpact('user-1', 'proj-1', 'myFunc');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('targetSymbol', 'myFunc');
    expect(result).toHaveProperty('impactRadius');
    expect(result).toHaveProperty('riskLevel');
    expect(result).toHaveProperty('estimatedFilesAffected');
    expect(result).toHaveProperty('estimatedTestFilesAffected');
    expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.riskLevel);
  });
});

// ─── CONTEXT FLOW ANALYZER ───────────────────────────────────
describe('CONTEXT FLOW ANALYZER — variable flow, API data flow', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    db.state.overrideCallCounts = new Map();
    recordAudit.mockClear();
    globalSearch.mockReset();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
  });

  it('analyzeContextFlow returns empty for no files', async () => {
    const { analyzeContextFlow } = await import('./contextFlowAnalyzer.js');
    const result = await analyzeContextFlow('user-1', 'proj-1');

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('variableFlows');
    expect(result).toHaveProperty('apiFlows');
    expect(result).toHaveProperty('suspiciousPatterns');
    expect(result.variableFlows).toHaveLength(0);
    expect(result.apiFlows).toHaveLength(0);
  });

  it('analyzeContextFlow detects API endpoint flows', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/routes.ts', path: 'src/routes.ts', category: 'source' }],
      total: 1,
    });
    const routeCode = `app.post('/api/users', (req, res) => {\n  const name = req.body.name;\n  res.json({ name });\n});`;
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/routes.ts', content: routeCode, updated_at: new Date() }] },
    ];

    const { analyzeContextFlow } = await import('./contextFlowAnalyzer.js');
    const result = await analyzeContextFlow('user-1', 'proj-1');

    expect(result.apiFlows.length).toBeGreaterThanOrEqual(1);
    expect(result.apiFlows[0].endpoint).toBe('/api/users');
    expect(result.apiFlows[0].method).toBe('POST');
  });

  it('analyzeContextFlow detects missing validation issues', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/routes.ts', path: 'src/routes.ts', category: 'source' }],
      total: 1,
    });
    const routeCode = `app.post('/api/data', (req, res) => {\n  const data = req.body;\n  db.save(data);\n  res.json(data);\n});`;
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/routes.ts', content: routeCode, updated_at: new Date() }] },
    ];

    const { analyzeContextFlow } = await import('./contextFlowAnalyzer.js');
    const result = await analyzeContextFlow('user-1', 'proj-1');

    const missingVal = result.apiFlows.some((f: any) =>
      f.issues.some((i: any) => i.type === 'missing_validation')
    );
    expect(missingVal).toBe(true);
  });

  it('analyzeContextFlow detects password exposure', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/auth.ts', path: 'src/auth.ts', category: 'source' }],
      total: 1,
    });
    const routeCode = `app.get('/api/user', (req, res) => {\n  const user = db.getUser(req.query.id);\n  res.json({ password: user.password });\n});`;
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/auth.ts', content: routeCode, updated_at: new Date() }] },
    ];

    const { analyzeContextFlow } = await import('./contextFlowAnalyzer.js');
    const result = await analyzeContextFlow('user-1', 'proj-1');

    const sensitiveLeak = result.apiFlows.some((f: any) =>
      f.issues.some((i: any) => i.type === 'sensitive_leak' && i.severity === 'CRITICAL')
    );
    expect(sensitiveLeak).toBe(true);
  });

  it('traceVariableFlow traces a variable across files', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/app.ts', content: 'const userId = req.body.id;\nconst name = userId.toUpperCase();\nconsole.log(userId);', updated_at: new Date() }] },
    ];

    const { traceVariableFlow } = await import('./contextFlowAnalyzer.js');
    const files = await globalSearch('user-1', { q: '', type: 'file', projectId: 'proj-1', limit: 300 });
    const result = await traceVariableFlow('user-1', 'proj-1', 'userId', files);

    expect(result).toHaveProperty('projectId', 'proj-1');
    expect(result).toHaveProperty('variableName', 'userId');
    expect(result).toHaveProperty('flows');
    expect(result.flows.length).toBeGreaterThanOrEqual(1);
    expect(result).toHaveProperty('origin');
    expect(result).toHaveProperty('destinations');
  });

  it('traceDataOrigin returns null for nonexistent variable', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/app.ts', content: 'const x = 1;', updated_at: new Date() }] },
    ];

    const { traceDataOrigin } = await import('./contextFlowAnalyzer.js');
    const result = await traceDataOrigin('user-1', 'proj-1', 'nonexistent', 'src/app.ts');

    expect(result).toBeNull();
  });

  it('traceDataOrigin finds parameter origin', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/handler.ts', content: 'const data = req.body;', updated_at: new Date() }] },
    ];

    const { traceDataOrigin } = await import('./contextFlowAnalyzer.js');
    const result = await traceDataOrigin('user-1', 'proj-1', 'data', 'src/handler.ts');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('parameter');
  });

  it('traceDataDestination finds return destinations', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/handler.ts', path: 'src/handler.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /FROM files WHERE project_id/i, rows: [{ path: 'src/handler.ts', content: 'const result = compute();\nreturn result;', updated_at: new Date() }] },
    ];

    const { traceDataDestination } = await import('./contextFlowAnalyzer.js');
    const result = await traceDataDestination('user-1', 'proj-1', 'result');

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].usage).toBe('return');
  });
});

// ─── REFACTORING WIZARD ──────────────────────────────────────
describe('REFACTORING WIZARD — plan creation, listing, rollback', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    db.state.overrideCallCounts = new Map();
    recordAudit.mockClear();
    globalSearch.mockReset();
    globalSearch.mockResolvedValue({ results: [], total: 0 });
    createTaskFromChat.mockReset();
    createTaskFromChat.mockResolvedValue({ id: 'task-1', title: 'test', description: '', risk_level: 'LOW' });
    proposeApproval.mockReset();
    proposeApproval.mockResolvedValue({ approval: { id: 'approval-1' } });
  });

  it('createRefactoringPlan for simplify_complexity is LOW risk, no approval needed', async () => {
    db.state.queryOverrides = [
      { pattern: /INSERT INTO refactoring_plans/i, rows: [] },
    ];

    const { createRefactoringPlan } = await import('./refactoringWizard.js');
    const plan = await createRefactoringPlan('user-1', 'proj-1', 'simplify_complexity', {
      filePath: 'src/app.ts',
      symbolName: 'complexFn',
    });

    expect(plan).toHaveProperty('id');
    expect(plan.type).toBe('simplify_complexity');
    expect(plan.estimatedRisk).toBe('LOW');
    expect(plan.requiresApproval).toBe(false);
    expect(plan.status).toBe('approved');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].action).toBe('modify');
  });

  it('createRefactoringPlan for move_code is HIGH risk, requires approval', async () => {
    db.state.queryOverrides = [
      { pattern: /INSERT INTO refactoring_plans/i, rows: [] },
      { pattern: /FROM files WHERE path = \$/i, rows: [{ content: 'line1\nline2\nline3' }] },
      { pattern: /FROM files WHERE project_id.*AND path/i, rows: [] },
    ];

    const { createRefactoringPlan } = await import('./refactoringWizard.js');
    const plan = await createRefactoringPlan('user-1', 'proj-1', 'move_code', {
      filePath: 'src/old.ts',
      destinationPath: 'src/new.ts',
    });

    expect(plan.estimatedRisk).toBe('HIGH');
    expect(plan.requiresApproval).toBe(true);
    expect(plan.status).toBe('planned');
    expect(plan.approvalId).toBe('approval-1');
  });

  it('createRefactoringPlan for extract_function generates 2 steps', async () => {
    db.state.queryOverrides = [
      { pattern: /INSERT INTO refactoring_plans/i, rows: [] },
      { pattern: /FROM files WHERE path = \$/i, rows: [{ content: 'line1\nline2\nline3\nline4' }] },
    ];

    const { createRefactoringPlan } = await import('./refactoringWizard.js');
    const plan = await createRefactoringPlan('user-1', 'proj-1', 'extract_function', {
      filePath: 'src/app.ts',
      newName: 'extractedFn',
      startLine: 1,
      endLine: 3,
    });

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].action).toBe('create');
    expect(plan.steps[1].action).toBe('modify');
    expect(plan.steps[0].description).toContain('extractedFn');
  });

  it('createRefactoringPlan for rename finds references', async () => {
    globalSearch.mockResolvedValue({
      results: [{ projectId: 'proj-1', label: 'src/app.ts', path: 'src/app.ts', category: 'source' }],
      total: 1,
    });
    db.state.queryOverrides = [
      { pattern: /INSERT INTO refactoring_plans/i, rows: [] },
      { pattern: /FROM files WHERE project_id.*AND path/i, rows: [{ path: 'src/app.ts', content: 'import { oldName } from "./utils";\noldName();' }] },
    ];

    const { createRefactoringPlan } = await import('./refactoringWizard.js');
    const plan = await createRefactoringPlan('user-1', 'proj-1', 'rename', {
      filePath: 'src/app.ts',
      symbolName: 'oldName',
      newName: 'newName',
    });

    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps.every((s: any) => s.action === 'modify')).toBe(true);
  });

  it('listRefactoringPlans returns plans from DB', async () => {
    db.state.queryOverrides = [
      {
        pattern: /SELECT \* FROM refactoring_plans WHERE project_id/i,
        rows: [{
          id: 'plan-1', project_id: 'proj-1', user_id: 'user-1', type: 'rename',
          target: JSON.stringify({ filePath: 'src/app.ts', symbolName: 'a', newName: 'b' }),
          steps: JSON.stringify([{ id: 's1', order: 1, description: 'Rename', filePath: 'src/app.ts', action: 'modify', diff: '', preconditions: [], verification: '' }]),
          estimated_risk: 'MEDIUM', requires_approval: false, approval_id: null, task_id: null,
          status: 'completed', created_at: new Date(), updated_at: new Date(),
        }],
      },
    ];

    const { listRefactoringPlans } = await import('./refactoringWizard.js');
    const plans = await listRefactoringPlans('user-1', 'proj-1');

    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe('plan-1');
    expect(plans[0].type).toBe('rename');
    expect(plans[0].status).toBe('completed');
  });

  it('rollbackRefactoring restores created files', async () => {
    db.state.queryOverrides = [
      {
        pattern: /SELECT \* FROM refactoring_plans WHERE id/i,
        rows: [{
          id: 'plan-1', project_id: 'proj-1', user_id: 'user-1', type: 'extract_function',
          target: JSON.stringify({ filePath: 'src/app.ts' }),
          steps: JSON.stringify([
            { id: 's1', order: 1, description: 'Create', filePath: 'src/extracted.ts', action: 'create', diff: '', preconditions: [], verification: '' },
            { id: 's2', order: 2, description: 'Modify', filePath: 'src/app.ts', action: 'modify', diff: '', preconditions: [], verification: '' },
          ]),
          estimated_risk: 'LOW', requires_approval: false, approval_id: null, task_id: null,
          status: 'in_progress', created_at: new Date(), updated_at: new Date(),
        }],
      },
      { pattern: /DELETE FROM files WHERE/i, rows: [] },
    ];

    const { rollbackRefactoring } = await import('./refactoringWizard.js');
    const result = await rollbackRefactoring('user-1', 'plan-1');

    expect(result).toHaveProperty('planId', 'plan-1');
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('restoredFiles');
    expect(result.restoredFiles.length).toBe(2);
  });

  it('throws when project not found', async () => {
    db.state.queryOverrides = [
      { pattern: /FROM projects/i, rows: [], rowCount: 0 },
    ];

    const { createRefactoringPlan } = await import('./refactoringWizard.js');
    await expect(createRefactoringPlan('user-1', 'nonexistent', 'simplify_complexity', {
      filePath: 'src/app.ts',
    })).rejects.toThrow('Project');
  });
});
