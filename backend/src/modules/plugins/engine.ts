/**
 * CodeConClave — plugin engine (Phase 10).
 * The controlled integration boundary every plugin action crosses:
 *
 *   REQUEST → VALIDATE → AUTHORIZATION → SCOPE CHECK → RATE LIMIT →
 *   CIRCUIT BREAKER → POLICY → PROVIDER CALL (timeout/retry/backoff) →
 *   RESULT VALIDATION → AUDIT
 *
 * Raw model output never invokes a provider directly — every action is a
 * typed tool call (zod schema on the adapter), policy-gated, approval-linked,
 * audited, and health-tracked. Failures degrade the plugin, never the app.
 */
import { getConnection, getConnectionInternal, transitionConnectionState, recordPluginEvent, recordPluginHealth, effectivePluginScopes } from './health.js';
import { getAdapter, getAction, type PluginAdapter, type PluginCredentials } from './sdk.js';
import { readPluginCredentials, storePluginCredential } from './credentials.js';
import { checkCircuit, checkRateLimit, recordCircuitFailure, recordCircuitSuccess, withRetry, resetCircuits, resetRateLimiters } from './circuit.js';
import { AppError } from '../../shared/errors.js';
import { outboundSignal } from '../../shared/http-timeout.js';
import { recordAudit } from '../audit/service.js';
import { evaluateToolCall, policyDeniedError } from '../execution/policy.js';
import { AuditAction } from '@codeconclave/shared';
import { createHmac } from 'node:crypto';
import { env } from '../../config/env.js';
import { incMetric } from '../../observability/metrics.js';

const FAILURE_TO_DEGRADED = 3;
const FAILURE_TO_FAILED = 5;

const failureTracker = new Map<string, number>();

export function consecutivePluginFailures(connectionId: string): number {
  return failureTracker.get(connectionId) ?? 0;
}

export function resetHealthTrackers(): void {
  failureTracker.clear();
  resetCircuits();
  resetRateLimiters();
}

export interface ExecutePluginOptions {
  userId: string;
  connectionId: string;
  action: string;
  input: Record<string, unknown>;
  taskId?: string;
  runId?: string;
  recordAsMemory?: boolean;
}

export interface PluginActionOutcome {
  ok: boolean;
  data: unknown;
  latencyMs: number;
  connectionId: string;
  pluginType: string;
  action: string;
}

async function loadAdapter(pluginType: string): Promise<PluginAdapter> {
  const adapter = getAdapter(pluginType);
  if (!adapter) throw AppError.badRequest('plugin_adapter_unknown', `No adapter registered for plugin type ${pluginType}`);
  return adapter;
}

/** Track failure transitions and notify on degradation/failure. */
async function trackOutcome(connectionId: string, ok: boolean, latencyMs: number, error?: string): Promise<void> {
  if (ok) {
    const prior = failureTracker.get(connectionId) ?? 0;
    failureTracker.set(connectionId, 0);
    await recordPluginHealth(connectionId, true, latencyMs, 0, undefined, { recovered: prior > 0 });
    return;
  }
  const failures = (failureTracker.get(connectionId) ?? 0) + 1;
  failureTracker.set(connectionId, failures);
  await recordPluginHealth(connectionId, false, latencyMs, failures, error, {});
  const row = await getConnectionInternal(connectionId);
  if (!row) return;
  if (failures === FAILURE_TO_DEGRADED && (row.state === 'CONNECTED' || row.state === 'CONNECTING')) {
    await transitionConnectionState(connectionId, 'DEGRADED', { lastError: error });
  } else if (failures >= FAILURE_TO_FAILED && (row.state === 'CONNECTED' || row.state === 'DEGRADED')) {
    await transitionConnectionState(connectionId, 'FAILED', { lastError: error });
  }
}

/**
 * The full plugin isolation boundary. Approval gating happens at the caller
 * (routes/coworkers); this function re-runs the deterministic policy for
 * defense in depth and rejects anything outside the granted scope.
 */
