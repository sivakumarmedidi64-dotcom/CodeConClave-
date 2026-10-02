/**
 * CodeConClave — V4E Deployment Wizard Tests.
 * Tests for: Discovery, Readiness, Plan, Secrets, Pre-Deploy,
 * Strategy, Approval, Post-Deploy, Rollback, Report.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: any[];
    rowCount: number;
    queryOverrides: { pattern: RegExp; rows: any[]; rowCount?: number }[];
    validProjectId: string;
  } = { calls: [], rows: [], rowCount: 1, queryOverrides: [], validProjectId: 'proj-1' };

  const resolveRows = (text: string, params?: unknown[]): { rows: any[]; rowCount: number } => {
    if (/FROM projects/i.test(text)) {
      const projectIdParam = params?.find(p => typeof p === 'string' && (p as string).startsWith('proj-')) || params?.[0];
      if (projectIdParam === state.validProjectId) {
        return { rows: [{ id: state.validProjectId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
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
    return resolveRows(text, params);
  };
  const queryOne = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    return resolveRows(text, params).rows[0] ?? null;
  };
  const queryMany = async (text: string, params?: unknown[]) => {
    state.calls.push({ text, params: params ?? [] });
    return resolveRows(text, params).rows;
  };
  const withTenant = async (_tid: string, fn: (q: unknown) => any) => fn({ query, queryOne, queryMany });
  const withSystem = async (fn: (q: unknown) => any) => fn({ query, queryOne, queryMany });
  return { state, pool: { query }, queryOne, queryMany, withTenant, withSystem };
});

const recordAudit = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../shared/db.js', () => db);
vi.mock('../../shared/errors.js', () => ({
  AppError: {
    notFound: (msg: string) => Object.assign(new Error(msg), { status: 404, errorCode: 'not_found' }),
    badRequest: (code: string, msg: string) => Object.assign(new Error(msg), { status: 400, errorCode: code }),
  },
}));
vi.mock('../audit/service.js', () => ({ recordAudit }));
vi.mock('../../shared/ids.js', () => ({
  newId: vi.fn(() => 'dw_test_001'),
  PREFIX: {
    DEPLOY_PROFILE: 'dpf',
    DEPLOY_READINESS: 'drd',
    DEPLOY_PLAN: 'dpl',
    DEPLOY_STEP: 'dst',
    DEPLOY_SECRETS: 'dsc',
    DEPLOY_CHECK: 'dck',
    DEPLOY_STRATEGY: 'dsg',
    DEPLOY_APPROVAL: 'dap',
    DEPLOY_VERIFY: 'dvf',
    DEPLOY_ROLLBACK: 'drb',
    DEPLOY_REPORT: 'drp',
  },
}));

// ─── DISCOVERY ─────────────────────────────────────────────────
describe('DEPLOYMENT DISCOVERY — project analysis', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    db.state.validProjectId = 'proj-1';
    recordAudit.mockClear();
  });

  it('discovers a full-stack Node.js project', async () => {
    const { discoverDeployment } = await import('./deploymentDiscovery.js');
    const result = await discoverDeployment('user-1', 'proj-1', {
      projectId: 'proj-1',
      fileList: [
        { path: 'package.json', size: 1000, isDirectory: false },
        { path: 'src/index.ts', size: 500, isDirectory: false },
        { path: '.env', size: 200, isDirectory: false },
      ],
      packageJson: {
        dependencies: { express: '^4.18.0', react: '^18.0.0', pg: '^8.0.0' },
        devDependencies: { typescript: '^5.0.0' },
        scripts: { build: 'tsc && vite build', start: 'node dist/index.js' },
      },
      envContent: 'DATABASE_URL=postgres://localhost/test\nPORT=3000\n',
    });

    expect(result).toHaveProperty('id');
    expect(result.projectId).toBe('proj-1');
    expect(result.language).toBe('typescript');
    expect(result.runtime).toBe('node');
    expect(result.packageManager).toBe('npm');
    expect(result.components.length).toBeGreaterThanOrEqual(2);
    expect(result.envFile.present).toBe(true);
    expect(result.envFile.variables.length).toBeGreaterThan(0);
    expect(recordAudit).toHaveBeenCalled();
  });

  it('detects pnpm monorepo', async () => {
    const { discoverDeployment } = await import('./deploymentDiscovery.js');
    const result = await discoverDeployment('user-1', 'proj-1', {
      projectId: 'proj-1',
      fileList: [
        { path: 'pnpm-lock.yaml', size: 100, isDirectory: false },
        { path: 'pnpm-workspace.yaml', size: 100, isDirectory: false },
        { path: 'backend/package.json', size: 500, isDirectory: false },
        { path: 'frontend/package.json', size: 500, isDirectory: false },
      ],
    });

    expect(result.packageManager).toBe('pnpm');
    expect(result.metadata.hasMonorepo).toBe(true);
  });

  it('detects Docker configuration', async () => {
    const { discoverDeployment } = await import('./deploymentDiscovery.js');
    const result = await discoverDeployment('user-1', 'proj-1', {
      projectId: 'proj-1',
      fileList: [
        { path: 'Dockerfile', size: 200, isDirectory: false },
        { path: 'docker-compose.yml', size: 300, isDirectory: false },
      ],
      dockerContent: 'FROM node:18-alpine\nRUN npm install\nCMD ["node", "dist/index.js"]',
      composeContent: 'services:\n  app:\n    build: .\n  redis:\n    image: redis:7',
    });

    expect(result.dockerFiles.hasDockerfile).toBe(true);
    expect(result.dockerFiles.hasCompose).toBe(true);
    expect(result.dockerFiles.multiStage).toBe(false);
    expect(result.deploymentConfigs.docker).toBe(true);
  });

  it('detects Railway and Vercel configs', async () => {
    const { discoverDeployment } = await import('./deploymentDiscovery.js');
    const result = await discoverDeployment('user-1', 'proj-1', {
      projectId: 'proj-1',
      fileList: [
        { path: 'railway.toml', size: 100, isDirectory: false },
        { path: 'frontend/vercel.json', size: 100, isDirectory: false },
      ],
    });

    expect(result.deploymentConfigs.railway).toBe(true);
    expect(result.deploymentConfigs.vercel).toBe(true);
  });

  it('detects AI, payment, and email deps', async () => {
    const { discoverDeployment } = await import('./deploymentDiscovery.js');
    const result = await discoverDeployment('user-1', 'proj-1', {
      projectId: 'proj-1',
      packageJson: {
        dependencies: {
          openai: '^4.0.0',
          stripe: '^14.0.0',
          resend: '^2.0.0',
        },
      },
    });

    const types = result.components.map(c => c.type);
    expect(types).toContain('AI_SERVICE');
    expect(types).toContain('PAYMENT');
    expect(types).toContain('EMAIL');
  });

  it('throws for invalid project', async () => {
    db.state.validProjectId = 'proj-1';
    const { discoverDeployment } = await import('./deploymentDiscovery.js');
    await expect(discoverDeployment('user-1', 'bad-project', { projectId: 'bad-project' })).rejects.toThrow();
  });
});

// ─── READINESS ─────────────────────────────────────────────────
describe('DEPLOYMENT READINESS — status checks', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('returns READY or PARTIAL for complete setup', async () => {
    const { checkDeploymentReadiness } = await import('./deploymentReadiness.js');
    const result = await checkDeploymentReadiness('user-1', 'proj-1', {
      profile: {
        id: 'dpf-1',
        projectId: 'proj-1',
        discoveredAt: new Date(),
        branch: 'main',
        packageManager: 'npm',
        runtime: 'node',
        language: 'typescript',
        components: [
          { type: 'BACKEND', name: 'backend', path: '.', framework: 'express', buildCommand: 'npm run build', startCommand: 'node dist/index.js', port: 3000, healthEndpoint: '/health', hasWebSockets: false, hasSSE: false, envVars: ['DATABASE_URL', 'SESSION_SECRET', 'JWT_SECRET'], dependencies: [] },
          { type: 'DATABASE', name: 'database', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['DATABASE_URL'], dependencies: [] },
          { type: 'REDIS', name: 'redis', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['REDIS_URL'], dependencies: [] },
          { type: 'STORAGE', name: 'storage', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['STORAGE_BUCKET'], dependencies: [] },
          { type: 'EMAIL', name: 'email', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['RESEND_API_KEY'], dependencies: [] },
        ],
        envFile: {
          present: true,
          files: ['.env'],
          variables: [
            { name: 'DATABASE_URL', hasValue: true, isSecret: false, source: '.env' },
            { name: 'SESSION_SECRET', hasValue: true, isSecret: true, source: '.env' },
            { name: 'JWT_SECRET', hasValue: true, isSecret: true, source: '.env' },
            { name: 'REDIS_URL', hasValue: true, isSecret: false, source: '.env' },
            { name: 'STORAGE_BUCKET', hasValue: true, isSecret: false, source: '.env' },
            { name: 'RESEND_API_KEY', hasValue: true, isSecret: true, source: '.env' },
          ],
          hasSecrets: true,
          missingRequired: [],
        },
        dockerFiles: { hasDockerfile: false, hasCompose: false, composeServices: [], multiStage: false },
        cicdFiles: [],
        deploymentConfigs: { railway: true, render: false, vercel: false, netlify: false, fly: false, cloudflare: false, kubernetes: false, docker: false },
        totalEnvVars: 6,
        requiredEnvVars: ['DATABASE_URL', 'SESSION_SECRET', 'JWT_SECRET'],
        optionalEnvVars: ['REDIS_URL', 'STORAGE_BUCKET', 'RESEND_API_KEY'],
        healthChecks: [{ component: 'backend', type: 'HTTP', endpoint: '/health', timeoutMs: 5000 }],
        metadata: {},
      } as any,
    });

    expect(['READY', 'PARTIAL']).toContain(result.overallStatus);
    expect(result.score).toBeGreaterThan(0);
    expect(result.summary.ready).toBeGreaterThan(0);
  });

  it('returns NOT_READY when blocked', async () => {
    const { checkDeploymentReadiness } = await import('./deploymentReadiness.js');
    const result = await checkDeploymentReadiness('user-1', 'proj-1', {
      profile: {
        id: 'dpf-1',
        projectId: 'proj-1',
        discoveredAt: new Date(),
        branch: 'main',
        packageManager: 'npm',
        runtime: 'node',
        language: 'typescript',
        components: [
          { type: 'DATABASE', name: 'database', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['DATABASE_URL'], dependencies: [] },
          { type: 'BACKEND', name: 'backend', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['DATABASE_URL'], dependencies: [] },
        ],
        envFile: { present: true, files: ['.env'], variables: [], hasSecrets: false, missingRequired: ['DATABASE_URL'] },
        dockerFiles: { hasDockerfile: false, hasCompose: false, composeServices: [], multiStage: false },
        cicdFiles: [],
        deploymentConfigs: { railway: false, render: false, vercel: false, netlify: false, fly: false, cloudflare: false, kubernetes: false, docker: false },
        totalEnvVars: 1,
        requiredEnvVars: ['DATABASE_URL'],
        optionalEnvVars: [],
        healthChecks: [],
        metadata: {},
      } as any,
    });

    expect(result.overallStatus).toBe('NOT_READY');
    expect(result.summary.blocked).toBeGreaterThan(0);
  });

  it('marks payment as DANGEROUS', async () => {
    const { checkDeploymentReadiness } = await import('./deploymentReadiness.js');
    const result = await checkDeploymentReadiness('user-1', 'proj-1', {
      profile: {
        id: 'dpf-1',
        projectId: 'proj-1',
        discoveredAt: new Date(),
        branch: 'main',
        packageManager: 'npm',
        runtime: 'node',
        language: 'typescript',
        components: [
          { type: 'PAYMENT', name: 'payment', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['STRIPE_SECRET_KEY'], dependencies: [] },
          { type: 'BACKEND', name: 'backend', path: '.', hasWebSockets: false, hasSSE: false, envVars: [], dependencies: [] },
        ],
        envFile: { present: true, files: [], variables: [{ name: 'STRIPE_SECRET_KEY', hasValue: true, isSecret: true, source: '.env' }], hasSecrets: true, missingRequired: [] },
        dockerFiles: { hasDockerfile: false, hasCompose: false, composeServices: [], multiStage: false },
        cicdFiles: [],
        deploymentConfigs: { railway: false, render: false, vercel: false, netlify: false, fly: false, cloudflare: false, kubernetes: false, docker: false },
        totalEnvVars: 1,
        requiredEnvVars: [],
        optionalEnvVars: [],
        healthChecks: [],
        metadata: {},
      } as any,
    });

    const payment = result.items.find(i => i.category === 'payment');
    expect(payment?.status).toBe('DANGEROUS');
  });
});

// ─── PLAN ──────────────────────────────────────────────────────
describe('DEPLOYMENT PLAN — step generation', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('generates a plan with steps', async () => {
    const { generateDeploymentPlan } = await import('./deploymentPlan.js');
    const result = await generateDeploymentPlan('user-1', 'proj-1', {
      profile: {
        id: 'dpf-1', projectId: 'proj-1', discoveredAt: new Date(), branch: 'main',
        packageManager: 'npm', runtime: 'node', language: 'typescript',
        components: [
          { type: 'BACKEND', name: 'backend', path: '.', framework: 'express', buildCommand: 'npm run build', startCommand: 'node dist/index.js', port: 3000, healthEndpoint: '/health', hasWebSockets: false, hasSSE: false, envVars: [], dependencies: [] },
          { type: 'DATABASE', name: 'database', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['DATABASE_URL'], dependencies: [] },
        ],
        envFile: { present: true, files: [], variables: [{ name: 'DATABASE_URL', hasValue: true, isSecret: false, source: '.env' }], hasSecrets: false, missingRequired: [] },
        dockerFiles: { hasDockerfile: false, hasCompose: false, composeServices: [], multiStage: false },
        cicdFiles: [],
        deploymentConfigs: { railway: true, render: false, vercel: false, netlify: false, fly: false, cloudflare: false, kubernetes: false, docker: false },
        totalEnvVars: 1, requiredEnvVars: [], optionalEnvVars: [], healthChecks: [{ component: 'backend', type: 'HTTP', endpoint: '/health', timeoutMs: 5000 }], metadata: {},
      } as any,
      readiness: {
        id: 'drd-1', profileId: 'dpf-1', projectId: 'proj-1', checkedAt: new Date(),
        overallStatus: 'READY', score: 100,
        items: [{ category: 'database', status: 'READY', label: 'Database', detail: 'Database ready' }],
        summary: { ready: 1, missing: 0, blocked: 0, optional: 0, dangerous: 0 },
        estimatedDeployTime: '5-15 minutes',
      } as any,
    });

    expect(result).toHaveProperty('id');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.estimatedTotalDurationSec).toBeGreaterThan(0);
    expect(result.rollbackPlan).toBeDefined();
  });
});

// ─── SECRETS ───────────────────────────────────────────────────
describe('SECRET HANDLING — inventory and validation', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('creates a secret inventory', async () => {
    const { createSecretInventory } = await import('./secretHandling.js');
    const result = await createSecretInventory('user-1', 'proj-1', {
      DATABASE_URL: 'postgres://localhost/db',
      SESSION_SECRET: 'a'.repeat(64),
    }, ['DATABASE_URL', 'SESSION_SECRET', 'OPENAI_API_KEY']);

    expect(result.secrets.length).toBe(3);
    expect(result.summary.configured).toBe(2);
    expect(result.totalRequired + result.totalOptional).toBe(3);
  });

  it('validates secrets correctly', async () => {
    const { validateSecret } = await import('./secretHandling.js');

    const validResult = validateSecret({ variableName: 'DATABASE_URL', value: 'postgres://host/db', targetService: 'postgresql' });
    expect(validResult.valid).toBe(true);

    const invalidResult = validateSecret({ variableName: 'SESSION_SECRET', value: 'short', targetService: 'backend' });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.issues.length).toBeGreaterThan(0);
  });

  it('masks secrets properly', async () => {
    const { maskSecret } = await import('./secretHandling.js');
    expect(maskSecret('sk_live_abcdefgh1234567890')).toContain('****');
    expect(maskSecret('short')).toBe('****');
  });
});

// ─── PRE-DEPLOY ────────────────────────────────────────────────
describe('PRE-DEPLOY CHECKS — verification', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('runs all pre-deploy checks', async () => {
    const { runPreDeployChecks } = await import('./preDeployCheck.js');
    const result = await runPreDeployChecks('user-1', 'proj-1', { projectId: 'proj-1' });

    expect(result).toHaveProperty('id');
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.summary.total).toBe(result.checks.length);
    expect(typeof result.passed).toBe('boolean');
  });

  it('can skip specific checks', async () => {
    const { runPreDeployChecks } = await import('./preDeployCheck.js');
    const result = await runPreDeployChecks('user-1', 'proj-1', {
      projectId: 'proj-1',
      runTests: false,
      runBuild: false,
    });

    const skipped = result.checks.filter(c => c.status === 'SKIP');
    expect(skipped.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── STRATEGY ──────────────────────────────────────────────────
describe('DEPLOYMENT STRATEGY — selection and comparison', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('compares available strategies', async () => {
    const { compareStrategies } = await import('./deploymentStrategy.js');
    const result = compareStrategies(
      { railway: true, render: false, vercel: false, netlify: false, fly: false, cloudflare: false, kubernetes: false, docker: false },
      true, true
    );

    expect(result.availableStrategies.length).toBe(4);
    expect(result.recommended).toBeDefined();
    expect(result.reason).toBeTruthy();
  });

  it('selects a strategy', async () => {
    const { selectStrategy } = await import('./deploymentStrategy.js');
    const result = await selectStrategy('user-1', 'proj-1', {
      projectId: 'proj-1',
      strategy: 'standard',
      deploymentConfigs: { railway: true },
    });

    expect(result.strategy).toBe('standard');
    expect(result.config.supported).toBe(true);
  });

  it('gets strategy info', async () => {
    const { getStrategyInfo } = await import('./deploymentStrategy.js');
    const info = getStrategyInfo('canary');
    expect(info.name).toBe('Canary Deployment');
    expect(info.supported).toBe(false);
  });

  it('checks strategy support', async () => {
    const { isStrategySupported } = await import('./deploymentStrategy.js');
    expect(isStrategySupported('preview', 'vercel')).toBe(true);
    expect(isStrategySupported('canary', 'railway')).toBe(false);
  });
});

// ─── APPROVAL ──────────────────────────────────────────────────
describe('HUMAN APPROVAL — gate system', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('requests approval', async () => {
    const { requestApproval } = await import('./humanApproval.js');
    const result = await requestApproval('user-1', {
      projectId: 'proj-1',
      type: 'PRODUCTION_DEPLOYMENT',
      requestedBy: 'user-1',
      message: 'Deploy v2.0 to production',
      details: { version: '2.0', commit: 'abc123' },
    });

    expect(result.status).toBe('PENDING');
    expect(result.riskLevel).toBe('HIGH');
  });

  it('decides an approval', async () => {
    const requestId = 'dap_test_001';
    db.state.queryOverrides = [
      { pattern: /FROM deployment_approvals/i, rows: [{ id: requestId, type: 'PRODUCTION_DEPLOYMENT', status: 'PENDING', requested_by: 'user-1', message: 'Deploy', details: '{}', risk_level: 'HIGH', requested_at: new Date(), expires_at: new Date(Date.now() + 3600000) }] },
    ];

    const { decideApproval } = await import('./humanApproval.js');
    const result = await decideApproval('user-1', 'proj-1', requestId, {
      decision: 'APPROVED',
      decidedBy: 'admin-1',
      comment: 'Looks good',
    });

    expect(result.status).toBe('APPROVED');
    expect(result.approvedBy).toBe('admin-1');
  });

  it('checks if approval is required', async () => {
    const { requiresApproval } = await import('./humanApproval.js');
    expect(requiresApproval('DEPLOY', true)).toBe(true);
    expect(requiresApproval('DEPLOY', false)).toBe(false);
    expect(requiresApproval('BUILD', true)).toBe(false);
  });
});

// ─── POST-DEPLOY ───────────────────────────────────────────────
describe('POST-DEPLOY VERIFICATION', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('runs verification checks without a live URL', async () => {
    const { runPostDeployVerification } = await import('./postDeployVerify.js');
    const result = await runPostDeployVerification('user-1', {
      projectId: 'proj-1',
      deploymentId: 'dep-1',
    });

    expect(result).toHaveProperty('id');
    expect(result.checks.length).toBeGreaterThan(0);
    expect(['HEALTHY', 'DEGRADED', 'FAILED']).toContain(result.overallStatus);
  });

  it('skips checks when components not present', async () => {
    const { runPostDeployVerification } = await import('./postDeployVerify.js');
    const result = await runPostDeployVerification('user-1', {
      projectId: 'proj-1',
      deploymentId: 'dep-1',
      hasWorker: false,
      hasQueue: false,
      hasAi: false,
    });

    const skipped = result.checks.filter(c => c.status === 'SKIP');
    expect(skipped.length).toBeGreaterThan(0);
  });
});

// ─── ROLLBACK ──────────────────────────────────────────────────
describe('ROLLBACK PLANNER', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('prepares a rollback plan', async () => {
    const { prepareRollbackPlan } = await import('./rollbackPlanner.js');
    const result = await prepareRollbackPlan('user-1', {
      projectId: 'proj-1',
      plan: {
        id: 'dpl-1',
        profileId: 'dpf-1',
        readinessId: 'drd-1',
        projectId: 'proj-1',
        createdAt: new Date(),
        strategy: 'standard',
        steps: [
          { id: 's1', order: 1, service: 'backend', action: 'DEPLOY', label: 'Deploy Backend', description: 'Deploy', requiredCredentials: [], safetyLevel: 'REQUIRES_APPROVAL', estimatedDurationSec: 120, rollbackAvailable: true, rollbackAction: 'DEPLOY', dependsOn: [], metadata: {} },
          { id: 's2', order: 2, service: 'database', action: 'RUN_MIGRATION', label: 'Run Migrations', description: 'Migrate', requiredCredentials: ['DATABASE_URL'], safetyLevel: 'REQUIRES_APPROVAL', estimatedDurationSec: 60, rollbackAvailable: true, rollbackAction: 'RUN_MIGRATION', dependsOn: [], metadata: {} },
        ],
        estimatedTotalDurationSec: 180,
        requiredApprovals: ['backend/DEPLOY'],
        rollbackPlan: { available: true, steps: [], backupRequired: false, estimatedRollbackTimeSec: 0 },
        metadata: {},
      } as any,
      currentCommit: 'abc123',
      previousCommit: 'def456',
    });

    expect(result).toHaveProperty('id');
    expect(result.available).toBe(true);
    expect(result.databaseBackupRequired).toBe(true);
    expect(result.currentCommit).toBe('abc123');
  });
});

// ─── REPORT ────────────────────────────────────────────────────
describe('DEPLOYMENT REPORT — generation', () => {
  beforeEach(() => {
    db.state.calls = [];
    db.state.rows = [];
    db.state.rowCount = 1;
    db.state.queryOverrides = [];
    recordAudit.mockClear();
  });

  it('generates a markdown report', async () => {
    const { generateDeploymentReport } = await import('./deploymentReport.js');
    const result = await generateDeploymentReport('user-1', {
      projectId: 'proj-1',
      profile: {
        id: 'dpf-1', projectId: 'proj-1', discoveredAt: new Date(), branch: 'main',
        packageManager: 'npm', runtime: 'node', language: 'typescript',
        components: [{ type: 'BACKEND', name: 'backend', path: '.', hasWebSockets: false, hasSSE: false, envVars: ['DATABASE_URL'], dependencies: [] }],
        envFile: { present: true, files: [], variables: [], hasSecrets: false, missingRequired: [] },
        dockerFiles: { hasDockerfile: false, hasCompose: false, composeServices: [], multiStage: false },
        cicdFiles: [],
        deploymentConfigs: { railway: true, render: false, vercel: false, netlify: false, fly: false, cloudflare: false, kubernetes: false, docker: false },
        totalEnvVars: 1, requiredEnvVars: [], optionalEnvVars: [], healthChecks: [], metadata: {},
      } as any,
      readiness: {
        id: 'drd-1', profileId: 'dpf-1', projectId: 'proj-1', checkedAt: new Date(),
        overallStatus: 'READY', score: 100,
        items: [{ category: 'backend', status: 'READY', label: 'Backend', detail: 'Ready', targetService: 'railway' }],
        summary: { ready: 1, missing: 0, blocked: 0, optional: 0, dangerous: 0 },
        estimatedDeployTime: '5-15 minutes',
      } as any,
      plan: {
        id: 'dpl-1', profileId: 'dpf-1', readinessId: 'drd-1', projectId: 'proj-1', createdAt: new Date(),
        strategy: 'standard',
        steps: [{ id: 's1', order: 1, service: 'backend', action: 'DEPLOY', label: 'Deploy', description: 'Deploy backend', requiredCredentials: [], safetyLevel: 'REQUIRES_APPROVAL', estimatedDurationSec: 120, rollbackAvailable: true, dependsOn: [], metadata: {} }],
        estimatedTotalDurationSec: 120,
        requiredApprovals: ['backend/DEPLOY'],
        rollbackPlan: { available: true, steps: ['Rollback backend'], backupRequired: false, estimatedRollbackTimeSec: 120 },
        metadata: {},
      } as any,
      preDeploy: {
        id: 'dck-1', projectId: 'proj-1', checkedAt: new Date(),
        checks: [{ name: 'tests', status: 'PASS', severity: 'CRITICAL', message: 'Tests pass', durationMs: 100 }],
        passed: true,
        summary: { total: 1, pass: 1, fail: 0, warn: 0, skip: 0 },
        criticalFailures: [],
      } as any,
    });

    expect(result).toHaveProperty('id');
    expect(result.markdown).toContain('Deployment Wizard Report');
    expect(result.markdown).toContain('Readiness');
    expect(result.markdown).toContain('Deployment Plan');
    expect(result.markdown).toContain('Pre-Deploy Checks');
  });
});
