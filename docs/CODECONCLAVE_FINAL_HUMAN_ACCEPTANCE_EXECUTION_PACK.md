# CodeConClave — Final Human Acceptance Execution Pack

Regenerated during Prompt 5/5 after a file-recovery event; content re-derived
from verified session evidence. Every Step below is a HUMAN step: run, observe,
record. Nothing auto-passes.

INSTALLER SHA256 (current build, rebuilt 2026-09-10):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`

## Settings / setup

- Make sure ONE canonical origin is the release URL. Every environment value is
  set there: `GOOGLE_REDIRECT_URI` = that origin + `/api/v1/auth/google/callback`;
  `CORS_ORIGINS` = only that origin; `AUTH_COOKIE_DOMAIN` = that host;
  `SESSION_COOKIE_SECURE=true`. For local acceptance the canonical origin is
  `http://localhost:5173` and the same layout repeats at release time.
- Check `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are from the Google Cloud
  Console project for that origin and that the redirect URI is registered.
- Payment: keys are server-side only. All payment tests with Razorpay TEST keys;
  live charge only for the one PRODUCTION_PAYMENT gate test.
- The desktop app MUST point to the same backend origin as the web app.

## Roles in this pack

- FOUNDER — performs every gate, provides evidence, signs the pack.
- AUTOMATION — may run, in order, the verified automated pre-flight only
  (156/2850/11/0 backend, 74/408/0 frontend, 5/58/0 desktop, 19 smoke files 411,
  secret scan 855 files 0 findings, migrations 76/76, payment proof 16/16,
  payments regression 134/3/0) and may NEVER mark a human gate PASS.
- REVIEWER — reviews evidence against the gate's PASS conditions.

## The gates (objectives, with evidence targets; full step lists live in the
   workbooks and per-gate conflict docs)

### Stage 1 — GOOGLE_OAUTH_LOGIN (Gate 1)
Perform a real Google sign in on the canonical origin. Sign out, sign in again.
Deny-consent path. New-account onboarding (display name, role, primary use
case). Refresh. Logout/login. Cross-browser: second hostname/browser profile,
same backend. Evidence: screenshots, console/server logs, what the app showed
after each step (never tokens or secrets). PASS when single-origin login works
on both clients and no silent cross-host mismatch.

### Stage 2 — PRODUCTION_PAYMENT (Gate 2)
On the canonical origin, start a paid checkout. Confirm the correct hosted link.
Complete payment personally. Return. Confirm evidence is detected, correct plan
granted exactly once, reservation preserved, replay rejected, dashboard shows
the entitlement, and no credentials are exposed. Payment reference + dashboard
before/after + entitlement state are evidence. NEVER card/bank/OTP or secrets.

### Stage 3 — WINDOWS_INSTALL (Gate 3)
Prerequisite artifact:
(SHA256 `52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`,
`desktop/release/CodeConClave Setup 0.1.0.exe`).
Verify the SHA256. Install. Launch. Restart-launch. Uninstall. Reinstall.
No silent failures. See CODECONCLAVE_WINDOWS_INSTALL_ACCEPTANCE.md for the full
checklist. Pass only on a real Windows machine with the real bundled installer.

### Stage 4 — OFFLINE_MODE (Gate 4)
Launch + sign in. Start a task/workflow. Disconnect the network. Expect ONE
offline/reconnect state (no crash, no data loss, no silent queued writes).
Reconnect and confirm the task resumes without duplication or corruption.
Close/reopen while offline and confirm graceful recovery.

### Stage 5 — PROVIDER_REPROBE (Gate 5)
Open the provider status surface on the canonical origin and re-probe each
configured provider. Evidence must match the honest ledger: google HEALTHY,
qwen HEALTHY, nemotron HEALTHY; openai QUOTA_EXHAUSTED (429), deepseek
QUOTA_EXHAUSTED (billing), anthropic OFFLINE (bad request), gemma OFFLINE
(unreachable); grok REQUIRES_REAUTH, kimi REQUIRES_REAUTH; mistral/north/
ox_alpha/z_code_5_3 NOT_CONFIGURED; manus + devin EXTERNAL_AGENT never
auto-run; big_pickle NOT_INTEGRATED. No keys/auth headers in evidence.

### Stage 6 — WEB_E2E (Gate 6)
Run the 35-step web flow in CODECONCLAVE_WEB_ACCEPTANCE_WORKBOOK.md. Real AI
chat where a valid provider exists; streaming, conversations, model selection,
routing/fallback, attachments, multimodal/image input where configured, image
generation only if real, AI Coworkers with real task tracking, Control Plane,
projects/tasks/memory/continuity, files/workspace, terminal/runtime where
permitted, connections, permissions/security, activity/audit, rolling usage,
settings/profile, error states, no secrets in UI, payment unchanged, no critical
console errors.

### Stage 7 — DESKTOP_E2E (Gate 7)
Run the 30-step desktop flow in CODECONCLAVE_DESKTOP_ACCEPTANCE_WORKBOOK.md on
the installed app, linking (5) same backend as Web: installer launch/install/
start/restart, auth against same backend, onboarding, Home, AI chat, streaming,
conversations, named conversations, model/provider selection, AI Coworkers,
projects/tasks/memory, Control Plane, files/workspace, terminal/runtime where
permitted, permissions/approvals, activity/audit, settings/profile, error
states, secrets not in renderer/preload, restart preserves state, offline
accept/reconnect/reopen recovery, no Electron errors. Also inside this stage:
the cross-cutting Windows checks (shutdown at exit, no lingering service).

### Stage 8 — WEB_DESKTOP_PARITY (Gate 8)
Run the same sensitive flows on the Web client AND the desktop client, same
account/backend. Same data/project/task/memory visible in both. Same AI/routing
behavior. Same entitlement. Desktop is NOT a separate product.

### Stage 9 — FULL_PRODUCT (Gate 9)
Aggregate sign-off documented in CODECONCLAVE_FULL_PRODUCT_ACCEPTANCE_WORKBOOK.md.
Passes ONLY when Stage 6, Stage 7, and Stage 8 are all PASS.

## Acceptance automation (Prompt 6) — run daily, read-only

- `backend` (run in `C:\Users\sride\CodeConClave-\backend`):
  - Preflight: accepted origins + provider keys present + canonical origin:
    `npm run acceptance:preflight`
  - OAuth-ready preflight (never prints secrets):
    `npm run acceptance:oauth:preflight`
  - Human-gate status (reads `docs/CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json`,
    prints per-gate status; RELEASE_READY derives ONLY from evidence):
    `npm run acceptance:status`
  - Provider re-probe (live, honest, never auto-creates tasks, does not persist
    NOT_CONFIGURED/LIMITED/BLOCKED states):
    `npm run provider:reprobe`
- Scripts: `backend/src/scripts/acceptance-preflight.ts`,
  `backend/src/scripts/acceptance-status.ts`,
  `backend/src/scripts/provider-reprobe.ts`.
- Rules: never loosen `acceptance:status` logic; NEVER patch a grep line into a
  "PASS"; human gates stay HUMAN_REQUIRED until the founder records evidence in
  `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` AND `.json`.

## Exit criteria

1. All nine gates PASS with real founder evidence in the evidence md + json.
2. The final acceptance status engine reports
   `HUMAN_ACCEPTANCE_COUNT = 9 / 9` and `RELEASE_READY = YES`.
3. The installer SHA256 matches the exact file installed.
4. No secrets anywhere.