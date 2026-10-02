/**
 * CodeConClave — V4D Production Intelligence Tests.
 * Tests for: Log Analysis, Error Correlation, Request Tracing,
 * DB Performance, Monitoring Autopilot, Runbook Automation, Cost Analysis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: any[];
    rowCount: number;
    /** Per-test override: regex pattern → rows to return */
    queryOverrides: { pattern: RegExp; rows: any[]; rowCount?: number }[];
  } = {
    calls: [],
    rows: [],
    rowCount: 1,
    queryOverrides: [],
  };

  const PROJECT_ROW = { id: 'proj-1' };

  const resolveRows = (text: string): { rows: any[]; rowCount: number } => {
    if (/FROM projects/i.test(text)) {
      return { rows: [PROJECT_ROW], rowCount: 1 };
    }
    for (const override of state.queryOverrides) {
      if (override.pattern.test(text)) {
        return { rows: override.rows, rowCount: override.rowCount ?? override.rows.length };
      }
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

  const withTenant = async (_tid: string, fn: (q: { query: typeof query }) => any) => fn({ query });
  const withSystem = async (fn: (q: { query: typeof query }) => any) => fn({ query });
  return { state, pool: { query }, queryOne, queryMany, withTenant, withSystem };
});

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const recentErrors = vi.hoisted(() => vi.fn(() => []));
const computeHealth = vi.hoisted(() => vi.fn(async () => ({ status: 'HEALTHY' as const })));
const metricSnapshot = vi.hoisted(() => vi.fn(() => ({})));
const incMetric = vi.hoisted(() => vi.fn());
const lastWatchdogRunAt = vi.hoisted(() => vi.fn(() => new Date()));
const createTask = vi.hoisted(() => vi.fn(async () => ({ id: 'task-1' })));
const listTasks = vi.hoisted(() => vi.fn(async () => []));
const getTask = vi.hoisted(() => vi.fn(async () => null));
const cancelTask = vi.hoisted(() => vi.fn(async () => {}));
const proposeApproval = vi.hoisted(() => vi.fn(async () => ({ id: 'approval-1', decision: 'APPROVE' })));
const decideApproval = vi.hoisted(() => vi.fn(async () => {}));
const getApproval = vi.hoisted(() => vi.fn(async () => ({ id: 'approval-1', decision: 'APPROVE' })));
const listCoworkerRuns = vi.hoisted(() => vi.fn(async () => []));
const newId = vi.hoisted(() => vi.fn(() => 'id-1'));
const PREFIX = vi.hoisted(() => ({
  COST_ENTRY: 'ce_',
  COST_ALERT: 'ca_',
  BUDGET: 'bud_',
  LOG_ANALYSIS: 'la_',
  DB_PERF_REPORT: 'dpr_',
  RUNBOOK: 'rb_',
  RUNBOOK_EXEC: 'rbe_',
  RUNBOOK_TEMPLATE: 'rbt_',
  ROLLBACK_PLAN: 'rbp_',
}));

vi.mock('../../shared/db.js', () => db);
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, errorCode: 'not_found' }),
    badRequest: (code: string, msg: string) => Object.assign(new Error(msg), { status: 400, errorCode: code }),
    unauthorized: (code: string, msg: string) => Object.assign(new Error(msg), { status: 401, errorCode: code }),
  },
}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
vi.mock('../../observability/error-buffer.js', () => ({ recentErrors }));
vi.mock('../../observability/metrics.js', () => ({ metricSnapshot, incMetric }));
vi.mock('../../health/health.js', () => ({ computeHealth }));
vi.mock('../../workers/watchdog.js', () => ({ lastWatchdogRunAt }));
vi.mock('../execution/tasks.js', () => ({ createTask, listTasks, getTask, cancelTask }));
vi.mock('../execution/approvals.js', () => ({ proposeApproval, decideApproval, getApproval }));
vi.mock('../execution/coworkers.js', () => ({ listCoworkerRuns }));
vi.mock('../../shared/ids.js', () => ({ newId, PREFIX }));
vi.mock('@codeconclave/shared', () => ({
  AuditAction: {
    LOG_ANALYSIS_COMPLETED: 'log_analysis.completed',
    COST_BUDGET_ALERT_ACKNOWLEDGED: 'cost_budget_alert_acknowledged',
  },
}));

