/**
 * CodeConClave — plugins routes (Phase 10).
 * Catalogue, connections lifecycle (connect/disconnect/reauthorize/revoke),
 * scopes, events, health checks, the typed plugin action endpoint, and the
 * OAuth flow (reusing the existing Google OAuth application through the same
 * registered redirect URI — the auth callback routes plugin states here).
 * Credential values are never accepted or returned on any of these routes
 * except the one-time connect credential (stored encrypted, never echoed).
 */
import { Router } from 'express';
import { pool } from '../../shared/db.js';
import { jsonResult } from '../auth/schemas.js';
import { requireAuth } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import {
  listCatalogue,
  listConnections,
  connectPlugin,
  revokePlugin,
  getConnection,
  recordPluginEvent,
  disconnectPlugin,
  reauthorizePlugin,
  updateConnectionScopes,
  listPluginScopes,
  listPluginEvents,
  searchCatalogue,
} from './health.js';
import { executePluginAction, healthCheckPlugin, beginPluginOAuth, completePluginOAuth, verifyPluginOAuthState } from './engine.js';
import { storePluginCredential, credentialKinds, readPluginCredentials } from './credentials.js';
import { getAdapter } from './sdk.js';
import { setConnectionState, getConnectionInternal } from './health.js';
import { evaluateToolCall, policyDeniedError } from '../execution/policy.js';
import { proposeApproval, executeApprovedAction } from '../execution/approvals.js';
import { ApprovalActionType } from '@codeconclave/shared';
import { pluginActionSchema, pluginConnectSchema, pluginScopesUpdateSchema, pluginSearchSchema } from '@codeconclave/shared';
import { env } from '../../config/env.js';

const VALID_TYPES = [
  'github', 'google', 'resend', 'slack', 'teams', 'discord', 'notion', 'linear',
  'jira', 'figma', 'sentry', 'cloudflare', 'supabase', 'vercel', 'render', 'vscode', 'webhook',
];

