/**
 * Non-secret test environment fixtures, shared by both Vitest configs.
 *
 * Vitest applies each project's `env` to every test file it runs, so these
 * values never reach the real process environment and never need to be
 * exported. They exist for one reason: backend/src/config/env.ts validates its
 * schema at import time and throws on a missing/invalid value, so any suite
 * that transitively imports the app graph needs the schema satisfied before
 * the first assertion runs.
 *
 * Everything here is a disposable placeholder: `localhost` hosts, `test`
 * passwords, zeroed Sentry DSN, and obviously-fake provider keys. No real
 * credential belongs in this file — it is committed to a public remote.
 *
 * These are load-bearing for two different reasons and must not be weakened:
 *   - They do NOT weaken the crypto cost centre. SCRYPT_V2 in
 *     src/shared/crypto.ts is not configured here; tests exercise the real
 *     N=65536 parameters.
 *   - They DO permit real-path integrations. A suite that wants to open a real
 *     file, spawn a real process or call a real code path still does so; it is
 *     not mocked or downgraded to accommodate this fixture. Suites that need a
 *     reachable database gate themselves at runtime and skip cleanly when
 *     DATABASE_URL points at an absent server, which is what happens in CI.
 *
 * Shared by vitest.config.ts (the unit + serial projects) and
 * vitest.perf.config.ts (the wall-clock performance smoke), which must observe
 * an identical environment or the perf numbers would not be comparable with the
 * rest of the suite.
 */
export const ENV = {
  NODE_ENV: 'test',
  PORT: '4000',
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:4000',
  APP_NAME: 'CodeConClave',
  LOG_LEVEL: 'error',
  SESSION_SECRET: 'b6f89bd97e1e93cfac1f62e8872686743552be21b5e8b333a2355095d177a057f74aeb7f888d5d63fd673ffe1af169b07fc9d7c3ca219104e81c70e81a16ecb7',
  JWT_SECRET: '289acac98f16e58d44a98a79dbc1818fcee19a225fdbf89ee99378bbb7a53d5f96d9b1216823c5fbfb6f9382cbcc4165eb776b5493780d75d5367b270ce6a423',
  CORS_ORIGINS: 'http://localhost:5173',
  TRUST_PROXY: 'false',
  DATABASE_URL: 'postgres://test:test@localhost:5432/codeconclave_test',
  DATABASE_SSL: 'false',
  REDIS_URL: 'rediss://default:test@localhost:6379',
  QUEUE_PROVIDER: 'memory',
  AUTH_ISSUER: 'codeconclave',
  AUTH_ACCESS_TOKEN_TTL: '900',
  AUTH_SESSION_TTL_DAYS: '30',
  AUTH_REMEMBER_DAYS: '90',
  MFA_REQUIREMENT_LEVEL: '0',
  MFA_MAX_ATTEMPTS: '5',
  RECOVERY_CODE_COUNT: '10',
  GOOGLE_CLIENT_ID: '31412526547-h8nil1kj1jhk5b12u2uh7g75nhgjtsr0.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret-placeholder',
  GOOGLE_REDIRECT_URI: 'http://localhost:4000/api/v1/auth/google/callback',
  GOOGLE_OAUTH_CONSENT_MODE: 'consent',
  GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/calendar.events',
  ANTHROPIC_API_KEY: 'test-anthropic-key-placeholder',
  OPENAI_API_KEY: 'test-openai-key-placeholder',
  GEMINI_API_KEY: 'test-gemini-key-placeholder',
  MISTRAL_API_KEY: 'test-mistral-key-placeholder',
  GROK_API_KEY: 'test-grok-key-placeholder',
  DEEPSEEK_API_KEY: 'test-deepseek-key-placeholder',
  KIMI_API_KEY: 'test-kimi-key-placeholder',
  NVIDIA_API_KEY: 'test-nvidia-key-placeholder',
  COHERE_API_KEY: 'test-cohere-key-placeholder',
  AI_PROVIDERS_ENABLED: 'anthropic,openai,google,mistral',
  AI_DEFAULT_MODEL: '',
  AI_PREMIUM_BUDGET_USD_PER_DAY: '4',
  AI_MODEL_REFRESH_MINUTES: '10',
  AI_REQUEST_TIMEOUT_MS: '120000',
  AI_CHAIN_TIMEOUT_MS: '180000',
  RESEND_API_KEY: 'test-resend-key-placeholder',
  RESEND_FROM_EMAIL: 'CodeConClave <noreply@example.com>',
  RESEND_ENABLED: 'false',
  GITHUB_APP_ID: '',
  GITHUB_CLIENT_ID: '',
  GITHUB_CLIENT_SECRET: '',
  GITHUB_PRIVATE_KEY: '',
  GITHUB_WEBHOOK_SECRET: '',
  GITHUB_WEBHOOK_URL: '',
  RAZORPAY_MODE: 'payment_link',
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  RAZORPAY_WEBHOOK_SECRET: '',
  RAZORPAY_PRO_PAYMENT_LINK: 'https://rzp.io/rzp/sAgHIpxS',
  RAZORPAY_TEAM_PAYMENT_LINK: 'https://rzp.io/rzp/3ioXlCxd',
  RAZORPAY_PAYMENT_LINK_STATUS_POLL_MINUTES: '30',
  CLOUDFLARE_WORKER_NAME: 'codeconclave-pro',
  CLOUDFLARE_WORKER_URL: 'https://codeconclave-pro.codeconclave-app.workers.dev',
  CLOUDFLARE_API_TOKEN: '',
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_KV_NAMESPACE_ID: '',
  CLOUDFLARE_KV_BINDING_NAME: '',
  CLOUDFLARE_R2_ACCOUNT_ID: '',
  CLOUDFLARE_R2_ENDPOINT: '',
  CLOUDFLARE_R2_BUCKET: '',
  CLOUDFLARE_R2_ACCESS_KEY_ID: '',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: '',
  STORAGE_PROVIDER: 'memory',
  STORAGE_PUBLIC_BASE_URL: 'http://localhost:4000/storage',
  STORAGE_AT_REST_ENCRYPTION: 'false',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'codeconclave_dev',
  S3_SECRET_ACCESS_KEY: 'codeconclave_dev_password',
  S3_BUCKET: 'codeconclave',
  S3_REGION: 'auto',
  S3_FORCE_PATH_STYLE: 'true',
  PLUGIN_WEBHOOK_ALLOWED_HOSTS: '',
  SENTRY_DSN: 'https://00000000000000000000000000000000@000000000000000.ingest.us.sentry.io/0000000000000000',
  SENTRY_TRACES_SAMPLE_RATE: '0.1',
  SENTRY_ENABLED: 'false',
  RATE_LIMIT_GLOBAL_PER_MIN: '300',
  RATE_LIMIT_AUTH_PER_MIN: '10',
  RATE_LIMIT_CHAT_PER_MIN: '60',
  CSRF_COOKIE_NAME: 'codeconclave_csrf',
  CSP_ENABLED: 'true',
  SESSION_COOKIE_SECURE: 'false',
  MAX_UPLOAD_MB: '50',
  FREE_DAILY_MESSAGES: '20',
  FREE_MAX_PROJECTS: '1',
  FREE_STORAGE_GB: '2',
  FREE_MODEL_TIER: 'efficient',
  LOCAL_AGENT_PORT: '43121',
  LOCAL_AGENT_TOKEN_TTL_HOURS: '1',
  LOCAL_AGENT_WS_URL: 'ws://localhost:4000/agent',
} as const;
