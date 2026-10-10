# PHASE 33 — HYBRID COWORKER INTEGRATION SPRINT

### Cross-surface user journeys: Web → paired device → real files/terminal → Workbench; browser + desktop automation; live preview; unified action runtime

Scope of this pass: surface the **unified action runtime** in the product UI (the last missing
cross-surface cockpit), verify it against the real backend contract, and re-run the focused
frontend suite. No deploy, no commit, no push, no prod config/secret/payment/auth changes.

---

## A. Current working-tree and branch state

- Branch: `temporary-demo-mode`
- HEAD: `9a4b33b` ("fix(execution): heartbeat the task during a long stage…") — **NOT deployed**.
- Deployed commit on Render: `96b4241` (older than HEAD).
- This pass touched only frontend files (see section L). No backend, no config, no `render.yaml`.

## B. Demo OAuth status — **WORKING (customer OAuth absent)**
- `LoginPage.tsx` / `RegisterPage.tsx` import only `../auth/AuthProvider`; no provider OAuth buttons.
- Prior pass: `entry-auth.test.tsx` 12/12, `AuthProvider.test.tsx` 18/18 — unchanged this pass.

## C. Demo payment status - **WORKING (payment UI absent from demo bundle; backend intact)**
- `vite.config.ts` aliases `./components/PaymentGateModal` → `components/paymentGateStub.tsx` (renders `null`) when `demoBuild`.
- `App.tsx` renders `PaymentGateModal` only when `!mode.temporaryDemoMode`.
- `SettingsPage.tsx` gates billing on `!__DEMO_BUILD__`. `DemoPaymentActivatePage.tsx` defined but never routed. Admin `/admin/payments` intact.
- Unchanged this pass.

## D. Web → local-workspace workflow — **WORKING (cockpit), deployment-conditional**

- `LocalWorkspacePanel` is wired into the Workbench `Local` bottom tab (`WorkbenchPage.tsx:569-576`).
- Deployed to the demo only when `LOCAL_EXECUTION_ENABLED` is on AND a real device is paired; the bridge routes themselves (`app.ts:313`) are only `requireAuth` + `paid` and forward to the paired agent.
- `LocalWorkspacePanel.test.tsx` 6/6 this pass (device list/ONLINE, offline state, browse→open→edit→save→diff, authorized exec + exit code, policy denial, mid-action offline).

## D2. Unified action-runtime cockpit - **WORKING (new this pass), gated OFF in prod**

- **New UI**: `frontend/src/components/ActionRuntimePanel.tsx` renders the real catalogue from
  `GET /api/v1/actions/surfaces` and routes one action via `POST /api/v1/actions`.
- Wired into `WorkbenchPage.tsx` as the new bottom tab **Actions** (`BottomTab` now includes `'actions'`).
- The panel is honest by construction:
  - It renders the server's `enabled` flag and each surface's `enabled`/`reason` verbatim — it never enables a surface.
  - Submit is disabled when the runtime is off, when the selected surface is disabled, or when no title is set.
  - A server refusal (e.g. `unified_action_runtime_disabled`, 503) is displayed verbatim; no optimistic/fake success.
  - On success it shows the real routed surface/executionMode and the created task id, pointing the operator at the Task/Audit tabs.
- Per-surface instruction builder is contract-exact (verified against backend):
  - LOCAL → `{ command }`
  - BROWSER → `{ type:'browser', grants: { capabilities:[<op→cap>], allowedOrigins:[origin] }, actions: [{ op, url|selector|query }] }`
  - DESKTOP → `{ type: 'desktop', grants: { capabilities: [cap] }, actions: [{ op, app?/title? }] }`
  - CLOUD sends no `localInstruction`.
- Op→capability maps match `backend/src/modules/agent/browser-policy.ts` `BROWSER_OP_TO_CAPABILITY`
  and `desktop-policy.ts`: navigate→browser.navigate, open→browser.open, read→browser.read,
  inspect→browser.inspect, search→browser.read; list_windows→desktop.inspect,
  open_app→desktop.open_app, focus_window→desktop.focus_window.
- Payload fields match `backend/src/modules/actions/routes.ts:32-48` (`projectId,title,description?,surface,deviceId?,localInstruction?`).

## D2.1 Backend contract (verified, unchanged this pass)
- `GET /api/v1/actions/surfaces` → `{ enabled, surfaces: ActionSurfaceView[] }` (`routes.ts:21-26`, `contract.ts:77-94`).
- `POST /api/v1/actions` → 201 `{ surface, executionMode, task }` (`routes.ts:28-49`).
- Disabled runtime → `AppError.unavailable('unified_action_runtime_disabled', …)` → 503 (`service.ts:104-107`).
- Disabled surface → `AppError.unavailable('<surface>_surface_disabled', …)` (`service.ts:111-113`).
- Device must be `PAIRED` and owned (`service.ts:59-65`).