export const pluginRoutes = (): Router => {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/catalogue',
    asyncRoute(async (req, res) => {
      const parsed = pluginSearchSchema.safeParse(req.query);
      if (!parsed.success) throw AppError.badRequest('invalid_plugin_search', 'Invalid plugin search filters');
      const plugins = await searchCatalogue(req.ctx.user!.id, parsed.data);
      res.json(jsonResult({ plugins }));
    }),
  );

  router.get(
    '/connections',
    asyncRoute(async (req, res) => {
      const connections = await listConnections(req.ctx.user!.id);
      res.json(jsonResult({ connections }));
    }),
  );

  router.post(
    '/connections',
    asyncRoute(async (req, res) => {
      const input = pluginConnectSchema.safeParse(req.body);
      if (!input.success) throw AppError.badRequest('invalid_plugin_input', 'Invalid connect payload');
      const { pluginType, name, credential } = input.data;
      if (!VALID_TYPES.includes(pluginType)) throw AppError.badRequest('invalid_plugin_type', 'Unknown plugin type');
      const adapter = getAdapter(pluginType);
      if (!adapter) throw AppError.badRequest('plugin_adapter_unknown', `No adapter registered for ${pluginType}`);
      const oauth = adapter.oauth?.required ?? false;
      const connection = await connectPlugin(req.ctx.user!.id, pluginType as never, (name || pluginType).slice(0, 80));
      if (credential && credential.value) {
        if (oauth) {
          throw AppError.badRequest('oauth_credential_rejected', 'This plugin uses OAuth; use the authorize flow instead');
        }
        await storePluginCredential(connection.id, credential.kind, credential.value, req.ctx.user!.id);
        await connectPluginFinalize(req.ctx.user!.id, connection.id, pluginType);
      } else if (!oauth) {
        await connectPluginFinalize(req.ctx.user!.id, connection.id, pluginType);
      }
      res.status(201).json(jsonResult({ connection: await getConnection(req.ctx.user!.id, connection.id) }));
    }),
  );

  router.get(
    '/connections/:id',
    asyncRoute(async (req, res) => {
      res.json(jsonResult({ connection: await getConnection(req.ctx.user!.id, req.params.id!) }));
    }),
  );

  router.post(
    '/connections/:id/disconnect',
    asyncRoute(async (req, res) => {
      await disconnectPlugin(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.post(
    '/connections/:id/reauthorize',
    asyncRoute(async (req, res) => {
      const connection = await getConnection(req.ctx.user!.id, req.params.id!);
      const adapter = getAdapter(connection.plugin_type);
      const oauth = adapter?.oauth?.required ?? false;
      if (oauth) {
        const { authUrl } = await beginPluginOAuth(req.ctx.user!.id, req.params.id!);
        res.json(jsonResult({ authUrl, oauth: true }));
        return;
      }
      await reauthorizePlugin(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true, oauth: false }));
    }),
  );

  router.post(
    '/connections/:id/revoke',
    asyncRoute(async (req, res) => {
      await revokePlugin(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ ok: true }));
    }),
  );

  router.get(
    '/connections/:id/scopes',
    asyncRoute(async (req, res) => {
      const connection = await getConnection(req.ctx.user!.id, req.params.id!);
      res.json(jsonResult({ scopes: await listPluginScopes(connection.id) }));
    }),
  );

  router.patch(
    '/connections/:id/scopes',
    asyncRoute(async (req, res) => {
      const input = pluginScopesUpdateSchema.safeParse(req.body);
      if (!input.success) throw AppError.badRequest('invalid_plugin_input', 'Invalid scopes payload');
      const scopes = await updateConnectionScopes(req.ctx.user!.id, req.params.id!, input.data.scopes);
      res.json(jsonResult({ scopes }));
    }),
  );

  router.get(
    '/connections/:id/events',
    asyncRoute(async (req, res) => {
      const limit = Number(req.query.limit ?? 50);
      res.json(jsonResult({ events: await listPluginEvents(req.ctx.user!.id, req.params.id!, limit) }));
    }),
  );

  router.post(
    '/connections/:id/health-check',
    asyncRoute(async (req, res) => {
      res.json(jsonResult(await healthCheckPlugin(req.ctx.user!.id, req.params.id!)));
    }),
  );

  router.get(
    '/connections/:id/health-history',
    asyncRoute(async (req, res) => {
      const connection = await getConnection(req.ctx.user!.id, req.params.id!);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
      const rows = await pool.query(
        `SELECT checked_at, ok, latency_ms, consecutive_failures, last_error, detail
         FROM plugin_health WHERE connection_id = $1 ORDER BY checked_at DESC LIMIT $2`,
        [connection.id, limit],
      );
      res.json(jsonResult({ history: rows.rows }));
    }),
  );

  router.get(
    '/catalogue/:type/actions',
    asyncRoute(async (req, res) => {
      const adapter = getAdapter(req.params.type!);
      if (!adapter) throw AppError.badRequest('plugin_adapter_unknown', `No adapter registered for ${req.params.type}`);
      res.json(
        jsonResult({
          actions: adapter.actions.map((a) => ({
            name: a.name,
            description: a.description,
            permission: a.permission,
            scope: a.scope,
            idempotent: a.idempotent,
          })),
          capabilities: adapter.capabilities,
        }),
      );
    }),
  );

  router.post(
    '/connections/:id/events',
    asyncRoute(async (req, res) => {
      const eventType = String(req.body?.eventType ?? '');
      if (!eventType) throw AppError.badRequest('event_type_required', 'eventType is required');
      await recordPluginEvent(req.params.id!, eventType, (req.body?.payload as Record<string, unknown>) ?? {});
      res.status(201).json(jsonResult({ ok: true }));
    }),
  );

  // ------------------------------------------------------ typed plugin actions

  router.post(
    '/actions',
    asyncRoute(async (req, res) => {
      const input = pluginActionSchema.safeParse(req.body);
      if (!input.success) throw AppError.badRequest('invalid_plugin_input', 'Invalid plugin action payload');
      const { connectionId, action, input: actionInput, approvalId, justification, taskId, runId, recordAsMemory } = input.data;
      const userId = req.ctx.user!.id;
      const connection = await getConnection(userId, connectionId);
      const adapter = getAdapter(connection.plugin_type);
      if (!adapter) throw AppError.badRequest('plugin_adapter_unknown', `No adapter registered for ${connection.plugin_type}`);

      const decision = evaluateToolCall({
        tool: 'plugin_action',
        input: { pluginType: connection.plugin_type, action },
        userId,
      });
      if (!decision.allowed) throw policyDeniedError(decision);

      if (decision.requiresApproval && !approvalId) {
        const proposed = await proposeApproval(userId, {
          actionType: ApprovalActionType.PLUGIN_ACTION,
          riskLevel: decision.risk,
          justification: justification ?? `Plugin action ${action} on ${connection.name}`,
          affectedResources: [{ type: 'plugin', ref: connectionId, detail: action }],
          proposedAction: { connectionId, action, input: actionInput },
          taskId,
        });
        if (!proposed.approval) {
          throw AppError.conflict('approval_not_created', 'Approval could not be created');
        }
        res.json(jsonResult({ requiresApproval: true, approval: { id: proposed.approval.id, status: proposed.approval.status } }));
        return;
      }

      if (approvalId) {
        const approval = await executeApprovedAction(userId, approvalId, {
          tool: 'plugin_action',
          input: { connectionId, action, input: actionInput, taskId, runId, recordAsMemory, path: connectionId },
        });
        const output = (approval.execution_result as { data?: unknown } | null)?.data ?? null;
        res.json(jsonResult({
          executed: approval.execution_status === 'SUCCEEDED',
          approvalId,
          status: approval.execution_status,
          result: output,
        }));
        return;
      }

      // Read-only low-risk actions (policy: no approval) execute directly.
      const outcome = await executePluginAction({ userId, connectionId, action, input: actionInput, taskId, runId, recordAsMemory });
      res.json(jsonResult({ executed: true, approvalId: null, result: outcome.data }));
    }),
  );

  // ------------------------------------------------------ oauth (google reuse)

  router.get(
    '/oauth/:connectionId/authorize',
    asyncRoute(async (req, res) => {
      const { authUrl } = await beginPluginOAuth(req.ctx.user!.id, req.params.connectionId!);
      res.json(jsonResult({ authUrl }));
    }),
  );

  return router;
};

/** After a one-time credential (or reauth), run a real handshake before CONNECTED. */
async function connectPluginFinalize(userId: string, connectionId: string, pluginType: string): Promise<void> {
  try {
    const adapter = getAdapter(pluginType);
    if (!adapter) return;
    const creds = await readPluginCredentials(connectionId);
    await adapter.authenticate(
      { id: connectionId, owner_id: userId, plugin_type: pluginType as never, scopes: [] },
      creds,
    );
    const row = await getConnectionInternal(connectionId);
    if (row && row.state !== 'REVOKED') {
      await setConnectionState(connectionId, 'CONNECTED');
    }
  } catch {
    await setConnectionState(connectionId, 'ERROR', 'authentication_failed');
  }
}

/** OAuth callback — called from the auth google callback when state is a plugin state. */
export async function pluginOAuthCallback(code: string, state: string): Promise<{ redirectUrl: string }> {
  // State verification + token exchange (same Google application, encrypted at rest).
  const { userId, connectionId } = await completePluginOAuth(code, state);
  void userId;
  void connectionId;
  return { redirectUrl: `${env.APP_URL}/plugins` };
}

export { verifyPluginOAuthState, credentialKinds };