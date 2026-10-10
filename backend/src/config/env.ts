/**
 * CodeConClave backend — environment configuration.
 * All secrets are read from environment only. Never print, never commit.
 */
import { z } from 'zod';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertTrustProxyUsable, parseTrustProxy } from './trust-proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// backend/src/config -> backend/src -> backend -> repo root
const repoRoot = path.resolve(here, '..', '..', '..');
loadEnv({ path: path.join(repoRoot, '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:4000'),
  APP_NAME: z.string().default('CodeConClave'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SESSION_SECRET: z.string().min(16).default('dev_only_session_secret_do_not_use_in_prod'),
  JWT_SECRET: z.string().min(16).default('dev_only_jwt_secret_do_not_use_in_prod'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.string().default('false'),

  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  DATABASE_SSL: z.string().default('false'),

  REDIS_URL: z.string().optional(),
  QUEUE_PROVIDER: z.enum(['memory', 'redis']).default('memory'),

  AUTH_ISSUER: z.string().default('codeconclave'),
  AUTH_ACCESS_TOKEN_TTL: z.coerce.number().int().default(900),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().default(30),
  AUTH_REMEMBER_DAYS: z.coerce.number().int().default(90),
  MFA_REQUIREMENT_LEVEL: z.coerce.number().int().default(0),
  MFA_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  RECOVERY_CODE_COUNT: z.coerce.number().int().default(10),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default(
    () => `${process.env.APP_URL || 'http://localhost:5173'}/api/v1/auth/google/callback`,
  ),
  GOOGLE_OAUTH_CONSENT_MODE: z.string().default('consent'),
  GOOGLE_SCOPES: z.string().default(
    'https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/calendar.events',
  ),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  GROK_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  KIMI_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  QWEN_API_KEY: z.string().optional(),
  DEVIN_API_KEY: z.string().optional(),
  DEVIN_ORG_ID: z.string().optional(),
  // Optional provider credentials for free-tier endpoints (add only if model is actually selected)
  GROQ_API_KEY: z.string().optional(),
  CLOUDFLARE_AUTH_TOKEN: z.string().optional(),
  // Pre-Prompt 3 provider key preparation (CODECONCLAVE PRO gate): verified
  // provider identities; empty = ENVIRONMENT_BLOCKED. AdaptErs/wiring land in
  // the Provider Configuration gate; keys are NOT used until then.
  OX_ALPHA_API_KEY: z.string().optional(),
  MANUS_API_KEY: z.string().optional(),
  Z_AI_API_KEY: z.string().optional(),
  // Meta Muse Spark (optional reasoning/coding provider). Dedicated
  // server-side credential; NEVER exposed to the browser, logs, or audit
  // content. MUSE_SPARK_ENABLED gates adapter construction (default OFF).
  MUSE_SPARK_API_KEY: z.string().optional(),
  MUSE_SPARK_ENABLED: z.string().default('false'),
  // Launch provider set (production): Gemini, Nemotron, Mistral only. Everything
  // else stays implementable by explicit env override, never on by default.
  AI_PROVIDERS_ENABLED: z.string().default('google,nemotron,mistral'),
  AI_DEFAULT_MODEL: z.string().optional(),
  AI_PREMIUM_BUDGET_USD_PER_DAY: z.coerce.number().positive().default(4),
  AI_MODEL_REFRESH_MINUTES: z.coerce.number().int().default(10),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  AI_CHAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default('CodeConClave <noreply@example.com>'),
  RESEND_ENABLED: z.string().default('false'),

  // ------------------------------------------------------------ EMAIL TRANSPORT
  // Single transmitting rail at a time. Default 'resend' = the existing
  // production rail (UNCHANGED). 'gmail' is a TEMPORARY zero-cost PILOT
  // transport via Gmail SMTP using an app password on a dedicated account
  // (e.g. codeconclave.dev@gmail.com). It is NOT the final production email
  // architecture: Resend / domain-based transactional email remains the
  // intended long-term path and is NOT removed. GMAIL_APP_PASSWORD is read
  // from env only — never logged, never returned, never committed.
  EMAIL_TRANSPORT: z.enum(['resend', 'gmail']).default('resend'),
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  GMAIL_FROM_EMAIL: z.string().optional(),
  // OTP code lifetime in minutes. Audit default 10; clamped 1..60 so the
  // audited security contract can never be weakened outside its bounds.
  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_URL: z.string().optional(),

  PLUGIN_WEBHOOK_ALLOWED_HOSTS: z.string().default(''),

  RAZORPAY_MODE: z.enum(['payment_link', 'api', 'webhook']).default('payment_link'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Trusted verification rail (independent of checkout mode): when enabled and
  // RAZORPAY_WEBHOOK_SECRET is set, signed Razorpay webhooks are accepted to
  // verify payments and auto-activate entitlements. Checkout still uses payment
  // links; the webhook is the verification rail, not the checkout method.
  RAZORPAY_WEBHOOK_ENABLED: z.string().default('false'),
  // Defense-in-depth rail token shared with the Cloudflare webhook adapter
  // (worker). When set, the webhook route requires `Authorization: Bearer
  // <token>`; when unset (direct Razorpay-to-origin mode), HMAC-only. The
  // worker forwards this token when configured.
  INTERNAL_WEBHOOK_TOKEN: z.string().optional(),
  RAZORPAY_PRO_PAYMENT_LINK: z.string().default('https://rzp.io/rzp/sAgHIpxS'),
  RAZORPAY_TEAM_PAYMENT_LINK: z.string().default('https://rzp.io/rzp/3ioXlCxd'),
  // API Access is a SEPARATE product at ₹9,999. Its own static payment link is
  // founder-provided (no sane default): when empty, any api purchase attempts to
  // fail safely (never falls back to the Team ₹4,999 link).
  RAZORPAY_API_PAYMENT_LINK: z.string().optional(),
  // Static per-plan Payment Link IDs (provider identity, NOT the URL). The
  // AUTOPILOT rail binds a signed webhook to the EXACT product it paid: the
  // payment_link.entity.id in a webhook must equal the configured link ID for
  // that plan. With these IDs configured, even static per-plan links (whose
  // intents carry no provider_reference_id) auto-activate after full webhook
  // verification. Unconfigured IDs fail closed: such events never auto-activate.
  RAZORPAY_PRO_PAYMENT_LINK_ID: z.string().optional(),
  RAZORPAY_TEAM_PAYMENT_LINK_ID: z.string().optional(),
  RAZORPAY_API_PAYMENT_LINK_ID: z.string().optional(),
  RAZORPAY_PAYMENT_LINK_STATUS_POLL_MINUTES: z.coerce.number().int().default(30),

  // ---------------------------------------------------------------- MANUAL FULFILLMENT MODE
  // UNLOCK_MODE selects how paid plans unlock. MANUAL (default) and AUTOPILOT
  // are the two real modes. AUTO is a deprecated legacy alias kept only for
  // back-compat in parsed configs: it is never simulated and normalizes to
  // MANUAL (fail-closed). MANUAL mode works with ZERO Razorpay credentials
  // (no key id/secret/webhook/custom domain). AUTOPILOT auto-activates paid
  // plans from the trusted signed-webhook verification rail; it additionally
  // requires the runtime readiness prerequisites (webhook secret enabled, all
  // three payment links configured) and can be flipped per-admin at runtime via
  // payment_unlock_settings.
  UNLOCK_MODE: z.enum(['MANUAL', 'AUTO', 'AUTOPILOT']).default('MANUAL'),
  // AUTOPILOT intervention window (ms): a signed-webhook verified payment is
  // held server-side/persisted for this long before auto-approval; the founder
  // can STOP during the window (payment_auto_approvals). Default 2000ms.
  PAYMENT_AUTO_APPROVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2000),
  // Founder payment mirror (Google Sheets). The DB is always the source of
  // truth; a sheet is ONLY a mirror. When set, the founder's connected Google
  // Sheets plugin can receive append-only revenue snapshots; when unset the
  // mirror stays disabled (payment truth is never affected by sheet state).
  FOUNDER_SHEET_ID: z.string().optional(),
  // Optional server-authoritative price re-check for MANUAL claims. When set,
  // the claim's amount_inr must equal the authoritative plan price +- tolerance;
  // the client-submitted amount is NEVER trusted, it is overwritten.
  PAYMENT_CLAIM_TOLERANCE_INR: z.coerce.number().int().default(0),

  PAYMENT_INTENT_TTL_HOURS: z.coerce.number().int().default(24),
  PAYMENT_GRACE_HOURS: z.coerce.number().int().default(72),
  PAYMENT_CONFIDENCE_ACTIVE: z.coerce.number().min(0).max(1).default(0.8),
  PAYMENT_CONFIDENCE_GRACE: z.coerce.number().min(0).max(1).default(0.5),
  PAYMENT_AMOUNT_TOLERANCE_INR: z.coerce.number().int().default(0),
  PAYMENT_ACCOUNT_EMAIL: z.string().optional(),
  PAYMENT_FOUNDER_EMAIL: z.string().optional(),
  // TEST-ONLY payment bypass allowlist (server-side, user IDs, comma-separated).
  // Empty (default) = disabled. A listed user ID receives Team-level workspace
  // access WITHOUT payment for development/manual validation. This is a
  // read-time override only: it never writes entitlement or payment rows, never
  // marks any payment successful, and never affects Razorpay reconciliation.
  // Matching is by exact user ID — never email, never client input. Ordinary
  // users can never activate it. Never commit real IDs.
  PAYMENT_TEST_USER_IDS: z.string().default(''),
  // Founder AI operations agent: LLM intent classification for founder queries.
  // When 'false', the deterministic (offline, zero-provider) classifier is used
  // — read tools work identically; safety is never lowered by either path.
  AI_FOUNDER_AGENT: z.string().default('true'),
  GMAIL_CLAIM_ENABLED: z.string().default('false'),
  GMAIL_CLAIM_HMAC_SECRET: z.string().optional(),
  GMAIL_CLAIM_TOKEN_TTL_HOURS: z.coerce.number().int().default(24),
  GMAIL_CLAIM_TIMESTAMP_TOLERANCE_SECONDS: z.coerce.number().int().default(300),
  PAYMENT_VELOCITY_WINDOW_MINUTES: z.coerce.number().int().default(60),
  PAYMENT_VELOCITY_MAX: z.coerce.number().int().default(3),

  // ---------------------------------------------------------------- IMAP AUTO-UNLOCK (NO-API / NO-WEBHOOK RAIL)
  // Reads UNSEEN Razorpay payment notifications from the MERCHANT mailbox over
  // IMAP using the existing transactional-email app-password credentials
  // (GMAIL_USER + GMAIL_APP_PASSWORD). No Razorpay API key, no webhook secret.
  // Evidence flows through the SAME trusted pipeline (matcher + activation) as
  // every other rail: auto-ACTIVE requires a server-issued reference (pool
  // links) plus amount/window/fraud checks; reference-less payments can reach
  // REVIEW (founder one-click) but never auto-ACTIVATE. OFF by default.
  PAYMENT_IMAP_UNLOCK_ENABLED: z.string().default('false'),
  PAYMENT_IMAP_POLL_SECONDS: z.coerce.number().int().min(60).default(180),
  PAYMENT_IMAP_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  GMAIL_IMAP_HOST: z.string().default('imap.gmail.com'),

  // ---------------------------------------------------------------- SELF-SERVICE PAYMENT (CONDITIONAL)
  // SAFE, feature-flagged, OFF by default. Layered on the EXISTING fail-closed
  // payment pipeline. When ON, an authenticated user may confirm EMAIL OWNERSHIP
  // of a matched payment via a one-time, hashed, expiring, account-bound token
  // before activation completes through the authoritative entitlement gate.
  // NEVER treats the email click as payment proof; payment must still satisfy the
  // full evidence policy (authenticated Razorpay origin + exact reference +
  // amount + window + fraud/replay guards). No schema change; tokens live in cache.
  AIOS_PAYMENT_SELF_SERVICE: z.string().default('false'),
  AIOS_PAYMENT_SELF_SERVICE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  AIOS_PAYMENT_SELF_SERVICE_MAX_PER_HOUR: z.coerce.number().int().nonnegative().default(5),
  AIOS_PAYMENT_SELF_SERVICE_MAX_ATTEMPTS: z.coerce.number().int().nonnegative().default(5),

  GMAIL_OAUTH_ACCESS_TOKEN: z.string().optional(),
  GMAIL_OAUTH_REFRESH_TOKEN: z.string().optional(),

  // ---------------------------------------------------------------- PAYMENT LINK-POOL (POLICY B)
  // Static Payment Link-Pool for automatic, no-API/no-webhook/no-admin
  // activation under POLICY B (payment binds to the authenticated checkout
  // intent; a third party may pay as a gift). POOL_SIZE default 50; TTL default
  // 15 minutes. PAYMENT_POOL_LINKS (optional JSON array of PoolLinkConfig) is
  // the deployment-time catalogue; PAZORPAY_REFERENCE_BEHAVIOR is UNVERIFIED.
  PAYMENT_POOL_TTL_MINUTES: z.coerce.number().int().default(15),
  PAYMENT_POOL_LINKS: z.string().optional(),
  // Email address that the READ-ONLY payment watchtower alerts are delivered
  // to (via the existing outbox/SMTP configuration). Optional. The watchtower
  // itself is GLOBALLY unscoped — it inspects payment state across all users,
  // workspaces and projects and is NOT an authorization boundary. This value
  // only decides where an alert is DELIVERED. It does NOT control whether the
  // watchtower runs: the engine is invoked by an explicit scheduler. On the
  // scheduled runner this is `npm run watchtower:run` (see
  // backend/src/scripts/run-watchtower.ts and docs/WATCHTOWER_SCHEDULING.md);
  // the engine performs every check C1-C7 regardless of this setting. If it is
  // unset/empty the watchtower still finishes every check, still records the
  // complete result, and emits exactly one ALERT_DESTINATION_UNCONFIGURED
  // warning. Never expose this address in frontend responses, logs of check
  // data, or audit payloads.
  PAYMENT_WATCHTOWER_ALERT_EMAIL: z.string().optional(),

  // ---------------------------------------------------------------- DEMO PAYMENT MODE
  // Strictly NON-PRODUCTION demo/test flow. Redirect-only "payment" is NEVER
  // payment verification. Enabled only when DEMO_PAYMENT_MODE=true AND
  // NODE_ENV !== "production" (hard server-side guard). A frontend env var,
  // cookie, or query parameter cannot enable it. By default no demo session
  // secret is set, so the rail is inert unless explicitly configured.
  DEMO_PAYMENT_MODE: z.string().default('false'),
  // Optional comma-separated allowlist of user emails permitted to use the
  // demo flow (additional server-side restriction in dev/staging).
  DEMO_PAYMENT_ALLOWLIST: z.string().default(''),
  // Server-only secret for HMAC-SHA256 signing of the short-lived demo
  // session. Falls back to a hash of SESSION_SECRET when unset (still
  // server-only; never exposed to the browser).
  DEMO_SESSION_SECRET: z.string().optional(),
  DEMO_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  DEMO_ACTIVATION_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  DEMO_ACTIVATION_MAX_PER_HOUR: z.coerce.number().int().positive().default(3),

  // ------------------------------------------------- TEMPORARY DEMO / EARLY ACCESS MODE
  // TEMPORARY — added for the Saturday Kuberns demonstration. DELETE this flag
  // (and every `temporaryDemoModeEnabled()` branch) once the demo is over.
  //
  // When 'true', an authenticated user may use the core workspace (projects,
  // tasks/agents, execution, memory, chat) WITHOUT a paid entitlement.
  //
  // SECURITY / COMMERCIAL INVARIANTS:
  //  - Server-side only. A frontend env var, localStorage value, cookie,
  //    URL/query parameter or request body can NEVER enable it; the only input
  //    is this process environment variable, read on the server.
  //  - Writes NO rows. It never creates a payment, payment_intent, webhook or
  //    entitlement row, and never marks a plan as purchased/PRO_VERIFIED. It is
  //    a read-time allowance, exactly like the founder/test-user grants above.
  //  - It is NOT a free tier. users.plan_id / users.entitlement_state are left
  //    untouched, so nothing downstream can mistake demo access for a purchase.
  //  - API Access (the separate ₹9,999 entitlement behind /api/v1/ai and
  //    cc_live_* keys) is NOT unlocked by this flag; apiKeyAuth still enforces it.
  //  - Safety limits are RETAINED, not removed: bounded message/project/storage
  //    caps, a hard per-run AI budget, auth rate limits and abuse controls all
  //    stay active. See DEMO_LIMITS in modules/entitlements/service.ts.
  // Default is 'false', i.e. full commercial enforcement. Setting this back to
  // 'false' restores the paywall everywhere with no code change and no migration.
  TEMPORARY_DEMO_MODE: z.string().default('false'),

  CLOUDFLARE_WORKER_NAME: z.string().optional(),
  CLOUDFLARE_WORKER_URL: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_KV_NAMESPACE_ID: z.string().optional(),
  CLOUDFLARE_KV_BINDING_NAME: z.string().optional(),
  CLOUDFLARE_R2_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_R2_ENDPOINT: z.string().optional(),
  CLOUDFLARE_R2_BUCKET: z.string().optional(),
  CLOUDFLARE_R2_ACCESS_KEY_ID: z.string().optional(),
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: z.string().optional(),

  STORAGE_PROVIDER: z.enum(['memory', 's3', 'r2', 'postgres']).default('postgres'),
  STORAGE_PUBLIC_BASE_URL: z.string().default('http://localhost:4000/storage'),
  STORAGE_AT_REST_ENCRYPTION: z.string().default('false'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('codeconclave'),
  S3_REGION: z.string().default('auto'),
  S3_FORCE_PATH_STYLE: z.string().default('true'),

  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().default(0.1),
  SENTRY_ENABLED: z.string().default('false'),

  // ---------------------------------------------------------------- HYBRID CONTROL PLANE
  // Feature gates for the local/browser/desktop/preview control surfaces.
  // Default OFF: every capability is additive, must pass its own tests, and
  // when disabled must report NOT ENABLED rather than pretend to work. The
  // backend NEVER bypasses the local agent's own deny-by-default policy.
  LOCAL_EXECUTION_ENABLED: z.string().default('false'),
  BROWSER_CONTROL_ENABLED: z.string().default('false'),
  DESKTOP_CONTROL_ENABLED: z.string().default('false'),
  LIVE_PREVIEW_ENABLED: z.string().default('false'),
  UNIFIED_ACTION_RUNTIME_ENABLED: z.string().default('false'),
  // Desktop control is deny-by-default: even with the gate on, only the
  // applications named in this comma-separated allowlist may be launched.
  DESKTOP_ALLOWED_APPS: z.string().default(''),
  // Kuberns adapter boundary (P2/P4). Declared but disabled by default; with no
  // API URL/token the integration reports CONFIGURATION_REQUIRED and never
  // fabricates a connected or deployed state.
  KUBERNS_ADAPTER_ENABLED: z.string().default('false'),
  KUBERNS_API_URL: z.string().default(''),
  KUBERNS_API_TOKEN: z.string().default(''),
  // Local task assignment lease: how long an assignment stays claimable before
  // the recovery sweep re-parks the task (honest offline semantics preserved).
  LOCAL_TASK_LEASE_MS: z.coerce.number().int().positive().default(120_000),

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().default(300),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().default(10),
  RATE_LIMIT_AUTH_IDENTITY_PER_MIN: z.coerce.number().int().default(5),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().default(60),

  // ---------------------------------------------------------------- API ACCESS (KEY) LIMITS
  // Per-api-key request rate and per-account concurrency/daily budgets for
  // external clients using cc_live_* keys. Enforced server-side in the Bearer
  // API-key middleware; NOT client-configurable.
  API_RATE_LIMIT_REQUESTS: z.coerce.number().int().default(60),
  API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().default(60),
  API_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().default(3),
  API_MAX_DAILY_REQUESTS: z.coerce.number().int().default(500),
  // Max simultaneously-active (non-revoked) API keys per user.
  MAX_ACTIVE_API_KEYS_PER_USER: z.coerce.number().int().default(20),
  CSRF_COOKIE_NAME: z.string().default('codeconclave_csrf'),
  CSP_ENABLED: z.string().default('true'),
  SESSION_COOKIE_SECURE: z.string().default('false'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().default(50),

  FREE_DAILY_MESSAGES: z.coerce.number().int().default(20),
  FREE_USAGE_WINDOW_HOURS: z.coerce.number().int().min(1).default(24),
  FREE_MAX_PROJECTS: z.coerce.number().int().default(1),
  FREE_STORAGE_GB: z.coerce.number().int().default(2),
  FREE_MODEL_TIER: z.string().default('efficient'),

  LOCAL_AGENT_PORT: z.coerce.number().int().default(43121),
  LOCAL_AGENT_TOKEN_TTL_HOURS: z.coerce.number().int().default(1),
  LOCAL_AGENT_WS_URL: z.string().default('ws://localhost:4000/agent'),

  PREVIEW_BUILD_ENABLED: z.string().default('false'),
  PREVIEW_BUILD_COMMAND: z.string().optional(),
  PREVIEW_PROJECTS_ROOT: z.string().optional(),
  PREVIEW_OUTPUT_DIR: z.string().optional(),

  // ---------------------------------------------------------------- PKG-19 runtime
  // Browser + Runtime Development targets (all optional, empty = honest
  // NOT_RUN/UNAVAILABLE — never fabricated PASS).
  RUNTIME_VERIFY_ENABLED: z.string().default('false'),
  RUNTIME_VERIFY_URLS: z.string().default(''),
  RUNTIME_HOST: z.string().default(''),
  RUNTIME_PORT: z.string().default(''),
  RUNTIME_SMOKE_CONFIG: z.string().default(''),
  RUNTIME_SMOKE_BASE_URL: z.string().default(''),

  // ---------------------------------------------------------------- PKG-20 env safety
  // Per-project environment awareness (DEVELOPMENT/STAGING/PRODUCTION). These
  // define, by NAME ONLY, which variables must be present/valid per environment.
  // Secret VALUES are never configured, read back, or exposed here.
  RUNTIME_ENV_ALLOWED: z.string().default('development,staging,production'),
  RUNTIME_ENV_REQUIRED_DEVELOPMENT: z.string().default(''),
  RUNTIME_ENV_REQUIRED_STAGING: z.string().default(''),
  RUNTIME_ENV_REQUIRED_PRODUCTION: z.string().default(''),
  RUNTIME_ENV_KNOWN_VARS: z.string().default(''),

  // -------------------------- PKG-21 — release history + rollback
  // Comma-separated list of deployment providers this environment declares as
  // configured (honest; a declared adapter is still ENVIRONMENT_BLOCKED until a
  // live deployment is attested). Detected by NAME ONLY — never a credential.
  RELEASE_CONFIGURED_PROVIDERS: z.string().default(''),

  // ---------------------------------------------------------------- AI OS (P0)
  // Additive, feature-flag-gated AI OS foundation. When AIOS_ENABLED=false
  // (default), every OS primitive falls back to existing behavior and none of
  // the OS adapters are active. Never enabled implicitly in production.
  AIOS_ENABLED: z.string().default('false'),
  // Supervisor: default restart policy for tracked processes when not given.
  AIOS_DEFAULT_RESTART_POLICY: z.enum(['none', 'on_failure', 'always']).default('on_failure'),
  // Resource Governor: hard global ceilings (real enforceable controls only).
  AIOS_MAX_CONCURRENCY: z.coerce.number().int().nonnegative().default(8),
  AIOS_MAX_RUNTIME_MS: z.coerce.number().int().nonnegative().default(0), // 0 = no default cap
  AIOS_MAX_COST_USD: z.coerce.number().nonnegative().default(0), // 0 = no default cap
  // Sandbox: allowed command prefixes the sandbox may execute. Empty = deny all
  // (deny-by-default). Comma-separated, e.g. "git,node,tsx,npm,tsc".
  AIOS_SANDBOX_ALLOWED_COMMANDS: z.string().default(''),
  AIOS_SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // ---------------------------------------------------------------- AI OS P1
  // Additive P1 capabilities, all default OFF so the live system is unchanged.
  // Supervisor: exponential backoff base (ms) and max total run attempts.
  AIOS_BACKOFF_BASE_MS: z.coerce.number().int().nonnegative().default(0), // 0 = legacy immediate restart
  AIOS_MAX_RESTARTS: z.coerce.number().int().nonnegative().default(5),
  // IPC: durable event-store flag (outbox/memory) for the P1 event bus.
  AIOS_IPC_DURABLE: z.string().default('false'),
  // Git engine: off by default; when on, git runs through the policy sandbox.
  AIOS_GIT_ENABLED: z.string().default('false'),

  // ---------------------------------------------------------------- AI OS P2
  // Additive user-facing cowork capabilities, all default OFF. Each feature is
  // independently disableable so a failing feature can be turned off and the
  // pre-existing behavior remains available. No production changes by default.
  AIOS_P2_BREAKPOINT: z.string().default('false'),
  AIOS_P2_DIFF: z.string().default('false'),
  AIOS_P2_REPLAY: z.string().default('false'),
  AIOS_P2_UNDO: z.string().default('false'),
  AIOS_P2_TEAM_COWORK: z.string().default('false'),
  AIOS_P2_STOP_RULES: z.string().default('false'),
  AIOS_P2_PERSONALITY: z.string().default('false'),
  AIOS_P2_SUMMARY: z.string().default('false'),
  AIOS_P2_SMART_FILES: z.string().default('false'),
  AIOS_P2_ERROR_FIX: z.string().default('false'),
  AIOS_P2_CONTEXT_SIDEBAR: z.string().default('false'),
  AIOS_P2_TEMPLATES: z.string().default('false'),
  AIOS_P2_COMMAND_PALETTE: z.string().default('false'),
  AIOS_P2_SKILLS: z.string().default('false'),
  // PKG-22 Advanced Code Workspace (Editor + Navigation + Multi-File + Refactoring).
  // Default OFF and reversible; when OFF the workspace feature reports UNAVAILABLE
  // and no workspace routes mutate anything. Reuses the runtime workspace root.
  AIOS_P2_WORKSPACE: z.string().default('false'),
  AIOS_P2_SCHEDULER: z.string().default('false'),
  AIOS_P2_VOICE: z.string().default('false'),
  AIOS_P2_NOTIFICATIONS: z.string().default('false'),
  // PKG-23 Memory-Powered Coding. Default OFF and reversible; when OFF the
  // memory-coding feature reports UNAVAILABLE and no route mutates anything.
  AIOS_P2_MEMORY_CODING: z.string().default('false'),
  // PKG-24 AI Developer Copilot. Default OFF and reversible; when OFF the
  // copilot feature reports UNAVAILABLE and never mutates the repository.
  AIOS_P2_COPILOT: z.string().default('false'),
  // PKG-25 24/7 Autonomous Cowork proof. Default OFF and reversible. When OFF
  // the autonomy proof/run endpoints report feature_disabled; the read-only
  // truth report stays available. The underlying task engine is always ON.
  AIOS_P2_AUTONOMY: z.string().default('false'),

  // ---------------------------------------------------------------- AI OS P3
  // Additive P3 capability + intelligence tracks, all default OFF. Each track
  // is independently disableable and reversible; when off, the pre-existing
  // behavior is fully available. No production changes by default. P3 reuses
  // the canonical P0/P1/P2 primitives — no second bus/scheduler/state/policy.
  AIOS_P3_GITHUB: z.string().default('false'),
  AIOS_P3_JIRA: z.string().default('false'),
  AIOS_P3_SLACK: z.string().default('false'),
  AIOS_P3_NOTIFICATIONS: z.string().default('false'),
  AIOS_P3_SKILL_SECURITY: z.string().default('false'),
  AIOS_P3_CONTEXT: z.string().default('false'),
  AIOS_P3_TESTING: z.string().default('false'),
  AIOS_P3_SECURITY: z.string().default('false'),
  AIOS_P3_PERFORMANCE: z.string().default('false'),
  AIOS_P3_ARCHITECTURE: z.string().default('false'),
  AIOS_P3_TEAM: z.string().default('false'),
  AIOS_P3_DOCUMENTATION: z.string().default('false'),
  AIOS_P3_IDE: z.string().default('false'),

  // ---------------------------------------------------------------- AI OS REAL ISOLATION
  // Real process/container isolation (next security layer). All default OFF so
  // the live system is unchanged. When OFF, the isolation facade reports the
  // honest host boundary and the default `policy_only` min mode keeps existing
  // behavior. Fail-closed: if the host cannot meet minMode, run is denied.
  AIOS_ISOLATION_ENABLED: z.string().default('false'),
  AIOS_ISOLATION_MIN_MODE: z
    .enum(['none', 'policy_only', 'process', 'container', 'microvm'])
    .default('policy_only'),
  AIOS_CONTAINER_IMAGE: z.string().default('busybox'),
  AIOS_CONTAINER_NETWORK: z.enum(['none', 'bridge']).default('none'),
  AIOS_CONTAINER_MEMORY_BYTES: z.coerce.number().int().nonnegative().default(0), // 0 = engine default limit
  AIOS_CONTAINER_CPUS: z.coerce.number().nonnegative().default(0), // 0 = engine default limit
  AIOS_CONTAINER_PIDS_LIMIT: z.coerce.number().int().nonnegative().default(0),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues
    .filter((i) => i.code === 'invalid_type' || i.message.includes('Required'))
    .map((i) => `${i.path.join('.')} — ${i.message}`);
  // eslint-disable-next-line no-console
  console.error('[config] Invalid or missing environment configuration:');
  for (const m of missing) console.error('  -', m);
  throw new Error('Invalid environment configuration. Copy .env.example to .env and fill required values.');
}

export const env: Env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const isProd = env.NODE_ENV === 'production';

/**
 * P0-3: resolve the proxy trust model once, at module load, so a malformed or
 * unsafe value is a boot failure rather than a silently mis-keyed rate limiter.
 */
export const trustProxyModel = parseTrustProxy(env.TRUST_PROXY);

// Phase 18: production fail-fast guard. A production deploy must never run
// with the weak dev defaults — that would silently expose sessions/JWTs that
// are public knowledge. Same for non-secure cookies and a disabled CSP.
if (isProd) {
  const weakSecrets =
    env.SESSION_SECRET === 'dev_only_session_secret_do_not_use_in_prod' ||
    env.JWT_SECRET === 'dev_only_jwt_secret_do_not_use_in_prod';
  if (weakSecrets) {
    throw new Error(
      'Refusing to start in production: SESSION_SECRET and JWT_SECRET must be set to strong random values (see .env.example).',
    );
  }
  if (env.SESSION_COOKIE_SECURE !== 'true') {
    throw new Error('Refusing to start in production: SESSION_COOKIE_SECURE must be set to "true".');
  }
  if (env.CSP_ENABLED !== 'true') {
    throw new Error('Refusing to start in production: CSP_ENABLED must be set to "true".');
  }
  // Defense-in-depth: when the signed-webhook verification rail is enabled in
  // production, the Cloudflare adapter must present the rail token (which the
  // worker holds as a secret). Never boot with an open, token-less webhook in
  // AUTOPILOT production.
  if (env.RAZORPAY_WEBHOOK_ENABLED === 'true' && !env.INTERNAL_WEBHOOK_TOKEN) {
    throw new Error(
      'Refusing to start in production: INTERNAL_WEBHOOK_TOKEN is required when RAZORPAY_WEBHOOK_ENABLED=true (the Cloudflare webhook adapter must authenticate with this Bearer token).',
    );
  }
  // P0-3: checked after the credential/cookie/CSP guards so an operator fixing
  // one misconfiguration is not met by a different error each deploy attempt.
  assertTrustProxyUsable(trustProxyModel, true);
}

/**
 * P1-4: production requires a shared cache.
 *
 * Security-critical transient state lives in the cache: single-use MFA challenge
 * consumption, distributed rate-limit counters, and idempotency keys. On the
 * in-memory store that state is per-process, so with more than one replica a
 * consumed MFA challenge is replayable on a sibling instance, and a restart
 * silently clears every limit. Production must never degrade to memory
 * silently — refuse to boot and name the missing variable.
 */
if (isProd && !env.REDIS_URL) {
  throw new Error(
    'Missing production requirement: REDIS_URL. A shared Redis-compatible store is required in production for single-use MFA challenges, distributed rate limits, and idempotency. Refusing to start with per-process memory state.',
  );
}

if (isProd && env.QUEUE_PROVIDER === 'memory') {
  throw new Error(
    'Missing production requirement: QUEUE_PROVIDER must be "redis" in production; the in-memory queue loses jobs on restart and does not survive a deploy.',
  );
}

/**
 * P1-5: same-origin invariant.
 *
 * Sessions are `sameSite=lax` cookies and the CSP is `connect-src 'self'`, so a
 * split-origin deployment (web host != API host) fails in a way that looks like
 * "the user is always logged out" rather than a configuration error. Detect the
 * split at boot instead of shipping a broken login.
 */
if (isProd) {
  const appOrigin = safeOrigin(env.APP_URL);
  const apiOrigin = safeOrigin(env.API_URL);
  const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (corsOrigins.includes('*')) {
    throw new Error('Refusing to start in production: CORS_ORIGINS must not contain "*".');
  }
  if (appOrigin && apiOrigin && appOrigin !== apiOrigin) {
    throw new Error(
      `Refusing to start in production: APP_URL (${appOrigin}) and API_URL (${apiOrigin}) are different origins. ` +
        'This deployment serves the web app and API from one origin; a split origin breaks sameSite=lax session cookies and the connect-src self CSP policy. Serve the SPA from the backend and point APP_URL at it.',
    );
  }
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export const enabledProviders = env.AI_PROVIDERS_ENABLED.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const enabledGoogleScopes = env.GOOGLE_SCOPES.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * TEST-ONLY payment bypass allowlist (server-side user IDs). Parsed once at
 * module load. Empty = disabled. Matching is exact user-ID equality — never
 * email, never client input. IDs are never logged.
 */
function parsePaymentTestUserIds(): Set<string> {
  return new Set(
    env.PAYMENT_TEST_USER_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export const paymentTestUserIds = parsePaymentTestUserIds();
