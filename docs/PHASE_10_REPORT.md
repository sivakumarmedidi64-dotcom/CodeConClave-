# PHASE 10 — Plugins + External Integrations + Plugin Isolation (Report)

## Status
COMPLETE. Plugins are now real integrations with a controlled isolation
boundary, not placeholders: a typed plugin SDK/registry, the full engine
boundary (validate → authorize → scope → rate limit → circuit breaker →
policy → provider with timeout/retry/backoff → result validation → audit),
an encrypted credential vault, four genuine adapters (GitHub, Google, Resend,
generic webhook/API), health monitoring with honest state transitions
(DEGRADED/FAILED/REAUTH_REQUIRED + notifications), Approval Center +
coworker integration, provenance artifacts/memories, a rewritten frontend
Plugins workspace, and a 66-test contract suite. The existing GitHub App
(`CodeConClave Pro`) and the existing Google OAuth application are reused —
no new apps or clients; the Google OAuth callback routes plugin states to the
plugin flow through the same registered redirect URI. Providers are only
called through the boundary, failures degrade the plugin (never the app), and
nothing is faked: without credentials or app configuration the adapters
answer honestly (`credentials_missing`/`github_app_not_installed`/
`google_not_configured`). Migration 0032 remains static-only (PostgreSQL
runtime unavailable). See Blockers.

## Files created
- `database/migrations/0032_phase10_plugins.sql` — Phase 10 schema: CHECK
  expansions (plugin types + google/resend; plugin states + DEGRADED/FAILED/
  REAUTH_REQUIRED), `plugin_credentials` (AES-256-GCM encrypted at rest,
  unique `(connection_id, kind) WHERE revoked_at IS NULL`, RLS + indexes),
  `plugin_health` ledger (RLS + indexes), `plugin_idempotency`, plugin events
  index, catalogue seeds for google/resend.
- `backend/src/modules/plugins/sdk.ts` — plugin adapter SDK + registry
  (`registerAdapter`/`getAdapter`/`listAdapters`/`getAction`).
- `backend/src/modules/plugins/circuit.ts` — per-connection circuit breaker
  (3 failures → OPEN, 30s cooldown → HALF_OPEN, trial closes), sliding rate
  limiter (60/min), `withRetry` (AbortController timeout, exponential
  backoff, idempotent-only retries; AppError/ProviderTimeoutError pass
  through unchanged), `ProviderTimeoutError`.
- `backend/src/modules/plugins/credentials.ts` — encrypted credential vault:
  `storePluginCredential` (upsert on `(connection_id, kind)` where not
  revoked), `readPluginCredentials` (decrypt server-side only),
  `credentialKinds` (safe for responses), `revokePluginCredentials`,
  `hasPluginCredential`.
- `backend/src/modules/plugins/adapters/github.ts` — real GitHub adapter:
  stored encrypted token OR GitHub App JWT → installation access token flow;
  actions repositories.list/get, repositories.contents, branches, issues.list,
  pulls.list, checks.list; 401→`github_unauthorized`, 404→`github_not_found`,
  no creds/App → `credentials_missing`; declares only genuinely implemented
  capabilities (NO webhooks).
- `backend/src/modules/plugins/adapters/google.ts` — real Google adapter
  reusing the existing OAuth application (same client id/secret and
  redirect URI): gmail (list/get/send), drive (files list/get/create), sheets
  (spreadsheets list, values get/append), calendar (events list/create);
  per-action `oauthScope` enforced against the scopes granted at connect
  (`oauth_scope_denied`); refresh/access tokens stored encrypted; exports
  `googlePluginAuthorizeUrl`.
- `backend/src/modules/plugins/adapters/resend.ts` — Resend adapter:
  `email.send` (idempotency key supported) + `email.status`; API key from
  stored credential or env; failures → `resend_send_failed`, missing key →
  `credentials_missing` (never faked as delivered).
- `backend/src/modules/plugins/adapters/webhook.ts` — generic webhook/API
  adapter: `http.request` (GET/POST/PUT/PATCH/DELETE/HEAD, typed body,
  per-call `timeoutMs`), destination must pass the deterministic host
  allowlist (`webhookHostAllowed`: https/http only, no localhost, env
  `PLUGIN_WEBHOOK_ALLOWED_HOSTS` + runtime `registerWebhookHosts`, deny by
  default → `plugin_url_not_allowed`), headers from secure credentials,
  non-2xx → `webhook_response_rejected`.
