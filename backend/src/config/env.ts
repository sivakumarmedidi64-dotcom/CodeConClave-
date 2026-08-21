/**
 * CodeConClave backend — environment configuration.
 * All secrets are read from environment only. Never print, never commit.
 */
import { z } from 'zod';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:4000/api/v1/auth/google/callback'),
  GOOGLE_OAUTH_CONSENT_MODE: z.string().default('consent'),
  GOOGLE_SCOPES: z.string().default(
    'https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/calendar.events',
  ),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  GROK_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  KIMI_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  AI_PROVIDERS_ENABLED: z.string().default('anthropic,openai,google,mistral'),
  AI_DEFAULT_MODEL: z.string().optional(),
  AI_PREMIUM_BUDGET_USD_PER_DAY: z.coerce.number().positive().default(4),
  AI_MODEL_REFRESH_MINUTES: z.coerce.number().int().default(10),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  AI_CHAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default('CodeConClave <noreply@example.com>'),
  RESEND_ENABLED: z.string().default('false'),

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
  RAZORPAY_PRO_PAYMENT_LINK: z.string().default('https://rzp.io/rzp/sAgHIpxS'),
  RAZORPAY_PAYMENT_LINK_STATUS_POLL_MINUTES: z.coerce.number().int().default(30),

  PAYMENT_INTENT_TTL_HOURS: z.coerce.number().int().default(24),
  PAYMENT_GRACE_HOURS: z.coerce.number().int().default(72),
  PAYMENT_CONFIDENCE_ACTIVE: z.coerce.number().min(0).max(1).default(0.8),
  PAYMENT_CONFIDENCE_GRACE: z.coerce.number().min(0).max(1).default(0.5),
  PAYMENT_AMOUNT_TOLERANCE_INR: z.coerce.number().int().default(0),
  PAYMENT_ACCOUNT_EMAIL: z.string().optional(),
  PAYMENT_FOUNDER_EMAIL: z.string().optional(),
  PAYMENT_VELOCITY_WINDOW_MINUTES: z.coerce.number().int().default(60),
  PAYMENT_VELOCITY_MAX: z.coerce.number().int().default(3),

  GMAIL_OAUTH_ACCESS_TOKEN: z.string().optional(),
  GMAIL_OAUTH_REFRESH_TOKEN: z.string().optional(),

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

  STORAGE_PROVIDER: z.enum(['memory', 's3', 'r2']).default('memory'),
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

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().default(300),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().default(10),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().default(60),
  CSRF_COOKIE_NAME: z.string().default('codeconclave_csrf'),
  CSP_ENABLED: z.string().default('true'),
  SESSION_COOKIE_SECURE: z.string().default('false'),
  MAX_UPLOAD_MB: z.coerce.number().int().default(50),

  FREE_DAILY_MESSAGES: z.coerce.number().int().default(20),
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
}

export const enabledProviders = env.AI_PROVIDERS_ENABLED.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const enabledGoogleScopes = env.GOOGLE_SCOPES.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
