# CODECONCLAVE FRONTEND DEPLOYMENT REPORT

## Result: DEPLOYMENT BLOCKED (2 hard blockers found during verification)

Date: 2026-08-30

Backend (reference, unchanged): https://backend-production-95faa.up.railway.app — LIVE, not redeployed.

## Verification performed (per task, BEFORE any deployment)

| Check | Result |
|-------|--------|
| /frontend/package.json | CORRECT — scripts build=`vite build`, start=`node server.js` |
| /frontend/server.js | PRESENT — but FAILS TO START (see Blocker 1) |
| Vite production build | PASS — `vite build` ✓ built in 6.71s (685 modules); dist/index.html + assets |
| VITE_API_URL at build time | MISSING (see Blocker 2) |
| Serve on port 8080 | server.js defaults to 8080, but crashes at startup (Blocker 1) |

Frontend service on Railway: EXISTS (offline), id `1041fc15-8d40-429b-b87e-577807c12412`,
URL `https://frontend-production-e367.up.railway.app`. No variables set. NOT deployed.

---

## BLOCKER 1 — START_FAILURE: `node server.js` crashes immediately

`frontend/server.js` uses CommonJS (`require('http')`), but `frontend/package.json`
declares `"type": "module"`. Node therefore treats `.js` as ESM and throws:

```
ReferenceError: require is not defined in ES module scope
This file is being treated as an ES module because it has a '.js' file extension
and '.../frontend/package.json' contains "type": "module".
```
(verified locally: server process exited immediately on start)

The user-specified start command `node server.js` cannot work as-is.

## BLOCKER 2 — API_URL_FAILURE: the frontend does not use `VITE_API_URL`

`frontend/src/lib/api.ts` (and all pages) make **relative, same-origin** requests:
`fetch('/api/v1/...')` and `fetch('/health')` with `credentials: 'same-origin'` and
CSRF double-submit cookies. Verified in the built bundle:
- `VITE_API_URL` references in bundle: 0
- `backend-production` URL in bundle: 0
- `import.meta.env` in bundle: 0
- 147 matches of `"/api/v1` / `"/health` (relative paths)

So setting `VITE_API_URL=https://backend-production-95faa.up.railway.app` has **no
effect** on the built app. On a separate frontend origin, every `/api/v1/*` and
`/health` request would be sent to the **frontend** origin (which has no such
routes — server.js only serves static files + SPA fallback), and same-origin
cookies/CSRF would not flow. Result: login, chat, AI, SSE, project creation all
fail — the browser never reaches the backend.

---

## Smallest safe corrections (require approval — they are SOURCE/TOPOLOGY changes)

For **Blocker 1** (choose one):
- Rename `frontend/server.js` → `frontend/server.cjs` and update the Railway start
  command to `node server.cjs` (minimal, no logic change). — RECOMMENDED
- OR make `server.js` ESM (convert `require`→`import`, `__dirname`→fileURLToPath).

For **Blocker 2** (choose one — this decides how the frontend talks to the backend):
- **A) Reverse proxy on the frontend service** (preserves same-origin architecture):
  extend the frontend serve step to proxy `/api`, `/health`, `/agent` (WS) to the
  backend so cookies/SSE/CSRF all work from `frontend-production-e367...`. No
  application source change; modifies the serve/proxy config only.
- **B) Absolute API base**: change `frontend/src/lib/api.ts` (+ SSE/file/health
  helpers) to use a single `VITE_API_URL` base (from `import.meta.env.VITE_API_URL`)
  with `credentials: 'include'`, and CORS with credentials on the backend. This is
  an application source change matching the task's VITE_API_URL intent.

No changes were made; nothing was deployed.

## Report fields

- FRONTEND_ROOT = /frontend
- BUILDER = NIXPACKS (per task; not yet applied)
- BUILD = PASS
- SERVER_JS = PRESENT (but crashes — START_FAILURE, Blocker 1)
- PORT = 8080 (coded default; unreachable due to Blocker 1)
- VITE_API_URL = MISSING (not consumed by source — Blocker 2)
- DEPLOYMENT = BLOCKED
