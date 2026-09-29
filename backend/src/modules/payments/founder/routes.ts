/**
 * CodeConClave — PRIVATE FOUNDER CONTROL PLANE API.
 *
 * Founder-only. Every route requires a session (requireAuth) AND control-center
 * access (owner/admin RBAC or PAYMENT_FOUNDER_EMAIL). Nothing here can grant an
 * entitlement, approve a claim or invent payment truth; the payment authority
 * remains activation.applyDecision -> activateEntitlement exactly where it has
 * always been. Founder actions allowed here are the two documented controls:
 *   - flip the runtime autopilot mode (MANUAL = kill switch);
 *   - STOP/HOLD a pending auto-approval (2-second intervention window).
 * Plus a read-only surface for the dashboard, revenue, reviews, failures and
 * audit trail, a founder AI operations interface and the best-effort Sheets
 * mirror.
 */
import { Router } from 'express';
import { jsonResult } from '../../auth/schemas.js';
import { requireAuth } from '../../../middleware/auth.js';
import { asyncRoute } from '../../../middleware/security.js';
import { AppError } from '../../../shared/errors.js';
import { assertControlCenterAccess } from '../control-center.js';
import { setRuntimeUnlockMode, getEffectiveUnlockMode, getRuntimeUnlockMode } from '../autopilot/service.js';
import {
  founderDashboard,
  founderReviewQueue,
  founderVerificationFailures,
  founderAuditTrail,
  founderPaymentDetail,
  founderAutopilotState,
} from './service.js';
import { founderRevenueOverview, founderMonthlyRevenue } from './revenue.js';
import { recentIntents } from './recent.js';
import { listAutoApprovals, stopAutoApproval } from '../autoapproval/service.js';
import { founderAiQuery } from './ai.js';
import { sheetMirrorStatus, pushRevenueSnapshot } from './sheet.js';

export const founderRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  router.use(asyncRoute(async (req, _res, next) => {
    await assertControlCenterAccess(req.ctx?.user ?? null);
    next();
  }));

  router.get('/config', asyncRoute(async (_req, res) => {
    res.json(jsonResult({ access: true }));
  }));

  router.get('/dashboard', asyncRoute(async (req, res) => {
    res.json(jsonResult(await founderDashboard(req.ctx!.user!.id)));
  }));

  router.get('/revenue', asyncRoute(async (_req, res) => {
    const [overview, monthly] = await Promise.all([founderRevenueOverview(), founderMonthlyRevenue(12)]);
    res.json(jsonResult({ overview: { periods: overview.periods, allTime: overview.allTime }, monthly }));
  }));

  router.get('/payments', asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit ?? 20);
    res.json(jsonResult(await recentIntents(Number.isFinite(limit) ? limit : 20)));
  }));

  router.get('/payments/:id', asyncRoute(async (req, res) => {
    const detail = await founderPaymentDetail(req.params.id!);
    if (!detail) throw AppError.notFound('payment_not_found', 'Payment intent not found');
    res.json(jsonResult(detail));
  }));

  router.get('/reviews', asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    res.json(jsonResult(await founderReviewQueue(Number.isFinite(limit) ? limit : 100)));
  }));

  router.get('/failures', asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json(jsonResult(await founderVerificationFailures(Number.isFinite(limit) ? limit : 50)));
  }));

  router.get('/audit', asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    res.json(jsonResult(await founderAuditTrail(Number.isFinite(limit) ? limit : 100)));
  }));

  router.get('/autopilot', asyncRoute(async (_req, res) => {
    const [effective, runtimeMode, autopilot, interventions] = await Promise.all([
      getEffectiveUnlockMode(),
      getRuntimeUnlockMode(),
      founderAutopilotState(),
      listAutoApprovals({ limit: 25 }),
    ]);
    res.json(jsonResult({ effective, runtimeMode, readiness: autopilot.readiness, pendingApprovals: interventions.pendingCount, interventions: interventions.rows }));
  }));

  router.post('/autopilot', asyncRoute(async (req, res) => {
    const mode = String(req.body?.mode ?? '');
    if (mode !== 'MANUAL' && mode !== 'AUTOPILOT') {
      throw AppError.badRequest('invalid_mode', 'mode must be MANUAL or AUTOPILOT');
    }
    const next = await setRuntimeUnlockMode(mode, req.ctx!.user!.id);
    res.json(jsonResult({ mode: next, note: 'MANUAL is the kill switch.' }));
  }));

  router.get('/interventions', asyncRoute(async (req, res) => {
    const { rows, pendingCount } = await listAutoApprovals({ limit: 100 });
    res.json(jsonResult({ rows, pendingCount }));
  }));

  router.post('/interventions/stop', asyncRoute(async (req, res) => {
    const paymentId = String(req.body?.paymentId ?? '');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    const outcome = await stopAutoApproval(paymentId, req.ctx!.user!.id, reason);
    res.json(jsonResult(outcome));
  }));

  router.get('/sheets', asyncRoute(async (req, res) => {
    res.json(jsonResult(await sheetMirrorStatus(req.ctx!.user!.id)));
  }));

  router.post('/sheets/push', asyncRoute(async (req, res) => {
    res.json(jsonResult(await pushRevenueSnapshot(req.ctx!.user!.id)));
  }));

  router.post('/ai/query', asyncRoute(async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question : '';
    if (!question.trim()) throw AppError.badRequest('question_required', 'Ask a question.');
    res.json(jsonResult(await founderAiQuery(req.ctx!.user!.id, question)));
  }));

  return router;
};