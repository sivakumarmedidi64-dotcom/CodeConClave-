/**
 * CodeConClave — Developer Workflow & Release Operations Tests (PKG-17).
 * Covers Workspace Migration Agent (#29), Documentation Drift Detector (#34),
 * Contextual Debugging (#41), Hotspot Profiler (#44), Branch Strategy (#31),
 * Rollback Predictor (#32), Hotfix Fast-Track (#33), Feature Flag Orchestrator
 * (#35), Workspace Health Dashboard (#43), Error Recovery Playbook (#45), and
 * the honest capability report. Files service + performance oracle are mocked;
 * everything asserts advisory, deterministic output with explicit truthfulness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ----------------------------- Mocks ----------------------------- */

const mocks = vi.hoisted(() => ({
  generatePerformanceReport: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockListFiles: vi.fn(),
  newId: vi.fn(),
  idSeed: { n: 0 },
}));

vi.mock('../../shared/ids.js', () => ({
  newId: (...args: unknown[]) => mocks.newId(...args),
  PREFIX: {
    DEVWORKFLOW_REPORT: 'dwr',
    DEVWORKFLOW_MIGRATE: 'dwm',
    DEVWORKFLOW_DOCDRIFT: 'dwd',
    DEVWORKFLOW_DEBUG: 'dwb',
    DEVWORKFLOW_HOTSPOT: 'dwh',
    DEVWORKFLOW_BRANCH: 'dws',
    DEVWORKFLOW_ROLLBACK: 'dwrb',
    DEVWORKFLOW_HOTFIX: 'dwhx',
    DEVWORKFLOW_FLAG: 'dwf',
    DEVWORKFLOW_HEALTH: 'dwhl',
    DEVWORKFLOW_RUNBOOK: 'dwrn',
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

/* ----------------------------- Imports ----------------------------- */

import { buildMigrationAgentReport } from './migrationAgent.js';
import { buildDocDriftReport } from './docDrift.js';
import { buildContextualDebugReport } from './contextualDebug.js';
import { buildHotspotProfilerReport } from './hotspotProfiler.js';
import { buildBranchStrategyReport } from './branchStrategy.js';
import { buildRollbackPredictorReport } from './rollbackPredictor.js';
import { buildHotfixFastTrackReport } from './hotfix.js';
import { buildFeatureFlagOrchestratorReport } from './featureFlagOrchestrator.js';
import { buildHealthDashboardReport } from './healthDashboard.js';
import { buildErrorRecoveryPlaybook } from './errorRunbook.js';
import { developerWorkflowService, ALL_KINDS } from './service.js';

function files(entries: { id: string; path: string; mimeType: string; content: string }[]) {
  mocks.mockListFiles.mockResolvedValue(
    entries.map((e) => ({ id: e.id, path: e.path, mimeType: e.mimeType })),
  );
  const contentById = new Map(entries.map((e) => [e.id, e.content]));
  mocks.mockGetFileContent.mockImplementation((_uid: string, _pid: string, fileId: string) => {
    const e = entries.find((x) => x.id === fileId);
    const c = contentById.get(fileId) ?? '';
    return { buffer: Buffer.from(c, 'utf8'), mimeType: e?.mimeType ?? 'text/plain', name: e?.path ?? '' };
  });
}

beforeEach(() => {
  mocks.idSeed.n = 0;
  mocks.newId.mockImplementation((p: string) => `${p}-${++mocks.idSeed.n}`);
});

/* ----------------------------- #29 Workspace Migration Agent ----------------------------- */

describe('WORKSPACE MIGRATION AGENT (#29)', () => {
  it('detects a stack and emits migration steps with risk', async () => {
    files([{ id: 'f1', path: 'package.json', mimeType: 'application/json', content: '{ "name": "x" }' }]);
    const report = await buildMigrationAgentReport('usr-1', 'prj-1');
    expect(report.state).toBe('HEURISTIC');
    expect(report.fromStack).toBe('Node.js');
    expect(report.steps.length).toBeGreaterThan(0);
    expect(report.steps.some((s) => s.path === 'package.json')).toBe(true);
    expect(report.totalSteps).toBe(report.steps.length);
  });

  it('is advisory — never rewrites or removes files', async () => {
    files([
      { id: 'f1', path: 'package.json', mimeType: 'application/json', content: '{}' },
      { id: 'f2', path: 'src/app.test.ts', mimeType: 'text/typescript', content: 'export default 1;' },
    ]);
    const report = await buildMigrationAgentReport('usr-1', 'prj-1');
    for (const s of report.steps) {
      expect(['MOVE', 'RENAME', 'REWRITE', 'VERIFY', 'MANUAL', 'REMOVE']).toContain(s.action);
    }
  });
});

/* ----------------------------- #34 Documentation Drift Detector ----------------------------- */

describe('DOCUMENTATION DRIFT DETECTOR (#34)', () => {
  it('flags a documented symbol that is not defined in source', async () => {
    files([
      { id: 'f1', path: 'README.md', mimeType: 'text/markdown', content: 'Use the `loadProfile` helper to fetch a profile.' },
      { id: 'f2', path: 'src/index.ts', mimeType: 'text/typescript', content: 'export const GREETING = "hi";' },
    ]);
    const report = await buildDocDriftReport('usr-1', 'prj-1');
    const symbol = report.findings.find((f) => f.kind === 'SYMBOL_NOT_FOUND');
    expect(symbol).toBeDefined();
    expect(symbol?.referenced).toBe('loadProfile');
    expect(report.state).toBe('HEURISTIC');
    expect(report.totalFindings).toBeGreaterThan(0);
  });

  it('does not flag symbols that are defined in source', async () => {
    files([
      { id: 'f1', path: 'README.md', mimeType: 'text/markdown', content: 'Use the `loadProfile` helper.' },
      { id: 'f2', path: 'src/index.ts', mimeType: 'text/typescript', content: 'export function loadProfile(id: string) { return id; }' },
    ]);
    const report = await buildDocDriftReport('usr-1', 'prj-1');
    const symbol = report.findings.find((f) => f.kind === 'SYMBOL_NOT_FOUND' && f.referenced === 'loadProfile');
    expect(symbol).toBeUndefined();
  });
});

/* ----------------------------- #41 Contextual Debugging ----------------------------- */

describe('CONTEXTUAL DEBUGGING (#41)', () => {
  it('surfaces relevant source clues for a matching error token', async () => {
    files([{ id: 'f1', path: 'src/auth.ts', mimeType: 'text/typescript', content: 'export function login() { throw new Error("token expired"); }' }]);
    const report = await buildContextualDebugReport('usr-1', 'prj-1', 'Error: token expired');
    expect(report.state).toBe('HEURISTIC');
    expect(report.totalClues).toBeGreaterThan(0);
    const clue = report.clues.find((c) => c.filePath === 'src/auth.ts');
    expect(clue).toBeDefined();
    expect(clue?.hypothesizedCause).toContain('explicit error/throw');
  });

  it('falls back to a no-match clue when nothing is relevant', async () => {
    files([{ id: 'f1', path: 'src/index.ts', mimeType: 'text/typescript', content: 'export const a = 1;' }]);
    const report = await buildContextualDebugReport('usr-1', 'prj-1', 'zzzzz_nonexistent_xyz');
    expect(report.matchType).toBe('NONE');
    expect(report.clues[0].filePath).toBe('');
  });
});

/* ----------------------------- #44 Hotspot Profiler ----------------------------- */

describe('HOTSPOT PROFILER (#44)', () => {
  it('ranks hotspots from the performance oracle and labels them ESTIMATED', async () => {
    mocks.generatePerformanceReport.mockResolvedValue({
      projectId: 'prj-1',
      slowFunctions: [
        { filePath: 'src/hot.ts', functionName: 'render', estimatedDurationMs: 900, source: 'ESTIMATED', reason: 'heavy loop', optimizationHints: [] },
      ],
      nPlusOnes: [],
      dbQueryRisks: [],
      apiLatencyRisks: [],
      complexity: { projectId: 'prj-1', functions: [], summary: { totalFunctions: 1, avgComplexity: 1, maxComplexity: 1, highComplexityCount: 0, estimatedRefactorHours: 0 } },
      cachingOpportunities: [],
      repeatedComputations: [],
      summary: { overallScore: 50, criticalIssues: 0, highIssues: 1, mediumIssues: 1, estimatedOptimizationHours: 2, topRecommendations: [] },
    });
    const report = await buildHotspotProfilerReport('usr-1', 'prj-1');
    expect(report.state).toBe('HEURISTIC');
    expect(report.hotspots.length).toBe(1);
    expect(report.hotspots[0].isHotPath).toBe(true);
    expect(report.hotspots[0].source).toBe('ESTIMATED');
    expect(report.limitations.some((l) => l.includes('ESTIMATED'))).toBe(true);
  });
});

/* ----------------------------- #31 Branch Strategy Optimizer ----------------------------- */

describe('BRANCH STRATEGY OPTIMIZER (#31)', () => {
  it('recommends a branching strategy and honest top recommendation', async () => {
    files([{ id: 'f1', path: 'README.md', mimeType: 'text/markdown', content: '# x' }]);
    const report = await buildBranchStrategyReport('usr-1', 'prj-1');
    expect(report.state).toBe('HEURISTIC');
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.topRecommendation).toBeTruthy();
    expect(report.limitations.some((l) => l.includes('no branches are created'))).toBe(true);
  });
});

/* ----------------------------- #32 Rollback Predictor ----------------------------- */

describe('ROLLBACK PREDICTOR (#32)', () => {
  it('raises risk when migrations are present and no commit pair is given', async () => {
    files([{ id: 'f1', path: 'database/migrations/0001_init.sql', mimeType: 'text/plain', content: 'CREATE TABLE t(id int);' }]);
    const report = await buildRollbackPredictorReport('usr-1', 'prj-1');
    expect(report.state).toBe('HEURISTIC');
    expect(report.risk).toBe('HIGH');
    expect(report.readinessScore).toBeLessThan(80);
    expect(report.signals.some((s) => s.label.includes('migration'))).toBe(true);
  });

  it('lowers risk when a distinct commit pair is provided', async () => {
    files([{ id: 'f1', path: 'README.md', mimeType: 'text/markdown', content: '# x' }]);
    const report = await buildRollbackPredictorReport('usr-1', 'prj-1', 'abc123', 'def456');
    expect(report.readinessScore).toBeGreaterThan(50);
  });
});

/* ----------------------------- #33 Hotfix Fast-Track ----------------------------- */

describe('HOTFIX FAST-TRACK (#33)', () => {
  it('produces a CRITICAL hotfix plan with containment and rollback steps', async () => {
    files([{ id: 'f1', path: 'src/api.ts', mimeType: 'text/typescript', content: 'export function apiHandler() { throw new Error("api"); }' }]);
    const report = await buildHotfixFastTrackReport('usr-1', 'prj-1', 'CRITICAL outage in billing API');
    expect(report.state).toBe('HEURISTIC');
    expect(report.severity).toBe('CRITICAL');
    expect(report.steps.length).toBeGreaterThanOrEqual(5);
    expect(report.steps.some((s) => s.action === 'Containment')).toBe(true);
    expect(report.steps.some((s) => s.action === 'Rollback plan ready')).toBe(true);
    expect(report.impactedArea).toBe('/api.ts');
  });
});

/* ----------------------------- #35 Feature Flag Orchestrator ----------------------------- */

describe('FEATURE FLAG ORCHESTRATOR (#35)', () => {
  it('invents no flags — inventories flag-style conditionals actually in source', async () => {
    files([{ id: 'f1', path: 'src/app.ts', mimeType: 'text/typescript', content: 'if (process.env.NEW_DASHBOARD) { render(); } else { legacy(); }' }]);
    const report = await buildFeatureFlagOrchestratorReport('usr-1', 'prj-1');
    expect(report.state).toBe('HEURISTIC');
    const flag = report.flagsInventory.find((f) => f.name === 'NEW_DASHBOARD');
    expect(flag).toBeDefined();
    expect(flag?.lifecycle).toBeDefined();
    expect(['PROPOSED', 'ACTIVE', 'RELEASED', 'STALE']).toContain(flag?.lifecycle);
  });

  it('reports zero flags when none are found', async () => {
    files([{ id: 'f1', path: 'README.md', mimeType: 'text/markdown', content: '# readme' }]);
    const report = await buildFeatureFlagOrchestratorReport('usr-1', 'prj-1');
    expect(report.totalFlags).toBe(0);
  });
});

/* ----------------------------- #43 Workspace Health Dashboard ----------------------------- */

describe('WORKSPACE HEALTH DASHBOARD (#43)', () => {
  it('scores health honestly from static signals without claiming runtime proof', async () => {
    files([
      { id: 'f1', path: 'package.json', mimeType: 'application/json', content: '{}' },
      { id: 'f2', path: 'src/a.test.ts', mimeType: 'text/typescript', content: 'it("works", () => {});' },
      { id: 'f3', path: '.eslintrc', mimeType: 'application/json', content: '{}' },
      { id: 'f4', path: 'README.md', mimeType: 'text/markdown', content: '# x' },
    ]);
    const report = await buildHealthDashboardReport('usr-1', 'prj-1');
    expect(report.score).toBeGreaterThan(50);
    expect(['HEALTHY', 'ATTENTION', 'CRITICAL']).toContain(report.overallStatus);
    expect(report.facets.some((f) => f.facet === 'Tests' && f.status === 'PASS')).toBe(true);
    expect(report.limitations.some((l) => l.includes('does NOT run'))).toBe(true);
  });
});

/* ----------------------------- #45 Error Recovery Playbook ----------------------------- */

describe('ERROR RECOVERY PLAYBOOK (#45)', () => {
  it('matches a deployment failure and emits a recovery playbook', async () => {
    const report = await buildErrorRecoveryPlaybook('usr-1', 'prj-1', 'deployment failed health check 503');
    expect(report.state).toBe('HEURISTIC');
    expect(report.matchedPattern).toBe('deployment_failure');
    expect(report.steps.some((s) => s.category === 'ROLLBACK')).toBe(true);
    expect(report.steps.some((s) => s.category === 'VERIFY')).toBe(true);
    expect(report.limitations.some((l) => l.includes('does not execute'))).toBe(true);
  });

  it('returns a generic playbook for unrecognized errors', async () => {
    const report = await buildErrorRecoveryPlaybook('usr-1', 'prj-1', 'something unusual happened');
    expect(report.matchedPattern).toBeNull();
    expect(report.steps.length).toBeGreaterThanOrEqual(4);
  });
});

/* ----------------------------- Capability report ----------------------------- */

describe('CAPABILITY REPORT', () => {
  it('reports exactly ten available, deterministic capabilities', () => {
    const caps = developerWorkflowService.getCapabilities();
    expect(ALL_KINDS).toHaveLength(10);
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