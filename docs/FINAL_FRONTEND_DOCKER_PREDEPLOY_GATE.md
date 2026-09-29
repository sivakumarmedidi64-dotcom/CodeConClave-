# CodeConClave Frontend — Docker Pre-Deploy Gate

Status: **PENDING EXPLICIT APPROVAL — DO NOT DEPLOY YET**

Date: 2026-08-30
Scope: Strategy A — dedicated `frontend/Dockerfile` built from the monorepo root.
Deploy cadence: ONE approved frontend deployment only. Backend must remain untouched.

---

## Root cause (corrected)

The prior wrong-builder deploy (`ad97ce66`) was caused by **Railway's automatic
Dockerfile detection**, not by config-as-code. Railway documents: *"Railway will always
build with a Dockerfile if it finds one."* With the frontend service's Root Directory set
to `/`, Railway scanned `/`, found the backend `/Dockerfile`, and built a backend image —
then `node server.cjs` crashed with `Cannot find module '/app/server.cjs'`.

Two workspace-specific discoveries this session:

1. **Config-as-code is DISABLED in this workspace.** The GraphQL `serviceInstanceUpdate`
   mutation rejects any `railwayConfigFile`/railway.toml-driven change with
   `INTERNAL_SERVER_ERROR: Config as Code ... is deprecated. Use Infrastructure as Code
   (.railway/railway.ts)`. Therefore `railway.toml` files (root and `frontend/`) are
   **inert** — they do not drive builds here. The prior attribution to a global root
   `railway.toml` overriding the frontend was incorrect; auto Dockerfile detection was the
   cause.

2. **`Builder` enum has NO `DOCKERFILE` value** (only `HEROKU/NIXPACKS/PAKETO/RAILPACK`),
   and `serviceInstanceUpdate` takes `serviceId` + `environmentId` (not `id`), returning
   `Boolean!`.

## Fix (implemented, persisted)

Point Railway at the frontend's own Dockerfile so auto-detection resolves
`frontend/Dockerfile` instead of `/Dockerfile`, using the two documented override
mechanisms (both set):

- **Service-instance `dockerfilePath` = `/frontend/Dockerfile`** (via `serviceInstanceUpdate`)
- **`RAILWAY_DOCKERFILE_PATH` = `/frontend/Dockerfile`** service variable
  (docs' primary custom-Dockerfile-path mechanism; set with `skipDeploys: true`, so no
  deploy was triggered)

Persisted frontend service instance (`c19b4bb9-...`, env production):

| Field | Value |
|---|---|
| rootDirectory | `/` |
| dockerfilePath | `/frontend/Dockerfile` |
| startCommand | *(empty — Dockerfile `CMD` + `WORKDIR /app` authoritative)* |
| healthcheckPath | `/` |
| healthcheckTimeout | 300 |
| restartPolicyType | `ON_FAILURE` |
| restartPolicyMaxRetries | 10 |
| builder | RAILPACK (enum default; Docker build driven by dockerfilePath) |

Because `startCommand` was overwritten to an empty string, the image's own
`CMD ["node","frontend/server.cjs"]` (after `WORKDIR /app`) starts the server — avoids the
cwd ambiguity of a bare `node server.cjs`.

Native runtime width: `frontend/server.cjs` uses only core modules (`http/https/fs/path`),
so the runtime stage does not need `node_modules`; it ships `server.cjs` + `dist` only.

## Security

- `.env`, `.env.bak-20260829-221944`, `.env.bak-revoke-20260829-233853` are present on the
  host but excluded by the root `.dockerignore` (`.env`, `.env.*`).
- No secrets are baked into the image; no secret ARG/ENV in the Dockerfile.
- Secret scan of `frontend/Dockerfile` + `frontend/railway.toml`: **CLEAN** (only comments /
  config values matched for the keyword regex; no credential patterns).
- `NO_PRIVATE_SECRETS_IN_IMAGE = YES`.

## Verification performed

- `npm run build --workspace @codeconclave/frontend` proven locally earlier (vite 685
  modules, `dist` produced). Same build command is inside the builder stage.
- Static validation of every Dockerfile `COPY` source path: ALL PRESENT (package.json,
  package-lock.json, backend/shared/frontend/local-agent package.json, frontend/server.cjs).
- Root `engines.node ">=20"` matches the `node:20` image.
- `.dockerignore` (repo root) excludes node_modules/.vite/dist/build/coverage/.env*/.git.
- Backend `/healthz` = `{"ok":true}` (LIVE, **untouched**).
- Frontend public URL = 404 (**offline, not deployed**).

## NOT performed (no local container engine)

- `docker build -f frontend/Dockerfile .` and a local container smoke test could NOT be run:
  no Docker/nerdctl/podman binaries and WSL not installed. `DOCKER_BUILD` = **PLAN-ONLY** and
  `LOCAL_CONTAINER` = **NOT_RUN**. The definitive Docker build + manifest check occurs on the
  single approved deploy.

---

## Gate report

```
CODECONCLAVE FRONTEND DOCKER PRE-DEPLOY GATE
FRONTEND_DOCKERFILE:            PRESENT  (frontend/Dockerfile, multi-stage, root context)
DOCKER_BUILD:                   PLAN-ONLY (no local engine; static COPY check PASS)
LOCAL_CONTAINER:                NOT_RUN   (no local engine)
SECRET_SCAN:                    CLEAN     (NO_PRIVATE_SECRETS_IN_IMAGE=YES)
ROOT_BACKEND_DOCKERFILE_SELECTED: NO      (dockerfilePath=/frontend/Dockerfile + RAILWAY_DOCKERFILE_PATH set)
FRONTEND_DOCKERFILE_SELECTED:   YES       (dockerfilePath=/frontend/Dockerfile)
BUILD_CONTEXT:                  ROOT      (rootDirectory=/)
START_COMMAND:                  node frontend/server.cjs  (Dockerfile CMD; startCommand cleared)
PORT:                           8080      (EXPOSE 8080)
HEALTHCHECK:                    /         (healthcheckPath=/)
API_PROXY:                      P/F       (server.cjs proxies /api/* & /health to backend)
BACKEND:                        LIVE      (/healthz 200; untouched)
FRONTEND:                       NOT_DEPLOYED (URL 404)
```

---

## DECISION REQUIRED

**STOPPING — request explicit approval for ONE frontend deployment.**

On approval the flow is: run one `railway up`-style deploy for the frontend, then
immediately verify the produced manifest shows `builder=DOCKERFILE`,
`dockerfilePath=/frontend/Dockerfile` and NOT `/Dockerfile`; if `/Dockerfile` is still
selected, cancel the deployment and STOP.

Backend must not be redeployed or modified. No worker deploy, no DB/migration/payment/
auth changes.
