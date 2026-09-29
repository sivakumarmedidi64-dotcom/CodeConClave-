/**
 * CodeConClave — PKG-21 — Deployment History + Rollback + Release Evidence routes.
 * Authenticated + project-owned, safe inputs/errors, secrets never returned.
 *
 *   - GET    /:projectId/history          deployment history (filter env/status/service)
 *   - GET    /:projectId/:depId          deployment details
 *   - GET    /:projectId/:depId/diff     release diff / change summary (evidence)
 *   - GET    /:projectId/:depId/failure  failure correlation
 *   - GET    /:projectId/current         current deployment ("what is running")
 *   - POST   /:projectId/start           create immutable deployment record
 *   - POST   /:projectId/:depId/gate     record a verification gate (build/test/health/smoke)
 *   - POST   /:projectId/:depId/finish   finalize verification
 *   - POST   /:projectId/rollback        request controlled rollback
 *   - GET    /:projectId/rollback/:runId rollback status
 *   - GET    /:projectId/rollback        rollback history
 *   - GET    /providers                  provider capabilities (honest)
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { releaseService } from './service.js';
import type { DbMigrationEvidence } from './rollback.js';
import { DEPLOYMENT_STAGES, DEPLOYMENT_STATUSES, type Environment, type ProviderId } from './types.js';

function pidFrom(req: import('express').Request): string {
  const id = req.params.projectId ?? req.query.projectId;
  if (typeof id !== 'string' || !id) throw Object.assign(new Error('project_required'), { status: 400 });
  return id;
}

function param(req: import('express').Request, key: string): string {
  const v = req.params[key];
  if (typeof v !== 'string' || !v) throw Object.assign(new Error('param_required'), { status: 400 });
  return v;
}

function str(body: unknown, key: string): string | undefined {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 4000) : undefined;
}

function bool(body: unknown, key: string): boolean | undefined {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

function num(body: unknown, key: string): number | undefined {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asEnvironment(v: unknown): Environment | undefined {
  if (typeof v !== 'string') return undefined;
  const e = v.toLowerCase();
  if (e === 'development' || e === 'staging' || e === 'production') return e;
  return undefined;
}

export const releaseRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const uid = (req: import('express').Request): string => req.ctx.user!.id;

  router.get('/providers', asyncRoute(async (req, res) => {
    res.json(jsonResult(releaseService.providers(uid(req))));
  }));

  router.get('/:projectId/history', asyncRoute(async (req, res) => {
    const env = asEnvironment(req.query.environment);
    const status = typeof req.query.status === 'string' && (DEPLOYMENT_STATUSES as readonly string[]).includes(req.query.status)
      ? (req.query.status as string) : undefined;
    const service = typeof req.query.service === 'string' ? req.query.service : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await releaseService.history(uid(req), pidFrom(req), { environment: env, status, service, limit });
    res.json(jsonResult(rows.map((d) => summaryOf(d))));
  }));

  router.get('/:projectId/current', asyncRoute(async (req, res) => {
    const env = asEnvironment(req.query.environment);
    const row = await releaseService.current(uid(req), pidFrom(req), env);
    res.json(jsonResult(row ? summaryOf(row) : null));
  }));

  router.get('/:projectId/rollback', asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json(jsonResult(await releaseService.rollbackHistory(uid(req), pidFrom(req), limit)));
  }));

  router.get('/:projectId/rollback/:runId', asyncRoute(async (req, res) => {
    const run = await releaseService.rollbackStatus(uid(req), pidFrom(req), param(req, 'runId'));
    res.json(jsonResult(run));
  }));

  router.get('/:projectId/:depId', asyncRoute(async (req, res) => {
    const row = await releaseService.detail(uid(req), pidFrom(req), param(req, 'depId'));
    res.json(jsonResult(row));
  }));

  router.get('/:projectId/:depId/diff', asyncRoute(async (req, res) => {
    const evidence = (req.query as Record<string, unknown>).evidence;
    let parsed: unknown;
    try {
      parsed = typeof evidence === 'string' ? JSON.parse(evidence) : undefined;
    } catch {
      throw Object.assign(new Error('invalid_evidence'), { status: 400 });
    }
    const diff = await releaseService.diff(uid(req), pidFrom(req), param(req, 'depId'), parsed as never);
    res.json(jsonResult(diff));
  }));

  router.get('/:projectId/:depId/failure', asyncRoute(async (req, res) => {
    const fc = await releaseService.failure(uid(req), pidFrom(req), param(req, 'depId'));
    res.json(jsonResult(fc));
  }));

  router.post('/:projectId/start', asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const env = asEnvironment(body?.environment) ?? 'development';
    const provider = (str(body, 'provider') as ProviderId) ?? 'unknown';
    const version = str(body, 'version');
    if (!version) throw Object.assign(new Error('version_required'), { status: 400 });
    const row = await releaseService.start(uid(req), {
      projectId: pidFrom(req),
      workspaceId: str(body, 'workspaceId') ?? null,
      environment: env,
      provider,
      service: str(body, 'service') ?? 'backend',
      version,
      branch: str(body, 'branch'),
      commitSha: str(body, 'commitSha'),
      commitTimestamp: str(body, 'commitTimestamp'),
      author: str(body, 'author'),
      predecessorId: str(body, 'predecessorId') ?? null,
      profileId: str(body, 'profileId') ?? null,
      planId: str(body, 'planId') ?? null,
      deploymentUrl: str(body, 'deploymentUrl') ?? null,
      providerDeploymentId: str(body, 'providerDeploymentId') ?? null,
    });
    res.json(jsonResult(row));
  }));

  router.post('/:projectId/:depId/gate', asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const gate = str(body, 'gate');
    if (!gate || !(DEPLOYMENT_STAGES as readonly string[]).includes(gate)) {
      throw Object.assign(new Error('invalid_gate'), { status: 400 });
    }
    const pass = bool(body, 'pass') ?? false;
    const skippable = bool(body, 'skippable') ?? false;
    const row = await releaseService.applyGate(uid(req), {
      projectId: pidFrom(req),
      deploymentId: param(req, 'depId'),
      gate: gate as 'build' | 'test' | 'health' | 'smoke',
      pass,
      skippable,
      name: str(body, 'name'),
      message: str(body, 'message'),
      evidence: str(body, 'evidence'),
      responseTimeMs: num(body, 'responseTimeMs'),
    });
    res.json(jsonResult(row));
  }));

  router.post('/:projectId/:depId/finish', asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const row = await releaseService.finish(uid(req), pidFrom(req), param(req, 'depId'), {
      durationMs: num(body, 'durationMs'),
      manualVerify: bool(body, 'manualVerify'),
    });
    res.json(jsonResult(row));
  }));

  router.post('/:projectId/rollback', asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const targetDeploymentId = str(body, 'targetDeploymentId');
    if (!targetDeploymentId) throw Object.assign(new Error('target_required'), { status: 400 });
    const dbEvidence = (body?.dbEvidence ?? {}) as DbMigrationEvidence;
    const run = await releaseService.rollback(uid(req), pidFrom(req), {
      targetDeploymentId,
      environment: asEnvironment(body?.environment) ?? 'development',
      providerDeploymentId: str(body, 'providerDeploymentId') ?? null,
      confirmed: bool(body, 'confirmed'),
      dbEvidence,
    });
    res.json(jsonResult(run));
  }));

  return router;
};

/** Compact history-row summary — traceable to version + env + status + evidence. */
function summaryOf(d: {
  id: string; projectId: string; environment: string; provider: string; service: string;
  version: string; git: { available: boolean; commitSha?: string; branch?: string }; status: string;
  verification: string; healthResult: { outcome?: string } | null; smokeResult: { outcome?: string } | null;
  rollbackAvailable: boolean; createdAt: string;
}): Record<string, unknown> {
  return {
    deploymentId: d.id,
    projectId: d.projectId,
    environment: d.environment,
    provider: d.provider,
    service: d.service,
    version: d.version,
    commit: d.git.available ? (d.git.commitSha ?? null) : null,
    status: d.status,
    verification: d.verification,
    health: d.healthResult?.outcome ?? 'SKIP',
    smoke: d.smokeResult?.outcome ?? 'SKIP',
    rollbackAvailable: d.rollbackAvailable,
    createdAt: d.createdAt,
  };
}