- `backend/src/modules/plugins/engine.ts` — the plugin isolation boundary:
  `executePluginAction` (tenant-scoped ownership → typed schema → state gate
  (only CONNECTED/DEGRADED execute) → effective scope check → rate limit →
  circuit breaker (open-circuit rejections also count toward health) →
  policy re-run (approval can never bypass scope) → OAuth credential check →
  provider via `withRetry` (idempotent: 2 attempts/15s, non-idempotent:
  1 attempt/10s, per-call `input.timeoutMs` override) → result validation →
  audit/event/health tracking → provenance), `healthCheckPlugin`,
  `beginPluginOAuth`/`completePluginOAuth` (state tokens namespaced
  `plugin-oauth`, HMAC-signed, 10 min expiry), `isPluginOAuthState`/
  `verifyPluginOAuthState`, `consecutivePluginFailures`/`resetHealthTrackers`.
- `backend/src/modules/plugins/pluginTool.ts` — `registerPluginTools` registers
  the `plugin_action` tool, requiring an authenticated caller context
  (`ctx.userId`; missing → `plugin_caller_unknown`).
- `backend/src/modules/plugins/index.ts` — once-guarded `registerPlugins()`
  registering the four adapters + tools.
- `backend/src/foundation/plugins-10.test.ts` — 66-test Phase 10 contract
  suite (see Tests).
- `docs/PHASE_10_REPORT.md` — this report.

## Files modified
- `shared/src/constants.ts` — PluginType +GOOGLE/RESEND; PluginState
  +DEGRADED/FAILED/REAUTH_REQUIRED; new `PluginPermission` (read/write/send/
  publish/create/update/delete/admin); new `PluginCapability`; NotificationType
  +PLUGIN_DEGRADED/PLUGIN_FAILED/PLUGIN_REAUTH_REQUIRED/PLUGIN_RECOVERED;
  AuditAction +PLUGIN_DISCONNECTED/PLUGIN_REAUTHED/PLUGIN_SCOPE_CHANGED/
  PLUGIN_HEALTH_CHANGED/PLUGIN_ACTION_PERFORMED/PLUGIN_CREDENTIAL_STORED.
- `shared/src/contracts.ts` — `pluginConnectSchema` (one-time `credential`
  `{kind, value}`), `pluginActionSchema`, `pluginScopesUpdateSchema`.
- `backend/src/config/env.ts` — `PLUGIN_WEBHOOK_ALLOWED_HOSTS` (default '').
- `backend/src/modules/plugins/health.ts` — extended to Phase 10: connection
  lifecycle (`connectPlugin` with duplicate conflict, `disconnectPlugin`
  soft, `reauthorizePlugin`, `revokePlugin` + scope revocation,
  `setConnectionState`, `transitionConnectionState` with owner
  notifications/audit/events), scope management (`updateConnectionScopes`
  replace-grants, `listPluginScopes`, `effectivePluginScopes`), events
  (`listPluginEvents`), health ledger (`recordPluginHealth`), sweep extended
  to CONNECTING/CONNECTED/DEGRADED/REAUTH_REQUIRED.
- `backend/src/modules/plugins/routes.ts` — extended: catalogue, connections
  (create with optional one-time credential + `connectPluginFinalize`
  handshake before CONNECTED), disconnect/reauthorize/revoke, scopes
  (GET/PATCH), events (GET/POST), health-check, `POST /actions` (policy →
  propose approval when required, execute via approval with `path` resource
  binding, direct execute for LOW), `GET /oauth/:connectionId/authorize`,
  exported `pluginOAuthCallback`.
- `backend/src/modules/execution/toolcalls.ts` — `ToolExecutionContext` and
  `runRegisteredTool(name, input, ctx?)` (2-arg calls remain valid).
- `backend/src/modules/execution/approvals.ts` — `executeApprovedAction`
  passes `{ userId }` as caller context so `plugin_action` re-verifies
  ownership (tenant isolation) at execution time.
- `backend/src/modules/auth/routes.ts` — the existing google OAuth callback
  branches to the plugin flow when `isPluginOAuthState(state)` is true →
  `pluginOAuthCallback` → redirect `${env.APP_URL}/plugins`.
- `backend/src/server.ts` + `backend/src/workers/run.ts` — `registerPlugins()`.
- `backend/src/modules/plugins/circuit.ts` — `withRetry` rethrows AppError
  and ProviderTimeoutError unchanged (adapter error codes must survive the
  retry wrapper).
- `backend/src/modules/plugins/engine.ts` — per-call `input.timeoutMs`
  override honored; open-circuit rejections counted in the health failure
  ledger; provenance `resource` derived from typed input (owner/repo pair,
  url, or explicit resource).
- `backend/src/modules/plugins/adapters/webhook.ts` — `response.text`
  defensively guarded for non-standard response objects.
