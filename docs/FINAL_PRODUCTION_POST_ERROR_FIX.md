# CodeConClave — FINAL PRODUCTION POST ERROR FIX

> Date: 2026-08-31 · Scope: JSON-body POST error semantics only.
> Payment architecture remains **FROZEN**. No deploy performed.
> No secrets exposed in this document or during the audit.

---

## Root cause

`backend/src/middleware/security.ts` — `errorHandler()` mapped only:

1. `AppError` (`isAppError`, `instanceof`) → its own status,
2. `ZodError` (structural `isZodError`) → 400 `validation_error`.

**body-parser / raw-body errors were unmapped.** A JSON POST whose body the
parser rejects (e.g. malformed JSON → `SyntaxError` with `type:
"entity.parse.failed"`, `status: 400`, `expose: true` from
`body-parser/lib/types/json.js`) is neither an `AppError` nor a `ZodError`, so
the handler fell through to the generic **500 `internal_error`** branch.

### Reproduction

- Assembled-app repro (`createApp()` + real HTTP server, DB/cache mocked):
  - `POST /api/v1/auth/login` with malformed JSON `{bad` → **500** (was)
    → **400** (after fix).
  - Stacks observed: `SyntaxError … at JSON.parse … at body-parser/lib/types/json.js:96`
- Same reproduced against the **compiled `dist/app.js`** build (production
  artifact equivalent).
- Verified unaffected (already correct, now pinned by tests):
  - valid JSON + wrong creds → 401 `bad_credentials`
  - missing/back CSRF → 403 `csrf_mismatch`
  - invalid email shape → 400 `validation_error` (ZodError path)
  - GET `/auth/me` → 401 · GET `/healthz` → 200
  - body-less POST (payments sessions) → 403 (CSRF gate reachable)
  - rate limit over quota → 429 · store outage (security path) → 503
  - unexpected error → sanitized 500 (no stack, no message leak)

> Note on the live production observation: the production backend also returned
> 500 for a *valid-JSON* `POST /auth/login` (with a correct CSRF round-trip),
> which does **not** reproduce locally under `src` or `dist`. Local + compiled
> builds both return 401 for that exact request. The environment-specific
> trigger is not captured by the repo code (repo `.env` carries a malformed
> `REDIS_URL` literal and cache/queue go through the environment; a store
> misbehaviour upstream of the handler is the leading hypothesis). The fix below
> makes the error boundary robust either way and **cannot weaken** any status
> path: what was confidently wrong (rejected-body → 500) is now correctly 400,
> and every other outcome is preserved and pinned by tests.

---

## Minimal fix

One change, `backend/src/middleware/security.ts`:

- Added `isBodyParserError(err)` — **structural** detection (mirrors the
  established `isZodError` shape-check pattern for dual-package safety): object
  with `type: string` starting `entity.` and a 4xx `status`/`statusCode`.
- In `errorHandler`, after `AppError` and `ZodError` branches (unchanged), map
  body-parser errors to a **sanitized 400**:

  ```json
  { "error": { "code": "invalid_body", "message": "Invalid request body" } }
  ```

Nothing else changed: no middleware architecture rewrite, no mass
`catch → 400`, no loosening of fail-closed behavior, no header/CSRF/auth/rate
limit changes, error envelope format preserved, never the raw message/stack.

---

## Tests

New regression file: `backend/src/foundation/post-error-semantics.test.ts`
(11 tests, assembled-app level, DB/cache mocked, real HTTP):

1. valid JSON POST reaches route (wrong creds → 401, not 500)
2. malformed JSON → sanitized 400 `invalid_body` (was 500)
3. missing CSRF → 403 `csrf_mismatch`
4. invalid credentials (valid email shape) → 401 `bad_credentials`
5. validation failure → 400 `validation_error` (existing envelope)
6. rate limit exceeded → 429
7. store outage (security path) → 503 fail-closed
8. unexpected error → sanitized 500, no stack / no leak
9. GET auth unchanged (`/auth/me` → 401, `/healthz` → 200)
10. protected POST remains protected (`/projects` → 401 with CSRF)
11. body-less POST still reaches CSRF gate (payments → 403)

Existing security tests untouched and passing.

## Full validation

| Suite | Result |
|---|---|
| Backend (all) | **PASS** — 100 files, 1789 passed, 3 skipped, 0 failed |
| Security / failures / CSP / webhook-route | **PASS** — 7 files |
| Payment tests | **PASS** — 5 files / 122 tests |
| New regression | **PASS** — 11 tests |
| Frontend | **PASS** — 48 files / 279 tests |
| Shared | **PASS** — 7 files / 63 tests |
| Local-agent | **PASS** — 5 files / 49 tests |
| Typecheck (backend/shared/frontend/local-agent) | **PASS** |
| Build (backend/shared/frontend/local-agent) | **PASS** |

## Security

- No bypass of CSRF, authentication, rate limiting, or fail-closed handling.
- No stack traces or raw messages ever returned; envelope unchanged.
- Sanitized 500 preserved for genuine unexpected errors.
- Security tests all green.

## Payment freeze (untouched)

- **Payment architecture: FROZEN — not modified.**
- No Razorpay API / webhook / link / admin activation changes.
- `backend/src/modules/payments/*`, `database/*` (migrations/RLS), AI config:
  **unchanged** (file-boundary check: only `middleware/security.ts` and the new
  test file changed this session).
- PRO ₹999 / TEAM ₹4999 checkout: unchanged; static-link zero-admin remains
  NOT_POSSIBLE under current constraints; Gmail = evidence/review rail only.

## Deployment status

**SOURCE_FIX = READY · TESTS = PASS · TYPECHECK = PASS · BUILD = PASS**
**DEPLOYMENT = APPROVAL_REQUIRED — NOT deployed.**

Post-approval (explicit, manual): deploy the **existing backend only** (no
`package.json`/config change), then verify live `POST /auth/login`,
`POST /projects`, normal JSON-POST routes, CSRF, auth, health, DB, Redis, AI,
Google OAuth. Frontend requires no redeploy.