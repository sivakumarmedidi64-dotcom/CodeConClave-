/**
 * CodeConClave — "Beyond agentic" API (/api/v1/beyond). Constitution Part VI.
 *   Thermostat  GET/POST /projects/:projectId/thermostat, POST …/thermostat/cool
 *   Gravity     GET  /projects/:projectId/gravity
 *   Council     POST /council            { projectId, fileId, withAi? }
 *   Immunity    GET/POST /immunity, DELETE /immunity/:id, POST /immunity/scan
 *   Night Shift GET /night-shift, POST /night-shift/run, PUT /night-shift/settings
 *   Teleport    GET /projects/:projectId/teleport (download),
 *               POST /teleport/verify, POST /teleport/import (raw bundle body)
 */
import express, { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { listFiles } from '../files/service.js';
import { getPreferences, updatePreferences } from '../workspace/service.js';
import { recordTemperature, temperatureHistory, WEIGHTS } from './thermostat.js';
import { buildGravityMap } from './gravity.js';
import { convene, LENSES } from './council.js';
import type { GatewayContext } from '../ai/gateway.js';
import { addVaccine, deleteVaccine, listVaccines, scanImmunity } from './immunity.js';
import { listNightShiftReports, runNightShift } from './nightShift.js';
import { exportProject, importBundle, MAX_BUNDLE_BYTES, verifyBundle } from './teleport.js';
import { loadBeyondFile, loadProjectSources } from './source.js';

const rawBundle = express.raw({ type: 'application/octet-stream', limit: MAX_BUNDLE_BYTES });

export const beyondRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const uid = (req: express.Request) => req.ctx.user!.id;

  // ---------------------------------------------------------------- Thermostat
  router.get(
    '/projects/:projectId/thermostat',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ history: await temperatureHistory(uid(req), String(req.params.projectId)), weights: WEIGHTS }));
    }),
  );
  router.post(
    '/projects/:projectId/thermostat',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ snapshot: await recordTemperature(uid(req), String(req.params.projectId), 'manual') }));
    }),
  );
  // Cool a hot file down: a Plan-first Cowork task (nothing runs before you approve).
  router.post(
    '/projects/:projectId/thermostat/cool',
    asyncRoute(async (req, res) => {
      const path = typeof req.body?.path === 'string' ? req.body.path.slice(0, 500) : '';
      const reasons = Array.isArray(req.body?.reasons) ? (req.body.reasons as unknown[]).filter((r): r is string => typeof r === 'string').slice(0, 6) : [];
      if (!path) throw AppError.badRequest('path_required', 'Which file should be cooled down?');
      const { createPlanFirstTask, describePlanForChat } = await import('../execution/orchestrator.js');
      const planned = await createPlanFirstTask({
        userId: uid(req),
        projectId: String(req.params.projectId),
        conversationId: null,
        title: `Cool down ${path}`.slice(0, 120),
        description: `Refactor ${path} to lower its Code Thermostat heat without changing behaviour.${reasons.length ? ` Measured problems: ${reasons.join('; ')}.` : ''} Keep public APIs unchanged and add tests for anything you touch.`,
        pipeline: ['ARCHITECT', 'CODER', 'TESTER', 'REVIEWER'],
      });
      res.status(201).json(
        jsonResult({
          taskId: planned.task.id,
          approvalId: planned.approvalId,
          plan: {
            goal: planned.plan.goal,
            source: planned.plan.source ?? 'user',
            steps: planned.plan.entries.map((e, i) => ({ order: i + 1, coworker: e.coworker, ...(e.acceptanceCriteria ? { acceptanceCriteria: e.acceptanceCriteria } : {}) })),
          },
          text: describePlanForChat(planned.plan, 30),
        }),
      );
    }),
  );

  // ---------------------------------------------------------------- Gravity
  router.get(
    '/projects/:projectId/gravity',
    asyncRoute(async (req, res) => {
      const sources = await loadProjectSources(uid(req), String(req.params.projectId));
      res.json(jsonResult({ map: buildGravityMap(sources.files), capped: sources.capped, skipped: sources.skipped.slice(0, 50) }));
    }),
  );

  // ---------------------------------------------------------------- Council
  router.get('/council/lenses', (_req, res) => res.json(jsonResult({ lenses: LENSES })));
  router.post(
    '/council',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '');
      const fileId = String(req.body?.fileId ?? '');
      if (!projectId || !fileId) throw AppError.badRequest('file_required', 'Pick a project file for the Council to review.');
      const [src, files] = await Promise.all([loadBeyondFile(uid(req), projectId, fileId), listFiles(uid(req), projectId)]);
      const user = req.ctx.user!;
      const result = await convene({
        path: src.path,
        text: src.text,
        projectPaths: files.map((f) => f.path),
        withAi: req.body?.withAi === true,
        ctx: { userId: user.id, sessionId: req.ctx.sessionId ?? 'council', conversationId: null, planId: (user.planId ?? 'free') as GatewayContext['planId'] },
      });
      res.json(jsonResult({ result }));
    }),
  );

  // ---------------------------------------------------------------- Immunity
  router.get('/immunity', asyncRoute(async (req, res) => res.json(jsonResult({ vaccines: await listVaccines(uid(req)) }))));
  router.post('/immunity', asyncRoute(async (req, res) => res.status(201).json(jsonResult({ vaccine: await addVaccine(uid(req), req.body) }))));
  router.delete(
    '/immunity/:id',
    asyncRoute(async (req, res) => {
      if (!(await deleteVaccine(uid(req), String(req.params.id)))) throw AppError.notFound('Vaccine');
      res.json(jsonResult({ deleted: true }));
    }),
  );
  router.post(
    '/immunity/scan',
    asyncRoute(async (req, res) => {
      const vaccineId = typeof req.body?.vaccineId === 'string' ? req.body.vaccineId : undefined;
      res.json(jsonResult(await scanImmunity(uid(req), vaccineId)));
    }),
  );

  // ---------------------------------------------------------------- Night Shift
  router.get(
    '/night-shift',
    asyncRoute(async (req, res) => {
      const prefs = await getPreferences(uid(req));
      res.json(
        jsonResult({
          reports: await listNightShiftReports(uid(req)),
          settings: { enabled: prefs.night_shift_enabled === true, hour: Number.isInteger(prefs.night_shift_hour) ? prefs.night_shift_hour : 2 },
        }),
      );
    }),
  );
  router.post('/night-shift/run', asyncRoute(async (req, res) => res.json(jsonResult({ report: await runNightShift(uid(req), 'manual') }))));
  router.put(
    '/night-shift/settings',
    asyncRoute(async (req, res) => {
      const enabled = req.body?.enabled === true;
      const hour = Number(req.body?.hour ?? 2);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw AppError.badRequest('invalid_hour', 'hour must be 0–23');
      await updatePreferences(uid(req), { night_shift_enabled: enabled, night_shift_hour: hour });
      res.json(jsonResult({ settings: { enabled, hour } }));
    }),
  );

  // ---------------------------------------------------------------- Teleport
  router.get(
    '/projects/:projectId/teleport',
    asyncRoute(async (req, res) => {
      const out = await exportProject(uid(req), String(req.params.projectId));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.setHeader('X-Teleport-Files', String(out.fileCount));
      res.setHeader('X-Teleport-Memories', String(out.memoryCount));
      res.send(out.data);
    }),
  );
  router.post(
    '/teleport/verify',
    rawBundle,
    asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw AppError.badRequest('teleport_empty', 'Send the .ccteleport file as the request body.');
      const v = verifyBundle(req.body);
      res.json(jsonResult({ name: v.bundle.project.name, createdAt: v.bundle.createdAt, fileCount: v.fileCount, memoryCount: v.memoryCount, signedHere: v.signedHere, intact: true }));
    }),
  );
  router.post(
    '/teleport/import',
    rawBundle,
    asyncRoute(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw AppError.badRequest('teleport_empty', 'Send the .ccteleport file as the request body.');
      res.status(201).json(jsonResult({ imported: await importBundle(uid(req), req.body) }));
    }),
  );

  return router;
};
