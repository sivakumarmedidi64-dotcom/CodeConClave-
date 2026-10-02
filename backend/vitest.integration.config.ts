/**
 * CodeConClave backend — vitest configuration for REAL integration tests.
 *
 * Unlike vitest.config.ts (which pins a fake localhost DATABASE_URL for pure
 * unit suites), this config lets a real DATABASE_URL flow through from the
 * process environment. Use it ONLY for tests that genuinely require a real
 * PostgreSQL database and gate themselves on a reachable DB at runtime:
 *
 *   DATABASE_URL=<real-url> NODE_ENV=test TRUST_PROXY=1 \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config vitest.integration.config.ts \
 *       src/foundation/p0-2-cross-tenant-real.test.ts
 *
 * Every other field mirrors vitest.config.ts so behaviour matches unit runs.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
    env: {
      NODE_ENV: 'test',
      PORT: '4000',
      APP_URL: 'http://localhost:5173',
      API_URL: 'http://localhost:4000',
      APP_NAME: 'CodeConClave',
      LOG_LEVEL: 'error',
      SESSION_SECRET: 'b6f89bd97e1e93cfac1f62e8872686743552be21b5e8b333a2355095d177a057f74aeb7f888d5d63fd673ffe1af169b07fc9d7c3ca219104e81c70e81a16ecb7',
      JWT_SECRET: '289acac98f16e58d44a98a79dbc1818fcee19a225fdbf89ee99378bbb7a53d5f96d9b1216823c5fbfb6f9382cbcc4165eb776b5493780d75d5367b270ce6a423',
      CORS_ORIGINS: 'http://localhost:5173',
      TRUST_PROXY: '1',
      CLOUDFLARE_WORKER_NAME: 'codeconclave-pro',
      CLOUDFLARE_WORKER_URL: 'https://codeconclave-pro.codeconclave-app.workers.dev',
      RESEND_FROM_EMAIL: 'CodeConClave <noreply@example.com>',
      RAZORPAY_PRO_PAYMENT_LINK: 'https://rzp.io/rzp/sAgHIpxS',
      RAZORPAY_TEAM_PAYMENT_LINK: 'https://rzp.io/rzp/3ioXlCxd',
      STORAGE_PUBLIC_BASE_URL: 'http://localhost:4000/storage',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY_ID: 'codeconclave_dev',
      S3_SECRET_ACCESS_KEY: 'codeconclave_dev_password',
      S3_BUCKET: 'codeconclave',
      S3_REGION: 'auto',
      S3_FORCE_PATH_STYLE: 'true',
      AI_PROVIDERS_ENABLED: 'anthropic,openai,google,mistral',
      GOOGLE_SCOPES: 'https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/calendar.events',
      GOOGLE_REDIRECT_URI: 'http://localhost:4000/api/v1/auth/google/callback',
      GOOGLE_OAUTH_CONSENT_MODE: 'consent',
      SENTRY_DSN: 'https://00000000000000000000000000000000@000000000000000.ingest.us.sentry.io/0000000000000000',
    },
  },
});