/**
 * CodeConClave - multi-agent workspace routes (Stage 25.5).
 * Agent CRUD, run lifecycle (start/cancel/detail), the role catalog, and
 * role -> eligible model suggestions for the assignment UI. All reads and
 * writes are owner-scoped; bounds are enforced in the service layer.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentTrust,
  listRuns,
  getRun,
  startRun,
  cancelRun,
  runTasks,
  roleCatalog,
  suggestedModelForRole,
  validAgentRole,
} from './service.js';
import { AGENT_ROLES } from './service.js';
import { createAndRunDebate, listDebates, getDebate, cancelDebate, decideDebate } from './debates.js';
import { browseCatalogue, getCatalogueItem, installPackage, listInstalled, setInstalledStatus, uninstallPackage, updateInstalled } from './marketplace.js';

export const agentRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/roles',
    asyncRoute(async (_req, res) => {
      res.json(jsonResult({ roles: roleCatalog() }));
    }),
  );

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ agents: await listAgents(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const agent = await createAgent(req.ctx.user!.id, {
        name: String(body.name ?? ''),
        role: String(body.role ?? ''),
        objective: body.objective !== undefined ? String(body.objective) : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
        modelProvider: body.modelProvider !== undefined ? String(body.modelProvider) : undefined,
        modelId: body.modelId !== undefined && body.modelId !== null ? String(body.modelId) : null,
        maxTasksPerRun: body.maxTasksPerRun !== undefined ? Number(body.maxTasksPerRun) : undefined,
        maxRetries: body.maxRetries !== undefined ? Number(body.maxRetries) : undefined,
        trustLevel: body.trustLevel !== undefined ? String(body.trustLevel) : undefined,
      });
      res.status(201).json(jsonResult({ agent }));
    }),
  );

  router.get(
    '/runs/:id',
    asyncRoute(async (req, res) => {
      const run = await getRun(req.ctx.user!.id, req.params.id!);
      const tasks = await runTasks(run.id);
      res.json(jsonResult({ run, tasks }));
    }),
  );

  router.post(
    '/runs/:id/cancel',
    asyncRoute(async (req, res) => {
      const run = await cancelRun(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ run }));
    }),
  );

  router.get(
    '/:id',
    asyncRoute(async (req, res) => {
      const agent = await getAgent(req.ctx.user!.id, req.params.id!);
      const runs = await listRuns(req.ctx.user!.id, agent.id);
      res.json(jsonResult({ agent, runs: runs.slice(0, 10) }));
    }),
  );

  router.patch(
    '/:id',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const agent = await updateAgent(req.ctx.user!.id, req.params.id!, {
        name: body.name !== undefined ? String(body.name) : undefined,
        objective: body.objective !== undefined ? String(body.objective) : undefined,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
        modelId: body.modelId !== undefined ? (body.modelId === null ? null : String(body.modelId)) : undefined,
        maxTasksPerRun: body.maxTasksPerRun !== undefined ? Number(body.maxTasksPerRun) : undefined,
        maxRetries: body.maxRetries !== undefined ? Number(body.maxRetries) : undefined,
      });
      res.json(jsonResult({ agent }));
    }),
  );

  router.patch(
    '/:id/trust',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const agent = await setAgentTrust(req.ctx.user!.id, req.params.id!, String(body.trustLevel ?? ''));
      res.json(jsonResult({ agent }));
    }),
  );

  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      await deleteAgent(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ deleted: true }));
    }),
  );

  router.post(
    '/:id/run',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const subtasks = Array.isArray(body.subtasks)
        ? body.subtasks
            .slice(0, 20)
            .map((s: unknown) => {
              if (typeof s === 'string') return { title: s };
              if (s && typeof s === 'object' && 'title' in s) {
                return { title: String((s as { title: unknown }).title ?? ''), description: (s as { description?: unknown }).description !== undefined ? String((s as { description?: unknown }).description) : undefined };
              }
              return null;
            })
            .filter((s: unknown): s is { title: string; description?: string } => s !== null && String((s as { title: string }).title).length > 0)
        : undefined;
      const run = await startRun(req.ctx.user!.id, req.params.id!, {
        projectId: body.projectId !== undefined ? String(body.projectId) : undefined,
        objective: String(body.objective ?? ''),
        subtasks,
        budgetUsd: body.budgetUsd !== undefined ? Number(body.budgetUsd) : undefined,
        deadlineMinutes: body.deadlineMinutes !== undefined ? Number(body.deadlineMinutes) : undefined,
        requireApproval: body.requireApproval === true,
      });
      res.status(201).json(jsonResult({ run }));
    }),
  );

  router.get(
    '/roles/:role/models',
    asyncRoute(async (req, res) => {
      const role = String(req.params.role! ?? '').toUpperCase();
      if (!validAgentRole(role) || !(AGENT_ROLES as readonly string[]).includes(role)) {
        throw AppError.badRequest('invalid_agent_role', 'Unknown agent role');
      }
      const suggested = await suggestedModelForRole(req.ctx.user!.id, role);
      res.json(jsonResult({ suggested }));
    }),
  );

  // ------------------------------------------------------ debates (Stage 26A)

  router.get(
    '/debates',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ debates: await listDebates(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/debates',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const result = await createAndRunDebate(req.ctx.user!.id, {
        agentIds: Array.isArray(body.agentIds) ? body.agentIds.map(String) : [],
        judgeAgentId: String(body.judgeAgentId ?? ''),
        prompt: String(body.prompt ?? ''),
        budgetUsd: body.budgetUsd !== undefined ? Number(body.budgetUsd) : undefined,
        deadlineMinutes: body.deadlineMinutes !== undefined ? Number(body.deadlineMinutes) : undefined,
        maxRounds: body.maxRounds !== undefined ? Number(body.maxRounds) : undefined,
        requireApproval: body.requireApproval === true,
      });
      res.status(201).json(jsonResult(result));
    }),
  );

  router.get(
    '/debates/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await getDebate(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.post(
    '/debates/:id/cancel',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ debate: await cancelDebate(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/debates/:id/decide',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const decision = String(body.decision ?? '').toUpperCase();
      if (decision !== 'APPROVED' && decision !== 'REJECTED') {
        throw AppError.badRequest('invalid_decision', 'Decision must be APPROVED or REJECTED');
      }
      res.json(jsonResult({ debate: await decideDebate(req.ctx.user!.id, req.params.id!, decision) }));
    }),
  );

  // ------------------------------------------------------ marketplace (Stage 26A)

  router.get(
    '/marketplace',
    asyncRoute(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const role = typeof req.query.role === 'string' ? req.query.role : undefined;
      res.json(jsonResult({ packages: await browseCatalogue(q, role) }));
    }),
  );

  router.get(
    '/marketplace/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ package: await getCatalogueItem(req.params.id!) }));
    }),
  );

  router.post(
    '/marketplace/:id/install',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const installed = await installPackage(req.ctx.user!.id, req.params.id!, {
        agentName: body.agentName !== undefined ? String(body.agentName) : undefined,
        trustLevel: body.trustLevel !== undefined ? String(body.trustLevel) : undefined,
      });
      res.status(201).json(jsonResult({ installed }));
    }),
  );

  router.get(
    '/installed',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ installed: await listInstalled(req.ctx.user!.id) }));
    }),
  );

  router.post(
    '/installed/:id/disable',
    asyncRoute(async (req, res) => {
      await setInstalledStatus(req.ctx.user!.id, req.params.id!, 'DISABLED');
      res.json(jsonResult({ disabled: true }));
    }),
  );

  router.post(
    '/installed/:id/enable',
    asyncRoute(async (req, res) => {
      await setInstalledStatus(req.ctx.user!.id, req.params.id!, 'ENABLED');
      res.json(jsonResult({ enabled: true }));
    }),
  );

  router.post(
    '/installed/:id/update',
    asyncRoute(async (req, res) => {
      await updateInstalled(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ updated: true }));
    }),
  );

  router.delete(
    '/installed/:id',
    asyncRoute(async (req, res) => {
      await uninstallPackage(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ deleted: true }));
    }),
  );

  return router;
};
