# VERIFIED RAILWAY DEPLOYMENT COMMANDS

## BACKEND

Root: /
Build: npm ci && npm run build --workspace @codeconclave/shared && npm run build --workspace @codeconclave/backend
Start: npm run start --workspace @codeconclave/backend
Port: 4000 (from env.PORT, default 4000)
Health: /healthz (primary), /health (detailed)

## WORKER

Root: /
Start: npm run worker --workspace @codeconclave/backend

## FRONTEND

Root: /frontend
Build: npm run build --workspace @codeconclave/frontend
Serve: node server.js
Port: 8080 (from process.env.PORT || 8080)

## VARIABLES

Backend:
- NODE_ENV=production (required)
- PORT=4000 (required)
- APP_URL (required - production frontend URL)
- API_URL (required - production backend URL)
- SESSION_SECRET (required)
- JWT_SECRET (required)
- CORS_ORIGINS (required - production frontend URL)
- TRUST_PROXY=true (required)
- DATABASE_URL (required - Supabase)
- DATABASE_SSL=true (required)
- REDIS_URL (required - Upstash)
- QUEUE_PROVIDER=redis (required)
- AUTH_ISSUER (required)
- AUTH_ACCESS_TOKEN_TTL (optional, default 900)
- AUTH_SESSION_TTL_DAYS (optional, default 30)
- AUTH_REMEMBER_DAYS (optional, default 90)
- MFA_REQUIREMENT_LEVEL (optional, default 0)
- MFA_MAX_ATTEMPTS (optional, default 5)
- RECOVERY_CODE_COUNT (optional, default 10)
- GOOGLE_CLIENT_ID (optional)
- GOOGLE_CLIENT_SECRET (optional)
- GOOGLE_REDIRECT_URI (required if OAuth enabled)
- ANTHROPIC_API_KEY (optional)
- OPENAI_API_KEY (optional)
- GEMINI_API_KEY (optional)
- MISTRAL_API_KEY (optional)
- GROK_API_KEY (optional)
- DEEPSEEK_API_KEY (optional)
- KIMI_API_KEY (optional)
- NVIDIA_API_KEY (optional)
- COHERE_API_KEY (optional)
- AI_PROVIDERS_ENABLED (optional, default 'anthropic,openai,google,mistral')
- AI_PREMIUM_BUDGET_USD_PER_DAY (optional, default 4)
- RESEND_API_KEY (optional)
- RESEND_FROM_EMAIL (optional)
- RESEND_ENABLED=true (optional)
- RAZORPAY_MODE=payment_link (optional)
- RAZORPAY_PRO_PAYMENT_LINK (optional)
- RAZORPAY_TEAM_PAYMENT_LINK (optional)
- CLOUDFLARE_WORKER_NAME (optional)
- CLOUDFLARE_WORKER_URL (optional)
- CLOUDFLARE_API_TOKEN (optional)
- CLOUDFLARE_ACCOUNT_ID (optional)
- CLOUDFLARE_KV_NAMESPACE_ID (optional)
- CLOUDFLARE_KV_BINDING_NAME (optional)
- CLOUDFLARE_R2_ACCOUNT_ID (optional)
- CLOUDFLARE_R2_ENDPOINT (optional)
- CLOUDFLARE_R2_BUCKET (optional)
- CLOUDFLARE_R2_ACCESS_KEY_ID (optional)
- CLOUDFLARE_R2_SECRET_ACCESS_KEY (optional)
- STORAGE_PROVIDER=memory (optional)
- STORAGE_PUBLIC_BASE_URL (optional)
- STORAGE_AT_REST_ENCRYPTION=false (optional)
- SENTRY_DSN (optional)
- SENTRY_TRACES_SAMPLE_RATE (optional)
- SENTRY_ENABLED=false (optional)
- CSP_ENABLED=true (required in production)
- SESSION_COOKIE_SECURE=true (required in production)
- LOG_LEVEL=info (optional)
- RATE_LIMIT_GLOBAL_PER_MIN=300 (optional)
- RATE_LIMIT_AUTH_PER_MIN=10 (optional)
- RATE_LIMIT_CHAT_PER_MIN=60 (optional)
- CSRF_COOKIE_NAME (optional)
- MAX_UPLOAD_MB=50 (optional)
- FREE_DAILY_MESSAGES=20 (optional)
- FREE_MAX_PROJECTS=1 (optional)
- FREE_STORAGE_GB=2 (optional)
- FREE_MODEL_TIER=efficient (optional)
- LOCAL_AGENT_PORT=43121 (optional)
- LOCAL_AGENT_TOKEN_TTL_HOURS=1 (optional)
- LOCAL_AGENT_WS_URL (optional)
- PREVIEW_BUILD_ENABLED=false (optional)

Worker: (same as backend, all backend variables required)

Frontend:
- VITE_API_URL (required - production backend URL)
- VITE_APP_URL (required - production frontend URL)

## EXTERNAL SERVICES

Supabase: YES
Upstash: YES
Railway PostgreSQL: NO
Railway Redis: NO

## NOTES

- Build requires shared workspace to be built first
- Backend start command uses the built dist/server.js
- Worker is a standalone process using tsx (already in dependencies)
- Frontend serves from dist/ directory using custom server.js
- All health endpoints: /health, /healthz (Railway uses /healthz per railway.toml)
- Monorepo root is / for backend and worker, /frontend for frontend
- No Railway PostgreSQL or Redis provisioning needed - external services used