- `frontend/src/lib/types.ts` — Phase 10 wire types: `PluginType` (7 types),
  `PluginCatalogueEntry`, `PluginConnection` (snake_case row incl. scopes/
  state/last_error), `PluginScopeRow`, `PluginEventRow`, `PLUGIN_PERMISSIONS`,
  `PLUGIN_STATES`.
- `frontend/src/pages/PluginsPage.tsx` — rewritten as the Plugins workspace
  (see Frontend).

## Plugins
- Catalogue is server-side (`plugins` table) with the four registered
  adapters; every action is a typed zod schema on the adapter (no free-form
  provider calls).
- Connections are per-user and tenant-scoped (every read verifies
  `owner_id`); only CONNECTED/DEGRADED execute; FAILED/REAUTH_REQUIRED/
  DISCONNECTED/REVOKED/ERROR/CONNECTING reject honestly
  (`plugin_not_connected`/`plugin_reauth_required`).
- Lifecycle: connect (duplicate conflict `plugin_connected`; one-time
  credential stored encrypted + real `authenticate` handshake before
  CONNECTED — never by UI claim), disconnect (soft, credentials kept),
  reauthorize (OAuth adapters → authorize URL + REAUTH_REQUIRED; token
  adapters verify stored credentials → CONNECTING), revoke (REVOKED +
  scopes/credentials revoked).

## Plugin SDK
- `PluginAdapter` (id/name/provider/version/capabilities/oauth/actions/
  authenticate/healthCheck/execute/validateResponse) + `PluginActionDef`
  (name/permission/scope/oauthScope/idempotent/description/inputSchema);
  `registerPlugins()` registers github/google/resend/webhook once-guarded.

## Isolation
- Every action crosses the engine boundary in order: ownership →
  schema → state gate → scope → rate → circuit → policy → OAuth → provider
  (timeout/retry/backoff) → result validation → audit/events/health →
  provenance. Raw model output never invokes a provider directly.
- Circuit breaker + rate limiter are per-connection and in-memory; retries
  only for idempotent actions; failures degrade the connection, never the
  process.

## Permissions
- Scopes are server-authoritative `plugin_scopes` grants (PluginPermission
  values: read/write/send/publish/create/update/delete/admin); actions carry
  a required permission (`def.permission`), `admin` covers any action;
  scope updates replace grants and are audited (`PLUGIN_SCOPE_CHANGED`);
  approvals cannot bypass scope — the engine re-checks at execution time
  (`plugin_scope_denied`).

## Credentials
- `plugin_credentials` rows are AES-256-GCM encrypted at rest
  (`encryptAtRest`, SESSION_SECRET-derived key); kinds token/api_key/
  refresh_token/access_token/secret/oauth_scopes; revocable via `revoked_at`;
  values are never returned through any API surface or audit (only
  `credentialKinds` is exposed); Google tokens include the granted
  `oauth_scopes` for per-action enforcement.

## GitHub
- Stored token or GitHub App JWT → installation access token (no invented
  permissions; without either → `credentials_missing`/`github_app_not_installed`);
  read-only foundation actions with versioned API headers
  (`X-GitHub-Api-Version: 2022-11-28`); 401/403 → `github_unauthorized`,
  404 → `github_not_found`; webhooks NOT declared.

## Google
- Reuses the existing Google OAuth application and registered redirect URI;
  auth callback routes plugin states to `pluginOAuthCallback` (redirect to
  `/plugins`); state tokens are namespaced (`plugin-oauth`), HMAC-signed,
  10-minute expiry; tokens stored encrypted; begin/complete flow honest when
  unconfigured (`google_not_configured`); gmail/drive/sheets/calendar with
  per-action OAuth scope enforcement (`oauth_scope_denied`).

## Resend
- `email.send` (idempotency key) + `email.status` against the real Resend
  API with server-side key (stored or env); failures → `resend_send_failed`
  (never faked as delivered); missing key → `credentials_missing`.

## Webhook / API
- `http.request` with method/body/headers from secure credentials and
  per-call `timeoutMs`; destinations must pass the deterministic allowlist
  (`plugin_url_not_allowed` otherwise — localhost and non-http rejected);
  non-2xx → `webhook_response_rejected`; response text parsed as JSON when
  possible.

## Health
- Every outcome writes the `plugin_health` ledger; failures accumulate
  (3 → DEGRADED, 5 → FAILED with `plugin.degraded`/`plugin.failed`
  notifications); clean actions and passing health checks recover to
  CONNECTED (`plugin.recovered`); the sweep marks stale connections ERROR
  (honest, with recorded last_error); REAUTH_REQUIRED surfaces
  `plugin.reauth_required` notifications.

