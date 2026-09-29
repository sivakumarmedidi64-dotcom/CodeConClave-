# CODECONCLAVE FRONTEND BUILD CONTEXT REMEDIATION

Date: 2026-08-30
Status: Remediation prepared, static/local validation PASS. Deployment BLOCKED (not executed — awaiting fresh approval).

---

## 1. Actual Railway context behavior

- Both services report `source.repo = "coders3305634/codeconclave-pro"`. The GitLab remote
  (`gitlab.com/coders3305634/codeconclave-pro.git`, per `.git/config`) is **private** (GitLab API
  404 without auth), so remote file state cannot be fetched.
- The failing frontend deploy (`bc5e183e`) was a **`railway up` local upload**. `railway up` ships
  the local working tree (filtered by `.dockerignore` / `.railwayignore`). The upload therefore
  contained only what existed locally.
- The **actual root cause of the failed `COPY frontend/package.json`** was NOT Railway context
  scoping: **`frontend/package.json` did not exist anywhere** — not locally, not in any backup
  (`Downloads\CodeConClave-Complete (1)`, `codeconclave`, `codeconclave-pro`). The file had been
  lost. `railway up` uploaded a tree with root `package.json` + `backend/` + `shared/` present and
  an empty `frontend/` manifest slot → `COPY frontend/package.json` resolved to a path that did
  not exist in the build context → `"/frontend/package.json": not found`.
- The backend (LIVE) builds via **RAILPACK** (`builder=RAILPACK`, `dockerfilePath=null`) with
  `startCommand: npm run start --workspace @codeconclave/backend`; Railpack uses its own install
  path and is unaffected by the local workspace-manifest drift.

## 2. Root Directory / Dockerfile path (persisted, read via Railway API)

- Frontend service instance (`1041fc15-8d40-429b-b87e-577807c12412`, env production):
  - `rootDirectory` = `/`
  - `dockerfilePath` = `/frontend/Dockerfile`  ✅ (backend `/Dockerfile` NOT selected)
  - `builder` = RAILPACK (nominal; `dockerfilePath` set → Dockerfile build, as the failed deploy proved)
  - `startCommand` = `""` (Dockerfile `CMD ["node","frontend/server.cjs"]` after `WORKDIR /app` authoritative)
  - `healthcheckPath` = `/`, `healthcheckTimeout` = 300, `restartPolicyType` = ON_FAILURE, maxRetries 10
  - `hasEverDeployed` = true (the failed build)
- `RAILWAY_DOCKERFILE_PATH` service variable (from prior approved config) additionally pins
  `/frontend/Dockerfile`.

## 3. Required files (all PRESENT)

- `package.json` (root) — PRESENT
- `package-lock.json` (root) — PRESENT (lockfileVersion 3)
- `backend/package.json`, `shared/package.json`, `local-agent/package.json` — PRESENT
- `frontend/package.json` — **RESTORED** (see §4)
- `frontend/server.cjs`, `frontend/src`, `frontend/vite.config.ts`, `frontend/tsconfig.json`,
  `frontend/index.html` — PRESENT

## 4. Chosen solution — restore the missing frontend workspace manifest (SOURCE_REQUIRED)

`frontend/package.json` was reconstructed **faithfully (not invented)** from authoritative local
records:

- `name`/`version`: `@codeconclave/frontend` 0.1.0 — identical to `package-lock.json` `packages["frontend"]`.
- `dependencies` + `devDependencies`: **exactly** the lockfile record (react, react-dom,
  react-router-dom, recharts; testing-library, jsdom, puppeteer-core, @types/react(-dom),
  @vitejs/plugin-react, typescript, vite, vitest).
- `"type": "module"`, `"build": "vite build"`, `"start": "node server.cjs"` — recorded verbatim in
  `docs/FINAL_FRONTEND_DEPLOYMENT_GATE.md` (the frontend server is `.cjs` precisely because the
  package is ESM).
- `dev`/`typecheck`/`test`/`test:unit` — sibling workspace conventions + vitest config (`vitest run`,
  `tsc --noEmit`, `vite`).
- `private: true`, `engines.node ">=20"` — root/sibling conventions.

