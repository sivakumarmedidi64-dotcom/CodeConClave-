/**
 * CodeConClave — Agent Sai Srinivasa Athreya · routes (PRIVATE single-owner).
 * GET  /sources — registry (19 final sources, text+image, no DB)
 * GET  /status  — last hashes per project (ledger-backed)
 * GET  /stream  — SSE push: heartbeat every second + state every minute
 * POST /check   — minute hash-check tick (metadata only, no download)
 * POST /pull/:sourceId — queue ONE pull on hash change (ownership-checked)
 */
import { Router } from 'express';
import { withTenant } from '../../shared/db.js';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { AGENT_NAME, INGEST_SOURCES, sourceById, sourceModalities } from './sources.js';
import {
  PUSH_HEARTBEAT_MS,
  buildPushEvent,
  fetchRemoteHead,
  formatSse,
  isAgentOwner,
  isCronSecretOk,
  persistDecision,
  tickSources,
  type PushEvent,
  type RemoteHead,
  type SourceState,
} from './service.js';

/** In-process SSE subscribers per project (single-instance free tier).
 *  Multi-instance deploys must replace this with Redis pub/sub. */
const streamClients = new Map<string, Set<(text: string) => boolean>>();

function broadcast(projectId: string, event: PushEvent): void {
  const clients = streamClients.get(projectId);
  if (!clients || clients.size === 0) return;
  const text = formatSse(event);
  for (const send of [...clients]) {
    try {
      if (!send(text)) clients.delete(send);
    } catch {
      clients.delete(send);
    }
  }
}

