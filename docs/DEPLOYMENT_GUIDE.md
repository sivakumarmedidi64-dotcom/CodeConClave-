# CodeConClave Pro — Deployment Guide (Phase 18)

Deployment to Vercel is **explicitly deferred** (Phase 18 instruction: "Do not
deploy to Vercel yet unless explicitly instructed"). This guide documents the
production topology and the exact commands to validate it later.

## Architecture at a glance

```
Browser (React SPA, same-origin /api/v1)
   │
   ▼
Reverse proxy / load balancer (TLS termination, TRUST_PROXY=true)
   │
   ▼
Backend (modular monolith, Express)          Workers (optional separate process)
   ├── PostgreSQL (pgvector)                 ├── task worker + watchdog
   ├── Redis (cache/rate-limit/queue)        └── drain/graceful shutdown
   └── Object storage (S3-compatible / R2)        │
                                                    ▼
                                              PostgreSQL (same schema)
```

- The frontend is a static build (`frontend/dist`) served over HTTPS with the
  backend on the same origin (CORS is then trivially satisfied; the API client
  uses relative `/api/v1` paths).
- The backend runs the task worker and watchdog in-process by default
  (`npm start`). For scale-out, run `npm run worker` as a separate process —
  both use the same PostgreSQL-backed task table, so claims/drains are safe.

## Build & artifact

```bash
npm ci
npm run build            # shared → backend → local-agent (ESM, dist/)
npm run build:frontend   # Vite production build (frontend/dist)
```

Artifacts:
- Backend entrypoint: `backend/dist/server.js` (`node dist/server.js`).
- Worker entrypoint: `backend/dist/workers/run.js` after a build; `npm run worker`
  runs the same worker via tsx from source (`tsx src/workers/run.ts`).
- Frontend: static files in `frontend/dist/`.
- Local agent CLI: `local-agent/dist/index.js` (`npx codeconclave-agent`).

## Environment

See `docs/ENVIRONMENT_VARIABLES.md`. Minimum production requirements:

| Requirement | Why |
| --- | --- |
| Strong `SESSION_SECRET` + `JWT_SECRET` | Guard enforced; do not deploy with dev defaults |
| `SESSION_COOKIE_SECURE=true`, `CSP_ENABLED=true` | Guard enforced |
| `DATABASE_URL` migrated | Server refuses to start on pending migrations |
| `CORS_ORIGINS` = real origin(s), `TRUST_PROXY=true` | Secure cookies behind proxy |
| `REDIS_URL` + `QUEUE_PROVIDER=redis` | Durable queues |
| `STORAGE_PROVIDER=s3`, `STORAGE_AT_REST_ENCRYPTION=true` | Real object storage |
| AI keys, `RESEND_API_KEY`+`RESEND_ENABLED=true`, `SENTRY_DSN`+`SENTRY_ENABLED=true` | Real capabilities |

Never commit `.env` (gitignored). Inject secrets via the platform's secret
manager.

## Database

Apply migrations in order — the backend enforces this at startup:

```bash
npm run db:migrate          # up
npm run db:migrate:status   # verify all applied
```

41 migrations exist (`database/migrations/0001…0041`), all applied at runtime
against the live database (verified in Stage 25: 41/41 recorded in
`schema_migrations`, 0 pending). RLS is applied by `0015_rls.sql` and is
active on all 106 tenant-scoped tables (verified live; see the runbook's
"PostgreSQL runtime validation" checklist).

## Health / readiness / liveness endpoints

| Endpoint | Purpose | Response |
| --- | --- | --- |
| `GET /healthz` | Liveness — process is up | `200 { ok: true }` |
| `GET /ready` | Readiness — core dependencies up (database reachable, not FAILED) | `200` when ready, `503` when a check is FAILED; body carries full honest check list |
| `GET /health` | Full health envelope (backward compatible) | `200` always; `status` + `checks[]` with HEALTHY / DEGRADED / FAILED / NOT_CONFIGURED |

Probe examples:

```bash
curl -fsS https://app.example.com/healthz   # liveness for the orchestrator
curl -fsS https://app.example.com/ready     # readiness for the load balancer
curl -fsS https://app.example.com/health    # full state for dashboards
```

`/health` never includes secrets, connection strings, or user content, and an
unconfigured provider is never labeled HEALTHY.

## Graceful shutdown

- Backend (`server.ts`): on `SIGINT`/`SIGTERM` closes WebSocket resources
  (graceful close frames), stops the watchdog, stops claiming and drains
  in-flight worker executions (bounded ~10s), closes the HTTP server, ends the
  connection pool, and exits 0; hard-exits after a bounded 15s backstop so a
  wedged drain cannot hang the orchestrator.
- Worker (`workers/run.ts`): drains in-flight executions (bounded) before
  exiting.

Send `SIGTERM` and allow ~15s before force-killing.

## Startup failure behavior

Fail-fast by design:
- Database unreachable → exit code 1 with a clear error.
- Pending migrations → exit code 1 telling you to run `npm run db:migrate`.
- Production env guard violations (weak secrets, insecure cookies, CSP off) →
  exit before the server binds.

## Runtime validation checklist (execute when infrastructure exists)

```bash
# 1. Postgres up + migrated
docker compose up -d postgres redis minio
npm run db:migrate && npm run db:migrate:status

# 2. Health gates
curl -fsS localhost:4000/healthz
curl -fsS localhost:4000/ready            # 200 when db reachable
curl -fsS localhost:4000/health           # review every check label

# 3. Operator diagnostics (owner/admin session)
curl -H "Cookie: <session>" localhost:4000/api/v1/operations/diagnostics

# 4. Worker restart / recovery
npm run worker                             # separate process
kill -TERM <worker-pid>                    # drain then exit; tasks recover
npm run worker                             # restart, verify resume

# 5. Object storage smoke (requires STORAGE_PROVIDER=s3)
#    upload → download → delete → restore via the Data Centre / Files APIs
```

## Frontend deployment

The SPA is static. Serve `frontend/dist` from the same origin as the API (or
from the configured `CORS_ORIGINS` origin). There are **no** frontend runtime
env vars — the client speaks same-origin `/api/v1`. Enforce HTTPS and leave
the backend's CSP/security headers in charge (they are emitted by the backend).

## Not covered here

- Vercel deployment: deferred by Phase 18 instruction.
- R2 activation: deferred (billing required); S3-compatible storage is the
  current production path.
- GitHub webhooks: deferred until a real production webhook endpoint exists.