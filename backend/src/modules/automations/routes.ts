/**
 * CodeConClave — automations + webhooks routes (Stage 26D).
 * Rule CRUD, manual event ingestion, run history, smart escalation decisions,
 * workflow recipes, webhook secret management, and the authenticated inbound
 * webhook endpoints (GitHub/Sentry HMAC, generic bearer tokens).
 */
import { Router } from 'express';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  createRule, updateRule, setRuleStatus, deleteRule, listRules, listRuleRuns,
  type RuleInput,
} from './rules.js';
import { ingestEvent, listRuns, getRun, decideAutomationApproval } from './executor.js';
import { smartEscalate, decideEscalation, listEscalations } from './escalate.js';
import { listRecipes, getRecipe, instantiateRecipe, deleteRecipe } from './recipes.js';
import { createWebhookSecret, listWebhookSecrets, deleteWebhookSecret, setWebhookSecretEnabled, handleWebhook } from './webhooks.js';
import type { WebhookSource } from './webhooks.js';

const WEBHOOK_SOURCES: WebhookSource[] = ['github', 'sentry', 'plugin', 'deployment', 'webhook'];
const EVENT_SOURCES = ['schedule', 'github', 'task_completed', 'plugin', 'deployment', 'webhook'] as const;

function ruleInputOf(body: Record<string, unknown>): RuleInput {
  const eventSource = body.eventSource;
  if (typeof eventSource !== 'string' || !(EVENT_SOURCES as readonly string[]).includes(eventSource)) {
    throw AppError.badRequest('invalid_event_source', 'Invalid eventSource');
  }
  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    eventSource: eventSource as RuleInput['eventSource'],
    eventType: typeof body.eventType === 'string' ? body.eventType : undefined,
    conditions: typeof body.conditions === 'object' && body.conditions !== null ? body.conditions as Record<string, unknown> : undefined,
    actions: Array.isArray(body.actions) ? body.actions as Array<Record<string, unknown>> : undefined,
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    requireApproval: typeof body.requireApproval === 'boolean' ? body.requireApproval : undefined,
    triggerMode: typeof body.triggerMode === 'string' ? (body.triggerMode as RuleInput['triggerMode']) : undefined,
    maxRunsPerHour: typeof body.maxRunsPerHour === 'number' ? body.maxRunsPerHour : undefined,
    cooldownMs: typeof body.cooldownMs === 'number' ? body.cooldownMs : undefined,
  };
}