## E. LOCAL execution lifecycle — **WORKING (backend), gated OFF in prod**
- Unchanged this pass; backend focused regression 190/190 in the prior pass (local-workspace,
  actions, agent browser/desktop/dispatch, execution/policy, etc.). No backend files touched here.

## F. Browser automation — **WORKING (backend + agent), gated OFF; NEW UI surfacing**
- Backend `parseBrowserInstruction` (deny-by-default grants/origins/op), agent bridge already handle it.
- Now reachable from the Workbench Actions tab (surface BROWSER) with a granted origin. Still requires
  `BROWSER_CONTROL_ENABLED=true` + a paired device; the panel refuses otherwise and shows the reason.

## G. Desktop control — **PARTIAL → now UI-surfaced; gated OFF**
- Previously no UI. The Actions tab now exposes DESKTOP (list_windows/open_app/focus_window) with the
  same deny-by-default posture; open_app is still restricted to `DESKTOP_ALLOWED_APPS` server-side.
- Remaining limitation: still OFF in prod, so live demo of desktop from the Actions tab is not possible without enabling the gate.

## H. Live preview — **NOT CONFIGURED**
- `previewConfigured()` = `PREVIEW_BUILD_ENABLED==='true' && PREVIEW_BUILD_COMMAND` (`modules/preview/service.ts:68-70`).
- Neither is set in `render.yaml`; defaults false/unset → honest `NOT_CONFIGURED`. Unchanged this pass.

## I. Unified action runtime — **WORKING (backend), gated OFF; NEW cockpit UI**
- As D2. This was the Phase 32 gap ("backend only, no UI"). Closed.

## J. Exact E2E steps and results (this pass)
1. Rewrote `frontend/src/components/ActionRuntimePanel.tsx` (previous write was truncated/corrupt) — complete, tsc-clean.
2. Verified the panel's assumed contract against `actions/routes.ts`, `contract.ts`, `service.ts`,
   `browser-policy.ts`, `desktop-policy.ts`, `shared/src/constants.ts`. All match.
3. Added `ActionRuntimePanel.test.tsx` → **7/7 pass** (surfaces+reasons, runtime-disabled refusal,
   CLOUD route, LOCAL command+device, BROWSER granted-origin, server refusal, disabled-surface block).
4. Wired the panel into `WorkbenchPage.tsx` as the `Actions` bottom tab.
5. Added a Workbench integration test: clicking the `Actions` tab mounts the runtime and shows the
   disabled LOCAL surface → **WorkbenchPage.test.tsx 5/5 pass**.
6. `tsc --noEmit -p frontend\tsconfig.json` → **clean**.
7. Re-ran adjacent suites individually (combined multi-file runs flake with
   `Unknown: ChildProcess.kill` on this box): LocalWorkspacePanel **6/6**, App **10/10**.

## K. Test totals and failures (this pass)
- ActionRuntimePanel 7/7; WorkbenchPage 5/5; LocalWorkspacePanel 6/6; App 10/10 → **28/28 passing, 0 failures**.
- Frontend typecheck: clean.
- Backend: not re-run this pass (no backend changes); prior-pass focused regression 190/190 stands.
- Prior-pass auth/demo suites (54/54) unchanged and unaffected.

## L. Files changed (this pass)
- `frontend/src/components/ActionRuntimePanel.tsx` (new, rewritten cleanly)
- `frontend/src/components/ActionRuntimePanel.test.tsx` (new, 7 tests)
- `frontend/src/pages/WorkbenchPage.tsx` (modified: import, `BottomTab`, tab entry, render branch)
- `frontend/src/pages/WorkbenchPage.test.tsx` (modified: stub routes + Actions-tab integration test)
- `PHASE33_HYBRID_COWORKER_MASTER_REPORT.md` (this file)
- (from prior pass, still uncommitted) `LocalWorkspacePanel.tsx`/`.test.tsx`, `PHASE30/31/32` reports

## M. Known limitations
- No real paired device on this box: local-workspace/browser/desktop journeys are verified against
  stubbed/local contracts, not a live end-to-end run. Mark E2E steps PARTIAL/NOT VERIFIED in the demo.
- `UNIFIED_ACTION_RUNTIME_ENABLED`, `LOCAL_EXECUTION_ENABLED`, `BROWSER_CONTROL_ENABLED`,
  `DESKTOP_CONTROL_ENABLED`, `LIVE_PREVIEW_ENABLED` remain default OFF and unset in `render.yaml`;
  nothing here enables them. The CLOUD demo is unaffected.
