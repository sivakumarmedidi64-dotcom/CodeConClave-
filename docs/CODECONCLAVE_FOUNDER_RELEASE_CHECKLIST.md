# CodeConClave — Founder Release Checklist (v2, final gate)

Everything that still needs an actual human. Work top-to-bottom. Never put
credentials, passwords, card numbers, or API keys into ANY record. The
installer hash below is current; recompute it from the exact file you install.

EVIDENCE TYPES (pick one per gate and store in the evidence JSON `evidence_type`):
`screenshot` | `video` | `flow-sheet` | `command-output` | `log-bundle` |
`payment-receipt` | `hash-output`

INSTALLER SHA256 (rebuilt 2026-09-10 03:59):
`Get-FileHash "desktop\release\CodeConClave Setup 0.1.0.exe"` → expect
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`.

Record every result in `docs/CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` + `.json`
(get `gate_id`, `name`, `status`, `performed_by`, `performed_at`,
`environment`, `evidence_type`, `evidence_reference`, `notes`).

---

## FOUNDER ACCEPTANCE SEQUENCE (do in this order)

1. GOOGLE_OAUTH_LOGIN → 2. WINDOWS_INSTALL → 3. PROVIDER_REPROBE →
4. WEB_E2E (web flow) → 5. DESKTOP_E2E (desktop flow) →
6. WEB_DESKTOP_PARITY → 7. OFFLINE_MODE → 8. PRODUCTION_PAYMENT (live money,
last) → 9. FULL_PRODUCT (only after 6, 7, 8 pass).

---

## Gate 1 — GOOGLE_OAUTH_LOGIN  (HUMAN_REQUIRED)

- WHAT TO DO: real Google sign-in + cross-browser check on the canonical
  (deployment) origin; cancel/deny path; refresh; logout; onboarding (chosen
  display name only if missing, role, primary use case).
- EXPECTED RESULT: single-origin login; consent; deny path; refresh; logout;
  no cross-host mismatch; no email re-ask; chosen display name persists and is
  used in later greetings; logout/login preserves identity.
- WHAT COUNTS AS PASS: all flows correct on the canonical origin.
- WHAT COUNTS AS FAIL: any login/redirect/cross-host/onboarding failure;
  401-only shadows; any residual Google security/redirect caveat still
  unresolved.
- EVIDENCE TO KEEP: screenshots of (1) consent, (2) callback URL host,
  (3) onboarding questions, (4) greeting using chosen display name,
  (5) logout/login continuity.
- WHERE TO RECORD: `GOOGLE_OAUTH_LOGIN` / evidence JSON.

## Gate 2 — PRODUCTION_PAYMENT  (HUMAN_REQUIRED)

- WHAT TO DO (live money, FROZEN until you choose to run it): pay once via the
  hosted link on the canonical origin; return; verify entitlement appears
  exactly once; attempt replay.
- EXPECTED RESULT: correct link; exactly-once grant; reservation preserved;
  replay rejected; no secret anywhere in UI/network.
- WHAT COUNTS AS PASS: exactly-once grant + no secrets exposed.
- WHAT COUNTS AS FAIL: double or missing grant; replay accepted.
- EVIDENCE TO KEEP: payment receipt (a real, non-fabricated reference),
  entitlement view after return, replay attempt output.
- WHERE TO RECORD: `PRODUCTION_PAYMENT` / evidence JSON. Pipeline proof
  (16/16) and regression (15 files/294) are automated context only — they are
  NOT this gate.

## Gate 3 — WINDOWS_INSTALL  (HUMAN_REQUIRED)

- WHAT TO DO: SHA256 verify → clean install → launch → relaunch → uninstall →
  reinstall on a clean machine.
- EXPECTED RESULT: hash matches; ProductName = CodeConClave, version 0.1.0;
  Start Menu entry; no leftover process/service after uninstall.
- WHAT COUNTS AS PASS: full lifecycle works.
- WHAT COUNTS AS FAIL: hash mismatch, signature issue, or any step failing.
- EVIDENCE TO KEEP: `Get-FileHash` output; installed/uninstalled Program
  listing screenshot; app launch screenshot.
- WHERE TO RECORD: `WINDOWS_INSTALL` + `CODECONCLAVE_WINDOWS_INSTALL_ACCEPTANCE.md`.

## Gate 4 — OFFLINE_MODE  (HYBRID)

- WHAT TO DO: sign in, start a task, disconnect the network, observe, reconnect,
  verify resume, close/reopen while offline.
- EXPECTED RESULT: ONE offline/reconnect state; no crash; no data loss; no
  silent queued writes; resume without duplication.
- WHAT COUNTS AS PASS: graceful offline→reconnect on both web and desktop.
- WHAT COUNTS AS FAIL: crash, loss, or double execution.
- EVIDENCE TO KEEP: network-toggle screenshot + reconnect state + a task that
  resumed once.
- WHERE TO RECORD: `OFFLINE_MODE` / evidence JSON.

## Gate 5 — PROVIDER_REPROBE  (HYBRID)

- WHAT TO DO: re-probe all configured providers on the canonical origin;
  compare with `docs/CODECONCLAVE_PROVIDER_RELEASE_STATUS.md`; verify manus and
  devin never auto-run.
- EXPECTED RESULT: surface matches the honest ledger exactly.
- WHAT COUNTS AS PASS: UI/status surface matches ledger; no fabricated state.
- WHAT COUNTS AS FAIL: any mismatch, or an external agent starting without an
  explicit approved workflow.
- EVIDENCE TO KEEP: reprobe command output / status-surface screenshot.
- WHERE TO RECORD: `PROVIDER_REPROBE` / evidence JSON.

## Gate 6 — WEB_E2E  (HUMAN_REQUIRED — web flow)

WHAT TO DO: run the 35-step workbook flow AND the launch journey below on a real
browser against the canonical origin:

1. Open the application.
2. Sign in.
3. Complete onboarding.
4. Confirm the chosen display name.
5. Reach Home/Chat.
6. Send a real AI message.
7. Confirm the streamed response.
8. Create and use another conversation.
9. Attach a file where supported.
10. Test model selection.
11. Test image mode if configured (see IMAGE note below).
12. Open the Control Plane.
13. Verify active task/worker state.
14. Verify approvals.
15. Verify activity/audit state.
16. Verify Memory.
17. Verify Coworkers.
18. Verify Projects/Tasks.
19. Verify Connections/Settings.
20. Verify logout/login continuity.

- EXPECTED RESULT: all steps behave with the honest provider registry; no
  secrets in the UI; no critical console errors.
- WHAT COUNTS AS PASS: 35/35 workbook + all 20 launch steps.
- WHAT COUNTS AS FAIL: any step failing or fake provider state.
- EVIDENCE TO KEEP: screenshot per section; one video of a streamed AI answer.
- WHERE TO RECORD: `WEB_E2E` / evidence JSON + workbook sign-off.
- ALSO VERIFY (same session): tenant isolation with two test accounts
  (user A never sees user B data / projects / conversations / memory / audit),
  free-usage rolling quota behavior (repeated use reaches the limit, no
  midnight-reset exploit, clear error, limit survives refresh/relogin),
  and UX/accessibility: exact CodeConClave logo unchanged, black/white/gray
  palette with selective purple accent, no moon/glitch/scanline aesthetic, no
  giant decorative robot, clean Home, compact composer, progressive disclosure,
  readable Coworker/Control Plane, keyboard navigation, visible focus,
  skip-link, useful error/loading states.

## Gate 7 — DESKTOP_E2E  (HUMAN_REQUIRED — desktop flow)

WHAT TO DO: run the 30-step installed-app flow AND this 20-step launch journey
on the real NSIS install, same backend as web:

1. Install the actual installer.
2. Verify ProductName = CodeConClave.
3. Verify version = 0.1.0.
4. Launch the application.
5. Sign in.
6. Complete/onboard if required.
7. Send a real AI request.
8. Confirm the response.
9. Test navigation.
10. Test provider/model selection.
11. Test relevant image workflow if available (see IMAGE note).
12. Test the Control Plane.
13. Test Coworkers.
14. Test Projects/Tasks.
15. Test Memory.
16. Test Settings/Security.
17. Close the application.
18. Relaunch the application.
19. Confirm session/state behavior.
20. Uninstall/reinstall only if the acceptance guide requires it.

- EXPECTED RESULT: installed product matches web behavior; no linger/restart/
  offline regressions; hash matches.
- WHAT COUNTS AS PASS: 30/30 workbook + all 20 launch steps.
- WHAT COUNTS AS FAIL: any step failing; hash mismatch; offline data loss.
- EVIDENCE TO KEEP: launch screenshot, one video of a streamed AI answer,
  Get-FileHash output.
- WHERE TO RECORD: `DESKTOP_E2E` / evidence JSON + workbook sign-off.

## Gate 8 — WEB_DESKTOP_PARITY  (HYBRID)

- WHAT TO DO: same account, same backend, same prompts on both clients; compare
  shared state (conversations, memory, projects, tasks, usage).

- EXPECTED RESULT: identical shared state; same responses via the same backend;
  desktop is a client, not a separate product.
- WHAT COUNTS AS PASS: full parity.
- WHAT COUNTS AS FAIL: any divergence in data, routing, or entitlement.
- EVIDENCE TO KEEP: same prompt answered on web then desktop; shared
  conversation visible on both.
- WHERE TO RECORD: `WEB_DESKTOP_PARITY` / evidence JSON.

## Gate 9 — FULL_PRODUCT  (HYBRID)

- WHAT TO DO: after gates 6, 7, 8 pass, sign the aggregate workbook and record
  this gate.
- EXPECTED RESULT: gates 6, 7, 8 all PASS with real evidence.
- WHAT COUNTS AS PASS: gates 6, 7, 8 all PASS.
- WHAT COUNTS AS FAIL: any of them not PASS.
- EVIDENCE TO KEEP: signed aggregate workbook page.
- WHERE TO RECORD: `FULL_PRODUCT` / evidence JSON.

## IMAGE GENERATION — ENVIRONMENT_BLOCKED (do NOT spend money)

The image-workflow foundation exists (registry `image_generation` flags,
dedicated image op, capability gates) but no verified live generation endpoint
is configured. Do NOT fake this. If a real endpoint is added later, then run:
select a project → select image generation → submit a SAFE request → verify the
generated image → verify message attachment → verify project file persistence →
verify reopening the conversation preserves it → verify Download. Until then
IMAGE_GENERATION = ENVIRONMENT_BLOCKED and IMAGE_GENERATION_HUMAN_GATE =
NOT_PERFORMED.

## EXTERNAL AGENT — NEVER_AUTORUN policy (do NOT start uncontrolled jobs)

Manus and Devin are NEVER_AUTORUN. A human gate for a real live external-agent
run stays NOT_PERFORMED unless you deliberately perform one through an approved
safe workflow. Verify only that the controls are visible and honest:
external-agent controls visible, permissions exist, approvals exist, task state
represented, cancellation policy represented, audit linkage exists.

## After all 9: release roll-out (separate, human-authorized)

1. Set canonical production origin environment values (GOOGLE_REDIRECT_URI,
   CORS_ORIGINS, AUTH_COOKIE_DOMAIN, SESSION_COOKIE_SECURE=true).
2. Add a git repo + version tag if desired (repository has none yet).
3. Deploy, then re-run `npm run db:migrate:status` (expect 76/76) and the
   payment proof + provider re-probe at the production origin.
4. Share the installer with its freshly recomputed SHA256 — never ship a hash
   that was not just recomputed from the exact file being installed.

Final sign-off line:
HUMAN_ACCEPTANCE_GATES = 0/9 → (fill as you complete gates)
Signed: ______________  Date: ______________