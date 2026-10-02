# PRODUCTION CREDENTIAL INVENTORY — CodeConClave Pro

**Date:** 2026-08-27
**Auditor:** Pre-Deployment Cleanup

This inventory lists every credential/environment value the application actually reads
(from `backend/src/config/env.ts` schema), whether it is currently set, and where the
user must obtain a fresh value. **No secret values are listed here.**

Status legend:
- **PRESENT** — value is set (note: may be a local/dev value, not production)
- **MISSING** — required for the named purpose but not yet supplied
- **OPTIONAL** — only needed if the dependent feature is enabled
- **NOT_APPLICABLE** — env variable exists but has no code counterpart / not used

---

## App / Session Security

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `SESSION_SECRET` | Local app | Session signing (httpOnly cookies) | YES | Random: `openssl rand -hex 32` | **PRESENT** (local) — must REGENERATE — was exposed in history |
| `JWT_SECRET` | Local app | JWT signing | YES | Random: `openssl rand -hex 32` | **PRESENT** (local) — must REGENERATE — was exposed in history |

## Database

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `DATABASE_URL` | Supabase Postgres | Primary database (only REQUIRED field) | YES | Supabase Dashboard → Project Settings → Databases → Connection string | **PRESENT** (local dev) — needs PROD URL |
| `DATABASE_SSL` | Supabase | SSL for hosted Postgres (`true` in prod) | NO | Set `true` | PRESENT (`false`) — set `true` for prod |
| `SUPABASE_URL` | Supabase | Auth/plugin integration | NO | Supabase Dashboard → Settings → API | MISSING |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase | Auth plugin key | NO | Supabase Dashboard → Settings → API | MISSING |

## Redis

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `REDIS_URL` | Upstash Redis | Queues (QUEUE_PROVIDER=redis in prod) | YES | Upstash Console → Redis → Connect | **PRESENT** (local) — needs PROD URL |
| `QUEUE_PROVIDER` | Queues | `redis` in prod / `memory` in dev | NO | Set value | PRESENT (`memory`) |

## Google

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `GOOGLE_CLIENT_ID` | Google Cloud | Google OAuth login (F03) + Gmail/Drive/Sheets/Calendar scopes | NO | Google Cloud Console → Credentials → OAuth 2.0 Client ID | MISSING |
| `GOOGLE_CLIENT_SECRET` | Google Cloud | Google OAuth login | YES | Google Cloud Console → Credentials | MISSING |
| `GOOGLE_REDIRECT_URI` | Google Cloud | OAuth callback URL (must match registered URI) | NO | Set to prod callback URL | PRESENT (default localhost — update) |
| `GOOGLE_SCOPES` | Google Cloud | Enabled Google APIs | NO | Register APIs in Google Cloud | PRESENT (default) |

## AI Providers

At least one provider key is required for AI features. All 9 below are referenced by the
AI gateway (`configuredProviders()` in `registry.ts`). `AI_PROVIDERS_ENABLED` controls which
are active (default: `anthropic,openai,google,mistral`).

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `ANTHROPIC_API_KEY` | Anthropic | Claude models | YES | Anthropic Console → API Keys | MISSING |
| `OPENAI_API_KEY` | OpenAI | GPT models | YES | OpenAI Platform → API Keys | MISSING |
| `GEMINI_API_KEY` | Google AI | Gemini models | YES | Google AI Studio → Get API Key | MISSING |
| `MISTRAL_API_KEY` | Mistral | Mistral models | YES | Mistral Console → API Keys | MISSING |
| `GROK_API_KEY` | xAI | Grok models | YES | xAI Console → API Keys | MISSING |
| `DEEPSEEK_API_KEY` | DeepSeek | DeepSeek models | YES | DeepSeek Platform → API Keys | MISSING |
| `KIMI_API_KEY` | Kimi/Moonshot | Kimi models | YES | Moonshot Platform → API Keys | MISSING |
| `NVIDIA_API_KEY` | NVIDIA | Nemotron models | YES | NVIDIA NIM / build.nvidia.com | MISSING |
| `COHERE_API_KEY` | Cohere | `north` provider models | YES | Cohere Dashboard → API Keys | MISSING |

## Email

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `RESEND_API_KEY` | Resend | Transactional email (verify, digests, receipts) | YES | Resend Dashboard → API Keys | MISSING |
| `RESEND_ENABLED` | Resend | Toggle (`true` in prod) | NO | Set value | PRESENT (`false`) |
| `RESEND_FROM_EMAIL` | Resend | Sender address | NO | Configure verified domain | PRESENT (placeholder — update) |

## GitHub (plugin integration — OPTIONAL)

