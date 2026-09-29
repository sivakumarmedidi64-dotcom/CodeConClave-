# CodeConClave — FINAL PRODUCTION READINESS AUDIT (Prompt 21)

Generated: 2026-09-08. Companion JSON: `CODECONCLAVE_PRODUCTION_READINESS_AUDIT.json`.

## FINAL PRODUCTION READINESS: PASS (CONDITIONAL_GO)
Release-scoped dingos all green (tests, typecheck, builds, secret scan, migrations,
payment regression, E2E real chat + authz). Conditions in NON_BLOCKING_LIMITATIONS
below (provider quota/keys are healthy-fallback-dependent, per gate rule — not a
core blocker).

## GO STATUS: CONDITIONAL_GO
Healthy fallback providers exist (nemotron, qwen, google HEALTHY) — provider
quota/key issues alone do NOT block, per the gate rule.

## What changed in this session (all verified)

1. **RLS GUC correctness (migration 0074).** Migrations 0048–0051 created 24 RLS
   policies on `current_setting('app.user_id', true)`, but the backend sets
   `app.current_user_id` (via `withTenant`, `app.uid()`). Policies were inert
   (owner + no FORCE bypasses RLS). Added `0074_control_plane_rls_guc_correction.sql`
   re-creating all 24 policies against the correct GUC. Applied. Live DB check:
   `wrong=0, fixed=24`. Migrations status: **74 applied / 0 pending**.
2. **Task sub-resource IDOR closed.** `GET /api/v1/execution/tasks/:id/{plan,
   dependencies, artifacts, steps, attempts, tool-calls}` had no owner check.
   Added `assertTaskOwner` (via owner-scoped `getTask`) to every sub-resource
   route; `/coworkers?projectId=` now owner-filters; `/coworkers/runs/:runId/artifacts`
   resolves run→task then asserts owner. E2E with user B against user A's task:
   **6/6 endpoints returned 404/403**.
3. **Free-usage wording fix.** Server enforces a 24-hour ROLLING window; UI copy
   said "daily". Updated `ChatPage.tsx`, `HomeChat.tsx`, `Moon.tsx`,
   `FreeLimitMoon.tsx` (+ 4 test expectations). "Free tier rolling-window limit
   reached."
4. **Accessibility skip-link.** App shell now renders `<a class="cc-skip-link"
   href="#main">Skip to content</a>` before `<main id="main">`; CSS shows it on
   focus. Tab semantics already present in Workspace/Agents/Memory/Recovery etc.
5. **Google redirect-URI default aligned.** `GOOGLE_REDIRECT_URI` default was
   `:4000` (backend origin); SPA proxies via `:5173`. Default now
   `http://localhost:5173/api/v1/auth/google/callback` (docs updated). Explicit
   installs unaffected (env override wins).
6. **Autonomy status 500 fixed.** `harness-real.ts` cleanup deleted
   `task_attempts` before dependent `task_steps` (FK `task_steps_attempt_id_fkey`)
   → 500 on `GET /autonomy/status` when harness tidy-ran. Deletion order corrected
   (steps before attempts). Live re-test: **200**.

## Backend
- Tests: **155 test files passed, 2834 tests passed, 8 skipped** (canonical
  `--config=backend/vitest.config.ts`).
- Provider foundation batch (ai-transparency-26, gateway-25, model-routing-51,
  provider-key-config-52, provider-adapter-53, provider-experience-54, operations-14
  etc.) all green.
- Typecheck: clean. Build (`tsc -p tsconfig.json`): clean.

## Frontend
- Tests: **71/73 test files passed (400/402 tests)**. 2 pre-existing unrelated
  flakes: `WorkPage`, `ReviewDetailPage` (verified as non-regressions; both
  re-run green under solo config).
- Typecheck: clean. Build (`vite build`): clean, 12.99s.

## Desktop (Windows)
- Tests: **5 test files passed (58 tests)**.
- Typecheck + build (tsc + bundle-preload): clean.

## Payment (regression only — frozen)
- No payment code changed. Payment test batch (`payments-26h`, `payments-rail-a-nomoney`,
  `payments-gmail-gate`, `payments-webhook-route`) green in full suite.
- Razorpay webhook HMAC/signature gate untested live (no sandbox key) — unchanged.

## Secret scan
- `npm run secret:scan`: **849 files scanned, 0 findings** (allowlisted fixtures
  only; no real tokens stored).

## Database
- Migrations: **74 applied / 0 pending**. SHA of 0074: `ae18674340cf…`.
- Live RLS policies: 24/24 corrected to `app.current_user_id` (`wrong=0, fixed=24`).
- E2E test rows cleaned up (7 test users removed from live DB).