// ─── LOG ANALYSIS ────────────────────────────────────────────────
describe('LOG ANALYSIS — error detection and security signals', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    recentErrors.mockReturnValue([]);
  });

  it('detects repeated errors when min threshold met', async () => {
    recentErrors.mockReturnValue([
      { msg: 'Connection timeout', t: new Date().toISOString(), correlationId: 'c1' },
      { msg: 'Connection timeout', t: new Date().toISOString(), correlationId: 'c2' },
      { msg: 'Connection timeout', t: new Date().toISOString(), correlationId: 'c3' },
    ]);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    const result = await analyzeLogs('user-1', 'proj-1', { timeWindowMs: 3600000 });

    expect(result.totalErrors).toBe(3);
    expect(result.repeatedErrors.length).toBeGreaterThanOrEqual(1);
    expect(result.repeatedErrors[0].count).toBe(3);
    expect(result.repeatedErrors[0].errorMessage).toContain('Connection timeout');
  });

  it('detects security signals — SQL injection', async () => {
    recentErrors.mockReturnValue([
      { msg: "union select * from users where 1=1", t: new Date().toISOString(), correlationId: 'c1' },
      { msg: "union select * from users where 1=1", t: new Date().toISOString(), correlationId: 'c2' },
    ]);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    const result = await analyzeLogs('user-1', 'proj-1');

    expect(result.securitySignals.length).toBeGreaterThanOrEqual(1);
    expect(result.securitySignals[0].type).toBe('SQL_INJECTION_ATTEMPT');
    expect(result.securitySignals[0].severity).toBe('CRITICAL');
  });

  it('detects XSS attempts', async () => {
    recentErrors.mockReturnValue([
      { msg: '<script>alert(1)</script>', t: new Date().toISOString(), correlationId: 'c1' },
    ]);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    const result = await analyzeLogs('user-1', 'proj-1');

    expect(result.securitySignals.some(s => s.type === 'XSS_ATTEMPT')).toBe(true);
  });

  it('detects path traversal', async () => {
    recentErrors.mockReturnValue([
      { msg: 'File not found: ../../etc/passwd', t: new Date().toISOString(), correlationId: 'c1' },
    ]);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    const result = await analyzeLogs('user-1', 'proj-1');

    expect(result.securitySignals.some(s => s.type === 'PATH_TRAVERSAL')).toBe(true);
  });

  it('detects auth failure spike', async () => {
    const errors = Array.from({ length: 15 }, (_, i) => ({
      msg: `Unauthorized: invalid credentials attempt ${i}`,
      t: new Date().toISOString(),
      correlationId: `c${i}`,
    }));
    recentErrors.mockReturnValue(errors);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    const result = await analyzeLogs('user-1', 'proj-1');

    expect(result.securitySignals.some(s => s.type === 'AUTH_FAILURE_SPIKE')).toBe(true);
  });

  it('returns empty results when no errors', async () => {
    recentErrors.mockReturnValue([]);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    const result = await analyzeLogs('user-1', 'proj-1');

    expect(result.totalErrors).toBe(0);
    expect(result.repeatedErrors).toHaveLength(0);
    expect(result.securitySignals).toHaveLength(0);
  });

  it('records audit on completion', async () => {
    recentErrors.mockReturnValue([]);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    await analyzeLogs('user-1', 'proj-1');

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'log_analysis.completed' }),
    );
  });
});