Why this solution: the Dockerfile and the upstream build command
(`npm run build --workspace @codeconclave/frontend`) require the workspace manifest to exist and to
match the lockfile. Solution B (duplicate second `package-lock.json`) and the other alternates are
prohibited / unnecessary. No backend files, no backend Dockerfile, no Railway backend config were
touched. No new product source added.

## 5. Why the previous COPY failed (recap)

`COPY frontend/package.json frontend/package.json` referenced a file that was **missing from the
local workspace and therefore missing from the `railway up` upload context**. The error
`"/frontend/package.json": not found` is a true "file absent" error, not a Railway context-scoping
behavior. Root/backend/shared manifests were present in the same upload, which is why their COPYs
succeeded.

## 6. Local static validation (no Docker engine on this machine)

`LOCAL_DOCKER_BUILD = NOT_RUN` (no docker/nerdctl/podman/WSL).

Performed locally:
- `npm ci --dry-run --ignore-scripts --no-audit --no-fund` → **"up to date in 2s"** (lockfile in sync
  with all manifests, including restored `frontend/package.json`) → Docker `RUN npm ci` will pass.
- `npm run build --workspace @codeconclave/frontend` → **PASS** (`vite build`, 685 modules,
  `dist/index.html` + assets). Frontend `src` has **no `@codeconclave/*` imports** (no sibling
  workspace needed at build/runtime).
- Dockerfile COPY static check: `package.json`, `backend/package.json`, `shared/package.json`,
  `frontend/package.json`, `local-agent/package.json`, `.`, `frontend/server.cjs` — all **EXISTS**
  and none excluded by `.dockerignore` / `.railwayignore`.
- Secret scan (byte-level, 12 image-bound files incl. freshly-built `dist`, `server.cjs`,
  `Dockerfile`, manifests, ignore files; 35 sensitive .env key names checked, values only):
  **`NO_PRIVATE_SECRETS_IN_IMAGE = YES`** (only `PORT=8080` / `NODE_ENV=production` config defaults,
  which are public non-secret).
- Server smoke test (matches Dockerfile CMD): `node frontend/server.cjs` with `PORT` → `GET /`
  → **HTTP 200** `text/html` SPA (`<div id="root">`); `GET /agents` → HTTP 200 SPA fallback.
  Healthcheck path `/` serves 200 independent of backend. Proxied `/api` / SSE unchanged in
  `server.cjs` (still targets `FRONTEND_PROXY_TARGET || https://backend-production-95faa.up.railway.app`).

## 7. Railway pre-deploy verification (read-only)

| Check | Result |
|-------|--------|
| DOCKER_CONTEXT | CORRECT by construction + static proof above; cannot be empirically re-proven without a deploy (deploy BLOCKED). |
| DOCKERFILE | `/frontend/Dockerfile` (instance + `RAILWAY_DOCKERFILE_PATH`) ✅ |
| FRONTEND_SOURCE_PRESENT | YES ✅ |
| REQUIRED_PACKAGE_FILES_PRESENT | YES (all 5 manifests + lockfile; npm ci dry-run PASS) ✅ |
| BACKEND_DOCKERFILE_SELECTED | NO ✅ (`dockerfilePath=/frontend/Dockerfile`) |

## 8. Report

```
CODECONCLAVE FRONTEND BUILD CONTEXT REMEDIATION
Actual Railway context:     root-context local upload (railway up) of the working tree; missing
                            frontend/package.json was the sole cause of the failed COPY.
Root directory:             /
Dockerfile:                 /frontend/Dockerfile
Frontend source available:  YES
Required package files:     PRESENT
Previous COPY failure:      EXPLAINED (frontend/package.json absent locally → absent from upload context)
Chosen solution:            Restore frontend/package.json (faithful from lockfile + documented scripts)
Configuration/source change: SOURCE_REQUIRED (frontend/package.json restored; no backend/Railway change)
Local Docker engine:        NOT_AVAILABLE
Static Docker validation:   PASS
Frontend build:             PASS
Backend:                    LIVE
Second deployment:          NOT_EXECUTED
Deployment:                 BLOCKED
NEXT STEP:                  Request approval for ONE frontend redeploy (`railway up --service frontend
                            --environment production --detach`); on success the root-context Dockerfile
                            builds because frontend/package.json is now present.
```

No secrets captured in this file.