# CODECONCLAVE FRONTEND FAILURE DIAGNOSTIC

- **Deployment examined:** `5183be32-48c4-4f7e-8dc5-c05cd8264d7e` (the ONLY frontend deploy so far)
- **Transport:** `railway up -p 82dd1698... -s 1041fc15... -e 2957bdcd...` then `logs --build <id>` / `logs --deployment <id>` / GraphQL serviceInstance query
- **Date:** 2026-08-30

## Build result
- **Build:** **FAIL**
- Log tail:
  ```
  copy . /app
  ...
  npm install
  ...
  npm run build --workspace @codeconclave/frontend
  npm error No workspaces found: --workspace=@codeconclave/frontend
  ```
- **Root cause (confirmed):** The frontend service's **Root Directory is `/frontend`**. Railpack pulls **only** the Root Directory content into the build container (`copy . /app` where `.` = `/frontend`). The shared npm-workspace root (`package.json` with `workspaces` + `package-lock.json`) lives at the repo root `/`, which is **not present** in the frontend build container. Therefore `--workspace @codeconclave/frontend` cannot resolve → BUILD_FAILURE.

## Deploy matrix (actual vs expected)
| Field          | Actually used                       | Expected                 | Match |
|----------------|-------------------------------------|--------------------------|-------|
| Build          | `npm run build --workspace @codeconclave/frontend` | same (from toml) | PASS (command correct, but CWD wrong) |
| Start command  | `node server.js`                    | `node server.cjs`        | FAIL (stale; server.js ABSENT) |
| Healthcheck    | `null`                              | `/`                      | FAIL (not applied) |
| server.cjs     | PRESENT in repo                     | PRESENT                  | PASS |
| server.js      | ABSENT in repo                      | ABSENT                   | PASS (start cmd wrong) |

Note: `frontend/railway.toml` build keys DID apply (`builder=RAILPACK`, `buildCommand` present in manifest), but `deploy.startCommand` / `healthcheckPath` did **not** override the persisted service settings. This is a secondary config-as-code override issue distinct from the primary build failure.

## Failure classification
- **PRIMARY:** **BUILD** — `npm error No workspaces found` (Root Directory `/frontend` ≠ workspace root `/`).
- **SECONDARY (must fix before a healthy start):** **CONFIG/START + HEALTHCHECK** — start must be `node server.cjs`, healthcheck `/`.

## Smallest safe fix (configuration-only) — APPLIED 2026-08-30
`railway environment edit --service-config frontend source.rootDirectory "/"` was attempted first but the CLI returned **"No changes to apply"** for every key (even genuine diffs) in this environment, so the CLI `environment edit` mechanism is non-functional here. The fix was applied instead via the Railway public GraphQL API `serviceInstanceUpdate` (the same service-config the dashboard/CLI edits), targeting ONLY the frontend service instance `c19b4bb9-a3f9-4a05-82c4-44977783cfe0`:

- `rootDirectory: "/"` (was `/frontend`)
- `builder: RAILPACK`
- `buildCommand: "npm run build --workspace @codeconclave/frontend"`
- `startCommand: "node server.cjs"` (was stale `node server.js`)
- `healthcheckPath: "/"`, `healthcheckTimeout: 300`
- `restartPolicyType: ON_FAILURE`, `restartPolicyMaxRetries: 10`
- `dockerfilePath` left null

Verified persisted via GraphQL (`serviceInstance` query): all above set correctly. Backend service instance `aa4265f5` unchanged; worker untouched. Backend stays LIVE and untouched.

## Dockerfile-inheritance determination (DOCKERFILE_INHERITANCE = CONFIRMED — CORRECTION 2026-08-30)
**The earlier "DOCKERFILE_INHERITANCE = NO" determination was WRONG and is corrected here.**

Deployment `ad97ce66-4057-48e2-b2ef-a14082894f45` (the single APPROVED deploy) produced a manifest with:
```
build: {
  buildCommand: "npm run build --workspace @codeconclave/frontend",
  builder: "DOCKERFILE",
  dockerfilePath: "/Dockerfile"
}
```
With Root Directory `/`, Railway **auto-detected the root backend `/Dockerfile`** and built with DOCKERFILE, overriding BOTH the persisted service-instance `builder: RAILPACK` AND the config-as-code `frontend/railway.toml` `builder="RAILPACK"`. The docs statement "Railway will always build with a Dockerfile if it finds one" WINS over the RAILPACK setting for a service whose root directory exposes a Dockerfile. My earlier evidence (backend uses config-as-code builder) was misapplied.

**Actual outcome (from deploy logs, once):** the backend Docker image was built; then the frontend `deploy.startCommand` = `node server.cjs` ran inside that *backend* image and crashed repeatedly: `Error: Cannot find module '/app/server.cjs'` (crash loop → would be STARTUP_FAILURE). The deployment was **cancelled via GraphQL `deploymentCancel`** before settling; status → `REMOVED`. Frontend URL returns 404 (offline, safe). The incorrect backend Dockerfile did NOT remain running as the frontend.

## Root cause restated
- Frontend Root Directory = `/` makes the shared repo (including root `railway.toml` AND root `Dockerfile`, both backend's) the build scope.
- Railway discovers `/Dockerfile` → `builder: DOCKERFILE` regardless of RAILPACK config → builds the backend image, which has no `server.cjs`.
- Root `railway.toml` (`builder="dockerfile"`) also belongs to the backend and is now within the frontend's config scope.

## Next safe frontend strategy (evaluated, NOT implemented)
Chosen: **OPTION A — dedicated frontend Dockerfile + correct Railway frontend configuration.**
A frontend-specific Dockerfile (its own build context/root) that:
- builds the frontend from the monorepo root when workspace resolution is needed (context must include root package.json/lockfile),
- runs `node server.cjs`,
- exposes port 8080,
- does NOT rely on `builder: RAILPACK` (since that loses to Dockerfile auto-detect) — instead sets the frontend service to an explicit Docker build pointing to the FRONTEND dockerfile path, or isolates the frontend root so the backend Dockerfile is not auto-detected,
- avoids touching the LIVE backend (deployment `575c2d1b`) and its `/Dockerfile` + root `railway.toml`.
Exact implementation deferred pending approval (source/Dockerfile changes require approval per policy).


## Deployment status
- **Deployment:** **BLOCKED** (no second frontend deploy without explicit approval)
- **Backend:** **LIVE** (`https://backend-production-95faa.up.railway.app`, deployment `575c2d1b`, Docker) — NOT redeployed, NOT modified.
