# FINAL RAILWAY BUILD CONTEXT GATE

**Date:** 2026-08-30
**Scope:** Fix the Railway backend build context so the EBUSY deploy failure cannot recur.
**Rule honored:** Non-application-source fix only. No application source, business logic, payment code, migrations, database architecture, Neon config, Railway plan, or secret handling changed. No Railway PostgreSQL / Redis created. No deployment performed.

## Problem

`railway up` was uploading the local build context including `frontend/node_modules/`.
The Vite cache directory `frontend/node_modules/.vite` was therefore present at
`/app/frontend/node_modules/.vite` during `npm ci`, and `npm ci` could not remove the
busy/locked directory:

```
npm error EBUSY: resource busy or locked, rmdir '/app/frontend/node_modules/.vite'
npm error exit code 240
```

This reproduced (EBUSY_REPRODUCED=YES) even after purging the Railway build cache
(`purgeServiceCache` scope `ALL`), proving the `.vite` came from the uploaded local
`frontend/node_modules`, not from a Railway build-cache layer.

Existing `.gitignore` already listed `node_modules/` but did not reliably prevent the
deployment context from shipping it, so Railway's dedicated context-ignore file,
`.railwayignore`, was added.

## Fix applied

- Created `C:\Users\sride\CodeConClave-\.railwayignore` (51 lines) with safe exclusions:
  - `node_modules/`, `**/node_modules/`
  - `.vite/`, `**/.vite/`
  - `dist/`, `**/dist/`, `build/`, `**/build/`, `coverage/`, `**/coverage/`, `*.tsbuildinfo`
  - `.cache/`, `**/.cache/`, `.tmp/`, `**/.tmp/`
  - `.env`, `.env.*` (with `!.env.example`, `!.env.test.example`)
  - logs, runtime data, local agent state, OS/IDE metadata, local backup copies
- Does **NOT** exclude: package.json, package-lock.json, workspace `package.json` files,
  `backend/`, `frontend/`, `shared/`, `local-agent/`, `database/migrations/`, `railway.toml`,
  or any production config.

## Context verification (local ignore simulation, no deploy)

Applied `.railwayignore` with gitignore-style semantics against the full repository tree:

| Check | Result |
|------|--------|
| node_modules (any workspace) excluded | YES |
| .vite anywhere excluded | YES (all `.vite` dirs live under `**/node_modules/`) |
| dist excluded | YES |
| coverage excluded | YES (pattern present; none outside node_modules) |
| .env excluded | YES |
| source preserved (backend/src, shared/src) | YES |
| local-agent preserved | YES |
| package.json preserved | YES |
| package-lock.json preserved | YES |
| railway.toml preserved | YES |
| migrations preserved | YES |

Confirmed in the tree: no `.vite` directory exists outside a `node_modules/` path, so every
Vite cache is covered by the `**/node_modules/` exclusion. `frontend/node_modules/.vite` is
excluded from the build context, removing the EBUSY trigger.

## Local validation (no application-source modification)

- `npm run typecheck` → PASS (all workspaces: backend, frontend, local-agent, shared)
- `npm run build --workspace @codeconclave/shared` → PASS
- `npm run build --workspace @codeconclave/backend` → PASS

No deployment performed in this gate.

## Gate summary

```
RAILWAY_IGNORE_CONFIG  = PRESENT  (.railwayignore)
NODE_MODULES_EXCLUDED  = YES
VITE_CACHE_EXCLUDED    = YES
DIST_EXCLUDED          = YES
ENV_EXCLUDED           = YES
SOURCE_FILES_PRESERVED = YES
LOCKFILE_PRESERVED     = YES
RAILWAY_TOML_PRESERVED = YES
CONTEXT_EBUSY_RISK     = REMOVED
TYPECHECK              = PASS
BUILD                  = PASS
DEPLOYMENT             = BLOCKED  (awaiting separate go-ahead)
```

## Next step

On explicit go-ahead, run exactly one clean deployment (same verified config)
to confirm EBUSY is gone and that runtime works. Deployment intentionally has
**not** been performed after this context fix.