// ─── ERROR CORRELATION ───────────────────────────────────────────
describe('ERROR CORRELATION — chain tracing', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('returns empty when no correlation ID provided', async () => {
    db.state.rows = [];
    const { traceCorrelation } = await import('./errorCorrelation.js');
    const result = await traceCorrelation('user-1', 'proj-1', {});
    expect(result.chains).toHaveLength(0);
  });

  it('traces chain from correlation ID', async () => {
    db.state.rows = [
      { correlation_id: 'corr-1', created_at: new Date(), action: 'test_error', detail: { message: 'err' }, actor_user_id: 'u1' },
    ];
    db.state.rowCount = 1;

    const { traceCorrelation } = await import('./errorCorrelation.js');
    const result = await traceCorrelation('user-1', 'proj-1', { correlationId: 'corr-1' });
    expect(result.chains.length).toBeGreaterThanOrEqual(1);
    expect(result.chains[0].correlationId).toBe('corr-1');
  });

  it('returns empty chain for unknown correlation ID', async () => {
    db.state.rows = [];
    db.state.rowCount = 0;

    const { traceCorrelation } = await import('./errorCorrelation.js');
    const result = await traceCorrelation('user-1', 'proj-1', { correlationId: 'unknown' });
    expect(result.chains).toHaveLength(0);
  });
});

// ─── REQUEST TRACING ─────────────────────────────────────────────
describe('REQUEST TRACING — trace and stats', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('traces requests with filters', async () => {
    db.state.rows = [
      {
        id: 'req-1', method: 'GET', path: '/api/test', user_id: 'u1',
        correlation_id: 'corr-1', started_at: new Date(), completed_at: new Date(),
        duration_ms: 150, status: 'SUCCESS', status_code: 200, project_id: 'proj-1',
        error: null, task_id: null, task_title: null, task_status: null,
      },
    ];

    const { traceRequest } = await import('./requestTracing.js');
    const result = await traceRequest('user-1', 'proj-1', { method: 'GET' });
    expect(result.traces.length).toBeGreaterThanOrEqual(1);
  });

  it('computes trace stats with percentiles', async () => {
    db.state.rows = [{ total_requests: 100, success_count: 95, avg_duration_ms: '120.5', p50_duration_ms: '100', p95_duration_ms: '350', p99_duration_ms: '800', error_rate: '0.05' }];

    const { getRequestTraceStats } = await import('./requestTracing.js');
    const stats = await getRequestTraceStats('user-1', 'proj-1');
    expect(stats.totalRequests).toBe(100);
    expect(stats.successRate).toBeCloseTo(0.95);
    expect(stats.p50DurationMs).toBe(100);
  });

  it('returns null for unknown trace ID', async () => {
    db.state.rows = [];
    db.state.rowCount = 0;

    const { getRequestTrace } = await import('./requestTracing.js');
    const trace = await getRequestTrace('user-1', 'proj-1', 'unknown');
    expect(trace).toBeNull();
  });
});

// ─── DB PERFORMANCE ──────────────────────────────────────────────
describe('DB PERFORMANCE — report generation', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('generates performance report', async () => {
    db.state.rows = [];

    const { generateDbPerformanceReport } = await import('./dbPerformance.js');
    const report = await generateDbPerformanceReport('user-1', 'proj-1', { timeWindowMs: 3600000 });

    expect(report).toHaveProperty('reportId');
    expect(report).toHaveProperty('projectId', 'proj-1');
    expect(report).toHaveProperty('generatedAt');
    expect(report).toHaveProperty('timeWindowMs', 3600000);
    expect(report).toHaveProperty('slowQueries');
    expect(report).toHaveProperty('missingIndexes');
    expect(report).toHaveProperty('longTransactions');
    expect(report).toHaveProperty('connectionPressure');
    expect(report).toHaveProperty('lockPatterns');
    expect(report).toHaveProperty('tableStats');
    expect(report).toHaveProperty('recommendations');
    expect(Array.isArray(report.recommendations)).toBe(true);
  });

  it('delegates getDbPerformanceReport to generate', async () => {
    db.state.rows = [];

    const { getDbPerformanceReport } = await import('./dbPerformance.js');
    const report = await getDbPerformanceReport('user-1', 'proj-1');
    expect(report).toHaveProperty('reportId');
  });
});

