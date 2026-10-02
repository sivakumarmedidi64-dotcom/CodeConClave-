/**
 * CodeConClave — PKG-23 Memory-Powered Coding — HTTP routes at /api/v1/memorycoding.
 *
 * Feature-gated: when AIOS_P2_MEMORY_CODING is OFF, mutating + read endpoints
 * report UNAVAILABLE and never mutate. `/capabilities` stays available so the
 * frontend knows the honest state.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { MCP_CONFIG } from './config.js';
import { memoryCodingCapabilities } from './service.js';
import { projectContinuity } from './continuity.js';
import { buildCodingContext } from './codingContext.js';
import { runtimeMemory } from './runtimeMemory.js';
import { deploymentMemory } from './deploymentMemory.js';
import { setPreference, resolvePreference, listUserPreferences, removePreference } from './preferences.js';
import { recordPattern, confirmPattern, rejectPattern, listDevPatterns, retirePattern } from './patterns.js';
import { reportBug, resolveBug, assessRecurrence, listIncidents } from './debugging.js';
import { learnFromFeedback } from './feedback.js';
import { supersedeStaleByCurrentCode, correctPreference, correctPattern } from './correction.js';
import { inspectMemory } from './inspector.js';
import { retentionStats, compact } from './lifecycle.js';

const enabledNow = MCP_CONFIG.enabled();

function requireEnabled(): void {
  if (!enabledNow) {
    throw AppError.unavailable('feature_disabled', 'Memory coding is feature-gated OFF (AIOS_P2_MEMORY_CODING). No read/write performed.');
  }
}

export const memoryCodingRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/capabilities',
    asyncRoute(async (_req, res) => res.json(jsonResult({ capabilities: memoryCodingCapabilities() }))),
  );

  router.get(
    '/continuity',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      if (!projectId) res.json(jsonResult({ continuity: null }));
      else res.json(jsonResult({ continuity: await projectContinuity(req.ctx.user!.id, projectId) }));
    }),
  );

  router.get(
    '/context',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : '';
      const file = req.query.file ? String(req.query.file) : null;
      const symbol = req.query.symbol ? String(req.query.symbol) : null;
      const taskId = req.query.taskId ? String(req.query.taskId) : null;
      const error = req.query.error ? String(req.query.error) : null;
      const items = await buildCodingContext(req.ctx.user!.id, {
        projectId,
        file,
        symbol,
        taskId,
        error,
      });
      res.json(jsonResult({ items }));
    }),
  );

  router.get(
    '/runtime',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : '';
      res.json(jsonResult({ evidence: await runtimeMemory(req.ctx.user!.id, projectId) }));
    }),
  );

  router.get(
    '/deployments',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : '';
      res.json(jsonResult(await deploymentMemory(req.ctx.user!.id, projectId)));
    }),
  );

  // ------------------------------------------------------------- preferences

  router.post(
    '/preferences',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const body = req.body as { projectId?: string; category: string; key: string; value: Record<string, unknown>; classification?: string; source?: string };
      const pref = await setPreference(req.ctx.user!.id, {
        projectId: body.projectId ?? null,
        category: body.category,
        key: body.key,
        value: body.value ?? {},
        classification: (body.classification as 'EXPLICIT' | 'INFERRED' | 'UNKNOWN' | undefined) ?? 'EXPLICIT',
        source: body.source ?? null,
      });
      res.status(201).json(jsonResult({ preference: pref }));
    }),
  );

  router.get(
    '/preferences',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      res.json(jsonResult({ preferences: await listUserPreferences(req.ctx.user!.id, projectId) }));
    }),
  );

  router.get(
    '/preferences/resolve',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const category = req.query.category ? String(req.query.category) : '';
      const key = req.query.key ? String(req.query.key) : '';
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      res.json(jsonResult({ resolved: await resolvePreference(req.ctx.user!.id, category, key, projectId) }));
    }),
  );

  router.delete(
    '/preferences/:id',
    asyncRoute(async (req, res) => {
      requireEnabled();
      await removePreference(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  // --------------------------------------------------------------- patterns

  router.post(
    '/patterns',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const body = req.body as { projectId?: string; name: string; description: string; category?: string; source?: string };
      const pattern = await recordPattern(req.ctx.user!.id, body);
      res.status(201).json(jsonResult({ pattern }));
    }),
  );

  router.get(
    '/patterns',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      res.json(jsonResult({ patterns: await listDevPatterns(req.ctx.user!.id, projectId) }));
    }),
  );

  router.post(
    '/patterns/:id/confirm',
    asyncRoute(async (req, res) => {
      requireEnabled();
      res.json(jsonResult({ pattern: await confirmPattern(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/patterns/:id/reject',
    asyncRoute(async (req, res) => {
      requireEnabled();
      res.json(jsonResult({ pattern: await rejectPattern(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.delete(
    '/patterns/:id',
    asyncRoute(async (req, res) => {
      requireEnabled();
      await retirePattern(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  // ----------------------------------------------------------- bug incidents

  router.post(
    '/bugs',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const body = req.body as { projectId: string; title: string; symptomKey: string };
      const incident = await reportBug(req.ctx.user!.id, body);
      res.status(201).json(jsonResult({ incident }));
    }),
  );

  router.get(
    '/bugs',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      res.json(jsonResult({ incidents: await listIncidents(req.ctx.user!.id, projectId ?? undefined) }));
    }),
  );

  router.get(
    '/recurrence',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : '';
      const symptomKey = req.query.symptomKey ? String(req.query.symptomKey) : '';
      res.json(jsonResult({ recurrence: await assessRecurrence(req.ctx.user!.id, projectId, symptomKey) }));
    }),
  );

  router.post(
    '/bugs/:id/resolve',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const body = req.body as { diagnosis?: string; fixSummary?: string; testRef?: string; deployRef?: string };
      res.json(jsonResult({ incident: await resolveBug(req.ctx.user!.id, req.params.id!, body) }));
    }),
  );

  // ---------------------------------------------------------------- feedback

  router.post(
    '/feedback',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const body = req.body as { projectId?: string; content: string; level: string; source?: string; structured?: Record<string, unknown> };
      const result = await learnFromFeedback(req.ctx.user!.id, {
        projectId: body.projectId ?? null,
        content: body.content,
        level: body.level as 'OBSERVED' | 'CONFIRMED' | 'EXPLICIT' | 'INFERRED',
        source: body.source,
        structured: body.structured,
      });
      res.status(201).json(jsonResult(result));
    }),
  );

  // ------------------------------------------------------------- corrections

  router.post(
    '/correction/stale',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const body = req.body as { memoryId: string; note: string };
      const result = await supersedeStaleByCurrentCode(req.ctx.user!.id, body.memoryId, body.note);
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/correction/preference/:id',
    asyncRoute(async (req, res) => {
      requireEnabled();
      await correctPreference(req.ctx.user!.id, req.params.id!, 'user correction');
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/correction/pattern/:id',
    asyncRoute(async (req, res) => {
      requireEnabled();
      await correctPattern(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  // --------------------------------------------------------------- inspector

  router.get(
    '/inspector',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      const category = req.query.category ? String(req.query.category) : 'all';
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      res.json(jsonResult(
        await inspectMemory(req.ctx.user!.id, { projectId, category: category as never, limit }),
      ));
    }),
  );

  router.get(
    '/stats',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      res.json(jsonResult({ stats: await retentionStats(req.ctx.user!.id, projectId) }));
    }),
  );

  router.post(
    '/compact',
    asyncRoute(async (req, res) => {
      requireEnabled();
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      res.json(jsonResult({ compacted: await compact(req.ctx.user!.id, { projectId }) }));
    }),
  );

  return router;
};
