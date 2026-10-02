/**
 * CodeConClave — memory routes.
 */
import { Router } from 'express';
import {
  createMemorySchema,
  memoryCorrectionSchema,
  memoryMergeSchema,
  memoryRelationshipSchema,
  memorySearchSchema,
  MemoryType,
  MemorySource,
  decisionStatusSchema,
} from '@codeconclave/shared';
import { jsonResult } from '../auth/schemas.js';
import {
  addMemoryRelationship,
  addMemorySource,
  correctMemory,
  createMemory,
  flagMemoryWrong,
  getMemory,
  listMemories,
  listMemoryRelationships,
  listMemorySources,
  listTeamMemories,
  mergeMemories,
  processEmbeddingQueue,
  restoreMemory,
  searchMemories,
  semanticSearch,
  softDeleteMemory,
  toMemoryJson,
  trashMemories,
  updateMemory,
  verifyMemory,
} from './service.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  addPattern,
  deleteHandoff,
  generateHandoff,
  getCrossProjectOptIn,
  getHandoff,
  getTimeline,
  listHandoffs,
  saveHandoff,
  setCrossProjectOptIn,
  suggestPatterns,
} from './continuity.js';
import {
  detectConflict,
  getDecision,
  listConflicts,
  listDecisionSources,
  listDecisions,
  recordDecision,
  replayDecision,
  resolveConflict,
  setDecisionStatus,
  softDeleteDecision,
} from './decisions.js';