// ─── suggestIndexes (unit) ──────────────────────────────────────
describe('suggestIndexes — column extraction and safe fallbacks', () => {
  it('extracts real column names from table.column = patterns', async () => {
    const { suggestIndexes } = await import('./dbPerformance.js');
    const result = suggestIndexes(
      'SELECT * FROM public.users WHERE public.users.email = $1 AND public.users.status > 0',
      ['public.users'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('email');
    expect(result[0]).toContain('status');
    expect(result[0]).not.toContain('column_name');
  });

  it('extracts columns from comparison operators', async () => {
    const { suggestIndexes } = await import('./dbPerformance.js');
    const result = suggestIndexes(
      'SELECT * FROM orders WHERE orders.total < 100',
      ['orders'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('total');
    expect(result[0]).toContain('CREATE INDEX ON orders (total)');
  });

  it('deduplicates columns', async () => {
    const { suggestIndexes } = await import('./dbPerformance.js');
    const result = suggestIndexes(
      'SELECT * FROM items WHERE items.id = $1 AND items.id > 0',
      ['items'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('items (id)');
    const idMatches = result[0]!.match(/\bid\b/g) || [];
    expect(idMatches.length).toBeGreaterThanOrEqual(1);
    expect(result[0]).not.toContain('id, id');
  });

  it('generates safe fallback when no columns are extracted', async () => {
    const { suggestIndexes } = await import('./dbPerformance.js');
    const result = suggestIndexes(
      'SELECT count(*) FROM products',
      ['products'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('[inferred_column]');
    expect(result[0]).toContain('please verify');
    expect(result[0]).not.toContain('column_name');
  });

  it('returns empty array for empty tables list', async () => {
    const { suggestIndexes } = await import('./dbPerformance.js');
    const result = suggestIndexes('SELECT 1', []);
    expect(result).toHaveLength(0);
  });

  it('handles empty query text with tables scanned', async () => {
    const { suggestIndexes } = await import('./dbPerformance.js');
    const result = suggestIndexes('', ['users']);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('[inferred_column]');
    expect(result[0]).not.toContain('column_name');
  });

  it('never contains literal column_name placeholder', async () => {
    const { suggestIndexes } = await import('./dbPerformance.js');
    const queries = [
      'SELECT * FROM t1 WHERE t1.x = 1',
      'SELECT count(*) FROM t2',
      '',
      'SELECT * FROM t3 JOIN t3_detail ON t3.id = t3_detail.t3_id',
    ];
    const tables = [['t1'], ['t2'], ['t3'], ['t3']];
    for (let i = 0; i < queries.length; i++) {
      const result = suggestIndexes(queries[i]!, tables[i]!);
      for (const idx of result) {
        expect(idx).not.toMatch(/\bcolumn_name\b/);
      }
    }
  });
});

// ─── MONITORING AUTOPILOT ────────────────────────────────────────
describe('MONITORING AUTOPILOT — checks and config', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    recentErrors.mockReturnValue([]);
    computeHealth.mockResolvedValue({ status: 'HEALTHY' });
    metricSnapshot.mockReturnValue({});
    lastWatchdogRunAt.mockReturnValue(new Date());
  });

  it('runs monitoring autopilot check', async () => {
    const { runMonitoringAutopilot } = await import('./monitoringAutopilot.js');
    const result = await runMonitoringAutopilot('user-1', 'proj-1');

    expect(result).toHaveProperty('checkId');
    expect(result).toHaveProperty('checkedAt');
    expect(result).toHaveProperty('overallStatus', 'HEALTHY');
    expect(result).toHaveProperty('anomalies');
    expect(result).toHaveProperty('alertCorrelations');
    expect(result).toHaveProperty('suppressedAlerts');
    expect(result).toHaveProperty('criticalPathStatus');
    expect(result).toHaveProperty('aiExplanation');
    expect(typeof result.aiExplanation).toBe('string');
  });

  it('returns config with default values', async () => {
    const { getMonitoringConfig } = await import('./monitoringAutopilot.js');
    const config = await getMonitoringConfig();
    expect(config.anomalyDetection.enabled).toBe(true);
    expect(config.criticalPaths.length).toBeGreaterThan(0);
  });

  it('updates config', async () => {
    const { updateMonitoringConfig } = await import('./monitoringAutopilot.js');
    const updated = await updateMonitoringConfig({ anomalyDetection: { enabled: false, sensitivity: 'LOW', minDeviationPercent: 100, minDurationMs: 600000 } });
    expect(updated.anomalyDetection.enabled).toBe(false);
  });

  it('manages suppression rules', async () => {
    const { addSuppressionRule, getSuppressionRules } = await import('./monitoringAutopilot.js');
    await addSuppressionRule({ type: 'duplicate', pattern: 'test' });
    const rules = await getSuppressionRules();
    expect(rules.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── RUNBOOK AUTOMATION ──────────────────────────────────────────
describe('RUNBOOK AUTOMATION — lifecycle', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('creates a runbook', async () => {
    const { createRunbook } = await import('./runbookAutomation.js');
    const runbook = await createRunbook('user-1', 'proj-1', {
      name: 'Test Runbook',
      description: 'A test runbook',
      trigger: 'MANUAL',
      triggerConfig: {},
      steps: [
        { index: 0, type: 'CREATE_TASK', name: 'Step 1', description: 'Create task', config: { title: 'Test' }, requiresApproval: false, maxRetries: 0, timeoutMs: 30000, dependsOn: [] },
      ],
    });

    expect(runbook).toHaveProperty('id');
    expect(runbook.name).toBe('Test Runbook');
    expect(runbook.status).toBe('DETECTED');
    expect(runbook.steps).toHaveLength(1);
  });

  it('lists runbooks', async () => {
    db.state.rows = [];
    const { listRunbooks } = await import('./runbookAutomation.js');
    const result = await listRunbooks('user-1', 'proj-1');
    expect(result.runbooks).toBeDefined();
    expect(result.total).toBeDefined();
  });

  it('creates runbook template', async () => {
    const { createRunbookTemplate } = await import('./runbookAutomation.js');
    const template = await createRunbookTemplate('user-1', 'proj-1', {
      name: 'Incident Template',
      description: 'Standard incident response',
      category: 'INCIDENT_RESPONSE',
      trigger: 'ERROR_THRESHOLD',
      triggerConfig: { threshold: 10 },
      steps: [
        { index: 0, type: 'CREATE_TASK', name: 'Create incident task', description: 'Create', config: {}, requiresApproval: false, maxRetries: 0, timeoutMs: 30000, dependsOn: [] },
      ],
    });

    expect(template).toHaveProperty('id');
    expect(template.name).toBe('Incident Template');
    expect(template.isSystem).toBe(false);
  });
});

// ─── COST ANALYSIS ───────────────────────────────────────────────
describe('COST ANALYSIS — recording, breakdowns, budgets', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('records a cost entry', async () => {
    db.state.rows = [{ id: 'proj-1' }];
    const { recordCost } = await import('./costAnalysis.js');
    const entry = await recordCost('user-1', 'proj-1', {
      category: 'AI_INFERENCE',
      source: 'MEASURED',
      amountUsd: 0.05,
      quantity: 1000,
      unit: 'tokens',
      description: 'GPT-4 inference',
    });

    expect(entry).toHaveProperty('id');
    expect(entry.amountUsd).toBe(0.05);
    expect(entry.category).toBe('AI_INFERENCE');
    expect(entry.source).toBe('MEASURED');
  });

  it('records AI cost with provider details', async () => {
    db.state.rows = [{ id: 'proj-1' }];
    const { recordAICost } = await import('./costAnalysis.js');
    const entry = await recordAICost('user-1', 'proj-1', {
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.03,
      source: 'MEASURED',
    });

    expect(entry.category).toBe('AI_INFERENCE');
    expect(entry.amountUsd).toBe(0.03);
  });

  it('creates a budget', async () => {
    const { createBudget } = await import('./costAnalysis.js');
    const budget = await createBudget('user-1', 'proj-1', {
      name: 'Monthly AI Budget',
      period: 'MONTHLY',
      limitUsd: 100,
      alertThresholdPercent: 80,
      categories: ['AI_INFERENCE'],
    });

    expect(budget).toHaveProperty('id');
    expect(budget.name).toBe('Monthly AI Budget');
    expect(budget.limitUsd).toBe(100);
  });

  it('gets cost breakdown', async () => {
    const costTotal = { total: '10.50', measured: '8.00', estimated: '2.50' };
    db.state.queryOverrides = [
      { pattern: /SELECT.*sum\(amount_usd\).*FROM cost_entries(?!.*GROUP BY)/i, rows: [costTotal] },
      { pattern: /GROUP BY category/i, rows: [] },
      { pattern: /GROUP BY.*provider/i, rows: [] },
      { pattern: /GROUP BY.*user_id/i, rows: [] },
      { pattern: /GROUP BY.*feature/i, rows: [] },
      { pattern: /date_trunc/i, rows: [] },
    ];

    const { getCostBreakdown } = await import('./costAnalysis.js');
    const breakdown = await getCostBreakdown('user-1', 'proj-1');
    expect(breakdown).toHaveProperty('totalUsd');
    expect(breakdown).toHaveProperty('measuredUsd');
    expect(breakdown).toHaveProperty('estimatedUsd');
    expect(breakdown).toHaveProperty('byCategory');
  });

  it('checks budget alerts when spend exceeds limit', async () => {
    const budgetRow = { id: 'bud-1', project_id: 'proj-1', name: 'Test Budget', period: 'MONTHLY', limit_usd: 50, alert_threshold_percent: 80, categories: ['AI_INFERENCE'], created_at: new Date(), updated_at: new Date() };
    const costTotal = { total: '60.00', measured: '60.00', estimated: '0' };

    db.state.queryOverrides = [
      { pattern: /FROM budgets/i, rows: [budgetRow] },
      { pattern: /sum\(amount_usd\).*FROM cost_entries.*GROUP BY/i, rows: [] },
      { pattern: /date_trunc.*FROM cost_entries/i, rows: [] },
      { pattern: /FROM cost_entries/i, rows: [costTotal] },
    ];

    const { checkBudgetAlerts } = await import('./costAnalysis.js');
    const alerts = await checkBudgetAlerts('user-1', 'proj-1');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].type).toBe('BUDGET_EXCEEDED');
    expect(alerts[0].severity).toBe('CRITICAL');
  });

  it('acknowledges cost alert', async () => {
    db.state.rowCount = 1;
    db.state.rows = [{ id: 'alert-1', project_id: 'proj-1' }];
    const { acknowledgeBudgetAlert } = await import('./costAnalysis.js');
    await acknowledgeBudgetAlert('user-1', 'proj-1', 'alert-1');
    expect(recordAudit).toHaveBeenCalled();
  });
});

// ─── INTEGRATION — CORRELATION ID FLOW ───────────────────────────
describe('INTEGRATION — correlation ID flows through all systems', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [{ id: 'proj-1' }];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
    recentErrors.mockReturnValue([]);
  });

  it('correlation ID connects log analysis to error correlation', async () => {
    recentErrors.mockReturnValue([
      { msg: 'Test error', t: new Date().toISOString(), correlationId: 'corr-integration' },
    ]);
    db.state.rows = [];

    const { analyzeLogs } = await import('./logAnalysis.js');
    const logResult = await analyzeLogs('user-1', 'proj-1');
    expect(logResult.totalErrors).toBe(1);

    db.state.rows = [
      { correlation_id: 'corr-integration', created_at: new Date(), action: 'test_error', detail: { message: 'Test error' }, actor_user_id: 'u1' },
    ];
    db.state.rowCount = 1;

    const { traceCorrelation } = await import('./errorCorrelation.js');
    const corrResult = await traceCorrelation('user-1', 'proj-1', { correlationId: 'corr-integration' });
    expect(corrResult.chains.length).toBeGreaterThanOrEqual(1);
  });
});
