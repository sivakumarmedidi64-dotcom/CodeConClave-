/**
 * CodeConClave — recovery routes (Stage 26E).
 * Failure autopsy, checkpoints, pause/resume, time travel (rewind/branch),
 * recovery-aware history, and irreversible action records.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import type { PlanEntryInput } from '../execution/planner.js';
import { createCheckpoint, listCheckpoints } from './checkpoints.js';
import { pauseTask, resumeTask, modifyFutureSteps, branchTask, rewindTask } from './timeTravel.js';
import { generateAutopsy, getAutopsy, listAutopsies, applyRemediation } from './autopsy.js';
import { listRecoveryHistory } from './history.js';
import { recordIrreversibleAction, listIrreversibleActions } from './irreversible.js';

function parseEntries(body: Record<string, unknown>): PlanEntryInput[] {
  const raw = body.entries;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw AppError.badRequest('invalid_entries', 'entries must be a non-empty array');
  }
  return raw.map((e) => {
    if (typeof e !== 'object' || e === null || typeof (e as { coworker?: unknown }).coworker !== 'string') {
      throw AppError.badRequest('invalid_entry', 'each entry requires a coworker string');
    }
    const ent = e as Record<string, unknown>;
    return {
      coworker: String(ent.coworker),
      input: typeof ent.input === 'object' && ent.input !== null ? (ent.input as Record<string, unknown>) : {},
      parallelGroup: typeof ent.parallelGroup === 'number' ? ent.parallelGroup : undefined,
      requiredTools: Array.isArray(ent.requiredTools) ? (ent.requiredTools as string[]) : undefined,
      risk: typeof ent.risk === 'string' ? (ent.risk as PlanEntryInput['risk']) : undefined,
      acceptanceCriteria: typeof ent.acceptanceCriteria === 'string' ? ent.acceptanceCriteria : undefined,
      expectedArtifacts: Array.isArray(ent.expectedArtifacts) ? (ent.expectedArtifacts as string[]) : undefined,
    };
  });
}

export const recoveryRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const userId = (req: { ctx?: { user?: { id?: string } | null } }): string => {
    const id = req.ctx?.user?.id;
    if (!id) throw AppError.unauthorized('authentication_required', 'Authentication required');
    return id;
  };
  const tid = (v: string | undefined): string => {
    if (!v) throw AppError.badRequest('missing_task_id', 'Task id is required');
    return v;
  };

  router.get('/tasks/:id/history', asyncRoute(async (req, res) => {
    const history = await listRecoveryHistory(userId(req), tid(req.params.id));
    res.json(jsonResult({ history }));
  }));

  router.get('/tasks/:id/checkpoints', asyncRoute(async (req, res) => {
    const checkpoints = await listCheckpoints(userId(req), tid(req.params.id));
    res.json(jsonResult({ checkpoints }));
  }));

  router.post('/tasks/:id/checkpoints', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const checkpoint = await createCheckpoint(userId(req), tid(req.params.id), {
      label: typeof body.label === 'string' ? body.label : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    res.status(201).json(jsonResult({ checkpoint }));
  }));

  router.post('/tasks/:id/pause', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const task = await pauseTask(userId(req), tid(req.params.id), {
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    res.json(jsonResult({ task }));
  }));

  router.post('/tasks/:id/resume', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const task = await resumeTask(userId(req), tid(req.params.id), {
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      modifySteps: body.modifySteps ? { entries: parseEntries(body.modifySteps as Record<string, unknown>) } : undefined,
    });
    res.json(jsonResult({ task }));
  }));

  router.post('/tasks/:id/modify-steps', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await modifyFutureSteps(userId(req), tid(req.params.id), {
      entries: parseEntries(body),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    res.json(jsonResult({ modified: true }));
  }));

  router.post('/tasks/:id/branch', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await branchTask(userId(req), tid(req.params.id), {
      checkpointId: typeof body.checkpointId === 'string' ? body.checkpointId : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    res.status(201).json(jsonResult(result));
  }));

  router.post('/tasks/:id/rewind', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.checkpointId !== 'string') {
      throw AppError.badRequest('missing_checkpoint_id', 'checkpointId is required');
    }
    const result = await rewindTask(userId(req), tid(req.params.id), {
      checkpointId: body.checkpointId,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    res.status(201).json(jsonResult(result));
  }));

  router.get('/tasks/:id/autopsy', asyncRoute(async (req, res) => {
    const autopsy = await getAutopsy(userId(req), tid(req.params.id));
    res.json(jsonResult({ autopsy }));
  }));

  router.get('/tasks/:id/autopsies', asyncRoute(async (req, res) => {
    const autopsies = await listAutopsies(userId(req), tid(req.params.id));
    res.json(jsonResult({ autopsies }));
  }));

  router.post('/tasks/:id/autopsy', asyncRoute(async (req, res) => {
    const autopsy = await generateAutopsy(userId(req), tid(req.params.id));
    res.status(201).json(jsonResult({ autopsy }));
  }));

  router.post('/tasks/:id/remediate', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.action !== 'string' || body.action.length === 0) {
      throw AppError.badRequest('missing_action', 'action is required');
    }
    await applyRemediation(userId(req), tid(req.params.id), {
      action: body.action,
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    res.json(jsonResult({ remediated: true }));
  }));

  router.post('/tasks/:id/irreversible', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.actionType !== 'string' || typeof body.description !== 'string') {
      throw AppError.badRequest('invalid_irreversible', 'actionType and description are required');
    }
    const action = await recordIrreversibleAction(userId(req), tid(req.params.id), {
      actionType: body.actionType,
      description: body.description,
      detail: typeof body.detail === 'object' && body.detail !== null ? (body.detail as Record<string, unknown>) : undefined,
    });
    res.status(201).json(jsonResult({ action }));
  }));

  router.get('/tasks/:id/irreversible', asyncRoute(async (req, res) => {
    const actions = await listIrreversibleActions(userId(req), tid(req.params.id));
    res.json(jsonResult({ actions }));
  }));

  return router;
};