export const memoryRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const type = req.query.type ? String(req.query.type) : undefined;
      const search = req.query.q ? String(req.query.q) : undefined;
      const includeTeam = req.query.team === '1';
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(Number(req.query.pageSize ?? 50), 200);
      const result = await listMemories(req.ctx.user!.id, {
        projectId,
        type: type as never,
        search,
        includeTeam,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      res.json(jsonResult({ memories: result.items.map(toMemoryJson), total: result.total, page, pageSize }));
    }),
  );

  router.get(
    '/team/:teamId',
    asyncRoute(async (req, res) => {
      const teamId = String(req.params.teamId!);
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const type = req.query.type ? String(req.query.type) : undefined;
      const search = req.query.q ? String(req.query.q) : undefined;
      const minConfidence = req.query.minConfidence ? Number(req.query.minConfidence) : undefined;
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(Number(req.query.pageSize ?? 50), 200);
      const result = await listTeamMemories(req.ctx.user!.id, teamId, {
        projectId,
        type: type as never,
        search,
        minConfidence,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      res.json(jsonResult({ memories: result.items.map(toMemoryJson), total: result.total, page, pageSize }));
    }),
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const input = createMemorySchema.parse(req.body);
      const memory = await createMemory(req.ctx.user!.id, {
        projectId: input.projectId,
        type: input.type as MemoryType,
        source: input.source as MemorySource,
        content: input.content,
        confidence: input.confidence,
      });
      res.status(201).json(jsonResult({ memory: toMemoryJson(memory) }));
    }),
  );

  router.post(
    '/search',
    asyncRoute(async (req, res) => {
      const input = memorySearchSchema.parse(req.body);
      const result = await searchMemories(req.ctx.user!.id, {
        query: input.query,
        mode: input.mode as 'VECTOR' | 'FULL_TEXT' | 'HYBRID',
        projectId: input.projectId,
        searchAll: input.searchAll,
        type: input.type as MemoryType | undefined,
        minConfidence: input.minConfidence,
        verification: input.verification ?? null,
        contradiction: input.contradiction ?? null,
        limit: input.limit,
      });
      res.json(jsonResult({ memories: result.items.map(toMemoryJson), modeUsed: result.modeUsed }));
    }),
  );

  router.post(
    '/merge',
    asyncRoute(async (req, res) => {
      const input = memoryMergeSchema.parse(req.body);
      const merged = await mergeMemories(req.ctx.user!.id, input.targetId, input.intoId, input.note);
      res.json(jsonResult({ memory: toMemoryJson(merged) }));
    }),
  );

  router.post(
    '/relationships',
    asyncRoute(async (req, res) => {
      const input = memoryRelationshipSchema.parse(req.body);
      await addMemoryRelationship(req.ctx.user!.id, input.sourceMemoryId, input.targetMemoryId, input.relation, input.weight);
      res.status(201).json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/queue/process',
    asyncRoute(async (req, res) => {
      const processed = await processEmbeddingQueue();
      res.json(jsonResult({ processed }));
    }),
  );
  router.get(
    '/search',
    asyncRoute(async (req, res) => {
      const q = String(req.query.q ?? '');
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      if (!q.trim()) res.json(jsonResult({ memories: [] }));
      else res.json(jsonResult({ memories: (await semanticSearch(req.ctx.user!.id, q, projectId)).map(toMemoryJson) }));
    }),
  );

  router.get(
    '/trash',
    asyncRoute(async (req, res) => res.json(jsonResult({ memories: (await trashMemories(req.ctx.user!.id)).map(toMemoryJson) }))),
  );

  router.get(
    '/:id',
    asyncRoute(async (req, res) => res.json(jsonResult({ memory: toMemoryJson(await getMemory(req.ctx.user!.id, req.params.id!)) }))),
  );

  router.patch(
    '/:id',
    asyncRoute(async (req, res) => {
      const patch: { content?: string; confidence?: number; source?: never; structured?: Record<string, unknown> | null } = {};
      if (typeof req.body.content === 'string') patch.content = req.body.content;
      if (typeof req.body.confidence === 'number') patch.confidence = req.body.confidence;
      if (typeof req.body.source === 'string') patch.source = req.body.source as never;
      if (req.body.structured !== undefined) patch.structured = req.body.structured;
      res.json(jsonResult({ memory: toMemoryJson(await updateMemory(req.ctx.user!.id, req.params.id!, patch)) }));
    }),
  );

  router.delete(
    '/:id',
    asyncRoute(async (req, res) => {
      await softDeleteMemory(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/:id/restore',
    asyncRoute(async (req, res) => res.json(jsonResult({ memory: toMemoryJson(await restoreMemory(req.ctx.user!.id, req.params.id!)) }))),
  );

  router.post(
    '/:id/flag-wrong',
    asyncRoute(async (req, res) => {
      const note = typeof req.body.note === 'string' ? req.body.note : undefined;
      res.json(jsonResult({ memory: toMemoryJson(await flagMemoryWrong(req.ctx.user!.id, req.params.id!, note)) }));
    }),
  );

  router.get(
    '/:id/sources',
    asyncRoute(async (req, res) => res.json(jsonResult({ sources: await listMemorySources(req.ctx.user!.id, req.params.id!) }))),
  );

  router.post(
    '/:id/sources',
    asyncRoute(async (req, res) => {
      const sourceLabel = String(req.body.sourceLabel ?? '');
      const sourceRef = String(req.body.sourceRef ?? '');
      if (!['OBSERVED', 'USER_STATED', 'AI_INFERRED', 'RECOMMENDATION'].includes(sourceLabel)) {
        res.status(400).json({ error: { code: 'invalid_source_label', message: 'Invalid source label' } });
        return;
      }
      await addMemorySource(req.ctx.user!.id, req.params.id!, sourceLabel as never, sourceRef);
      res.status(201).json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/:id/correct',
    asyncRoute(async (req, res) => {
      const input = memoryCorrectionSchema.parse(req.body);
      res.json(jsonResult({ memory: toMemoryJson(await correctMemory(req.ctx.user!.id, req.params.id!, input.reason)) }));
    }),
  );

  router.post(
    '/:id/verify',
    asyncRoute(async (req, res) => {
      const state = req.body.state === 'REJECTED' ? 'REJECTED' : req.body.state === 'VERIFIED' ? 'VERIFIED' : undefined;
      if (!state) {
        res.status(400).json({ error: { code: 'invalid_verification_state', message: 'state must be VERIFIED or REJECTED' } });
        return;
      }
      res.json(jsonResult({ memory: toMemoryJson(await verifyMemory(req.ctx.user!.id, req.params.id!, state)) }));
    }),
  );

  router.get(
    '/:id/relationships',
    asyncRoute(async (req, res) => res.json(jsonResult({ relationships: await listMemoryRelationships(req.ctx.user!.id, req.params.id!) }))),
  );

  // --------------------------------------------------- decisions (Stage 26B)

  router.get(
    '/decisions',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const status = req.query.status ? String(req.query.status) : undefined;
      const decisions = status ? await listDecisions(req.ctx.user!.id, projectId, status as never) : await listDecisions(req.ctx.user!.id, projectId);
      res.json(jsonResult({ decisions }));
    }),
  );

  router.post(
    '/decisions',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const decision = await recordDecision(req.ctx.user!.id, {
        title: String(body.title ?? ''),
        decision: String(body.decision ?? ''),
        projectId: body.projectId ? String(body.projectId) : null,
        context: body.context ? String(body.context) : undefined,
        alternatives: Array.isArray(body.alternatives) ? body.alternatives.map(String) : undefined,
        rationale: body.rationale ? String(body.rationale) : undefined,
        consequences: Array.isArray(body.consequences) ? body.consequences.map(String) : undefined,
        sourceConversationId: body.sourceConversationId ? String(body.sourceConversationId) : null,
        sourceTaskId: body.sourceTaskId ? String(body.sourceTaskId) : null,
        evidenceRef: body.evidenceRef ? String(body.evidenceRef) : undefined,
        impact: body.impact ?? 'MEDIUM',
      });
      res.status(201).json(jsonResult({ decision }));
    }),
  );

  router.post(
    '/decisions/replay',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const result = await replayDecision(req.ctx.user!.id, String(body.query ?? ''));
      res.json(jsonResult(result));
    }),
  );

  router.post(
    '/decisions/conflicts/detect',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult(await detectConflict(req.ctx.user!.id, String(body.requestText ?? ''))));
    }),
  );

  router.get(
    '/decisions/conflicts',
    asyncRoute(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      res.json(jsonResult({ conflicts: await listConflicts(req.ctx.user!.id, status) }));
    }),
  );

  router.post(
    '/decisions/conflicts/:id/resolve',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const resolution = String(body.resolution ?? '').toUpperCase();
      if (!['KEEP', 'REPLACE', 'EXCEPTION', 'CANCEL'].includes(resolution)) {
        throw AppError.badRequest('invalid_resolution', 'Resolution must be KEEP, REPLACE, EXCEPTION or CANCEL');
      }
      const conflict = await resolveConflict(req.ctx.user!.id, req.params.id!, {
        resolution: resolution as 'KEEP' | 'REPLACE' | 'EXCEPTION' | 'CANCEL',
        note: body.note ? String(body.note) : undefined,
        approved: body.approved === true,
        replacement: body.replacement
          ? {
              title: String(body.replacement.title ?? ''),
              decision: String(body.replacement.decision ?? ''),
              projectId: body.replacement.projectId ? String(body.replacement.projectId) : null,
              context: body.replacement.context ? String(body.replacement.context) : undefined,
              alternatives: Array.isArray(body.replacement.alternatives) ? body.replacement.alternatives.map(String) : undefined,
              rationale: body.replacement.rationale ? String(body.replacement.rationale) : undefined,
              consequences: Array.isArray(body.replacement.consequences) ? body.replacement.consequences.map(String) : undefined,
              impact: body.replacement.impact ?? 'MEDIUM',
            }
          : undefined,
      });
      res.json(jsonResult({ conflict }));
    }),
  );

  router.get(
    '/decisions/:id',
    asyncRoute(async (req, res) => res.json(jsonResult({ decision: await getDecision(req.ctx.user!.id, req.params.id!) }))),
  );

  router.get(
    '/decisions/:id/sources',
    asyncRoute(async (req, res) =>
      res.json(jsonResult({ sources: await listDecisionSources(req.ctx.user!.id, req.params.id!) })),
    ),
  );

  router.patch(
    '/decisions/:id/status',
    asyncRoute(async (req, res) => {
      const input = decisionStatusSchema.parse(req.body ?? {});
      res.json(jsonResult({ decision: await setDecisionStatus(req.ctx.user!.id, req.params.id!, input.status) }));
    }),
  );

  router.delete(
    '/decisions/:id',
    asyncRoute(async (req, res) => {
      await softDeleteDecision(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  // --------------------------------------------------- cross-project (Stage 26B)

  router.get(
    '/cross-project/opt-in',
    asyncRoute(async (req, res) => res.json(jsonResult({ optIn: await getCrossProjectOptIn(req.ctx.user!.id) }))),
  );

  router.post(
    '/cross-project/opt-in',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      res.json(jsonResult({ optIn: await setCrossProjectOptIn(req.ctx.user!.id, body.enabled === true) }));
    }),
  );

  router.post(
    '/cross-project/patterns',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const pattern = await addPattern(req.ctx.user!.id, {
        sourceProjectId: String(body.sourceProjectId ?? ''),
        name: String(body.name ?? ''),
        pattern: String(body.pattern ?? ''),
        tag: body.tag ? String(body.tag) : undefined,
        proven: body.proven === true,
      });
      res.status(201).json(jsonResult({ pattern }));
    }),
  );

  router.get(
    '/cross-project/patterns/suggest',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const tag = req.query.tag ? String(req.query.tag) : undefined;
      if (!projectId) throw AppError.badRequest('project_id_required', 'projectId is required');
      res.json(jsonResult(await suggestPatterns(req.ctx.user!.id, projectId, tag)));
    }),
  );

  // --------------------------------------------------- handoffs (Stage 26B)

  router.get(
    '/handoffs/generate',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId ? String(req.query.projectId) : null;
      res.json(jsonResult(await generateHandoff(req.ctx.user!.id, projectId)));
    }),
  );

  router.get(
    '/handoffs',
    asyncRoute(async (req, res) => {
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      res.json(jsonResult({ handoffs: await listHandoffs(req.ctx.user!.id, projectId) }));
    }),
  );

  router.post(
    '/handoffs',
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const handoff = await saveHandoff(req.ctx.user!.id, {
        projectId: body.projectId ? String(body.projectId) : null,
        title: String(body.title ?? ''),
        content: String(body.content ?? ''),
      });
      res.status(201).json(jsonResult({ handoff }));
    }),
  );

  router.get(
    '/handoffs/:id',
    asyncRoute(async (req, res) => res.json(jsonResult({ handoff: await getHandoff(req.ctx.user!.id, req.params.id!) }))),
  );

  router.delete(
    '/handoffs/:id',
    asyncRoute(async (req, res) => {
      await deleteHandoff(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  // --------------------------------------------------- timeline (Stage 26B)

  router.get(
    '/timeline',
    asyncRoute(async (req, res) => {
      const since = req.query.since ? String(req.query.since) : undefined;
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      res.json(jsonResult({ items: await getTimeline(req.ctx.user!.id, { since, projectId, limit }) }));
    }),
  );

  return router;
};