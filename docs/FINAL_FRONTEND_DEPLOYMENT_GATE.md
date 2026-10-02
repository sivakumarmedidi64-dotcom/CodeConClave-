# FINAL FRONTEND DEPLOYMENT GATE

Status: **PRE-DEPLOY GATE COMPLETE — deployment NOT performed (awaiting explicit approval for exactly ONE frontend deploy)**
Backend: LIVE and UNCHANGED during this task (deployment 575c2d1b, Docker).

## 1. Inspected (all verified, not guessed)
- `frontend/package.json`: `"type":"module"`, `build: vite build`, `start: node server.cjs`,
  dependencies = react/react-dom/react-router-dom/recharts (frontend-only app code).
- `frontend/server.cjs` (140 lines): production static server.
  - `PORT = process.env.PORT || 8080`; serves `frontend/dist` (path.join(__dirname,'dist')).
  - Reverse proxy: `/api/*` and `/health`(or `/health/`) → `FRONTEND_PROXY_TARGET ||
    https://backend-production-95faa.up.railway.app` (exact required backend URL).
  - Proxies SSE (stream/pipe; no buffering) and WebSocket `upgrade` on those prefixes.
  - SPA fallback: unknown/nonexistent paths → index.html.
  - **No secrets in server.cjs**; backend URL is a default (overridable) target, not a credential.
- `frontend/vite.config.ts`: dev proxy only (localhost:4000) — build output to `frontend/dist`,
  `sourcemap:false` (no source maps → smaller, no bundled source paths).
- `frontend/index.html`: Vite entry (`<div id="root">`, `/src/main.tsx`).
- `frontend/tsconfig.json`: extends `../tsconfig.base.json` (workspace-level) → frontend build is
  **workspace-root dependent** (root `npm run build --workspace @codeconclave/frontend` + root
  `npm ci` with `workspaces`).
- Root `package.json`: workspaces = backend/frontend/local-agent/shared; engines.node >=20;
  `build:frontend` = `npm run build --workspace @codeconclave/frontend`.
- Root `railway.toml` (backend): `[build] builder = "dockerfile"`, `[deploy] healthcheckPath=/healthz`.
- Root `Dockerfile` (backend): multi-stage node:20 → builds shared + backend only.
- `.railwayignore`(root) + `.gitignore`: exclude node_modules/.vite/dist/build/coverage/.env/.env.*/
  data/logs/tmp; keep source, server.cjs, lockfile, railway.toml, config.

## 2. Railway frontend service (persisted, read via API)
- service id `1041fc15-8d40-429b-b87e-577807c12412`, name `frontend`.
- `builder: RAILPACK`, `dockerfilePath: null`, rootDirectory `/frontend`,
  `buildCommand: npm run build --workspace @codeconclave/frontend`,
  `startCommand: node server.js` (STALE — actual file is server.cjs),
  `healthcheckPath: null`, `hasEverDeployed: false` (offline, never deployed),
  `isUpdatable: false`, `railwayConfigFile: null`.
- Public URL already assigned: `https://frontend-production-e367.up.railway.app`
- Env (names only, no values): `PORT=8080`, Railway-internal vars. NO `FRONTEND_PROXY_TARGET`
  override → server.cjs uses its verified default backend URL.

## 3. Local verification (all executed, PASS)
- `npm run typecheck --workspace @codeconclave/frontend` → exit 0.
- `npm run build --workspace @codeconclave/frontend` → exit 0; `frontend/dist` produced
  (index.html + index-*.css + index-*.js). (Chunk>500kB warning is cosmetic.)
- Local startup `node server.cjs` on port 8080:
  - `/` → 200 serves index.html; SPA fallback `/agents` → 200 HTML.
  - `/health` proxy → 200 (backend JSON; status DEGRADED = expected baseline, HTTP 200).
  - `/api/v1/auth/me` proxy → 401 (backend auth enforced).
  - CORS preflight OPTIONS → 204.
  - WS upgrade handler present for /api + /health (no browser WS exists in source ⇒ NOT_TESTED).
- Production-bundle secret scan (byte-level substring check of `dist`): NONE of the sensitive
  tokens present → `FRONTEND_SECRET_SCAN = CLEAN`.

## 4. Configuration conflict (why this must be handled before deploy)
1. **Stale startCommand.** Persisted `startCommand = node server.js`; the file is `server.cjs`
   (renamed because `"type":"module"` makes `.js` ESM). A deploy using `node server.js` fails to
   start. Must be `node server.cjs`.
2. **Builder/config inheritance risk.** `railway up` from the repo root reads the ROOT
   `railway.toml` (`builder=dockerfile`) and Railway "always builds with a Dockerfile if it finds
   one" → deploying the frontend from `/` could build the ROOT backend Dockerfile instead of the
   frontend. The frontend must be configured independently (its own root-dir config) so it does
   NOT inherit the backend Docker file.
3. **Workspace build root.** The frontend build runs via root workspaces (root package.json +
   lockfile). A `/frontend`-only build context cannot run `npm run build --workspace
   @codeconclave/frontend`.

## 5. Proposed smallest safe config (Approach A — service root /frontend, no backend change)
- Create `frontend/railway.toml` (config-as-code scoped to the frontend's root directory) so the
  frontend deploy does NOT inherit the root backend Docker config:
  ```toml
  [build]
  builder = "RAILPACK"
  buildCommand = "npm run build --workspace @codeconclave/frontend"
  [deploy]
  startCommand = "node server.cjs"
  healthcheckPath = "/"
  healthcheckTimeout = 300
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 10
  ```
- Deploy ONE frontend deployment via `railway up` targeting service `frontend`, using the repo
  root as the archive context (so the workspace build resolves) while the frontend service's own
  config-as-code governs builder/start/healthcheck.
- `frontend/package.json` start script already = `node server.cjs`.
- Healthcheck `/` returns the SPA index.html with 200 (independent of backend); avoids proxied
  `/health` 502 when backend is momentarily unreachable.
- Backend `railway.toml`, root `Dockerfile`, db.ts, migrations, database, Redis, payments:
  **UNCHANGED.**

## 6. Gate result
```
FRONTEND_ROOT            = /frontend
FRONTEND_BUILD           = npm run build --workspace @codeconclave/frontend  (local PASS)
FRONTEND_START           = node server.cjs  (local PASS; persisted Railway startCommand STALE - must override)
FRONTEND_PORT            = 8080
VITE_API_URL             = N/A (frontend reads no VITE_/import.meta.env; same-origin proxy → verified backend URL)
BACKEND_DOCKERFILE_INHERIT = to be prevented via frontend/railway.toml (Approach A)
FRONTEND_CONFIG          = READY (needs frontend/railway.toml created + approval)
LOCAL_BUILD              = PASS
LOCAL_SERVER             = PASS
FRONTEND_SECRET_SCAN     = CLEAN
Backend                  = LIVE (575c2d1b, Docker)
Frontend                 = NOT_DEPLOYED
NEXT_STEP                = REQUEST EXPLICIT APPROVAL FOR ONE FRONTEND DEPLOYMENT
```
No secrets captured in this file.
