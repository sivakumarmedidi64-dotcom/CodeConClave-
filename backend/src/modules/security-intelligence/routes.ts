/**
 * CodeConClave — Security Intelligence Routes (V4C).
 * Security Analysis, Vulnerability Management, Supply Chain,
 * Secret Intelligence, API Security, Security Posture.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  runSecurityScan,
  getVulnerabilityFindings,
  updateVulnerabilityStatus,
} from './securityAnalysis.js';
import {
  listVulnerabilities,
  updateVulnerability,
  acknowledgeVulnerability,
  markFixed,
  markRegression,
  getVulnerabilityHistory,
  getVulnerabilityStats,
  createRemediationPlan,
  updateRemediationStep,
  getRemediationPlan,
  listRemediationPlans,
} from './vulnerabilityManagement.js';
import {
  scanDependencies,
  getSupplyChainScanHistory,
  getDependencyVulnerabilities,
  getLicenseReport,
} from './supplyChain.js';
import {
  scanProjectForSecrets,
  detectExposedSecrets,
  getSecretMetadata,
  recordRotation,
  getRotationHistory,
  setRotationPolicy,
  getRotationPolicies,
  redactSecretsInContent,
  getExposureStats,
} from './secretIntelligence.js';
import {
  runApiSecurityScan,
  getApiSecurityScanHistory,
  getEndpointSecurity,
  getApiSecurityConfig,
  updateApiSecurityConfig,
} from './apiSecurity.js';
import {
  assessSecurityPosture,
  getSecurityPosture,
  getPostureTrend,
  getSecurityBenchmarks,
  getFailingChecks,
  getQuickWins,
  savePostureAssessment,
} from './securityPosture.js';

export const securityIntelligenceRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const userId = (req: { ctx?: { user?: { id?: string } | null } }): string => {
    const id = req.ctx?.user?.id;
    if (!id) throw AppError.unauthorized('authentication_required', 'Authentication required');
    return id;
  };

  const pid = (req: { params?: Record<string, string>; query?: Record<string, any> }): string => {
    const id = req.params?.projectId ?? req.query?.projectId;
    if (!id) throw AppError.badRequest('project_required', 'projectId is required');
    return id;
  };

  const rid = (v: string | undefined): string => {
    if (!v) throw AppError.badRequest('missing_id', 'Resource id is required');
    return v;
  };

  // ============================================================ SECURITY ANALYSIS ENGINE
  router.post(
    '/scan',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const result = await runSecurityScan(userId(req), { ...options, projectId });
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/findings',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const type = req.query.type as string;
      const severity = req.query.severity as string;
      const status = req.query.status as string;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
      const findings = await getVulnerabilityFindings(userId(req), projectId, { type: type as any, severity: severity as any, status: status as any, limit });
      res.json(jsonResult({ findings }));
    }),
  );

  router.patch(
    '/findings/:id/status',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const { status, assignedTo } = req.body ?? {};
      if (!status) throw AppError.badRequest('status_required', 'status is required');
      const finding = await updateVulnerabilityStatus(userId(req), projectId, findingId, status, assignedTo);
      res.json(jsonResult({ finding }));
    }),
  );

  // ============================================================ VULNERABILITY MANAGEMENT
  router.get(
    '/vulnerabilities',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const type = req.query.type as string;
      const severity = req.query.severity as string;
      const status = req.query.status as string;
      const assignedTo = req.query.assignedTo as string;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const result = await listVulnerabilities(userId(req), projectId, { type, severity, status, assignedTo, limit, offset });
      res.json(jsonResult(result));
    }),
  );

  router.get(
    '/vulnerabilities/:id',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      // We need a get by ID function, but for now return from list
      const result = await getVulnerabilityFindings(userId(req), projectId, { type: undefined, severity: undefined, status: undefined, limit: 100 });
      const found = result.find(f => f.id === findingId);
      if (!found) throw AppError.notFound('Vulnerability finding');
      res.json(jsonResult({ finding: found }));
    }),
  );

  router.patch(
    '/vulnerabilities/:id',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const updates = req.body ?? {};
      const finding = await updateVulnerability(userId(req), projectId, findingId, updates);
      res.json(jsonResult({ finding }));
    }),
  );

  router.post(
    '/vulnerabilities/:id/acknowledge',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const finding = await acknowledgeVulnerability(userId(req), projectId, findingId);
      res.json(jsonResult({ finding }));
    }),
  );

  router.post(
    '/vulnerabilities/:id/fix',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const { fixCommit } = req.body ?? {};
      if (!fixCommit) throw AppError.badRequest('fix_commit_required', 'fixCommit is required');
      const finding = await markFixed(userId(req), projectId, findingId, fixCommit);
      res.json(jsonResult({ finding }));
    }),
  );

  router.post(
    '/vulnerabilities/:id/regression',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const finding = await markRegression(userId(req), projectId, findingId);
      res.json(jsonResult({ finding }));
    }),
  );

  router.get(
    '/vulnerabilities/:id/history',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const history = await getVulnerabilityHistory(userId(req), projectId, findingId);
      res.json(jsonResult({ history }));
    }),
  );

  router.get(
    '/vulnerabilities/stats',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const stats = await getVulnerabilityStats(userId(req), projectId);
      res.json(jsonResult({ stats }));
    }),
  );

  router.post(
    '/vulnerabilities/:id/remediation',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const { steps, targetDate, owner } = req.body ?? {};
      if (!steps || !targetDate || !owner) throw AppError.badRequest('invalid_input', 'steps, targetDate, owner required');
      const plan = await createRemediationPlan(userId(req), projectId, findingId, steps, new Date(targetDate), owner);
      res.status(201).json(jsonResult({ plan }));
    }),
  );

  router.patch(
    '/vulnerabilities/:id/remediation/:stepId',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const stepId = rid(req.params.stepId);
      const { completed } = req.body ?? {};
      if (completed === undefined) throw AppError.badRequest('completed_required', 'completed is required');
      const plan = await updateRemediationStep(userId(req), projectId, findingId, stepId, completed);
      res.json(jsonResult({ plan }));
    }),
  );

  router.get(
    '/vulnerabilities/:id/remediation',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const findingId = rid(req.params.id);
      const plan = await getRemediationPlan(userId(req), projectId, findingId);
      res.json(jsonResult({ plan }));
    }),
  );

  // ============================================================ SUPPLY CHAIN SECURITY
  router.post(
    '/supply-chain/scan',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const result = await scanDependencies(userId(req), projectId);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/supply-chain/scans',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
      const history = await getSupplyChainScanHistory(userId(req), projectId, limit);
      res.json(jsonResult({ history }));
    }),
  );

  router.get(
    '/supply-chain/vulnerabilities/:name',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const name = rid(req.params.name);
      const vulns = await getDependencyVulnerabilities(userId(req), projectId, name);
      res.json(jsonResult({ vulnerabilities: vulns }));
    }),
  );

  router.get(
    '/supply-chain/licenses',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const licenses = await getLicenseReport(userId(req), projectId);
      res.json(jsonResult({ licenses }));
    }),
  );

  // ============================================================ SECRET MANAGEMENT INTELLIGENCE
  router.post(
    '/secrets/scan',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const result = await scanProjectForSecrets(userId(req), projectId);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/secrets/exposures',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const since = req.query.since ? new Date(String(req.query.since)) : undefined;
      const targetTypes = req.query.targetTypes ? String(req.query.targetTypes).split(',') : undefined;
      const exposures = await detectExposedSecrets(userId(req), projectId, { since, targetTypes });
      res.json(jsonResult({ exposures }));
    }),
  );

  router.get(
    '/secrets/metadata',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const kind = req.query.kind as string;
      const metadata = await getSecretMetadata(userId(req), projectId, kind);
      res.json(jsonResult({ metadata }));
    }),
  );

  router.post(
    '/secrets/rotate',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const { kind, newKind, trigger } = req.body ?? {};
      if (!kind || !newKind || !trigger) throw AppError.badRequest('invalid_input', 'kind, newKind, trigger required');
      await recordRotation(userId(req), projectId, kind, newKind, trigger);
      res.json(jsonResult({ rotated: true }));
    }),
  );

  router.get(
    '/secrets/rotations',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const kind = req.query.kind as string;
      const history = await getRotationHistory(userId(req), projectId, kind);
      res.json(jsonResult({ history }));
    }),
  );

  router.post(
    '/secrets/policies',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const { kind, policy } = req.body ?? {};
      if (!kind || !policy) throw AppError.badRequest('invalid_input', 'kind and policy required');
      await setRotationPolicy(userId(req), projectId, kind, policy);
      res.json(jsonResult({ updated: true }));
    }),
  );

  router.get(
    '/secrets/policies',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const policies = await getRotationPolicies(userId(req), projectId);
      res.json(jsonResult({ policies }));
    }),
  );

  router.post(
    '/secrets/redact',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const content = String(req.body?.content ?? '');
      if (!content) throw AppError.badRequest('content_required', 'content is required');
      const redacted = await redactSecretsInContent(userId(req), projectId, content);
      res.json(jsonResult({ redacted }));
    }),
  );

  router.get(
    '/secrets/stats',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const since = req.query.since ? new Date(String(req.query.since)) : undefined;
      const groupBy = req.query.groupBy as 'day' | 'week' | 'month';
      const stats = await getExposureStats(userId(req), projectId, { since, groupBy });
      res.json(jsonResult({ stats }));
    }),
  );

  // ============================================================ API SECURITY
  router.post(
    '/api/scan',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const options = req.body?.options ?? {};
      const result = await runApiSecurityScan(userId(req), projectId, options);
      res.json(jsonResult({ result }));
    }),
  );

  router.get(
    '/api/scans',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
      const scans = await getApiSecurityScanHistory(userId(req), projectId, limit);
      res.json(jsonResult({ scans }));
    }),
  );

  router.get(
    '/api/endpoints/:method/:path',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const method = req.params.method;
      const path = req.params.path;
      const security = await getEndpointSecurity(userId(req), projectId, method!, path!);
      res.json(jsonResult({ security }));
    }),
  );

  router.get(
    '/api/config',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const config = await getApiSecurityConfig(userId(req), projectId);
      res.json(jsonResult({ config }));
    }),
  );

  router.patch(
    '/api/config',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const config = req.body?.config ?? {};
      const updated = await updateApiSecurityConfig(userId(req), projectId, config);
      res.json(jsonResult({ config: updated }));
    }),
  );

  // ============================================================ SECURITY POSTURE
  router.get(
    '/posture',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const useCache = req.query.cache !== 'false';
      const posture = await getSecurityPosture(userId(req), projectId, { useCache });
      res.json(jsonResult({ posture }));
    }),
  );

  router.post(
    '/posture/assess',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const categories = req.body?.categories as string[] | undefined;
      const posture = await assessSecurityPosture(userId(req), projectId, { categories: categories as any });
      await savePostureAssessment(userId(req), projectId, posture);
      res.json(jsonResult({ posture }));
    }),
  );

  router.get(
    '/posture/trend/:category',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const category = req.params.category as any;
      const days = req.query.days ? parseInt(String(req.query.days), 10) : 30;
      const trend = await getPostureTrend(userId(req), projectId, category, days);
      res.json(jsonResult({ trend }));
    }),
  );

  router.get(
    '/posture/benchmarks',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const benchmarks = await getSecurityBenchmarks(userId(req), projectId);
      res.json(jsonResult({ benchmarks }));
    }),
  );

  router.get(
    '/posture/failing',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const severity = req.query.severity as string;
      const category = req.query.category as any;
      const checks = await getFailingChecks(userId(req), projectId, { severity, category });
      res.json(jsonResult({ checks }));
    }),
  );

  router.get(
    '/posture/quick-wins',
    asyncRoute(async (req, res) => {
      const projectId = pid(req);
      const wins = await getQuickWins(userId(req), projectId);
      res.json(jsonResult({ quickWins: wins }));
    }),
  );

  return router;
};