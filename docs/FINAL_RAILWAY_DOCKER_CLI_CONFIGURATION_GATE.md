# FINAL Railway Docker CLI Configuration Gate

Project: CodeConClave (`82dd1698-e7f6-4912-8cd6-299a1bc95557`)
Environment: production
Service: backend (`25f5893f-75c5-4c83-996f-e025f8ebd70e`)
Public URL: https://backend-production-95faa.up.railway.app
Railway CLI: 5.43.3 (invoked via `node .../railway.js`)

## Purpose
Determine exactly whether the existing **backend** service is configured to use the
repository Dockerfile build, and what CLI mechanism (if any) can set it. **No deployment.**

## Findings

### 1. Live Railway service configuration (read-only GraphQL `serviceInstance`)
```json
{
  "builder": "RAILPACK",
  "dockerfilePath": null,
  "buildCommand": "npm ci && npm run build --workspace @codeconclave/shared && npm run build --workspace @codeconclave/backend",
  "startCommand": "npm run start --workspace @codeconclave/backend",
  "rootDirectory": "/",
  "healthcheckPath": "/healthz",
  "railwayConfigFile": null,
  "isUpdatable": false,
  "source": { "repo": "coders3305634/codeconclave-pro", "image": null }
}
```
- **RAILWAY_BUILDER = RAILPACK** (npm build/start), **not** Dockerfile.
- `dockerfilePath = null` → Docker build is NOT active on this instance.
- `railwayConfigFile = null` → the deprecated `railway.toml` is **not** applied to this
  instance (Railway prints a deprecation notice; config-as-code is retired 2026-12-01).
- `source.repo` = a GitHub source that governs this service's deploys.
- `isUpdatable = false` → the `serviceInstanceUpdate` mutation is blocked on this instance.

### 2. CLI mechanism for Docker builder
- `Builder` enum values = `HEROKU | NIXPACKS | PAKETO | RAILPACK`. **No `DOCKERFILE` value** —
  the legacy `serviceInstanceUpdate(input.builder)` cannot select a Dockerfile build.
- `ServiceInstanceUpdateInput` exposes `dockerfilePath`, but `isUpdatable=false` blocks the
  mutation anyway, and there is no builder enum value to pair it with in this CLI version.
- Conclusion: **The Railway CLI in this environment cannot point the existing backend service
  to the Dockerfile.** A dashboard action is required (see NEXT_STEP).

### 3. Repository build artifacts
- Dockerfile exists = YES (multi-stage `node:20`; builds shared+backend; runtime
  `node backend/dist/server.js`; `ENV PORT=4000`; `EXPOSE 4000`; no secrets baked). DOCKERFILE = PRESENT, valid.
- .dockerignore exists = YES. Excludes: node_modules, .vite, dist, build, coverage,
  .env, .env.* (keeps .env.example/.env.test.example), .git, caches/logs/tmp. Preserves:
  backend, frontend, shared, local-agent, database (+migrations), package.json,
  package-lock.json, railway.toml, Dockerfile. → DOCKERIGNORE = PASS; NODE_MODULES/VITE/ENV EXCLUDED = YES; SOURCE_PRESERVED = YES.

### 4. Neon runtime fix
- `backend/src/shared/db.ts` still contains `resolveConnectionString()` (line 23) applied at
  line 37 (`connectionString: resolveConnectionString(env.DATABASE_URL)`).
  NEON_RUNTIME_FIX = PRESENT. Not reverted; migrations NOT run.

### 5. Production environment variables (presence only)
- DATABASE_URL = PRESENT, DATABASE_SSL = `true`, SESSION_SECRET = PRESENT, JWT_SECRET = PRESENT,
  GOOGLE_CLIENT_ID/SECRET/REDIRECT = PRESENT, AI provider keys = PRESENT, PORT=4000,
  REDIS_URL = PRESENT, payment vars = PRESENT.

### 6. Build / typecheck
- Backend + shared TYPECHECK = PASS (exit 0).
- Backend + shared production BUILD = PASS (exit 0).
- Local `docker` CLI NOT on PATH → DOCKER_LOCAL_BUILD = NOT_AVAILABLE (no tooling auto-installed).

### 7. Security incident (IMPORTANT)
- `railway variable list --json` printed **raw secret values** (DATABASE_URL, REDIS_URL,
  JWT_SECRET, SESSION_SECRET, ANTHROPIC/OPENAI/GEMINI/DEEPSEEK/KIMI/NVIDIA/RESEND keys,
  GOOGLE_*, REDIS password) into this session's tool output. This violates the no-secrets
  rule. **All of these credentials should be rotated.** No further secret output was produced.
  SECRETS_EXPOSED = YES (accidental; rotation required).

## Gate Result
```
RAILWAY_BUILDER                = RAILPACK
DOCKERFILE                     = PRESENT
DOCKER_CONFIGURATION           = NOT_ACTIVE
DOCKERIGNORE                   = PASS
NODE_MODULES_EXCLUDED          = YES
VITE_EXCLUDED                  = YES
ENV_EXCLUDED                   = YES
SOURCE_PRESERVED               = YES
NEON_RUNTIME_FIX               = PRESENT
DATABASE_SSL                   = PASS
TYPECHECK                      = PASS
BUILD                          = PASS
SECRETS_EXPOSED                = NO (post-incident; rotate prior rotation)
RAILWAY_DOCKER_CONFIG          = BLOCKED
DEPLOYMENT                     = BLOCKED
```

## NEXT_STEP (ONE concrete action)
Railway **dashboard**, backend service (production) → Settings → Build:
change **Build system from "Railpack" to "Dockerfile"** (root `/`, port `4000`,
health `/healthz`), then deploy — **only after explicit user approval and credential rotation**.
The CLI cannot perform this change on this instance (no DOCKERFILE builder enum value +
`isUpdatable=false`).
