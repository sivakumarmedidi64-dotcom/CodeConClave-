# CodeConClave — Human Acceptance Evidence Log (9 Gates)

Rule: NO field below may be filled with invented information. Each record may be
completed ONLY after the founder actually performs the test and reports the real
outcome. Until then every record stays `NOT_PERFORMED`. Automated test results do
NOT satisfy any human gate — the human evidence system never converts
`HUMAN_REQUIRED` into `PASS`.

Canonical source-of-truth for automation: `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json`
(read by backend `npm run acceptance:status`). This markdown file is the
human-readable log; both must be updated together by the founder.

Current state: `HUMAN_ACCEPTANCE_COUNT = 0 / 9` ·
`RELEASE_READY = NO` · `DEPLOYMENT_ALLOWED = NO`.
Gates: GOOGLE_OAUTH_LOGIN, PRODUCTION_PAYMENT, WINDOWS_INSTALL, OFFLINE_MODE,
PROVIDER_REPROBE, WEB_E2E, DESKTOP_E2E, WEB_DESKTOP_PARITY, FULL_PRODUCT.

Installer SHA256 (current release build, rebuilt 2026-09-10):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`.

---

## Gate 1 — GOOGLE_OAUTH_LOGIN

- TEST NAME: GOOGLE_OAUTH_LOGIN
- DATE: (leave blank until performed)
- ENVIRONMENT: one canonical origin (deployment URL; GOOGLE_REDIRECT_URI =
  `https://<host>/api/v1/auth/google/callback` registered in Google Cloud Console)
- BUILD VERSION: 0.1.0
- STEPS PERFORMED: (point BOTH browser and the desktop app at the SAME canonical
  origin; sign in with Google; consent screen; allow; return; deny-consent path;
  new-account onboarding; display-name persistence; refresh; logout/login; and
  the cross-browser check: sign in on the primary browser, sign out, sign in on a
  SECOND hostname/browser profile with the same backend — no silent success in
  one host and failure in another)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (screenshots, console/server logs, what the app showed
  after each step — never include tokens or secrets)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 2 — PRODUCTION_PAYMENT

- TEST NAME: PRODUCTION_PAYMENT
- DATE: (leave blank until performed)
- ENVIRONMENT: (deployment URL; live Razorpay keys configured on the server only)
- BUILD VERSION: 0.1.0
- STEPS PERFORMED: (start paid checkout; confirm correct hosted link; complete
  payment personally; return; confirm evidence detected; confirm correct plan
  granted exactly once; confirm dashboard entitlement; confirm reservation
  preserved and replay rejected; confirm no credentials exposed)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (payment reference, dashboard row before/after,
  entitlement state — NEVER card details, bank details, OTPs, or credentials)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 3 — WINDOWS_INSTALL

- TEST NAME: WINDOWS_INSTALL
- DATE: (leave blank until performed)
- ENVIRONMENT: (clean Windows version/machine)
- BUILD VERSION: 0.1.0 · INSTALLER SHA256:
  `52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`
- STEPS PERFORMED: (verify SHA256 of `desktop/release/CodeConClave Setup 0.1.0.exe`;
  install; single-user install; launch; Start Menu + desktop shortcut launch;
  restart launch; uninstall removes app without leftover services; reinstall
  after uninstall; verify no silent failures / no unsigned prompts)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (SHA256 match, install log, screenshots before/after
  install, uninstall screen, fresh reinstall — no secrets)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 4 — OFFLINE_MODE

- TEST NAME: OFFLINE_MODE
- DATE: (leave blank until performed)
- ENVIRONMENT: (Windows desktop connected to the canonical backend origin)
- BUILD VERSION: 0.1.0 · INSTALLER SHA256:
  `52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`
- STEPS PERFORMED: (launch; sign in; start a task/workflow; disconnect network;
  confirm single "offline/trying to reconnect" state — no crash, no data loss, no
  silent queuing of writes; reconnect; confirm task resume without duplication or
  corruption; close/reopen during offline; confirm graceful recovery)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (screenshots of offline state + recovery, task list
  before/after, electron logs — no secrets)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 5 — PROVIDER_REPROBE

