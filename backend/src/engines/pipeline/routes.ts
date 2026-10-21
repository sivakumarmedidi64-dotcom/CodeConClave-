/**
 * Pipeline v3 API (/api/v1/pipeline):
 *   GET  /registry      the 13 roles: contract version, resident driver, readiness
 *   GET  /runs          your recent runs (filter ?status=ESCALATED for the operator view)
 *   GET  /runs/:id      one run: receipt + its hash-linked events + chain check
 *   POST /verify        run the Scientific Verification Kernel on claims you send
 *                       (pure software — 0 tokens; every proof hashed)
 */
import { Router } from 'express';
import { jsonResult } from '../../modules/auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import { residentReady } from '../../modules/resident/infer.js';
import { ROLE_CONTRACTS, contractVersion, driverSlot } from './contracts.js';
import { getRun, listRuns, verifyEvents, type RunStatus } from './ledger.js';
import { runKernel, VERIFIER_FOR, KERNEL_VERSION, type Claim } from '../kernel/index.js';

const STATUSES: RunStatus[] = ['RUNNING', 'KNOWN', 'VERIFIED', 'UNVERIFIED', 'CACHED', 'DENIED', 'ESCALATED', 'NEEDS_BUDGET', 'HALTED', 'FAILED'];

export const pipelineRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/registry',
    asyncRoute(async (_req, res) => {
      const roles = ROLE_CONTRACTS.map((c) => {
        const ready = residentReady(c.role);
        return {
          role: c.role,
          lane: c.lane,
          science: c.science,
          contractVersion: contractVersion(c),
          driver: driverSlot(c.role).split('/').pop(),
          residentReady: ready.ok,
          residentNote: ready.ok ? null : ready.reason,
          claimKinds: c.claimKinds,
          tools: c.tools,
        };
      });
      res.json(jsonResult({ roles, kernelVersion: KERNEL_VERSION }));
    }),
  );

  router.get(
    '/runs',
    asyncRoute(async (req, res) => {
      const status = typeof req.query.status === 'string' && (STATUSES as string[]).includes(req.query.status) ? (req.query.status as RunStatus) : undefined;
      const runs = await listRuns(req.ctx.user!.id, { status, limit: Number(req.query.limit ?? 50) });
      res.json(
        jsonResult({
          runs: runs.map((r) => ({
            id: r.id,
            status: r.status,
            role: r.role,
            lane: r.lane,
            risk: r.risk,
            attempts: r.attempts,
            tokensUsed: r.tokens_used,
            budgetTokens: r.budget_tokens,
            proofHash: r.proof_hash,
            createdAt: r.created_at,
            sealedAt: r.sealed_at,
          })),
        }),
      );
    }),
  );

  router.get(
    '/runs/:id',
    asyncRoute(async (req, res) => {
      const found = await getRun(req.ctx.user!.id, String(req.params.id));
      if (!found) throw AppError.notFound('Run');
      const chain = verifyEvents(found.run.id, found.events, found.run.head_hash);
      res.json(jsonResult({ run: found.run, events: found.events, chain }));
    }),
  );

  router.post(
    '/verify',
    asyncRoute(async (req, res) => {
      const raw = (req.body ?? {}).claims as unknown;
      const list = Array.isArray(raw) ? raw : [];
      if (list.length === 0 || list.length > 24) throw AppError.badRequest('invalid_claims', 'Send 1–24 claims as { "claims": [...] }.');
      for (const c of list) {
        if (!c || typeof c !== 'object' || !((c as Claim).kind in VERIFIER_FOR)) {
          throw AppError.badRequest('invalid_claims', `Unknown claim kind. Use one of: ${Object.keys(VERIFIER_FOR).join(', ')}.`);
        }
      }
      if (JSON.stringify(list).length > 64 * 1024) throw AppError.badRequest('invalid_claims', 'Claims are larger than 64 KB.');
      const seed = typeof req.body?.seed === 'string' ? req.body.seed.slice(0, 64) : `verify:${req.ctx.user!.id}:${Date.now()}`;
      res.json(jsonResult({ kernel: runKernel(list as Claim[], seed), seed }));
    }),
  );

  return router;
};
