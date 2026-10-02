# CodeConClave Pro — Environment Variables Guide (Phase 18)

Source of truth: `backend/src/config/env.ts` (zod schema) and `.env.example`.
Every variable in this guide is read by the backend at startup. The frontend
uses same-origin relative `/api/v1` calls, so it needs **no** runtime env vars.

Secrets are read from the environment only. The `.env` file at the repository
root is loaded by the backend in dev; in production, inject environment
variables directly (never commit `.env`).

## Required

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (pgvector image supported). Required — server refuses to start without it. |

## Application

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` activates the Phase 18 fail-fast guard. |
| `PORT` | `4000` | HTTP listen port. |
| `APP_URL` | `http://localhost:5173` | Public origin of the web app. |
| `API_URL` | `http://localhost:4000` | Public origin of the API. |
| `APP_NAME` | `CodeConClave` | Shown in health response. |
| `LOG_LEVEL` | `info` | `debug|info|warn|error`. |
| `SESSION_SECRET` | dev default | **Must be a strong random value in production** (guard enforced). 32+ hex chars: `openssl rand -hex 32`. |
| `JWT_SECRET` | dev default | **Must be a strong random value in production** (guard enforced). |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed origins for credentialed requests. |
| `TRUST_PROXY` | `false` | Set `true` behind a TLS-terminating proxy (required for secure-cookie + client IP rate limiting). |

## Database

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. |
| `SUPABASE_URL` | — | Optional, hosted Postgres convenience. |
| `SUPABASE_PUBLISHABLE_KEY` | — | Optional. |
| `DATABASE_SSL` | `false` | `true` for hosted Postgres (e.g. Supabase). |

## Redis / queue

| Variable | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | — | Optional. When unset the in-memory cache/rate-limit store is used (single-process dev only — documented honestly). |
| `QUEUE_PROVIDER` | `memory` | `memory` = in-process queue (dev); `redis` = durable BullMQ-style queue. `memory` is not durable across restarts. |

## Auth

| Variable | Default | Notes |
| --- | --- | --- |
| `AUTH_ISSUER` | `codeconclave` | JWT issuer claim. |
| `AUTH_ACCESS_TOKEN_TTL` | `900` | Access token TTL (s). |
| `AUTH_SESSION_TTL_DAYS` | `30` | Session lifetime. |
| `AUTH_REMEMBER_DAYS` | `90` | "Remember me" lifetime. |
| `MFA_REQUIREMENT_LEVEL` | `0` | `0` = disabled, `60` = MFA required for high-risk actions. |
| `MFA_MAX_ATTEMPTS` | `5` | Failed TOTP attempts before lockout. |
| `RECOVERY_CODE_COUNT` | `10` | Recovery codes issued. |

## Google (existing OAuth client — do not create a second one)

| Variable | Default | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Required for Google OAuth sign-in and Gmail/Drive/Sheets/Calendar. |
| `GOOGLE_REDIRECT_URI` | `http://localhost:5173/api/v1/auth/google/callback` | Must match the console-configured redirect. The SPA proxies `/api/*` from :5173 to the backend so the session cookie lands on the frontend origin; set the production value to the live backend callback. |
| `GOOGLE_OAUTH_CONSENT_MODE` | `consent` | |
| `GOOGLE_SCOPES` | gmail.send, drive.file, spreadsheets, calendar.events | Comma-separated. |

## AI providers (at least one key required for AI features)

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `MISTRAL_API_KEY` | — | Provider credentials. |
| `GROK_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY` / `NVIDIA_API_KEY` / `COHERE_API_KEY` | — | Stage 25.5 expansion: grok/deepseek/kimi/nemotron (OpenAI-compatible) + north (Cohere). |
| `AI_PROVIDERS_ENABLED` | `anthropic,openai,google,mistral` | Comma-separated enabled provider ids (also grok, deepseek, kimi, nemotron, north). |
| `AI_DEFAULT_MODEL` | — | Server-level default model; enforced at gateway routing when the caller requests no specific model (must still pass eligibility). |
| `AI_PREMIUM_BUDGET_USD_PER_DAY` | `4` | Server-enforced cost ceiling for premium tier. |
| `AI_MODEL_REFRESH_MINUTES` | `10` | Provider model-catalog refresh interval. |
| `AI_REQUEST_TIMEOUT_MS` | `120000` | Per-request AI timeout. |
| `AI_CHAIN_TIMEOUT_MS` | `180000` | Whole AI chain (route + retries + fallbacks) deadline; SSE streams add a 15s margin. |

