# CodeConClave Pro — Provider Integration Guide (Phase 18)

Honest inventory of every external integration, its capability, and its live
validation status. Nothing here is claimed verified without evidence.

## AI Gateway — Anthropic, OpenAI, Google, Mistral

- Config-driven gateway: `AI_PROVIDERS_ENABLED` + per-provider API keys.
- Routing: cheapest qualified model first; premium tier constrained to a
  `AI_PREMIUM_BUDGET_USD_PER_DAY` budget; on failure/entitlement/capability
  mismatch the gateway degrades to the next qualified provider — never a
  silent success.
- Streaming chat (SSE) with server-confirmed message ids and `Last-Event-ID`
  replay (`sse-replay-17.test.ts`).
- Tool-call normalization and usage/cost metadata are recorded
  (`ai-gateway-5.test.ts`, `perf-16.test.ts`).
- Provider health is persisted (`provider_health`) and surfaces in `/health`.
- **Live validation: BLOCKED** — no live API keys in this environment. On
  deployment, run one real request per configured provider and verify
  authentication, routing, streaming, fallback, usage logging, cost metadata,
  and tool-call normalization.

## Resend (email)

- Verification and notification email via outbox with retry, failure
  handling, and per-op idempotency (`outbox-14.test.ts`, `idempotency-16.test.ts`).
- `RESEND_ENABLED=false` disables cleanly (no fake delivery).
- **Live validation: BLOCKED** — no live `RESEND_API_KEY`. After deployment,
  send a real verification email and confirm the delivery path, outbox state,
  retry, and idempotency.

## Google (existing OAuth client)

- OAuth sign-in with HMAC-signed, expiring, protocol-bound state
  (`security-17.test.ts`).
- Enabled API scopes: Gmail (send), Drive (file), Sheets, Calendar (events).
- **Live validation: BLOCKED** — no live credentials. Do not attempt
  capabilities beyond the configured scopes. After deployment, verify the
  OAuth consent flow and one real call per enabled API.

## GitHub (CodeConClave Pro GitHub App)

- App credentials are configurable (`GITHUB_APP_ID`, `CLIENT_ID/SECRET`,
  `PRIVATE_KEY`); operations restricted to what the configured app permits.
- Webhooks: **deferred** until a real production webhook endpoint exists
  (`GITHUB_WEBHOOK_URL` empty).
- **Live validation: BLOCKED** — no live credentials. After deployment, verify
  App authentication, repository access, and permitted operations only.

## Razorpay

- **Payment Link only** (current capability). See `docs/PAYMENT_CAPABILITY.md`.
- API/webhook modes stay OFF without real credentials; entitlement activates
  only on provider-verified payment.

## Cloudflare

- Worker + KV: configured via env, **not validated** (no `CLOUDFLARE_API_TOKEN`).
- R2: **deferred** (billing activation required) — reported as
  `R2_NOT_CONFIGURED`, never as active. The provider-agnostic storage
  abstraction is the supported path (`STORAGE_PROVIDER=s3` for S3-compatible /
  MinIO, `r2` once activated).

## Storage

- Abstraction over memory (dev), S3-compatible, and R2 (deferred).
- At-rest encryption: AES-256-GCM, key derived from `SESSION_SECRET`
  (`STORAGE_AT_REST_ENCRYPTION=true`).
- **Live validation: BLOCKED** — no production object storage configured.
  On deployment, run a real upload → download → delete → restore smoke test
  and verify encryption + authorization.

## Sentry

- Env-gated: `SENTRY_DSN` + `SENTRY_ENABLED=true` initialize; otherwise a
  guaranteed no-op (`observability/sentry.ts`). No fake reporting.
- **Live validation: BLOCKED** — no DSN configured.

## Plugins

- Plugin engine with scoped connections and honest health; webhook delivery
  restricted to `PLUGIN_WEBHOOK_ALLOWED_HOSTS`; scope escalation rejected
  (`plugins-10.test.ts`).
- **Live validation: BLOCKED** — no live plugin providers configured.