- Live preview remains NOT CONFIGURED (no `PREVIEW_BUILD_COMMAND`).
- Combined multi-file vitest runs are unreliable in this environment; run test files individually.
- Node is not on PATH; used `…\codex-primary-runtime\dependencies\node\bin\node.exe` (v24.19.0).
- `AGENTS.md` does not exist at the repo root; per the phase rule it was not created. Portable
  procedure instead: (1) `where.exe node`; (2) verify `node --version`/`npm --version`; (3) if
  missing, locate a working runtime and add its bin dir to PATH for the current process only;
  (4) record version/location. Test command: `node <repo>\node_modules\vitest\vitest.mjs run <files>`
  from the package dir; typecheck: `node <repo>\node_modules\typescript\bin\tsc --noEmit -p <pkg>\tsconfig.json`.

## N. What to demonstrate to Kuberns
- The CLOUD path (default, enabled): project → task → coworker runs → verification → audit.
- The Workbench `Actions` tab: the honest surface catalogue (CLOUD enabled; LOCAL/BROWSER/DESKTOP
  show `disabled` with the exact disabling flag) — proving the product tells the truth about what is
  and isn't enabled rather than faking it.
- The `Local` tab cockpit (renders even when no device is paired) as the local-workspace entry point.
- Do NOT claim live local/browser/desktop execution unless those env flags and a paired device are
  set up beforehand.

## P. Temporary demo auto-login — direct sign-in (this pass)
Directive: for the demo, remove Register + payment and open the app straight into the workspace with
no email, no password, no registration.

### P.1 Backend
- `backend/src/modules/auth/service.ts`: new `demoLogin()` + `DEMO_ACCOUNT_EMAIL = 'demo@codeconclave.app'`.
  Gated by `temporaryDemoModeEnabled()` (imported from `modules/entitlements/service.js`).
  - Flag OFF → throws `AppError.notFound()` (404) and writes NOTHING (no user, no session).
  - Flag ON → signs into the single dedicated demo account, issues a real session, audits
    `AUTH_LOGIN` with `via: 'temporary_demo_autologin'`.
- `backend/src/modules/auth/routes.ts`: new route `POST /api/v1/auth/demo-login`.

### P.2 Frontend
- `frontend/src/auth/AuthProvider.tsx`: on `/auth/me` 401, attempts `POST /api/v1/auth/demo-login`
  once per provider instance (ref guard). On success sets authed; on 404 falls through to anonymous.
- `frontend/src/App.tsx`: `DemoEntry` gate redirects `/`, `/login`, `/register` → `/home` when
  `__DEMO_BUILD__` && authed. Non-demo builds pass through unchanged.

### P.3 Safety invariants (preserved)
- Flag defaults OFF; production auth path untouched. No client-side switch: the flag token is never
  read in frontend code (invariant `temporary-demo-mode.test.ts` passes; offending comment reworded).
- API-key gate untouched; RLS/permission/attempt-fencing untouched.
- Auto-login only ever touches the one fixed demo account — never an arbitrary user.

### P.4 Tests (this pass)
- Backend `demo-login.test.ts` **5/5** (flag OFF→404 & zero writes; non-true values→OFF; flag ON→session+user;
  only-demo-account; idempotent sign-in).
- Frontend `AuthProvider.test.tsx` **20/20** (2 new: auto-sign-in on 401; refusal stays anonymous).
- `temporary-demo-mode.test.ts` **33/33**; `App.test.tsx` **10/10**. Backend + frontend `tsc` clean.

### P.5 Caveat
- Has effect only on a build with `VITE_DEMO_BUILD=1` + `TEMPORARY_DEMO_MODE=true`. The live Render
  commit `96b4241` does NOT include this until someone deploys — auto-login will not appear on
  `codeconclave-api.onrender.com` yet.

### P.6 Local Postgres (blocked)
- Cannot install a Postgres with `pgvector` here: no admin rights; no server/service (port 5432 free);
  `winget`/`choco` need elevation; no bundled `vector.dll`; migrations (`0001_extensions.sql`) require
  `CREATE EXTENSION vector` + `pg_trgm`. Recommended route: a free cloud Postgres with pgvector
  (Supabase/Neon) provided as `DATABASE_URL`, then create `.env`, run migrations, start
  `dev:backend` (:4000) + `dev:frontend` (:5173).

## O. Final GO / NO-GO
- **CLOUD demo: GO.** No demo-affecting behavior changed; the Actions tab degrades honestly when the
  runtime is disabled.
- **Local / browser / desktop / live-preview live demos: NO-GO until their flags are enabled and a
  device is paired** (unchanged from Phase 32).
- **Release: NO.** HEAD `9a4b33b` + this uncommitted pass are not deployed; nothing was committed,
  pushed, or deployed. Stopping for review as instructed.