## Email

Transmitting rail is selected once via `EMAIL_TRANSPORT` (default `resend`).

### Resend (primary, long-term architecture)

| Variable | Default | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | — | Required when `EMAIL_TRANSPORT=resend`. |
| `RESEND_FROM_EMAIL` | `CodeConClave <noreply@example.com>` | Verified sender. |
| `RESEND_ENABLED` | `false` | Master switch. |

### Gmail SMTP (TEMPORARY zero-cost pilot)

`EMAIL_TRANSPORT=gmail` enables a temporary pilot rail for small real-user
rollouts before a verified sending domain / `RESEND_API_KEY` exists. It uses
Gmail SMTP with an app password on a **dedicated** account and is **NOT** the
final production email architecture — Resend / domain-based transactional
email stays the intended long-term path and is not removed.

| Variable | Default | Notes |
| --- | --- | --- |
| `EMAIL_TRANSPORT` | `resend` | `resend` (current production rail, unchanged) · `gmail` (pilot). |
| `GMAIL_USER` | — | Gmail account for SMTP auth (pilot). |
| `GMAIL_APP_PASSWORD` | — | App password (never commit; never logged). |
| `GMAIL_FROM_EMAIL` | — | Optional display sender; defaults to `GMAIL_USER`; SMTP `From` is always the authenticated account (never spoofed). |
| `OTP_TTL_MINUTES` | `10` | OTP code lifetime in minutes; clamped `1..60`. |

## GitHub (CodeConClave Pro GitHub App)

| Variable | Default | Notes |
| --- | --- | --- |
| `GITHUB_APP_ID` / `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_PRIVATE_KEY` | — | App credentials. |
| `GITHUB_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_URL` | — | Deferred until a real production webhook endpoint exists. |

## Razorpay (Payment Link only — current capability)

| Variable | Default | Notes |
| --- | --- | --- |
| `RAZORPAY_MODE` | `payment_link` | `payment_link` (current) · `api` / `webhook` only when real credentials exist. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | — | Only required for api/webhook modes. |
| `RAZORPAY_PRO_PAYMENT_LINK` | `https://rzp.io/rzp/sAgHIpxS` | The configured Pro Payment Link. |
| `RAZORPAY_PAYMENT_LINK_STATUS_POLL_MINUTES` | `30` | Expiry window for PENDING sessions. |

## Cloudflare (Worker + KV; R2 deferred until billing activated)

| Variable | Default | Notes |
| --- | --- | --- |
| `CLOUDFLARE_WORKER_NAME` / `CLOUDFLARE_WORKER_URL` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_KV_NAMESPACE_ID` / `CLOUDFLARE_KV_BINDING_NAME` | — | Worker + KV. |
| `CLOUDFLARE_R2_*` | — | R2 deferred. `STORAGE_PROVIDER=s3` supports MinIO locally. |

## Storage (provider-agnostic)

| Variable | Default | Notes |
| --- | --- | --- |
| `STORAGE_PROVIDER` | `postgres` | `postgres` (durable blobs in `object_blobs`, default, Rs 0) · `memory` (local disk, dev only, ephemeral on hosted deployments) · `s3` (S3-compatible/MinIO) · `r2` (deferred). Objects over 10 MiB require `s3`/`r2`. |
| `STORAGE_PUBLIC_BASE_URL` | `http://localhost:4000/storage` | Public base for stored objects. |
| `STORAGE_AT_REST_ENCRYPTION` | `false` | `true` = AES-256-GCM encryption of stored blobs (key derived from `SESSION_SECRET`). Required for production object storage. |
| `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` / `S3_REGION` / `S3_FORCE_PATH_STYLE` | MinIO dev defaults | S3-compatible connection. |

