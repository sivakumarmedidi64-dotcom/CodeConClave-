/**
 * CodeConClave — DNA routes.
 */
import { Router } from 'express';
import { saveDnaSchema, teamDnaSchema } from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import {
  compareDnaVersions,
  createBranch,
  dnaVersions,
  exportDnaJsonl,
  getDna,
  listDna,
  mergeBranches,
  resolveDnaConflict,
  restoreDna,
  restoreDnaVersion,
  saveDna,
  softDeleteDna,
  toDnaJson,
  trashDna,
  updateDna,
} from './service.js';
import {
  createTeamBranch,
  listTeamDna,
  mergeTeamBranches,
  resolveTeamDnaConflict,
  saveTeamDna,
  teamDnaVersions,
} from './team.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';

export const dnaRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      const scope = req.query.scope === 'BRANCH' ? 'BRANCH' : req.query.scope === 'MAIN' ? 'MAIN' : undefined;
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      res.json(jsonResult({ blocks: (await listDna(req.ctx.user!.id, projectId, scope)).map(toDnaJson) }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const input = saveDnaSchema.parse(req.body);
      const block = await saveDna(req.ctx.user!.id, {
        projectId: input.projectId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        scope: input.scope,
        auto: input.auto,
      });
      res.status(201).json(jsonResult({ block: toDnaJson(block) }));
    }),
  );

  router.get(
    '/export',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const jsonl = await exportDnaJsonl(req.ctx.user!.id, projectId);
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', 'attachment; filename="dna.jsonl"');
      res.send(jsonl);
    }),
  );

  router.get(
    '/trash',
    asyncRoute(async (req, res) => res.json(jsonResult({ blocks: (await trashDna(req.ctx.user!.id)).map(toDnaJson) }))),
  );

  // ------------------------------------------------------- team DNA (Phase 6)

  router.get(
    '/team/:teamId',
    asyncRoute(async (req, res) => {
      const scope = req.query.scope === 'BRANCH' ? 'BRANCH' : req.query.scope === 'MAIN' ? 'MAIN' : undefined;
      res.json(jsonResult({ blocks: await listTeamDna(req.ctx.user!.id, req.params.teamId!, scope) }));
    }),
  );

  router.post(
    '/team',
    asyncRoute(async (req, res) => {
      const input = teamDnaSchema.parse(req.body);
      const block = await saveTeamDna(req.ctx.user!.id, {
        teamId: input.teamId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        scope: input.scope as 'MAIN' | 'BRANCH',
      });
      res.status(201).json(jsonResult({ block }));
    }),
  );

  router.post(
    '/team/:teamId/branch',
    asyncRoute(async (req, res) => {
      const baseDnaId = String(req.body.baseDnaId ?? '');
      const title = String(req.body.title ?? 'Branch');
      const content = String(req.body.content ?? '');
      const changeSummary = typeof req.body.changeSummary === 'string' ? req.body.changeSummary : undefined;
      if (!baseDnaId) throw AppError.badRequest('base_required', 'baseDnaId is required');
      const block = await createTeamBranch(req.ctx.user!.id, req.params.teamId!, baseDnaId, title, content, changeSummary);
      res.status(201).json(jsonResult({ block }));
    }),
  );

  router.post(
    '/team/:teamId/merge',
    asyncRoute(async (req, res) => {
      const branchId = String(req.body.branchId ?? '');
      const baseId = String(req.body.baseId ?? '');
      const resolution = typeof req.body.resolution === 'string' ? req.body.resolution : undefined;
      const changeSummary = typeof req.body.changeSummary === 'string' ? req.body.changeSummary : undefined;
      if (!branchId || !baseId) throw AppError.badRequest('merge_required', 'branchId and baseId are required');
      const merged = await mergeTeamBranches(req.ctx.user!.id, req.params.teamId!, branchId, baseId, resolution, changeSummary);
      res.json(jsonResult({ block: merged }));
    }),
  );

  router.post(
    '/team/:teamId/conflicts/resolve',
    asyncRoute(async (req, res) => {
      const branchId = String(req.body.branchId ?? '');
      const baseId = String(req.body.baseId ?? '');
      const resolution = String(req.body.resolution ?? '');
      if (!resolution.trim()) throw AppError.badRequest('resolution_required', 'resolution is required');
      const resolved = await resolveTeamDnaConflict(req.ctx.user!.id, req.params.teamId!, branchId, baseId, resolution);
      res.json(jsonResult({ block: resolved }));
    }),
  );

  router.get(
    '/team/:teamId/versions/:dnaId',
    asyncRoute(async (req, res) => res.json(jsonResult({ versions: await teamDnaVersions(req.ctx.user!.id, req.params.dnaId!) }))),
  );

  router.get(
    '/:id',
    asyncRoute(async (req, res) => res.json(jsonResult({ block: toDnaJson(await getDna(req.ctx.user!.id, req.params.id!)) }))),
  );

  router.patch(
    '/:id',
    asyncRoute(async (req, res) => {
      const patch: { title?: string; content?: string; changeSummary?: string } = {};
      if (typeof req.body.title === 'string') patch.title = req.body.title;
      if (typeof req.body.content === 'string') patch.content = req.body.content;
      if (typeof req.body.changeSummary === 'string') patch.changeSummary = req.body.changeSummary;
      res.json(jsonResult({ block: toDnaJson(await updateDna(req.ctx.user!.id, req.params.id!, patch)) }));
    }),
  );

  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      await softDeleteDna(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/:id/restore',
    asyncRoute(async (req, res) => res.json(jsonResult({ block: toDnaJson(await restoreDna(req.ctx.user!.id, req.params.id!)) }))),
  );

  router.get(
    '/:id/versions',
    asyncRoute(async (req, res) => res.json(jsonResult({ versions: await dnaVersions(req.ctx.user!.id, req.params.id!) }))),
  );

  router.get(
    '/:id/compare',
    asyncRoute(async (req, res) => {
      const from = Number(req.query.from ?? 1);
      const to = Number(req.query.to ?? 0);
      res.json(jsonResult(await compareDnaVersions(req.ctx.user!.id, req.params.id!, from, to)));
    }),
  );

  router.post(
    '/:id/restore-version',
    asyncRoute(async (req, res) => {
      const version = Number(req.body.version ?? 0);
      if (!version) throw AppError.badRequest('version_required', 'version is required');
      res.json(jsonResult({ block: toDnaJson(await restoreDnaVersion(req.ctx.user!.id, req.params.id!, version)) }));
    }),
  );

  router.post(
    '/:id/branch',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body.projectId ?? '');
      const title = String(req.body.title ?? 'Branch');
      const content = String(req.body.content ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const branch = await createBranch(req.ctx.user!.id, projectId, req.params.id!, title, content);
      res.status(201).json(jsonResult({ block: toDnaJson(branch) }));
    }),
  );

  router.post(
    '/merge',
    asyncRoute(async (req, res) => {
      const branchId = String(req.body.branchId ?? '');
      const baseId = String(req.body.baseId ?? '');
      const resolution = typeof req.body.resolution === 'string' ? req.body.resolution : undefined;
      const projectId = String(req.body.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const merged = await mergeBranches(req.ctx.user!.id, projectId, branchId, baseId, resolution);
      res.json(jsonResult({ block: toDnaJson(merged) }));
    }),
  );

  router.post(
    '/conflicts/resolve',
    asyncRoute(async (req, res) => {
      const branchId = String(req.body.branchId ?? '');
      const baseId = String(req.body.baseId ?? '');
      const resolution = String(req.body.resolution ?? '');
      if (!resolution.trim()) throw AppError.badRequest('resolution_required', 'resolution is required');
      const resolved = await resolveDnaConflict(req.ctx.user!.id, branchId, baseId, resolution, 'base');
      res.json(jsonResult({ block: toDnaJson(resolved) }));
    }),
  );

  return router;
};