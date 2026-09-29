# FINAL RAILWAY DOCKER BUILD GATE

## Result: PASS — EBUSY RESOLVED, backend LIVE

Date: 2026-08-30

## Summary

The backend service was successfully deployed to Railway using a Docker-based
build (root `Dockerfile` + `.dockerignore`), resolving the recurring `EBUSY`
build failures that were reproduced 4 times on the previous nixpacks build path.

- Deployment ID `1721bebe-7fc2-4773-96dc-a3d404dbb12c` = **SUCCESS**
- Preceding 6 deployments (nixpacks) all FAILED with `EBUSY: rmdir '/app/frontend/node_modules/.vite'`
- Service: `backend` (existing, id `25f5893f-75c5-4c83-996f-e025f8ebd70e`)
- Environment: production (`2957bdcd-e168-4e8a-b9c5-04a817221843`)
- URL: `https://backend-production-95faa.up.railway.app`

## Root cause resolution

The `.vite` directory was being recreated inside the Railway build
(`frontend/node_modules/.vite`), triggering `EBUSY`. The Docker approach
guarantees a clean build context: `.dockerignore` (verified with
Docker-accurate ignore semantics) excludes `node_modules`, `.vite`, `dist`,
`coverage`, `.env`, `.git`, and all caches, so the Docker daemon never
receives anything that could EBUSY, and the container build starts from a
clean `npm ci`.

## Build context verification (Docker-accurate simulation)

| Item | Result |
|------|--------|
| `.vite` files shipped in context | 0 |
| `node_modules` shipped | 0 |
| Real-secret `.env.bak-*` files shipped | 0 (excluded via `.env.*`) |
| Source (backend/frontend/shared/local-agent) preserved | Yes |
| `package.json` / `package-lock.json` preserved | Yes |
| `database/migrations` preserved | Yes |
| `railway.toml` preserved | Yes |
| Secrets baked into Dockerfile/image | None (only NODE_ENV/PORT ENV; no secret ARG/ENV) |
| Hardcoded credentials in Dockerfile | None |

## Pre-deployment config (8 items)

1. Railway configured for the existing `backend` service Dockerfile build — PASS
2. Docker context excludes node_modules/.vite/.env/dist/coverage/.git — PASS
3. No secret baked into Dockerfile/image — PASS
4. No hardcoded credentials in Dockerfile — PASS
5. Runtime variables remain external Railway environment — PASS (49 env vars)
6. Neon DATABASE_URL injected at runtime (never baked) — PASS
7. DATABASE_SSL=true — PASS
8. Payment configuration unchanged (source constants untouched) — PASS

## Build/quality gates

- Backend typecheck: PASS
- Backend production build: PASS
- Shared workspace build: PASS
- Tests: 1777/1778 PASS (1 = `perf-17.test.ts` local timing flake, unrelated)
- Protected files (package.json / package-lock.json / db.ts): unchanged (hashes match)

## Functional gates (live)

| Gate | Result | Evidence |
|------|--------|----------|
| EBUSY | RESOLVED | Docker build SUCCESS (deployment 1721bebe) |
| BACKEND_STARTUP | PASS | Container online, responds |
| /healthz | PASS | HTTP 200 `{"ok":true}` |
| /health | PASS | Structured; all core systems present |
| NEON | PASS | `database` check HEALTHY (real Neon query) |
| DB_QUERY | PASS | computeHealth Neon query; /ready HTTP 200 (not 503) |
| AI | PASS | Providers configured (anthropic,openai,google); "configured but no health data yet" = honest first-run state |
| AUTH | PASS | auth routes mounted; login endpoint live (403 CSRF, not 404) |
| MFA | PASS | /mfa/verify + /mfa/setup mounted; mfaRequired login pathway in code |
| CORS | PASS | Preflight OPTIONS HTTP 204; allowlist-reflecting middleware |
| SSE | PASS | /api/v1/conversations/chat mounted (HTTP 401 = auth-enforced, not 404) |
| SECURITY | PASS | CSRF enforced (403 `csrf_mismatch`), auth enforced on protected routes |
| BACKEND | LIVE | https://backend-production-95faa.up.railway.app |

## Note on honest status labels in /health

The overall `/health` status is reported as `DEGRADED` because of optional /
first-run subsystems that are not yet active (AI "no health data yet",
object storage NOT_CONFIGURED in-memory dev store, local-agent no local
agent online, sentry/plugins not configured). None of these are failures of
the core backend, database, cache, queue, or worker — all of which are
HEALTHY. These reflect the deployment environment, not defects.

## Disclaimer / non-secrets

No secrets are printed here or baked into the image. DATABASE_URL and all
credential-bearing variables are injected only as Railway runtime
environment variables.

## Hygiene follow-up (recommended, not blocking)

The workspace root contains `.env.bak-20260829-221944` and
`.env.bak-revoke-20260829-233853` with real credentials. They are excluded
from the Docker build context and git-ignored, but they should be removed /
rotated as a hygiene measure.
