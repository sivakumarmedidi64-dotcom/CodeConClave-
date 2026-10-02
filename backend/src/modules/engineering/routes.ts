/**
 * CodeConClave — engineering agent swarm routes (Stage 26F).
 * PR Review Swarm, Dependency Upgrade Agent, Flaky Test Hunter,
 * Self-Healing CI.
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  startPrReview, runPrReview, getSwarm, listSwarms, listSwarmFindings, decideFinding,
} from './prReview.js';
import {
  startUpgrade, stepUpgrade, acceptUpgrade, rollbackUpgrade, failUpgrade, getUpgrade, listUpgrades,
} from './dependencyUpgrade.js';
import {
  analyzeTestRuns, createInvestigationTask, markFlakeResolved, getFlake, listFlakes,
} from './flakeHunter.js';
import {
  recordCiFailure, proposeCiFix, applyCiFix, decideCiFixApproval, recordRetest, getCiRun, listCiRuns,
} from './selfHealingCi.js';

function parseFiles(raw: unknown): { path: string; content: string }[] {
  if (!Array.isArray(raw)) {
    throw AppError.badRequest('invalid_files', 'files must be an array of {path, content}');
  }
  return raw.map((f) => {
    if (typeof f !== 'object' || f === null) throw AppError.badRequest('invalid_files', 'each file requires path and content');
    const file = f as Record<string, unknown>;
    if (typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw AppError.badRequest('invalid_files', 'each file requires path and content');
    }
    return { path: file.path, content: file.content };
  });
}

function parseRuns(raw: unknown): { status: 'PASSED' | 'FAILED'; durationMs: number; timestamp: string; environment?: string | null; concurrent?: boolean }[] {
  if (!Array.isArray(raw)) {
    throw AppError.badRequest('invalid_runs', 'runs must be an array');
  }
  return raw.map((r) => {
    if (typeof r !== 'object' || r === null) throw AppError.badRequest('invalid_runs', 'each run must be an object');
    const run = r as Record<string, unknown>;
    if (run.status !== 'PASSED' && run.status !== 'FAILED') throw AppError.badRequest('invalid_runs', 'run status must be PASSED or FAILED');
    if (typeof run.durationMs !== 'number' || typeof run.timestamp !== 'string') {
      throw AppError.badRequest('invalid_runs', 'each run requires durationMs and timestamp');
    }
    return {
      status: run.status,
      durationMs: run.durationMs,
      timestamp: run.timestamp,
      environment: typeof run.environment === 'string' || run.environment === null ? run.environment : null,
      concurrent: typeof run.concurrent === 'boolean' ? run.concurrent : undefined,
    };
  });
}

export const engineeringRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const userId = (req: { ctx?: { user?: { id?: string } | null } }): string => {
    const id = req.ctx?.user?.id;
    if (!id) throw AppError.unauthorized('authentication_required', 'Authentication required');
    return id;
  };
  const rid = (v: string | undefined): string => {
    if (!v) throw AppError.badRequest('missing_id', 'Resource id is required');
    return v;
  };
  const str = (body: Record<string, unknown>, key: string): string | undefined =>
    typeof body[key] === 'string' ? (body[key] as string) : undefined;

  // ---------------------------------------------------------- PR Review Swarm
  router.post('/pr-reviews', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.projectId !== 'string' || typeof body.prRef !== 'string') {
      throw AppError.badRequest('pr_review_invalid_input', 'projectId and prRef are required');
    }
    const swarm = await startPrReview(userId(req), {
      projectId: body.projectId,
      prRef: body.prRef,
      targetRef: str(body, 'targetRef'),
      title: str(body, 'title'),
      files: parseFiles(body.files),
    });
    res.status(201).json(jsonResult({ swarm }));
  }));

  router.post('/pr-reviews/:id/run', asyncRoute(async (req, res) => {
    const swarm = await runPrReview(userId(req), rid(req.params.id));
    res.json(jsonResult({ swarm }));
  }));

  router.get('/pr-reviews', asyncRoute(async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const swarms = await listSwarms(userId(req), projectId);
    res.json(jsonResult({ swarms }));
  }));

  router.get('/pr-reviews/:id', asyncRoute(async (req, res) => {
    const swarm = await getSwarm(userId(req), rid(req.params.id));
    res.json(jsonResult({ swarm }));
  }));

  router.get('/pr-reviews/:id/findings', asyncRoute(async (req, res) => {
    const findings = await listSwarmFindings(userId(req), rid(req.params.id));
    res.json(jsonResult({ findings }));
  }));

  router.post('/findings/:id/decide', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.decision !== 'ACCEPTED' && body.decision !== 'DISMISSED') {
      throw AppError.badRequest('invalid_decision', 'decision must be ACCEPTED or DISMISSED');
    }
    const finding = await decideFinding(userId(req), rid(req.params.id), body.decision);
    res.json(jsonResult({ finding }));
  }));

  // ------------------------------------------------------ Dependency Upgrades
  router.post('/upgrades', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.projectId !== 'string' || typeof body.packageName !== 'string' ||
        typeof body.fromVersion !== 'string' || typeof body.toVersion !== 'string' || typeof body.manifestPath !== 'string') {
      throw AppError.badRequest('upgrade_invalid_input', 'projectId, packageName, fromVersion, toVersion and manifestPath are required');
    }
    const upgrade = await startUpgrade(userId(req), {
      projectId: body.projectId,
      packageName: body.packageName,
      fromVersion: body.fromVersion,
      toVersion: body.toVersion,
      manifestPath: body.manifestPath,
    });
    res.status(201).json(jsonResult({ upgrade }));
  }));

  router.get('/upgrades', asyncRoute(async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const upgrades = await listUpgrades(userId(req), projectId);
    res.json(jsonResult({ upgrades }));
  }));

  router.get('/upgrades/:id', asyncRoute(async (req, res) => {
    const upgrade = await getUpgrade(userId(req), rid(req.params.id));
    res.json(jsonResult({ upgrade }));
  }));

  router.post('/upgrades/:id/step', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.step !== 'string' || typeof body.ok !== 'boolean') {
      throw AppError.badRequest('invalid_step', 'step and ok are required');
    }
    const upgrade = await stepUpgrade(userId(req), rid(req.params.id), {
      step: body.step as 'MODIFYING' | 'INSTALLING' | 'TESTING' | 'BUILDING' | 'ANALYZING',
      ok: body.ok,
      output: str(body, 'output'),
      diff: typeof body.diff === 'object' && body.diff !== null ? (body.diff as Record<string, unknown>) : undefined,
    });
    res.json(jsonResult({ upgrade }));
  }));

  router.post('/upgrades/:id/accept', asyncRoute(async (req, res) => {
    const upgrade = await acceptUpgrade(userId(req), rid(req.params.id));
    res.json(jsonResult({ upgrade }));
  }));

  router.post('/upgrades/:id/rollback', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.reason !== 'string' || body.reason.length === 0) {
      throw AppError.badRequest('rollback_reason_required', 'reason is required');
    }
    const upgrade = await rollbackUpgrade(userId(req), rid(req.params.id), body.reason);
    res.json(jsonResult({ upgrade }));
  }));

  router.post('/upgrades/:id/fail', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const upgrade = await failUpgrade(userId(req), rid(req.params.id), str(body, 'reason') ?? 'failed');
    res.json(jsonResult({ upgrade }));
  }));

  // ----------------------------------------------------------- Flaky Hunter
  router.post('/flakes/analyze', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.projectId !== 'string' || typeof body.testId !== 'string' || typeof body.testName !== 'string') {
      throw AppError.badRequest('flake_invalid_input', 'projectId, testId and testName are required');
    }
    const flake = await analyzeTestRuns(userId(req), {
      projectId: body.projectId,
      testId: body.testId,
      testName: body.testName,
      runs: parseRuns(body.runs),
    });
    res.status(201).json(jsonResult({ flake }));
  }));

  router.get('/flakes', asyncRoute(async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const flakes = await listFlakes(userId(req), projectId);
    res.json(jsonResult({ flakes }));
  }));

  router.get('/flakes/:id', asyncRoute(async (req, res) => {
    const flake = await getFlake(userId(req), rid(req.params.id));
    res.json(jsonResult({ flake }));
  }));

  router.post('/flakes/:id/investigate', asyncRoute(async (req, res) => {
    const flake = await createInvestigationTask(userId(req), rid(req.params.id));
    res.json(jsonResult({ flake }));
  }));

  router.post('/flakes/:id/resolve', asyncRoute(async (req, res) => {
    const flake = await markFlakeResolved(userId(req), rid(req.params.id));
    res.json(jsonResult({ flake }));
  }));

  // ----------------------------------------------------------- Self-Healing CI
  router.post('/ci/failures', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.projectId !== 'string' || typeof body.pipeline !== 'string' || typeof body.commitRef !== 'string') {
      throw AppError.badRequest('ci_invalid_input', 'projectId, pipeline and commitRef are required');
    }
    const run = await recordCiFailure(userId(req), {
      projectId: body.projectId,
      pipeline: body.pipeline,
      commitRef: body.commitRef,
      logRef: str(body, 'logRef'),
      logs: typeof body.logs === 'string' ? body.logs : '',
    });
    res.status(201).json(jsonResult({ run }));
  }));

  router.get('/ci/runs', asyncRoute(async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const runs = await listCiRuns(userId(req), projectId);
    res.json(jsonResult({ runs }));
  }));

  router.get('/ci/runs/:id', asyncRoute(async (req, res) => {
    const run = await getCiRun(userId(req), rid(req.params.id));
    res.json(jsonResult({ run }));
  }));

  router.post('/ci/runs/:id/propose-fix', asyncRoute(async (req, res) => {
    const run = await proposeCiFix(userId(req), rid(req.params.id));
    res.json(jsonResult({ run }));
  }));

  router.post('/ci/runs/:id/apply-fix', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const run = await applyCiFix(userId(req), rid(req.params.id), str(body, 'action'));
    res.json(jsonResult({ run }));
  }));

  router.post('/ci/runs/:id/approval', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') {
      throw AppError.badRequest('invalid_decision', 'decision must be APPROVE or REJECT');
    }
    const run = await decideCiFixApproval(userId(req), rid(req.params.id), body.decision, str(body, 'reason'));
    res.json(jsonResult({ run }));
  }));

  router.post('/ci/runs/:id/retest', asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.ok !== 'boolean' || typeof body.summary !== 'string') {
      throw AppError.badRequest('invalid_retest', 'ok and summary are required');
    }
    const run = await recordRetest(userId(req), rid(req.params.id), { ok: body.ok, summary: body.summary });
    res.json(jsonResult({ run }));
  }));

  return router;
};