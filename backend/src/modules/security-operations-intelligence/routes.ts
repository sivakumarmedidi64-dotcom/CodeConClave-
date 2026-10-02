/**
 * CodeConClave — Security Operations Intelligence Routes (PKG-15).
 * Authenticated REST endpoints for Security Incident Response (#21),
 * API Rate Limit Awareness (#22), Network Resilience Checker (#23),
 * Workspace Compliance Checker (#24). All routes enforce auth + project
 * ownership (via existing services + RLS); findings are advisory.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { securityOperationsService } from './service.js';
import { SecurityIncidentService } from './incidents.js';
import { assessRateLimitAwareness } from './rateLimitAwareness.js';
import { checkNetworkResilience } from './networkResilience.js';
import { runComplianceCheck, getComplianceHistory } from './compliance.js';
import {
  ComplianceRequestSchema,
  CreateIncidentSchema,
  ListIncidentsSchema,
  NetworkResilienceRequestSchema,
  RateLimitAssessmentSchema,
  UpdateIncidentSchema,
} from './types.js';

export const securityOperationsRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  // Honest capability report for the four capabilities.
  router.get(
    '/capabilities',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(securityOperationsService.getCapabilities()));
    }),
  );

  // #21 — incidents
  router.post(
    '/incidents',
    asyncRoute(async (req, res) => {
      const parsed = CreateIncidentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const incident = await SecurityIncidentService.create(uid(req), parsed.data);
      res.status(201).json(jsonResult(incident));
    }),
  );

  router.get(
    '/incidents',
    asyncRoute(async (req, res) => {
      const parsed = ListIncidentsSchema.safeParse({
        projectId: req.query.projectId,
        status: req.query.status ?? undefined,
        severity: req.query.severity ?? undefined,
        limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const incidents = await SecurityIncidentService.list(uid(req), parsed.data);
      res.json(jsonResult(incidents));
    }),
  );

  router.get(
    '/incidents/stats',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId;
      if (!projectId) return res.status(400).json({ error: 'project_required' });
      const stats = await SecurityIncidentService.stats(uid(req), String(projectId));
      res.json(jsonResult(stats));
    }),
  );

  router.get(
    '/incidents/:id',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId ?? req.body?.projectId;
      if (!projectId) return res.status(400).json({ error: 'project_required' });
      const incident = await SecurityIncidentService.get(uid(req), String(projectId), req.params.id as string);
      res.json(jsonResult(incident));
    }),
  );

  router.patch(
    '/incidents/:id',
    asyncRoute(async (req, res) => {
      const parsed = UpdateIncidentSchema.safeParse({ ...req.body, incidentId: req.params.id });
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const incident = await SecurityIncidentService.update(uid(req), parsed.data);
      res.json(jsonResult(incident));
    }),
  );

  // #22 — rate limit awareness
  router.post(
    '/rate-limit-awareness',
    asyncRoute(async (req, res) => {
      const parsed = RateLimitAssessmentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const report = await assessRateLimitAwareness(uid(req), parsed.data);
      res.json(jsonResult(report));
    }),
  );

  // #23 — network resilience
  router.post(
    '/network-resilience',
    asyncRoute(async (req, res) => {
      const parsed = NetworkResilienceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const report = await checkNetworkResilience(uid(req), parsed.data);
      res.json(jsonResult(report));
    }),
  );

  // #24 — compliance
  router.post(
    '/compliance',
    asyncRoute(async (req, res) => {
      const parsed = ComplianceRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      }
      const report = await runComplianceCheck(uid(req), parsed.data);
      res.json(jsonResult(report));
    }),
  );

  router.get(
    '/compliance/history',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
      if (!projectId) return res.status(400).json({ error: 'project_required' });
      const history = await getComplianceHistory(uid(req), String(projectId), Number.isFinite(limit) ? limit : 20);
      res.json(jsonResult(history));
    }),
  );

  return router;
};