## Retry + circuit
- `withRetry` (timeout via AbortController, exponential backoff,
  idempotent-only), `ProviderTimeoutError`, circuit CLOSED → OPEN (3) →
  HALF_OPEN (30s) → trial → CLOSED/OPEN; open-circuit rejections surface
  `plugin_circuit_open` (503) and keep the health ledger moving;
  rate limiter rejects bursts with `plugin_rate_limited` (60/min per
  connection).

## Approval integration
- `POST /api/v1/plugins/actions` proposes an approval when policy requires
  it (never auto-executes), executes via `executeApprovedAction` with the
  `path` resource binding (approval for a different connection →
  `approval_resource_mismatch`), and records SUCCEEDED/FAILED back on the
  approval; rejected/expired approvals cannot execute; approvals cannot
  bypass plugin scope or policy.

## Coworker / tool calls
- `plugin_action` is a registered tool gated by the policy engine with
  approval linkage; it requires an authenticated caller context
  (`plugin_caller_unknown` without one) and re-verifies ownership at
  execution time; failed provider calls surface as AppErrors (503
  `plugin_provider_error`), never process crashes.

## Provenance
- Plugin outputs never silently become verified user facts: artifacts are
  saved as `PLUGIN_RESULT` (verification SKIPPED, `plugin://` refs) and
  memories as OBSERVED/SEMANTIC — best-effort, never breaking the action;
  events record action/ok/latency/resource without provider internals.

## Frontend
- PluginsPage rewritten as the Plugins workspace: catalogue grid with
  capabilities chips; per-plugin connection card with state badge (all 8
  states colored), Connect (one-time credential input — token/api_key/secret
  — encrypted and never echoed, or Connect + Authorize redirecting to the
  existing Google OAuth flow), Manage (scope checkboxes for all 8
  permissions + save, events list with payloads, health check result,
  last error), Reauthorize (OAuth redirect or server verify), Disconnect,
  Revoke. The 18-item sidebar is unchanged.

## Database migrations
- `0032_phase10_plugins.sql` adds the credentials vault, health ledger,
  idempotency table, CHECK expansions and seeds. IMPORTANT: PostgreSQL
  runtime is NOT available in this environment — the migration was validated
  for SQL syntax only and never applied. Do not claim runtime migration
  success.

## Tests
- `plugins-10.test.ts` (66): core (registration, connect → CONNECTING with
  no fake success, duplicate conflict, disconnect/revoke, reauthorize OAuth/
  token, sweep), permissions (allowed/denied/revoked/admin/tenant isolation/
  scope replace + audit/invalid scope), security (credential values never
  exposed, revoke unreadability, allowlist rejection, non-CONNECTED states
  never execute, typed schemas, unknown actions before any provider call),
  health (healthy/degraded/failed/recovery/clean-action recovery/counter),
  retry + circuit (timeout, idempotent backoff, non-idempotent single
  attempt, engine 2-attempt cap, open circuit, half-open trial, rate limit),
  github (auth headers, 401/404/credentials_missing, capabilities), google
  (state round-trip, honest unconfigured, OAuth-only, token storage
  encrypted + CONNECT, oauth scope enforcement, token protection in audits/
  events, four APIs), resend (send/failure/missing key), webhook
  (allowlisted execute + body validation, credential headers, non-2xx,
  per-call timeout, result validation), approval integration (propose
  PENDING, approved SUCCEEDED, rejected/expired cannot execute, scope bypass
  → FAILED, resource mismatch), coworker (policy + approval linkage +
  audit, caller context required, engine execution, failure isolation,
  state transitions audited), provenance (artifacts + events without
  provider internals).
- Pre-existing suites remain green.

## Validation
- shared: typecheck PASS, build PASS, 63/63 tests.
- local-agent: unchanged 49/49 tests.
- backend: typecheck PASS, build PASS, 650/650 tests (584 pre-existing + 66
  new).
- frontend: typecheck PASS, build PASS, 62/62 tests.
- Total: 824/824.

## Blockers
- PostgreSQL runtime unavailable — migration 0032 (and the plugin SQL
  shapes) are static-validated only; RLS, upserts and the CHECK expansions
  are unverified against a live database.
- No live provider credentials and no GitHub App / Google OAuth client
  configuration in this environment — adapters are exercised against mocked
  fetch boundaries (real implementation, mocked network); live validation
  with real accounts is required before production claims. Google OAuth
  (`beginPluginOAuth`) honestly reports `google_not_configured` until
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set.
- Circuit breaker/rate limiter state is in-memory per process (deterministic
  and test-friendly); multi-process deployments need a shared store.
- No lint scripts configured in any workspace — typecheck + build are the
  enforced gates.
- The `webhook` adapter's token is optional by design (allowlisted public
  endpoints may need no auth); operators must scope allowlists tightly.