export const automationRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);
  const pid = (v: string | undefined): string => v ?? '';

  router.get('/rules', asyncRoute(async (req, res) => {
    const rules = await listRules(req.ctx.user!.id, true);
    res.json(jsonResult({ rules }));
  }));

  router.post('/rules', asyncRoute(async (req, res) => {
    const rule = await createRule(req.ctx.user!.id, ruleInputOf(req.body ?? {}));
    res.status(201).json(jsonResult({ rule }));
  }));

  router.patch('/rules/:id', asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const rule = await updateRule(req.ctx.user!.id, pid(req.params.id), ruleInputOf(body));
    res.json(jsonResult({ rule }));
  }));

  router.post('/rules/:id/status', asyncRoute(async (req, res) => {
    const status = (req.body ?? {}).status;
    if (typeof status !== 'string' || !['ACTIVE', 'PAUSED', 'DISABLED'].includes(status)) {
      throw AppError.badRequest('invalid_status', 'Invalid status');
    }
    const rule = await setRuleStatus(req.ctx.user!.id, pid(req.params.id), status as 'ACTIVE' | 'PAUSED' | 'DISABLED');
    res.json(jsonResult({ rule }));
  }));

  router.delete('/rules/:id', asyncRoute(async (req, res) => {
    await deleteRule(req.ctx.user!.id, pid(req.params.id));
    res.json(jsonResult({ deleted: true }));
  }));

  router.get('/rules/:id/runs', asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const runs = await listRuleRuns(req.ctx.user!.id, pid(req.params.id), limit);
    res.json(jsonResult({ runs }));
  }));

  router.post('/events', asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const source = body.source;
    const eventId = body.eventId;
    const eventType = body.eventType;
    if (typeof source !== 'string' || !(EVENT_SOURCES as readonly string[]).includes(source)) {
      throw AppError.badRequest('invalid_event_source', 'Invalid event source');
    }
    if (typeof eventId !== 'string' || !eventId) throw AppError.badRequest('missing_event_id', 'eventId is required');
    if (typeof eventType !== 'string' || !eventType) throw AppError.badRequest('missing_event_type', 'eventType is required');
    const result = await ingestEvent({
      source: source as (typeof EVENT_SOURCES)[number],
      eventId,
      eventType,
      ownerId: req.ctx.user!.id,
      payload: typeof body.payload === 'object' && body.payload !== null ? body.payload : {},
    });
    res.json(jsonResult(result));
  }));

  router.get('/runs', asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const runs = await listRuns(req.ctx.user!.id, limit);
    res.json(jsonResult({ runs }));
  }));

  router.get('/runs/:id', asyncRoute(async (req, res) => {
    const run = await getRun(req.ctx.user!.id, pid(req.params.id));
    res.json(jsonResult({ run }));
  }));

  router.get('/escalations', asyncRoute(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const escalations = await listEscalations(req.ctx.user!.id, status);
    res.json(jsonResult({ escalations }));
  }));

  router.post('/escalations/:id/decide', asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const decision = body.decision;
    if (typeof decision !== 'string') throw AppError.badRequest('missing_decision', 'decision is required');
    const note = typeof body.note === 'string' ? body.note : undefined;
    const escalation = await decideEscalation(req.ctx.user!.id, pid(req.params.id), decision, note);
    res.json(jsonResult({ escalation }));
  }));

  router.post('/runs/:id/approve', asyncRoute(async (req, res) => {
    const run = await decideAutomationApproval(req.ctx.user!.id, pid(req.params.id), 'APPROVE', 'approved_by_rule_owner');
    res.json(jsonResult({ run }));
  }));

  router.post('/runs/:id/reject', asyncRoute(async (req, res) => {
    const run = await decideAutomationApproval(req.ctx.user!.id, pid(req.params.id), 'REJECT', 'rejected_by_rule_owner');
    res.json(jsonResult({ run }));
  }));

  router.get('/recipes', asyncRoute(async (req, res) => {
    const recipes = await listRecipes(req.ctx.user!.id);
    res.json(jsonResult({ recipes }));
  }));

  router.get('/recipes/:id', asyncRoute(async (req, res) => {
    const recipe = await getRecipe(req.ctx.user!.id, pid(req.params.id));
    res.json(jsonResult({ recipe }));
  }));

  router.post('/recipes/:id/instantiate', asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const rule = await instantiateRecipe(req.ctx.user!.id, pid(req.params.id), {
      name: typeof body.name === 'string' ? body.name : undefined,
      agentIds: typeof body.agentIds === 'object' && body.agentIds !== null ? body.agentIds : undefined,
      projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
      requireApproval: typeof body.requireApproval === 'boolean' ? body.requireApproval : undefined,
    });
    res.status(201).json(jsonResult({ rule }));
  }));

  router.delete('/recipes/:id', asyncRoute(async (req, res) => {
    await deleteRecipe(req.ctx.user!.id, pid(req.params.id));
    res.json(jsonResult({ deleted: true }));
  }));

  return router;
};

export const webhookRoutes = (): Router => {
  const router = Router();

  router.post('/:source', asyncRoute(async (req, res) => {
    const source = req.params.source as WebhookSource;
    if (!WEBHOOK_SOURCES.includes(source)) throw AppError.badRequest('invalid_webhook_source', 'Invalid webhook source');
    if (!Buffer.isBuffer(req.body)) throw AppError.badRequest('raw_body_required', 'Webhook endpoints require a raw body');
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    const result = await handleWebhook({ source, rawBody: req.body as Buffer, headers });
    if (result === null) throw AppError.notFound('unregistered_repository', 'No secret registered for this repository');
    res.json(jsonResult(result));
  }));

  const authed = Router();
  authed.use(requireAuth);
  const aid = (v: string | undefined): string => v ?? '';

  authed.get('/secrets', asyncRoute(async (req, res) => {
    const secrets = await listWebhookSecrets(req.ctx.user!.id);
    res.json(jsonResult({ secrets }));
  }));

  authed.post('/secrets', asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const source = body.source;
    if (typeof source !== 'string' || !WEBHOOK_SOURCES.includes(source as WebhookSource)) {
      throw AppError.badRequest('invalid_webhook_source', 'Invalid webhook source');
    }
    const name = typeof body.name === 'string' ? body.name : source;
    const repo = typeof body.repo === 'string' ? body.repo : undefined;
    const { secret, plaintextSecret } = await createWebhookSecret(req.ctx.user!.id, {
      source: source as WebhookSource, name, repo,
    });
    res.status(201).json(jsonResult({ secret, plaintextSecret }));
  }));

  authed.patch('/secrets/:id', asyncRoute(async (req, res) => {
    const enabled = (req.body ?? {}).enabled;
    if (typeof enabled !== 'boolean') throw AppError.badRequest('invalid_enabled', 'enabled must be a boolean');
    await setWebhookSecretEnabled(req.ctx.user!.id, aid(req.params.id), enabled);
    res.json(jsonResult({ updated: true }));
  }));

  authed.delete('/secrets/:id', asyncRoute(async (req, res) => {
    await deleteWebhookSecret(req.ctx.user!.id, aid(req.params.id));
    res.json(jsonResult({ deleted: true }));
  }));

  router.use(authed);
  return router;
};