export const ingestRoutes = (): Router => {
  const router = Router();

  // Token-guarded cron tick (free-tier scheduler without a login session).
  // Stateless monitor: runs the full 29-source tick and returns decisions,
  // writes NO ledger rows (ledger writes stay behind login via /check).
  // Unset INGEST_CRON_SECRET = always 403. No secret, no tick.
  router.post(
    '/cron-tick',
    asyncRoute(async (req, res) => {
      if (!isCronSecretOk(req.header('x-cron-secret'))) {
        throw AppError.forbidden('cron_forbidden', 'Valid x-cron-secret required');
      }
      const dna = typeof req.body?.dnaVersion === 'string' && req.body.dnaVersion ? req.body.dnaVersion : 'v1';
      const tier = typeof req.body?.tier === 'string' && req.body.tier ? req.body.tier : 'standard';
      const states: SourceState[] = INGEST_SOURCES.map((s) => ({
        sourceId: s.id,
        lastHash: null,
        lastDna: dna,
        lastTier: tier,
        repairCount: 0,
      }));
      const remotes: RemoteHead[] = [];
      for (const s of INGEST_SOURCES) {
        if (s.kind === 'arxiv') await new Promise((r) => setTimeout(r, 3000));
        remotes.push(await fetchRemoteHead(s, dna, tier));
      }
      const decisions = tickSources(states, remotes);
      res.json(
        jsonResult({
          agent: AGENT_NAME,
          pulls: decisions.filter((d) => d.action === 'PULL').length,
          blocked: decisions.filter((d) => d.action === 'BLOCKED' || d.action === 'UNKNOWN').length,
          decisions,
        }),
      );
    }),
  );

  router.use(requireAuth);
  // Private agent: only the pinned owner may call. Unpinned (no env) falls
  // back to project ownership alone so local dev still works.
  router.use((req, _res, next) => {
    const userId = req.ctx?.user?.id;
    if (!userId || !isAgentOwner(userId)) {
      next(AppError.forbidden('agent_private', `${AGENT_NAME} is private to its owner`));
      return;
    }
    next();
  });

  router.get(
    '/sources',
    asyncRoute(async (_req, res) => {
      res.json(
        jsonResult({
          agent: AGENT_NAME,
          private: true,
          count: INGEST_SOURCES.length,
          sources: INGEST_SOURCES.map((s) => ({ ...s, modalities: sourceModalities(s) })),
        }),
      );
    }),
  );

  router.get(
    '/status',
    asyncRoute(async (req, res) => {
      const projectId = String(req.query.projectId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const userId = req.ctx.user!.id;
      const { getProject } = await import('../projects/service.js');
      await getProject(userId, projectId);
      const rows = await withTenant(userId, async (q) => {
        const r = await q.query(
          `SELECT source_id, to_hash AS last_hash, COUNT(*) FILTER (WHERE verdict='FAIL')::int AS fails
           FROM ingest_runs WHERE project_id=$1 GROUP BY source_id, to_hash`,
          [projectId],
        ).catch(() => ({ rows: [] as Array<{ source_id: string; last_hash: string | null; fails: number }> }));
        return (r as { rows: Array<{ source_id: string; last_hash: string | null; fails: number }> }).rows;
      });
      res.json(jsonResult({ agent: AGENT_NAME, states: rows }));
    }),
  );

  router.post(
    '/check',
    asyncRoute(async (req, res) => {
      const { projectId, dnaVersion, tier } = (req.body ?? {}) as {
        projectId?: string;
        dnaVersion?: string;
        tier?: string;
      };
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const userId = req.ctx.user!.id;
      const { getProject } = await import('../projects/service.js');
      await getProject(userId, projectId);
      const dna = typeof dnaVersion === 'string' && dnaVersion ? dnaVersion : 'v1';
      const budgetTier = typeof tier === 'string' && tier ? tier : 'standard';

      const saved = await withTenant(userId, async (q) => {
        const r = await q.query(
          `SELECT DISTINCT ON (source_id) source_id, to_hash AS last_hash
           FROM ingest_runs WHERE project_id=$1 ORDER BY source_id, created_at DESC`,
          [projectId],
        ).catch(() => ({ rows: [] as Array<{ source_id: string; last_hash: string | null }> }));
        return (r as { rows: Array<{ source_id: string; last_hash: string | null }> }).rows;
      });
      const savedById = new Map(saved.map((s) => [s.source_id, s.last_hash]));
      const states: SourceState[] = INGEST_SOURCES.map((s) => ({
        sourceId: s.id,
        lastHash: savedById.get(s.id) ?? null,
        lastDna: dna,
        lastTier: budgetTier,
        repairCount: 0,
      }));

      // Minute tick: metadata HEAD only, strictly sequential to stay cheap.
      // arXiv politeness: ~3s spacing between arXiv calls.
      const remotes: RemoteHead[] = [];
      for (const s of INGEST_SOURCES) {
        if (s.kind === 'arxiv') await new Promise((r) => setTimeout(r, 3000));
        remotes.push(await fetchRemoteHead(s, dna, budgetTier));
      }
      const decisions = tickSources(states, remotes);
      const pulls = decisions.filter((d) => d.action === 'PULL').length;
      const blocked = decisions.filter((d) => d.action === 'BLOCKED').length;
      let seq = 0;
      for (const d of decisions) {
        const st = states.find((s) => s.sourceId === d.sourceId);
        const rm = remotes.find((r) => r.sourceId === d.sourceId);
        await persistDecision({
          userId,
          projectId,
          sourceId: d.sourceId,
          action: d.action,
          reason: d.reason,
          fromHash: st?.lastHash ?? null,
          toHash: rm?.revisionHash ?? null,
        });
        // Automatic push: every PULL decision streams to the owner instantly.
        if (d.action === 'PULL') {
          broadcast(
            projectId,
            buildPushEvent('data_ingested', seq++, {
              sourceId: d.sourceId,
              reason: d.reason,
              toHash: rm?.revisionHash ?? null,
            }),
          );
        }
      }
      res.json(jsonResult({ agent: AGENT_NAME, decisions, pulls, blocked }));
    }),
  );

  router.post(
    '/pull/:sourceId',
    asyncRoute(async (req, res) => {
      const { projectId } = (req.body ?? {}) as { projectId?: string };
      const sourceId = String(req.params.sourceId ?? '');
      if (!projectId) throw AppError.badRequest('project_required', 'projectId is required');
      const source = sourceById(sourceId);
      if (!source) throw AppError.badRequest('unknown_source', `Unknown ingest source: ${sourceId}`);
      if (source.evalOnly) {
        throw AppError.forbidden('eval_only', `${source.name} is eval-only (SWE-bench): never train on it`);
      }
      const userId = req.ctx.user!.id;
      const { getProject } = await import('../projects/service.js');
      await getProject(userId, projectId);
      await persistDecision({
        userId,
        projectId,
        sourceId,
        action: 'PULL',
        reason: 'operator_queued_single_pull',
        fromHash: null,
        toHash: null,
      });
      broadcast(projectId, buildPushEvent('data_ingested', 0, { sourceId, reason: 'operator_queued_single_pull' }));
      res.json(
        jsonResult({
          agent: AGENT_NAME,
          queued: sourceId,
          note: 'One pull queued. Full download runs off-tick with Gate + Verify before any Blob write.',
        }),
      );
    }),
  );

  router.get('/stream', (req, res) => {
    const projectId = String(req.query.projectId ?? '');
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    // SSE push channel: heartbeat to the owner every second so data feels
    // live; upstream source checks stay on the minute tick (see /check).
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let seq = 0;
    const send = (text: string): boolean => {
      try {
        res.write(text);
        return true;
      } catch {
        return false;
      }
    };
    send(formatSse(buildPushEvent('hello', seq++, { projectId, modalities: ['text', 'image'] })));
    const timer = setInterval(() => {
      const ok = send(formatSse(buildPushEvent('heartbeat', seq++, { projectId })));
      if (!ok) clearInterval(timer);
    }, PUSH_HEARTBEAT_MS);
    let set = streamClients.get(projectId);
    if (!set) {
      set = new Set();
      streamClients.set(projectId, set);
    }
    set.add(send);
    req.on('close', () => {
      clearInterval(timer);
      set.delete(send);
      if (set.size === 0) streamClients.delete(projectId);
    });
  });

  return router;
};