## Plugins

| Variable | Default | Notes |
| --- | --- | --- |
| `PLUGIN_WEBHOOK_ALLOWED_HOSTS` | `` | Comma-separated allowlist of hosts permitted to deliver plugin webhooks. |

## Preview (main-workspace live preview)

Builds run on the deployment host (no server-side sandbox); the session stays
honestly `NOT_CONFIGURED` until `PREVIEW_BUILD_ENABLED=true` and a workspace
checkout exist.

| Variable | Default | Notes |
| --- | --- | --- |
| `PREVIEW_BUILD_ENABLED` | `false` | Master switch (never fakes a build). |
| `PREVIEW_BUILD_COMMAND` | `npm run build` | Build command executed in the project workspace. |
| `PREVIEW_PROJECTS_ROOT` | — | Parent dir of checked-out project workspaces (`<root>/<projectId>`). |
| `PREVIEW_OUTPUT_DIR` | — | Sandboxed build-output root; only files under it are served. |

## Sentry

| Variable | Default | Notes |
| --- | --- | --- |
| `SENTRY_DSN` | — | DSN. |
| `SENTRY_ENABLED` | `false` | Master switch (no fake reporting — no-op when off). |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | |

## Security

| Variable | Default | Notes |
| --- | --- | --- |
| `RATE_LIMIT_GLOBAL_PER_MIN` | `300` | Global API budget. |
| `RATE_LIMIT_AUTH_PER_MIN` | `10` | Auth path budget (fail closed). |
| `RATE_LIMIT_CHAT_PER_MIN` | `60` | Chat stream budget. |
| `CSRF_COOKIE_NAME` | `codeconclave_csrf` | |
| `CSP_ENABLED` | `true` | Strict CSP header. **Must stay true in production** (guard enforced). |
| `SESSION_COOKIE_SECURE` | `false` | **Must be `true` in production** (guard enforced). |
| `MAX_UPLOAD_MB` | `50` | Upload cap. |

## Free limits (server-enforced — never faked client-side)

| Variable | Default | Notes |
| --- | --- | --- |
| `FREE_DAILY_MESSAGES` | `20` | |
| `FREE_MAX_PROJECTS` | `1` | |
| `FREE_STORAGE_GB` | `2` | |
| `FREE_MODEL_TIER` | `efficient` | |

## Local agent

| Variable | Default | Notes |
| --- | --- | --- |
| `LOCAL_AGENT_PORT` | `43121` | |
| `LOCAL_AGENT_TOKEN_TTL_HOURS` | `1` | |
| `LOCAL_AGENT_WS_URL` | `ws://localhost:4000/agent` | |

## Production checklist

1. `NODE_ENV=production` and all four of: strong `SESSION_SECRET`, strong
   `JWT_SECRET`, `SESSION_COOKIE_SECURE=true`, `CSP_ENABLED=true` — the server
   **refuses to start** otherwise (fail-fast guard, `backend/src/config/env.ts`).
2. `DATABASE_URL` points at a migrated schema (server also refuses to start on
   pending migrations — `npm run db:migrate` first).
3. `CORS_ORIGINS` lists the real frontend origin(s) and `TRUST_PROXY=true`
   behind TLS termination.
4. `REDIS_URL` + `QUEUE_PROVIDER=redis` for durable queues in production.
5. Durable object storage: the `postgres` default (migration 0138+) is durable
   for objects up to 10 MiB; use `STORAGE_PROVIDER=s3` (or `r2` once billing
   is activated) with `STORAGE_AT_REST_ENCRYPTION=true` for larger objects.
6. At least one AI provider key; `RESEND_API_KEY` + `RESEND_ENABLED=true`
   for email; `SENTRY_DSN` + `SENTRY_ENABLED=true` for error reporting.
7. Verify with `/health`, `/ready`, `/healthz` (see DEPLOYMENT_GUIDE.md).