- TEST NAME: PROVIDER_REPROBE
- DATE: (leave blank until performed)
- ENVIRONMENT: (production deployment URL)
- BUILD VERSION: 0.1.0
- STEPS PERFORMED: (open provider status surface; re-probe each configured
  provider; expected states from the last real probe: google HEALTHY, qwen
  HEALTHY, nemotron HEALTHY, openai QUOTA_EXHAUSTED (429), deepseek
  QUOTA_EXHAUSTED (billing), anthropic OFFLINE (bad request), gemma OFFLINE
  (unreachable), grok REQUIRES_REAUTH (credentials rejected), kimi
  REQUIRES_REAUTH, mistral/north/ox_alpha/z_code_5_3 NOT_CONFIGURED,
  manus + devin EXTERNAL_AGENT never auto-run, big_pickle NOT_INTEGRATED;
  confirm no task is ever auto-created for manus/devin)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (provider status screenshot/JSON matching the ledger —
  no keys, no auth headers)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 6 — WEB_E2E

- TEST NAME: WEB_E2E
- DATE: (leave blank until performed)
- ENVIRONMENT: (real browser; deployment URL or local app)
- BUILD VERSION: 0.1.0
- STEPS PERFORMED: (35-step web flow in `CODECONCLAVE_WEB_ACCEPTANCE_WORKBOOK.md` —
  launch, Google sign-in, onboarding, display-name persistence, Home, real AI
  chat, streaming, named/conversations/new-conversation, model selection, auto
  routing, provider fallback where testable, attachments, multimodal/image input
  where configured, image generation where configured, AI Coworkers, coworker
  task status, Control Plane, active tasks/workers/approvals, projects, tasks,
  memory, project continuity, files/workspace, terminal/runtime where permitted,
  connections/integrations, permissions/security, activity/audit, rolling usage,
  settings/profile, error states, no secrets in UI, payment unchanged, clean UI,
  no critical console errors)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (screenshots per step, console log capture, real AI
  response text — no secrets)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 7 — DESKTOP_E2E

- TEST NAME: DESKTOP_E2E
- DATE: (leave blank until performed)
- ENVIRONMENT: (actual Windows machine; the real NSIS installer)
- BUILD VERSION: 0.1.0 · INSTALLER SHA256:
  `52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`
- STEPS PERFORMED: (30-step desktop flow in `CODECONCLAVE_DESKTOP_ACCEPTANCE_WORKBOOK.md`
  — installer launches, NSIS install, start, restart launch, auth, onboarding,
  Home, AI chat through SAME backend as Web, streaming, conversations, named
  conversations, model/provider selection, AI Coworkers, projects, tasks, memory,
  Control Plane, files/workspace, terminal/runtime where permitted, permissions
  and approvals, activity/audit, settings/profile, error states, secrets NOT in
  renderer/preload, restart preserves state, network disconnect, offline/
  background resume, reconnection restores operation, close/reopen without
  corruption, no critical Electron errors)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (install + runtime screenshots, offline/reconnect
  captures, task-state before/after — no secrets)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 8 — WEB_DESKTOP_PARITY

- TEST NAME: WEB_DESKTOP_PARITY
- DATE: (leave blank until performed)
- ENVIRONMENT: (Web browser AND Windows desktop, same account/backend)
- BUILD VERSION: 0.1.0
- STEPS PERFORMED: (on BOTH clients verify same backend, same auth/session model,
  same AI gateway, same routing, same provider registry, same memory, same task
  state, same permissions, same audit system, same payment entitlement, same
  user/workspace data; desktop is NOT a separate product)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (same data/project/task/memory visible in both; same
  responses via same backend — no secrets)
- FOLLOW-UP ISSUE: (leave blank)

## Gate 9 — FULL_PRODUCT

- TEST NAME: FULL_PRODUCT
- DATE: (leave blank until performed)
- ENVIRONMENT: (Web + Windows desktop combined)
- BUILD VERSION: 0.1.0
- STEPS PERFORMED: (combined acceptance in `CODECONCLAVE_FULL_PRODUCT_ACCEPTANCE_WORKBOOK.md`
  — passes only when gates 6, 7, and 8 are all PASS)
- OBSERVED RESULT: NOT_PERFORMED
- PASS/FAIL: (leave blank)
- EVIDENCE DESCRIPTION: (aggregate of gates 6–8 evidence — no secrets)
- FOLLOW-UP ISSUE: (leave blank)

---

_Signed off by: ______________  Date: ______________ (only when all nine
gates carry real evidence and are PASS in this file AND in the JSON)._