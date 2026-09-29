/**
 * CodeConClave — PKG-11 Team Collaboration routes.
 * Auth + server-side team RBAC only (never frontend-only authorization).
 * Every handler goes through requireAuth and the TeamCollaboration service
 * which re-resolves the caller's role from the teams module on every call.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { MemoryStateStore, type StateStore } from '../../os/state.js';
import { TeamCollaboration, defaultTeamAccess, QUEUE_STATUSES, type QueueStatus } from './service.js';

let singleton: TeamCollaboration | null = null;

export const teamCollabRoutes = (opts: { state?: StateStore } = {}): Router => {
  const router = Router();
  router.use(requireAuth);

  const svc = () => {
    if (!singleton) {
      singleton = new TeamCollaboration({
        state: opts.state ?? new MemoryStateStore(),
        teamAccess: defaultTeamAccess(),
      });
    }
    return singleton;
  };

  const teamId = (req: { params: Record<string, string> }) => String(req.params.teamId);

  // presence
  router.post(
    '/:teamId/presence/heartbeat',
    asyncRoute(async (req, res) => {
      const signal = String((req.body as { signal?: string }).signal ?? 'active') as 'active' | 'idle' | 'busy';
      await svc().heartbeat(req.ctx.user!.id, teamId(req), signal);
      res.json(jsonResult({ ok: true }));
    }),
  );
  router.get(
    '/:teamId/presence',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await svc().listPresence(req.ctx.user!.id, teamId(req))));
    }),
  );

  // async handoff
  router.post(
    '/:teamId/handoffs',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as {
        toUserId?: string | null;
        workspaceId?: string | null;
        taskContext?: string;
        files?: string[];
        memoryRefs?: string[];
        reviewState?: string | null;
      };
      const h = await svc().createHandoff(req.ctx.user!.id, teamId(req), {
        toUserId: body.toUserId ?? null,
        workspaceId: body.workspaceId ?? null,
        taskContext: String(body.taskContext ?? ''),
        files: body.files,
        memoryRefs: body.memoryRefs,
        reviewState: body.reviewState ?? null,
      });
      res.json(jsonResult({ handoff: h }));
    }),
  );
  router.get(
    '/:teamId/handoffs',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ handoffs: await svc().listHandoffs(req.ctx.user!.id, teamId(req)) }));
    }),
  );
  router.post(
    '/:teamId/handoffs/:handoffId/accept',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ handoff: await svc().acceptHandoff(req.ctx.user!.id, teamId(req), String(req.params.handoffId)) }));
    }),
  );
  router.post(
    '/:teamId/handoffs/:handoffId/status',
    asyncRoute(async (req, res) => {
      const status = String((req.body as { status?: string }).status ?? '') as 'COMPLETED' | 'FAILED' | 'CANCELLED';
      res.json(jsonResult({ handoff: await svc().updateHandoff(req.ctx.user!.id, teamId(req), String(req.params.handoffId), status) }));
    }),
  );

  // collaboration queue
  router.post(
    '/:teamId/queue',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { title?: string; assigneeId?: string | null };
      res.json(jsonResult({ item: await svc().enqueue(req.ctx.user!.id, teamId(req), String(body.title ?? ''), body.assigneeId) }));
    }),
  );
  router.get(
    '/:teamId/queue',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ items: await svc().listQueue(req.ctx.user!.id, teamId(req)) }));
    }),
  );
  router.post(
    '/:teamId/queue/:itemId/status',
    asyncRoute(async (req, res) => {
      const status = String((req.body as { status?: string }).status ?? '') as QueueStatus;
      if (!QUEUE_STATUSES.includes(status)) throw new Error('invalid queue status');
      res.json(jsonResult({ item: await svc().setQueueStatus(req.ctx.user!.id, teamId(req), String(req.params.itemId), status) }));
    }),
  );

  // team context (shared only)
  router.post(
    '/:teamId/context',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { title?: string; body?: string };
      res.json(jsonResult({ entry: await svc().writeContext(req.ctx.user!.id, teamId(req), { title: String(body.title ?? ''), body: String(body.body ?? '') }) }));
    }),
  );
  router.get(
    '/:teamId/context',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ entries: await svc().listContext(req.ctx.user!.id, teamId(req)) }));
    }),
  );

  // code ownership
  router.post(
    '/:teamId/ownership',
    asyncRoute(async (req, res) => {
      const paths = ((req.body as { paths?: unknown }).paths ?? []) as Array<{ path: string; ownerUserId: string; confidence: number }>;
      await svc().setOwnership(req.ctx.user!.id, teamId(req), paths);
      res.json(jsonResult({ ok: true }));
    }),
  );
  router.get(
    '/:teamId/ownership',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ entries: await svc().listOwnership(req.ctx.user!.id, teamId(req)) }));
    }),
  );

  // team skill visibility
  router.get(
    '/:teamId/skills',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ skills: await svc().listTeamSkills(req.ctx.user!.id, teamId(req)) }));
    }),
  );
  router.post(
    '/:teamId/skills',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { id?: string; name?: string; visible?: boolean };
      await svc().publishTeamSkill(req.ctx.user!.id, teamId(req), { id: String(body.id ?? ''), name: String(body.name ?? ''), visible: body.visible });
      res.json(jsonResult({ ok: true }));
    }),
  );

  // conflict coordination
  router.post(
    '/:teamId/conflicts',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { topic?: string; evidence?: string[]; participants?: string[] };
      const r = await svc().recordConflict(req.ctx.user!.id, teamId(req), {
        topic: String(body.topic ?? ''),
        evidence: (body.evidence ?? []).map(String),
        participants: (body.participants ?? []).map(String),
      });
      res.json(jsonResult(r));
    }),
  );

  return router;
};
