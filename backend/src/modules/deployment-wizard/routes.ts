/**
 * CodeConClave — Deployment Wizard Routes (V4E).
 * Authenticated, tenant-scoped, auditable deployment operations.
 */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { discoverDeployment } from './deploymentDiscovery.js';
import { checkDeploymentReadiness } from './deploymentReadiness.js';
import { generateDeploymentPlan } from './deploymentPlan.js';
import { createSecretInventory, validateSecret, maskSecret } from './secretHandling.js';
import { runPreDeployChecks } from './preDeployCheck.js';
import { selectStrategy, compareStrategies } from './deploymentStrategy.js';
import { requestApproval, decideApproval, listPendingApprovals } from './humanApproval.js';
import { runPostDeployVerification } from './postDeployVerify.js';
import { prepareRollbackPlan } from './rollbackPlanner.js';
import { generateDeploymentReport } from './deploymentReport.js';

export const deploymentWizardRoutes = (): Router => {
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

  router.post('/:projectId/discover', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await discoverDeployment(uid, projectId, req.body);
    await recordAudit({ action: 'DEPLOY_DISCOVER', actorUserId: uid, scope: 'USER', tenantId: projectId, detail: { projectId } });
    res.json(result);
  }));

  router.post('/:projectId/readiness', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await checkDeploymentReadiness(uid, projectId, req.body);
    res.json(result);
  }));

  router.post('/:projectId/plan', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await generateDeploymentPlan(uid, projectId, req.body);
    res.json(result);
  }));

  router.post('/:projectId/secrets', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await createSecretInventory(uid, projectId, req.body.envVars, req.body.requiredVars);
    await recordAudit({ action: 'DEPLOY_SECRETS_INVENTORY', actorUserId: uid, scope: 'USER', tenantId: projectId, detail: { projectId } });
    res.json(result);
  }));

  router.post('/:projectId/secrets/validate', asyncRoute(async (req, res) => {
    userId(req);
    const result = validateSecret(req.body);
    res.json(result);
  }));

  router.get('/:projectId/secrets/mask/:value', asyncRoute(async (req, res) => {
    userId(req);
    res.json({ masked: maskSecret(req.params.value!) });
  }));

  router.post('/:projectId/pre-deploy', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await runPreDeployChecks(uid, projectId, { projectId, ...req.body });
    res.json(result);
  }));

  router.post('/:projectId/strategy', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await selectStrategy(uid, projectId, { projectId, ...req.body });
    res.json(result);
  }));

  router.post('/:projectId/strategy/compare', asyncRoute(async (req, res) => {
    userId(req);
    const result = compareStrategies(req.body.deploymentConfigs, req.body.hasDatabase, req.body.isProduction);
    res.json(result);
  }));

  router.post('/:projectId/approvals', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await requestApproval(uid, { projectId, ...req.body, requestedBy: uid });
    await recordAudit({ action: 'DEPLOY_APPROVAL_REQUESTED', actorUserId: uid, scope: 'USER', tenantId: projectId, detail: { projectId } });
    res.json(result);
  }));

  router.post('/:projectId/approvals/:approvalId', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await decideApproval(uid, projectId, req.params.approvalId!, { ...req.body, decidedBy: uid });
    await recordAudit({ action: 'DEPLOY_APPROVAL_DECIDED', actorUserId: uid, scope: 'USER', tenantId: projectId, detail: { projectId, approvalId: req.params.approvalId } });
    res.json(result);
  }));

  router.get('/:projectId/approvals/pending', asyncRoute(async (req, res) => {
    userId(req);
    const projectId = pid(req);
    const result = await listPendingApprovals(projectId);
    res.json(result);
  }));

  router.post('/:projectId/post-deploy', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await runPostDeployVerification(uid, { projectId, ...req.body });
    await recordAudit({ action: 'DEPLOY_POST_VERIFY', actorUserId: uid, scope: 'USER', tenantId: projectId, detail: { projectId } });
    res.json(result);
  }));

  router.post('/:projectId/rollback', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await prepareRollbackPlan(uid, { projectId, ...req.body });
    await recordAudit({ action: 'DEPLOY_ROLLBACK_PLANNED', actorUserId: uid, scope: 'USER', tenantId: projectId, detail: { projectId } });
    res.json(result);
  }));

  router.post('/:projectId/report', asyncRoute(async (req, res) => {
    const uid = userId(req);
    const projectId = pid(req);
    const result = await generateDeploymentReport(uid, { projectId, ...req.body });
    res.json({ id: result.id, markdownLength: result.markdown.length });
  }));

  return router;
};
