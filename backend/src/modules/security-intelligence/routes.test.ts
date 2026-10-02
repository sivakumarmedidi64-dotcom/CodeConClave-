/**
 * CodeConClave — V4C Security Intelligence Route Tests.
 * Tests for: Security Analysis, Vulnerability Management, Supply Chain,
 * Secret Intelligence, API Security, Security Posture routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSecurityScan = vi.hoisted(() => vi.fn());
const getVulnerabilityFindings = vi.hoisted(() => vi.fn());
const updateVulnerabilityStatus = vi.hoisted(() => vi.fn());
const listVulnerabilities = vi.hoisted(() => vi.fn());
const updateVulnerability = vi.hoisted(() => vi.fn());
const acknowledgeVulnerability = vi.hoisted(() => vi.fn());
const markFixed = vi.hoisted(() => vi.fn());
const markRegression = vi.hoisted(() => vi.fn());
const getVulnerabilityHistory = vi.hoisted(() => vi.fn());
const getVulnerabilityStats = vi.hoisted(() => vi.fn());
const createRemediationPlan = vi.hoisted(() => vi.fn());
const updateRemediationStep = vi.hoisted(() => vi.fn());
const getRemediationPlan = vi.hoisted(() => vi.fn());
const listRemediationPlans = vi.hoisted(() => vi.fn());
const scanDependencies = vi.hoisted(() => vi.fn());
const getSupplyChainScanHistory = vi.hoisted(() => vi.fn());
const getDependencyVulnerabilities = vi.hoisted(() => vi.fn());
const getLicenseReport = vi.hoisted(() => vi.fn());
const scanProjectForSecrets = vi.hoisted(() => vi.fn());
const detectExposedSecrets = vi.hoisted(() => vi.fn());
const getSecretMetadata = vi.hoisted(() => vi.fn());
const recordRotation = vi.hoisted(() => vi.fn());
const getRotationHistory = vi.hoisted(() => vi.fn());
const setRotationPolicy = vi.hoisted(() => vi.fn());
const getRotationPolicies = vi.hoisted(() => vi.fn());
const redactSecretsInContent = vi.hoisted(() => vi.fn());
const getExposureStats = vi.hoisted(() => vi.fn());
const runApiSecurityScan = vi.hoisted(() => vi.fn());
const getApiSecurityScanHistory = vi.hoisted(() => vi.fn());
const getEndpointSecurity = vi.hoisted(() => vi.fn());
const getApiSecurityConfig = vi.hoisted(() => vi.fn());
const updateApiSecurityConfig = vi.hoisted(() => vi.fn());
const assessSecurityPosture = vi.hoisted(() => vi.fn());
const getSecurityPosture = vi.hoisted(() => vi.fn());
const getPostureTrend = vi.hoisted(() => vi.fn());
const getSecurityBenchmarks = vi.hoisted(() => vi.fn());
const getFailingChecks = vi.hoisted(() => vi.fn());
const getQuickWins = vi.hoisted(() => vi.fn());
const savePostureAssessment = vi.hoisted(() => vi.fn());

vi.mock('./securityAnalysis.js', () => ({
  runSecurityScan, getVulnerabilityFindings, updateVulnerabilityStatus,
}));
vi.mock('./vulnerabilityManagement.js', () => ({
  listVulnerabilities, updateVulnerability, acknowledgeVulnerability, markFixed,
  markRegression, getVulnerabilityHistory, getVulnerabilityStats,
  createRemediationPlan, updateRemediationStep, getRemediationPlan, listRemediationPlans,
}));
vi.mock('./supplyChain.js', () => ({
  scanDependencies, getSupplyChainScanHistory, getDependencyVulnerabilities, getLicenseReport,
}));
vi.mock('./secretIntelligence.js', () => ({
  scanProjectForSecrets, detectExposedSecrets, getSecretMetadata, recordRotation,
  getRotationHistory, setRotationPolicy, getRotationPolicies, redactSecretsInContent, getExposureStats,
}));
vi.mock('./apiSecurity.js', () => ({
  runApiSecurityScan, getApiSecurityScanHistory, getEndpointSecurity,
  getApiSecurityConfig, updateApiSecurityConfig,
}));
vi.mock('./securityPosture.js', () => ({
  assessSecurityPosture, getSecurityPosture, getPostureTrend,
  getSecurityBenchmarks, getFailingChecks, getQuickWins, savePostureAssessment,
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock('../../middleware/security.js', () => ({
  asyncRoute: vi.fn((fn: Function) => (req: unknown, res: unknown, next: unknown) =>
    Promise.resolve(fn(req, res, next)).catch(next),
  ),
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

// ─── Helpers ──────────────────────────────────────────────────────
function findHandler(router: any, method: string, path: string) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route?.methods?.[method]) {
      const routeStack = layer.route.stack;
      if (routeStack.length > 0) {
        return routeStack[routeStack.length - 1].handle;
      }
      return layer.handle;
    }
  }
  throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
}

function req(overrides: Record<string, unknown> = {}): any {
  return { ctx: { user: { id: 'user-1' } }, params: {}, query: {}, body: {}, ...overrides };
}

function res(): any {
  const r: any = {};
  r.json = vi.fn().mockReturnValue(r);
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  return r;
}

// ─── SECURITY ANALYSIS ENGINE ROUTES ────────────────────────────
describe('SECURITY ANALYSIS ENGINE routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /scan runs security scan', async () => {
    runSecurityScan.mockResolvedValue({ scanId: 'ssn-1', findings: [] });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/scan');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), r, vi.fn());
    expect(runSecurityScan).toHaveBeenCalledWith('user-1', { projectId: 'proj-1' });
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /scan requires projectId (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/scan');
    const next = vi.fn();
    await h(req({ query: {} }, ), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('GET /findings returns findings', async () => {
    getVulnerabilityFindings.mockResolvedValue([{ id: 'f1', severity: 'HIGH' }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/findings');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(getVulnerabilityFindings).toHaveBeenCalledWith('user-1', 'proj-1', expect.objectContaining({ limit: 100 }));
    expect(r.json).toHaveBeenCalled();
  });

  it('PATCH /findings/:id/status requires status (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'patch', '/findings/:id/status');
    const next = vi.fn();
    await h(req({ params: { id: 'f1' }, query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('PATCH /findings/:id/status updates status', async () => {
    updateVulnerabilityStatus.mockResolvedValue({ id: 'f1', status: 'FIXED' });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'patch', '/findings/:id/status');
    const r = res();
    await h(req({ params: { id: 'f1' }, query: { projectId: 'proj-1' }, body: { status: 'FIXED' } }), r, vi.fn());
    expect(updateVulnerabilityStatus).toHaveBeenCalledWith('user-1', 'proj-1', 'f1', 'FIXED', undefined);
  });
});

// ─── VULNERABILITY MANAGEMENT ROUTES ────────────────────────────
describe('VULNERABILITY MANAGEMENT routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /vulnerabilities lists vulnerabilities', async () => {
    listVulnerabilities.mockResolvedValue({ findings: [], total: 0 });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/vulnerabilities');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(listVulnerabilities).toHaveBeenCalledWith('user-1', 'proj-1', expect.objectContaining({ limit: 50 }));
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /vulnerabilities/stats returns stats', async () => {
    getVulnerabilityStats.mockResolvedValue({ total: 10, bySeverity: {} });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/vulnerabilities/stats');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /vulnerabilities/:id/fix requires fixCommit (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/vulnerabilities/:id/fix');
    const next = vi.fn();
    await h(req({ params: { id: 'v1' }, query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /vulnerabilities/:id/fix marks as fixed', async () => {
    markFixed.mockResolvedValue({ id: 'v1', status: 'FIXED' });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/vulnerabilities/:id/fix');
    const r = res();
    await h(req({ params: { id: 'v1' }, query: { projectId: 'proj-1' }, body: { fixCommit: 'abc123' } }), r, vi.fn());
    expect(markFixed).toHaveBeenCalledWith('user-1', 'proj-1', 'v1', 'abc123');
  });

  it('POST /vulnerabilities/:id/acknowledge acknowledges finding', async () => {
    acknowledgeVulnerability.mockResolvedValue({ id: 'v1', status: 'ACKNOWLEDGED' });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/vulnerabilities/:id/acknowledge');
    const r = res();
    await h(req({ params: { id: 'v1' }, query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(acknowledgeVulnerability).toHaveBeenCalledWith('user-1', 'proj-1', 'v1');
  });

  it('POST /vulnerabilities/:id/regression marks regression', async () => {
    markRegression.mockResolvedValue({ id: 'v1', status: 'REGRESSED' });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/vulnerabilities/:id/regression');
    const r = res();
    await h(req({ params: { id: 'v1' }, query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(markRegression).toHaveBeenCalledWith('user-1', 'proj-1', 'v1');
  });

  it('GET /vulnerabilities/:id/history returns history', async () => {
    getVulnerabilityHistory.mockResolvedValue([{ field: 'status' }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/vulnerabilities/:id/history');
    const r = res();
    await h(req({ params: { id: 'v1' }, query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /vulnerabilities/:id/remediation requires fields (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/vulnerabilities/:id/remediation');
    const next = vi.fn();
    await h(req({ params: { id: 'v1' }, query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /vulnerabilities/:id/remediation creates plan (201)', async () => {
    createRemediationPlan.mockResolvedValue({ findingId: 'v1', status: 'PLANNED' });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/vulnerabilities/:id/remediation');
    const r = res();
    await h(req({
      params: { id: 'v1' }, query: { projectId: 'proj-1' },
      body: { steps: [{ description: 'Fix' }], targetDate: '2025-12-31', owner: 'user-1' },
    }), r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(201);
  });
});

// ─── SUPPLY CHAIN SECURITY ROUTES ──────────────────────────────
describe('SUPPLY CHAIN SECURITY routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /supply-chain/scan scans dependencies', async () => {
    scanDependencies.mockResolvedValue({ scanId: 'scs-1', vulnerabilities: [] });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/supply-chain/scan');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(scanDependencies).toHaveBeenCalledWith('user-1', 'proj-1');
  });

  it('GET /supply-chain/scans returns history', async () => {
    getSupplyChainScanHistory.mockResolvedValue([]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/supply-chain/scans');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /supply-chain/vulnerabilities/:name returns vulns', async () => {
    getDependencyVulnerabilities.mockResolvedValue([{ cve: 'CVE-2021-1234' }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/supply-chain/vulnerabilities/:name');
    const r = res();
    await h(req({ params: { name: 'lodash' }, query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /supply-chain/licenses returns licenses', async () => {
    getLicenseReport.mockResolvedValue([{ name: 'express', license: 'MIT' }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/supply-chain/licenses');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });
});

// ─── SECRET INTELLIGENCE ROUTES ─────────────────────────────────
describe('SECRET INTELLIGENCE routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /secrets/scan scans for secrets', async () => {
    scanProjectForSecrets.mockResolvedValue({ summary: { totalSecrets: 0 } });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/secrets/scan');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(scanProjectForSecrets).toHaveBeenCalledWith('user-1', 'proj-1');
  });

  it('GET /secrets/exposures returns exposures', async () => {
    detectExposedSecrets.mockResolvedValue([]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/secrets/exposures');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /secrets/metadata returns metadata', async () => {
    getSecretMetadata.mockResolvedValue([{ kind: 'API_KEY' }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/secrets/metadata');
    const r = res();
    await h(req({ query: { projectId: 'proj-1', kind: 'API_KEY' } }), r, vi.fn());
    expect(getSecretMetadata).toHaveBeenCalledWith('user-1', 'proj-1', 'API_KEY');
  });

  it('POST /secrets/rotate requires kind, newKind, trigger (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/secrets/rotate');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /secrets/rotate records rotation', async () => {
    recordRotation.mockResolvedValue(undefined);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/secrets/rotate');
    const r = res();
    await h(req({
      query: { projectId: 'proj-1' },
      body: { kind: 'API_KEY', newKind: 'NEW_KEY', trigger: 'MANUAL' },
    }), r, vi.fn());
    expect(recordRotation).toHaveBeenCalledWith('user-1', 'proj-1', 'API_KEY', 'NEW_KEY', 'MANUAL');
    expect(r.json).toHaveBeenCalledWith({ rotated: true });
  });

  it('POST /secrets/policies requires kind and policy (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/secrets/policies');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /secrets/redact requires content (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/secrets/redact');
    const next = vi.fn();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('POST /secrets/redact redacts content', async () => {
    redactSecretsInContent.mockResolvedValue('my *** key');
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/secrets/redact');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: { content: 'my secret key' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalledWith({ redacted: 'my *** key' });
  });

  it('GET /secrets/stats returns stats', async () => {
    getExposureStats.mockResolvedValue({ timeline: [], byKind: {} });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/secrets/stats');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });
});

// ─── API SECURITY ROUTES ────────────────────────────────────────
describe('API SECURITY routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /api/scan runs API security scan', async () => {
    runApiSecurityScan.mockResolvedValue({ scanId: 'aas-1', endpoints: [] });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/api/scan');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), r, vi.fn());
    expect(runApiSecurityScan).toHaveBeenCalledWith('user-1', 'proj-1', {});
  });

  it('GET /api/scans returns history', async () => {
    getApiSecurityScanHistory.mockResolvedValue([]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/api/scans');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /api/endpoints/:method/:path returns security', async () => {
    getEndpointSecurity.mockResolvedValue({ overallScore: 90 });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/api/endpoints/:method/:path');
    const r = res();
    await h(req({ params: { method: 'GET', path: '/api/users' }, query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(getEndpointSecurity).toHaveBeenCalledWith('user-1', 'proj-1', 'GET', '/api/users');
  });

  it('GET /api/config returns config', async () => {
    getApiSecurityConfig.mockResolvedValue({ checkAuth: true, checkCors: true });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/api/config');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('PATCH /api/config updates config', async () => {
    updateApiSecurityConfig.mockResolvedValue({ checkCors: false });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'patch', '/api/config');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: { config: { checkCors: false } } }), r, vi.fn());
    expect(updateApiSecurityConfig).toHaveBeenCalledWith('user-1', 'proj-1', { checkCors: false });
  });
});

// ─── SECURITY POSTURE ROUTES ────────────────────────────────────
describe('SECURITY POSTURE routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /posture returns security posture', async () => {
    getSecurityPosture.mockResolvedValue({ overallScore: 80, overallLevel: 'GOOD' });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/posture');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /posture/assess assesses and saves posture', async () => {
    assessSecurityPosture.mockResolvedValue({ overallScore: 75 });
    savePostureAssessment.mockResolvedValue(undefined);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/posture/assess');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' }, body: {} }), r, vi.fn());
    expect(assessSecurityPosture).toHaveBeenCalled();
    expect(savePostureAssessment).toHaveBeenCalled();
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /posture/trend/:category returns trend', async () => {
    getPostureTrend.mockResolvedValue({ trend: 'IMPROVING', dataPoints: [] });
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/posture/trend/:category');
    const r = res();
    await h(req({ params: { category: 'AUTH' }, query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(getPostureTrend).toHaveBeenCalledWith('user-1', 'proj-1', 'AUTH', 30);
  });

  it('GET /posture/benchmarks returns benchmarks', async () => {
    getSecurityBenchmarks.mockResolvedValue([{ category: 'AUTH', percentile: 90 }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/posture/benchmarks');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /posture/failing returns failing checks', async () => {
    getFailingChecks.mockResolvedValue([{ check: 'TLS', status: 'FAIL' }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/posture/failing');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('GET /posture/quick-wins returns quick wins', async () => {
    getQuickWins.mockResolvedValue([{ title: 'Enable CSP', severity: 'LOW' }]);
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'get', '/posture/quick-wins');
    const r = res();
    await h(req({ query: { projectId: 'proj-1' } }), r, vi.fn());
    expect(r.json).toHaveBeenCalled();
  });

  it('POST /scan requires projectId (400)', async () => {
    const router = (await import('./routes.js')).securityIntelligenceRoutes();
    const h = findHandler(router, 'post', '/scan');
    const next = vi.fn();
    await h(req({ query: {} }), res(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