These are genuinely used at runtime ONLY if the GitHub plugin integration is enabled
(`plugins/adapters/github.ts` — App JWT signing + OAuth). Optional, not required to boot.

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `GITHUB_APP_ID` | GitHub | GitHub App JWT auth (plugin) | NO | GitHub → Developer Settings → GitHub Apps | MISSING |
| `GITHUB_CLIENT_ID` | GitHub | GitHub OAuth (plugin) | NO | GitHub → Developer Settings → OAuth Apps | MISSING |
| `GITHUB_CLIENT_SECRET` | GitHub | GitHub OAuth (plugin) | YES | GitHub → Developer Settings → OAuth Apps | MISSING |
| `GITHUB_PRIVATE_KEY` | GitHub | GitHub App JWT signing (plugin) | YES | GitHub App → generate private key (.pem) | MISSING |
| `GITHUB_WEBHOOK_SECRET` | GitHub | Webhook verification | YES | GitHub App settings | MISSING |
| `GITHUB_WEBHOOK_URL` | GitHub | Webhook endpoint | NO | Prod webhook URL | MISSING |

## Razorpay Payments

Current mode is `payment_link`. **API/webhook credentials are NOT required** in this mode —
payments use public payment links (₹999 / ₹4999, not secrets). API/webhook creds only become
required if switching to `api` or `webhook` mode.

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `RAZORPAY_MODE` | Razorpay | Mode selector | NO | Set `payment_link` | PRESENT (`payment_link`) |
| `RAZORPAY_PRO_PAYMENT_LINK` | Razorpay | ₹999 payment link (public) | NO (public URL) | Razorpay Dashboard → Payment Links | PRESENT (₹999 link) |
| `RAZORPAY_TEAM_PAYMENT_LINK` | Razorpay | ₹4999 payment link (public) | NO (public URL) | Razorpay Dashboard → Payment Links | PRESENT (₹4999 link) |
| `RAZORPAY_KEY_ID` | Razorpay | ONLY for `api`/`webhook` mode | YES | Razorpay Dashboard → API Keys | NOT_APPLICABLE (payment_link mode) |
| `RAZORPAY_KEY_SECRET` | Razorpay | ONLY for `api`/`webhook` mode | YES | Razorpay Dashboard → API Keys | NOT_APPLICABLE (payment_link mode) |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay | ONLY for `webhook` mode | YES | Razorpay Dashboard → Webhooks | NOT_APPLICABLE (payment_link mode) |
| `PAYMENT_ACCOUNT_EMAIL` | Razorpay | Receipts (founder digest) | NO | Set owner email | OPTIONAL (not set) |
| `PAYMENT_FOUNDER_EMAIL` | Razorpay | Founder digest recipient | NO | Set owner email | OPTIONAL (not set) |

## Cloudflare / R2 (OPTIONAL — storage / worker)

Only required if the Cloudflare Worker/KV integration or R2 object storage is enabled.
Current default `STORAGE_PROVIDER=memory` (local disk) means these are not needed to boot.

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare | Worker/KV management | YES | Cloudflare Dashboard → My Profile → API Tokens | MISSING (optional) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare | Worker/KV | NO | Cloudflare Dashboard | MISSING (optional) |
| `CLOUDFLARE_WORKER_NAME` | Cloudflare | Worker name | NO | Cloudflare Workers | PRESENT (default — update) |
| `CLOUDFLARE_WORKER_URL` | Cloudflare | Worker URL | NO | Cloudflare Workers | PRESENT (default — update) |
| `CLOUDFLARE_KV_NAMESPACE_ID` | Cloudflare | KV namespace | NO | Cloudflare KV | MISSING (optional) |
| `CLOUDFLARE_KV_BINDING_NAME` | Cloudflare | KV binding | NO | Cloudflare Worker config | MISSING (optional) |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | Cloudflare | R2 storage (deferred) | YES | Cloudflare R2 → Manage R2 API Tokens | MISSING (optional) |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | Cloudflare | R2 storage (deferred) | YES | Cloudflare R2 | MISSING (optional) |
| `CLOUDFLARE_R2_ACCOUNT_ID` | Cloudflare | R2 | NO | Cloudflare Dashboard | MISSING (optional) |
| `CLOUDFLARE_R2_BUCKET` | Cloudflare | R2 bucket name | NO | Cloudflare R2 | MISSING (optional) |
| `CLOUDFLARE_R2_ENDPOINT` | Cloudflare | R2 endpoint | NO | Cloudflare R2 | MISSING (optional) |