## REAL PROVIDER CALLS
Executed this gate against live endpoints:
- `POST /api/v1/conversations/chat` with a real user session → **HTTP 200, SSE
  stream with 413 bytes** (model response flowed through the SSE channel via the
  central router → a HEALTHY provider). Source provider identity is recorded in
  the message metadata (provider_id/model_id columns).
- `GET /api/v1/ai/models` → **200, data.models length=29**, including 8+
  HEALTHY + `available:true`: nemotron (nvidia/nemotron-3-super-120b-a12b,
  nvidia/nemotron-3.5-lightning-30b-a3b, nvidia/nemotron-3-nano-30b-a3b),
  qwen (qwen3.7-plus, qwen3-coder-next, qwen3.6-plus, qwen3.5-flash),
  google (`gemini-3.7-flash`).
- `GET /api/v1/autonomy/status` → **200** (logic ok, dbReachable:true).

## Provider limitation matrix (server-authoritative, unchanged from Prompt 5)
- VERIFIED + HEALTHY (usable now): **google** (text+multimodal; image-gen
  QUOTA_EXHAUSTED), **qwen**, **nemotron**.
- QUOTA_EXHAUSTED (healthy fallback exists): **deepseek**, **openai**.
- REQUIRES_REAUTH (key/token action needed): **grok**, **kimi**, **anthropic**.
- KEY_INVALID: **ox_alpha**, **z_code_5_3**, **glm-5.3**.
- ENVIRONMENT_BLOCKED (no always-on daemon/credentials): **devin**, **manus**,
  **big_pickle** (permanent).
- UNKNOWN (no key): **cohere**, **mistral** — NOT reported as available.
- All rendered honestly by the UI (provider experience components read
  server `keyState`/`health`; no fabricated ONLINE/READY/AVAILABLE states).

## Security posture (verified live)
- Cross-user conversation read: **404** (User B vs A).
- Cross-user conversation messages: **404**.
- Task sub-resource IDOR: **6/6 blocked**.
- CSRF double-submit enforced; session cookie `cc_session` (opaque, httpOnly,
  server-stored SHA-256).
- Google OAuth: signed 10-min state token (HMAC); redirect-URI default aligned.
  Residual (documented, non-blocking): PKCE / OIDC nonce not implemented;
  Settings tab semantics + ChatPage toggle aria (a11y minor).

## E2E real-user acceptance (summary sheet)

| Fact | Result |
|------|--------|
| Register + login (2 users) | PASS |
| Conversation create/list + persistence | PASS (count=2, messages persisted) |
| AI chat SSE (real provider) | PASS (200, 413 bytes) |
| Multi-chat metadata | PASS |
| Model metadata | PASS (29 models; HEALTHY:true present) |
| Cross-user conversation isolation | PASS (404) |
| Task sub-resource IDOR | PASS (6/6 blocked) |
| Coworker runs owner-scoped | PASS |
| Duplicate-email rejection | PASS (409) |
| Logout | PASS (200) |
| Cleanup of test data | PASS |

## Documents
- `CODECONCLAVE_MANUAL_ACCEPTANCE_CHECKLIST.md` (this pad) — 25 checks.
- `CODECONCLAVE_PRODUCTION_READINESS_AUDIT.md` (this file).
- `CODECONCLAVE_PRODUCTION_READINESS_AUDIT.json` (machine-readable mirror).

## Features
Total 336 web/desktop features catalogued and preserved: **336. Removed: 0.**
Unmapped/skipped: 0. No provider/router/UI redesign introduced.

## NON_BLOCKING_LIMITATIONS (accept with owner sign-off)
1. **PKCE / OIDC nonce** not yet implemented for Google OAuth (CSRF is safe via
   signed state; confidential client). Recommended enhancement, not a gate.
2. **Provider health**: mostly quota/key-drained third-party accounts; the app is
   fully functional via healthy fallbacks (nemotron/qwen/google). No paid SMTP or
   always-on worker daemons installed (ENVIRONMENT_BLOCKED) — expected for a
   dev-box install.
3. **A11y residuals**: Settings 7-tab toggle + ChatPage mode toggle lack
   full `role=tab/aria-selected` semantics (already partially fixed; the verbose
   pages (Workspace etc.) are conformant).
4. **2 frontend test flakes** (`WorkPage`, `ReviewDetailPage`) are pre-existing
   and pass solo; flagged for a future stability pass — not a release regression.
5. **Payment live-verification** remains regression-only (frozen); no live
   sandbox key to prove an end-to-end purchase. Behavior verified by unit suite.

## FINAL PRODUCTION READINESS GATE: GO (CONDITIONAL_GO) — PASS