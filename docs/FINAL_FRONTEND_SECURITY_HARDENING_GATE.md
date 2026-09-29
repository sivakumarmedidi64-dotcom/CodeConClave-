# FINAL Frontend Security Hardening Gate

- **Date:** 2026-08-31
- **Scope:** The one remaining code-hardening gap found by the live production readiness audit — missing security headers on the frontend's own static responses.
- **File changed (only):** `frontend/server.cjs` (frontend server layer). Backend, Neon, migrations, payments untouched.

## What changed (smallest safe change)

A `SECURITY_HEADERS` map plus a `withSecurityHeaders()` helper was added to `frontend/server.cjs`. The headers are applied **only to the three static response `writeHead` sites** (normal file, SPA fallback, 404). The reverse-proxy handlers (`/api/*`, `/health`) and the WebSocket upgrade handler were **not modified** — backend responses still pass through byte-for-byte carrying the backend's own authoritative security headers (no duplication/conflict).

### CSP design (scoped to the actual bundle)
Verified against the built `dist/` before writing the policy:

- **All assets are self-origin** (single `/assets/index-*.js` module + `/assets/index-*.css`); no external CDNs, no external fonts (`fonts.googleapis`/`gstatic` = 0 occurrences), no `@import`, no `@font-face`.
- **No inline scripts, no `eval`/`new Function`** in the bundle → `script-src 'self'`.
- **React 19 runtime style hoisting** injects `<style>` elements (verified) → `style-src 'self' 'unsafe-inline'` (`'unsafe-inline'` confined to **styles only**, never scripts).
- **All API/SSE/WebSocket are same-origin** (relative `/api/v1/*`, `EventSource` on `/api/v1/preview/...` and `/api/v1/conversations/chat`, agent WebSocket on `/agent`) → `connect-src 'self' ws: wss:`.
- **Preview iframe is same-origin** (`src=/api/v1/preview/...`) → `frame-src 'self'`.
- **Google OAuth is a top-level navigation** via `<a href="/api/v1/auth/google/authorize">`, redirected server-side to `accounts.google.com` — not governed by `connect-src`/`frame-src`/`form-action`, so OAuth is unaffected (verified 302 flow intact).
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` (anti-clickjacking, matches backend), `upgrade-insecure-requests` (all resources already https).

**CSP final value:**
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none';
base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```

**Other headers added (match backend where applicable):**
- `Strict-Transport-Security: max-age=63072000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

## Validation (local, read-only, no payment)

### Pipeline
- `npm run typecheck` → **PASS** (clean, no errors)
- `npm run build` → **PASS** (dist rebuilt, identical asset hashes `index-DicCf8wU.js` / `index-Bs7t5iyP.css` → no bundle content change; chunk-size warning pre-existing)
- Frontend server smoke test (local server, proxy → live backend, `server.cjs` headless-served via `node`):
  - HTTP header checks on `/`, `/login`, `/agents`, `/register`, `/health`, `/api/v1/auth/me`, and `/assets/index-*.js` → **all required headers present, zero missing**
  - **Real browser (Chrome + puppeteer-core)**:
    - SPA boots; `/` redirects to `/login`; login page renders
    - Google OAuth link `/api/v1/auth/google/authorize` present
    - Direct SPA routes `/login` and `/agents` → 200
    - **CSP violations: 0 · page errors: 0** only expected unauthenticated 401 API checks (normal)
  - Proxy + streaming checks (through local server):
    - Google OAuth start → **302 → `https://accounts.google.com/o/oauth2/v2/auth`** (redirect preserved)
    - `POST /api/v1/conversations/chat` (SSE) → **403** (route present; auth-gated, not 404)
    - `GET /api/v1/preview/*` (EventSource target) → **401** (route present)
    - `/api/v1/auth/me` proxied response retains **backend** CSP/HSTS/nosniff unchanged; FE headers do not override proxy responses

## Report

```
CSP                 = PASS
HSTS                = PASS
NOSNIFF             = PASS
X_FRAME_OPTIONS     = PASS
REFERRER_POLICY     = PASS
PERMISSIONS_POLICY  = PASS

Frontend build      = PASS
Frontend proxy      = PASS
Auth                = PASS
Google OAuth        = PASS
SSE                 = PASS
Secret scan         = PASS (bundle unchanged; previous clean scan applies)

Backend:
UNCHANGED

Payments:
FROZEN

ZERO_ADMIN_PAYMENT:
BLOCKED

DEPLOYMENT:
NOT_EXECUTED

NEXT_STEP:
REQUEST EXPLICIT APPROVAL FOR ONE FRONTEND SECURITY-HARDENING DEPLOYMENT
```

## Deployment gate

The change is **validated locally and ready**. It requires **ONE frontend deployment only** (frontend service on Railway). This is a request for explicit approval — **no deploy has been performed**, and the backend will not be redeployed.

- Affected service: frontend (service deploy via `frontend/` → Dockerfile build, `server.cjs` + `dist/`)
- Rollout note: dropping HSTS (`max-age=63072000`) on the FE static responses is safe; all traffic is already HTTPS. CSP `script-src 'self'` cannot break the bundle (verified zero CSP violations in real Chromium).
- Backend — UNCHANGED. Payments — FROZEN. Real money — NOT involved.