## Storage (S3 / MinIO — dev only)

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `STORAGE_PROVIDER` | Storage | `memory` (dev) / `s3` / `r2` | NO | Set value | PRESENT (`memory`) |
| `S3_ACCESS_KEY_ID` | MinIO | Local S3-compatible storage (dev) | NO (dev) | Local MinIO | PRESENT (dev value — not for prod) |
| `S3_SECRET_ACCESS_KEY` | MinIO | Local S3-compatible storage (dev) | YES (dev) | Local MinIO | PRESENT (dev value — not for prod) |
| `S3_BUCKET` | MinIO | Bucket name | NO | Local MinIO | PRESENT (dev value) |

## Monitoring

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `SENTRY_DSN` | Sentry | Error tracking (only if enabled) | NO (DSN) | Sentry → Project → Client Keys | MISSING (optional — `SENTRY_ENABLED=false`) |
| `SENTRY_ENABLED` | Sentry | Toggle (`false` by default) | NO | Set value | PRESENT (`false`) |

## Miscellaneous / NOT_APPLICABLE

| Variable | Service | Required For | Secret? | Where To Obtain | Current Status |
| -------- | ------- | ------------ | ------- | --------------- | -------------- |
| `GMAIL_OAUTH_ACCESS_TOKEN` | Google | Gmail send (deferred — no code reference found) | YES | Google Cloud Console | OPTIONAL (no code reference) |
| `GMAIL_OAUTH_REFRESH_TOKEN` | Google | Gmail send (deferred) | YES | Google Cloud Console | OPTIONAL (no code reference) |
| `DASHSCOPE_API_KEY` | Alibaba DashScope | **NOT referenced anywhere in code** | YES | n/a | NOT_APPLICABLE (present only in `render.yaml`, no code counterpart) |

---

## Required Now Summary

### MUST HAVE FOR CORE PRODUCTION
| Variable | Source |
| -------- | ------ |
| `SESSION_SECRET` (regenerate — was exposed) | `openssl rand -hex 32` |
| `JWT_SECRET` (regenerate — was exposed) | `openssl rand -hex 32` |
| `DATABASE_URL` (production Supabase) | Supabase Dashboard → Connection string |
| `REDIS_URL` (production Upstash) | Upstash Console |
| `DATABASE_SSL=true` | Set value |
| `APP_URL` / `API_URL` | Set to production origin |
| `CORS_ORIGINS` | Set to production frontend origin |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Google Cloud Console |
| `GOOGLE_REDIRECT_URI` (prod callback) | Set to production callback URL |
| At least one AI provider key | Provider console (see below) |

### NEEDED FOR PAYMENT/EMAIL
| Variable | Source |
| -------- | ------ |
| `RESEND_API_KEY` + `RESEND_ENABLED=true` | Resend Dashboard |
| `RESEND_FROM_EMAIL` (verified domain) | Resend Dashboard |
| `RAZORPAY_PRO_PAYMENT_LINK` / `RAZORPAY_TEAM_PAYMENT_LINK` | Already set (public ₹999/₹4999 links) |

### OPTIONAL PROVIDERS (add one or more AI keys to unlock models)
| Variable | Source |
| -------- | ------ |
| `ANTHROPIC_API_KEY` | Anthropic Console |
| `OPENAI_API_KEY` | OpenAI Platform |
| `GEMINI_API_KEY` | Google AI Studio |
| `MISTRAL_API_KEY` | Mistral Console |
| `GROK_API_KEY` | xAI Console |
| `DEEPSEEK_API_KEY` | DeepSeek Platform |
| `KIMI_API_KEY` | Moonshot Platform |
| `NVIDIA_API_KEY` | NVIDIA build.nvidia.com |
| `COHERE_API_KEY` | Cohere Dashboard |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` | Supabase Dashboard |

### OPTIONAL MONITORING
| Variable | Source |
| -------- | ------ |
| `SENTRY_DSN` + `SENTRY_ENABLED=true` | Sentry Dashboard |

### OPTIONAL STORAGE / INFRA
| Variable | Source |
| -------- | ------ |
| Cloudflare API/account/KV/R2 (only if enabling Worker or R2 storage) | Cloudflare Dashboard |
| GitHub App/OAuth creds (only if enabling GitHub plugin) | GitHub Developer Settings |
| Razorpay API/webhook creds (only if switching from `payment_link`) | Razorpay Dashboard |

---

## Note on "32 empty values"

The earlier "32 empty" count reflected all optional provider keys in the template. After
code analysis, the **truly required** set for core production is ~10 (session/jwt +
database + redis + google + at least one AI key + resend). The rest are optional and
enabled only when the matching feature is turned on. Do NOT treat all 32 as mandatory.