export async function executePluginAction(opts: ExecutePluginOptions): Promise<PluginActionOutcome> {
  // 1. VALIDATE + AUTHORIZATION — tenant-scoped ownership lookup.
  const connection = await getConnection(opts.userId, opts.connectionId);
  const found = getAction(connection.plugin_type, opts.action);
  if (!found) throw AppError.badRequest('plugin_action_unknown', `Unknown action ${opts.action} for ${connection.plugin_type}`);
  const { adapter, def } = found;

  // Stage 26G control plane: a matching plugin-scope policy can require
  // approval or block plugin actions outright.
  const { evaluatePolicy } = await import('../control/policies.js');
  const policy = await evaluatePolicy(opts.userId, 'plugin', def.permission, 'MEDIUM');
  if (!policy.allowed) {
    throw AppError.forbidden('policy_blocked', `Plugin action blocked by control policy (${policy.matched?.scope}/${policy.matched?.action})`);
  }
  if (policy.requireApproval) {
    const { proposeApproval } = await import('../execution/approvals.js');
    const { ApprovalActionType } = await import('@codeconclave/shared');
    const proposal = await proposeApproval(opts.userId, {
      actionType: ApprovalActionType.PLUGIN_ACTION,
      justification: `Policy requires approval for plugin scope ${def.permission}`,
      affectedResources: [{ type: 'plugin_connection', ref: connection.id, detail: `${connection.plugin_type}::${opts.action}` }],
      proposedAction: { pluginType: connection.plugin_type, action: opts.action },
    });
    throw AppError.forbidden(
      'plugin_policy_approval_required',
      proposal.approval
        ? `Plugin action requires approval under control policy (approval ${proposal.approval.id})`
        : 'Plugin action requires approval under control policy',
    );
  }

  // Typed tool schema: input is validated against the action's contract.
  const parsed = def.inputSchema.safeParse(opts.input);
  if (!parsed.success) {
    throw AppError.badRequest('plugin_input_invalid', `Invalid input for ${opts.action}`, parsed.error.flatten());
  }
  const input = parsed.data as Record<string, unknown>;

  // 2. STATE gate — FAILED/REAUTH_REQUIRED/DISCONNECTED/REVOKED never execute.
  const executable = ['CONNECTED', 'DEGRADED'];
  if (!executable.includes(connection.state)) {
    if (connection.state === 'REAUTH_REQUIRED') {
      throw AppError.conflict('plugin_reauth_required', 'Reauthorize the plugin before using it again');
    }
    throw AppError.conflict('plugin_not_connected', `Plugin is ${connection.state.toLowerCase()}; connect it before use`);
  }

  // 3. SCOPE CHECK — the action's permission must be in the granted scopes.
  const granted = await effectivePluginScopes(connection.id);
  if (!granted.has(def.permission) && !granted.has('admin')) {
    incMetric('security.plugin_scope_denied');
    throw AppError.forbidden('plugin_scope_denied', `Plugin scope '${def.permission}' is not granted for ${connection.plugin_type}`);
  }

  // 4. RATE LIMIT.
  checkRateLimit(connection.id);

  // 5. CIRCUIT BREAKER. An open circuit is a health signal too: it keeps the
  // failure ledger moving toward DEGRADED/FAILED instead of silently stalling.
  try {
    checkCircuit(connection.id);
  } catch (err) {
    await trackOutcome(connection.id, false, 0, err instanceof Error ? err.message : String(err));
    throw err;
  }

  // 6. POLICY — deterministic, re-run at execution time (approval can't bypass).
  const decision = evaluateToolCall({
    tool: 'plugin_action',
    input: { pluginType: connection.plugin_type, action: opts.action },
    userId: opts.userId,
  });
  if (!decision.allowed) throw policyDeniedError(decision);

  // 7. CREDENTIALS — decrypted server-side only.
  const creds = await readPluginCredentials(connection.id);
  const needsOAuth = adapter.oauth?.required ?? false;
  if (needsOAuth && !creds.kinds['refresh_token']) {
    await transitionConnectionState(connection.id, 'REAUTH_REQUIRED', { lastError: 'refresh_token_missing' });
    throw AppError.conflict('plugin_reauth_required', 'Reauthorize the plugin with its provider');
  }

  // 8. PROVIDER CALL with timeout + retry (idempotent only) + exponential backoff.
  const attempts = def.idempotent ? 2 : 1;
  const timeoutMs = Number(input.timeoutMs) || (def.idempotent ? 15_000 : 10_000);
  let latencyMs = 0;
  let data: unknown = null;
  try {
    const result = await withRetry(
      async (signal) => {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort);
        try {
          return await adapter.execute(connection, creds, def, input);
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
      { attempts, baseDelayMs: 250, timeoutMs, idempotent: def.idempotent },
    );
    latencyMs = result.latencyMs;
    data = result.data;
    // 9. RESULT VALIDATION.
    if (!result.ok || !adapter.validateResponse(result.data)) {
      throw new Error(result.error ?? 'Provider returned an invalid response');
    }
    await recordCircuitSuccess(connection.id);
    await trackOutcome(connection.id, true, latencyMs);
    if (connection.state === 'DEGRADED') {
      // Recovery detection: a clean action after degradation returns to CONNECTED.
      await transitionConnectionState(connection.id, 'CONNECTED', { lastError: null });
    }
  } catch (err) {
    recordCircuitFailure(connection.id);
    const message = err instanceof Error ? err.message : String(err);
    await trackOutcome(connection.id, false, latencyMs || 0, message);
    throw err instanceof AppError ? err : AppError.unavailable('plugin_provider_error', message);
  }

  // 10. AUDIT — never include credential values.
  await recordAudit({
    action: AuditAction.PLUGIN_ACTION_PERFORMED,
    actorUserId: opts.userId,
    scope: 'USER',
    tenantId: opts.userId,
    resourceType: 'plugin_connection',
    resourceId: connection.id,
    detail: { pluginType: connection.plugin_type, action: opts.action, ok: true, latencyMs, taskId: opts.taskId ?? null },
  });
  await recordPluginEvent(connection.id, 'action.performed', {
    action: opts.action,
    ok: true,
    latencyMs,
    taskId: opts.taskId ?? null,
    resource: pluginActionResource(input),
  }, 'RECORDED');

  // 11. PROVENANCE — plugin outputs may become artifacts/memories, never
  // silently as verified user facts (source-labeled OBSERVED + plugin:// ref).
  if (opts.taskId || opts.runId) {
    await saveArtifactProvenance(connection, adapter, opts, input);
  }
  if (opts.recordAsMemory) {
    await saveMemoryProvenance(opts.userId, connection, opts, input);
  }

  return { ok: true, data, latencyMs, connectionId: connection.id, pluginType: connection.plugin_type, action: opts.action };
}

/** Best-effort provenance label for an action input: repo pair, url, or explicit resource. */
function pluginActionResource(input: Record<string, unknown>): string | null {
  if (typeof input.resource === 'string' && input.resource) return input.resource;
  if (typeof input.owner === 'string' && typeof input.repo === 'string') return `${input.owner}/${input.repo}`;
  if (typeof input.url === 'string') return input.url;
  return null;
}

async function saveArtifactProvenance(
  connection: { id: string; plugin_type: string },
  adapter: PluginAdapter,
  opts: ExecutePluginOptions,
  input: Record<string, unknown>,
): Promise<void> {
  try {
    const { saveCoworkerArtifact } = await import('../execution/coworkers.js');
    if (!opts.runId) return;
    await saveCoworkerArtifact({
      runId: opts.runId,
      name: `plugin:${opts.action}`,
      kind: 'PLUGIN_RESULT',
      content: JSON.stringify({
        provider: adapter.provider,
        plugin: connection.plugin_type,
        action: opts.action,
        resource: pluginActionResource(input),
        timestamp: new Date().toISOString(),
      }),
      attemptId: opts.taskId ?? undefined,
      verification: 'SKIPPED',
    });
  } catch {
    /* provenance artifacts are best-effort — never break the action */
  }
}

async function saveMemoryProvenance(
  userId: string,
  connection: { id: string; plugin_type: string },
  opts: ExecutePluginOptions,
  input: Record<string, unknown>,
): Promise<void> {
  try {
    const { createMemory } = await import('../memory/service.js');
    await createMemory(userId, {
      type: 'SEMANTIC',
      source: 'OBSERVED',
      content: `Plugin ${connection.plugin_type} executed ${opts.action}`,
      confidence: 0.5,
      provenance: `plugin://${connection.plugin_type}/${opts.action}@${new Date().toISOString()}`,
    });
  } catch {
    /* provenance memory is best-effort */
  }
}

// ---------------------------------------------------------------- health checks

/**
 * Run the adapter's real health check, persist the outcome, and drive
 * CONNECTED → DEGRADED → FAILED → (recovery) → CONNECTED transitions.
 */
export async function healthCheckPlugin(userId: string, connectionId: string): Promise<{ ok: boolean; state: string; latencyMs: number; detail?: string }> {
  const connection = await getConnection(userId, connectionId);
  const adapter = await loadAdapter(connection.plugin_type);
  const creds = await readPluginCredentials(connection.id);
  const needsOAuth = adapter.oauth?.required ?? false;
  if (needsOAuth && !creds.kinds['refresh_token']) {
    await transitionConnectionState(connection.id, 'REAUTH_REQUIRED', { lastError: 'refresh_token_missing', actorUserId: userId });
    return { ok: false, state: 'REAUTH_REQUIRED', latencyMs: 0, detail: 'refresh_token_missing' };
  }
  const result = await adapter.healthCheck(connection, creds);
  await recordPluginHealth(connection.id, result.ok, result.latencyMs, result.ok ? 0 : (consecutivePluginFailures(connection.id) + 1), result.detail);
  if (result.ok) {
    failureTracker.set(connection.id, 0);
    if (connection.state === 'FAILED' || connection.state === 'DEGRADED' || connection.state === 'ERROR') {
      await transitionConnectionState(connection.id, 'CONNECTED', { lastError: null, actorUserId: userId });
    }
    return { ok: true, state: 'CONNECTED', latencyMs: result.latencyMs };
  }
  const failures = (consecutivePluginFailures(connection.id) ?? 0) + 1;
  failureTracker.set(connection.id, failures);
  if (failures >= FAILURE_TO_FAILED && connection.state === 'CONNECTED') {
    await transitionConnectionState(connection.id, 'DEGRADED', { lastError: result.detail, actorUserId: userId });
  }
  if (failures >= FAILURE_TO_FAILED + 2) {
    await transitionConnectionState(connection.id, 'FAILED', { lastError: result.detail, actorUserId: userId });
  }
  return { ok: false, state: 'DEGRADED', latencyMs: result.latencyMs, detail: result.detail };
}

// ---------------------------------------------------------------- oauth flow

export async function beginPluginOAuth(userId: string, connectionId: string): Promise<{ authUrl: string }> {
  const connection = await getConnection(userId, connectionId);
  const adapter = await loadAdapter(connection.plugin_type);
  if (!adapter.oauth || !adapter.oauth.required) {
    throw AppError.badRequest('oauth_not_required', `${connection.plugin_type} does not use OAuth`);
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw AppError.unavailable('google_not_configured', 'Google OAuth is not configured on the server');
  }
  const state = pluginOAuthStateToken(userId, connectionId);
  return { authUrl: googleAuthorizeUrl(state) };
}

function googleAuthorizeUrl(state: string): string {
  const scopes = (env.GOOGLE_SCOPES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: env.GOOGLE_OAUTH_CONSENT_MODE,
    state,
    include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function pluginOAuthStateToken(userId: string, connectionId: string): string {
  const body = Buffer.from(
    JSON.stringify({ kind: 'plugin-oauth', userId, connectionId, exp: Date.now() + 10 * 60 * 1000 }),
  ).toString('base64url');
  const sig = createHmac('sha256', env.JWT_SECRET).update(`plugin-oauth:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

/** True when the callback state belongs to the plugin OAuth flow (not login). */
export function isPluginOAuthState(token: string): boolean {
  try {
    const [body] = token.split('.');
    if (!body) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as { kind?: string };
    return payload.kind === 'plugin-oauth';
  } catch {
    return false;
  }
}

export function verifyPluginOAuthState(token: string): { userId: string; connectionId: string } {
  const [body, sig] = token.split('.');
  if (!body || !sig || createHmac('sha256', env.JWT_SECRET).update(`plugin-oauth:${body}`).digest('base64url') !== sig) {
    throw AppError.badRequest('plugin_oauth_state_invalid', 'Invalid plugin OAuth state');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
    kind?: string;
    userId: string;
    connectionId: string;
    exp: number;
  };
  if (payload.kind !== 'plugin-oauth' || payload.exp <= Date.now()) {
    throw AppError.badRequest('plugin_oauth_state_expired', 'Plugin OAuth state expired');
  }
  return { userId: payload.userId, connectionId: payload.connectionId };
}

/** Exchange the OAuth code, store encrypted tokens + granted scopes, CONNECT. */
export async function completePluginOAuth(code: string, stateToken: string): Promise<{ userId: string; connectionId: string }> {
  const { userId, connectionId } = verifyPluginOAuthState(stateToken);
  const connection = await getConnection(userId, connectionId);
  const adapter = await loadAdapter(connection.plugin_type);
  if (!adapter.oauth?.required) throw AppError.badRequest('oauth_not_required', `${connection.plugin_type} does not use OAuth`);
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? '',
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
      signal: outboundSignal(),
    });
  } catch {
    throw AppError.unavailable('google_token_timeout', 'Google token exchange timed out');
  }
  if (!response.ok) throw AppError.badRequest('google_token_failed', 'Google token exchange failed');
  const payload = (await response.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!payload.refresh_token) {
    throw AppError.badRequest('google_refresh_token_missing', 'Google returned no refresh token (consent required)');
  }
  await storePluginCredential(connectionId, 'refresh_token', payload.refresh_token, userId);
  if (payload.access_token) await storePluginCredential(connectionId, 'access_token', payload.access_token, userId);
  const grantedScopes = (payload.scope ?? '').split(' ').filter(Boolean);
  await storePluginCredential(connectionId, 'oauth_scopes', JSON.stringify(grantedScopes), userId);
  await transitionConnectionState(connectionId, 'CONNECTED', { lastError: null, actorUserId: userId });
  await recordAudit({
    action: AuditAction.PLUGIN_REAUTHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'plugin_connection',
    resourceId: connectionId,
    detail: { pluginType: connection.plugin_type, oauth: true },
  });
  return { userId, connectionId };
}