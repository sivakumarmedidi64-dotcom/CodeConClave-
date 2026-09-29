# CodeConClave — Human Acceptance Guide (9 Gates)

The release cannot pass on automated results alone. This guide gives the founder
the exact manual procedure for each of the 9 acceptance gates. One gate per
session entry; never run two gates from memory — use the evidence log.

Reading order: this guide → the relevant `*_ACCEPTANCE_WORKBOOK.md` (web/desktop/
full-product) → `CODECONCLAVE_WINDOWS_INSTALL_ACCEPTANCE.md` →
`CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md`/`.json` (record evidence) →
`npm run acceptance:status` (verify the engine picked it up).

Current state: HUMAN_ACCEPTANCE_GATES = 0/9 · RELEASE_READY = NO.
Installer SHA256 (current build, rebuilt 2026-09-10):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`.

Never put credentials, tokens, keys, or OTPs into any evidence record.

---

## Gate 1 — GOOGLE_OAUTH_LOGIN (release surface: Web production-origin auth)

- WHAT TO DO: On the canonical (release) origin, sign in with Google. Use the
  SAME browser and a second browser/hostname pointing at the same backend.
  Test the consent screen, the deny-consent path, refresh, logout/login.
- WHAT TO EXPECT: Single-origin login works; no silent success on one host and
  failure on another; redirect URI resolves on the canonical origin.
- WHERE TO RECORD: `GOOGLE_OAUTH_LOGIN` entry in
  `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` + `.json`.
- PASS: real login, consent, refresh, sign-out, and cross-host check all behave
  on the canonical origin; new-account onboarding collects only display name
  (if missing), role, primary use case — no email re-ask.
- FAIL: login fail, redirect mismatch, cross-host inconsistency, onboarding
  re-asks identity, or console/auth errors.

## Gate 2 — PRODUCTION_PAYMENT (release surface: live payment acceptance)

- WHAT TO DO: On the canonical origin, start the paid checkout, confirm the
  correct hosted link, complete the payment yourself, return, and verify the
  entitlement.
- WHAT TO EXPECT: Evidence detected exactly once; correct plan granted exactly
  once; reservation preserved; replay rejected; no credentials shown anywhere.
- WHERE TO RECORD: `PRODUCTION_PAYMENT` entry in the evidence log.
- PASS: entitlement granted exactly once, reservation preserved, replay
  rejected, dashboard shows the row, no secrets exposed.
- FAIL: double grant, missing grant, replay accepted, secrets exposed.

## Gate 3 — WINDOWS_INSTALL (release surface: Windows installer/runtime)

- WHAT TO DO: Recompute the SHA256 of `desktop/release/CodeConClave Setup 0.1.0.exe`
  and compare to the published hash; run the installer on a clean machine;
  launch from Start Menu, launch again after restart; uninstall; reinstall.
- WHAT TO EXPECT: Hash matches; install/launch/reinstall work; uninstall leaves
  no leftover process/service.
- WHERE TO RECORD: `WINDOWS_INSTALL` entry + `CODECONCLAVE_WINDOWS_INSTALL_ACCEPTANCE.md`.
- PASS: hash match, clean install, restart-launch, uninstall, reinstall all OK.
- FAIL: hash mismatch or any install/launch/uninstall/reinstall failure.

## Gate 4 — OFFLINE_MODE (release surface: network loss behavior)

- WHAT TO DO: Sign in, start a task/workflow, disconnect the network, observe,
  reconnect, verify the task resumes, close/reopen during offline.
- WHAT TO EXPECT: exactly one offline/reconnect state; no crash; no data loss;
  no silent queued writes; resume without duplication.
- WHERE TO RECORD: `OFFLINE_MODE` entry in the evidence log.
- PASS: single offline state, graceful reconnect, resume without loss/duplication.
- FAIL: crash, data loss, double-execution, silent queued writes.

## Gate 5 — PROVIDER_REPROBE (release surface: provider status honesty)

- WHAT TO DO: Open the provider status surface on the canonical origin and
  re-probe every configured provider; compare to the honest ledger
  (`docs/CODECONCLAVE_PROVIDER_RELEASE_STATUS.md`).
- WHAT TO EXPECT: google/qwen/nemotron HEALTHY; openai/deepseek QUOTA_EXHAUSTED;
  anthropic/gemma OFFLINE; grok/kimi REQUIRES_REAUTH; mistral/north/ox_alpha/
  z_code_5_3 NOT_CONFIGURED; manus/devin NEVER_AUTORUN; big_pickle NOT_INTEGRATED.
- WHERE TO RECORD: `PROVIDER_REPROBE` entry in the evidence log (no keys).
- PASS: surface matches the ledger; no task auto-created for manus/devin.
- FAIL: mismatch, fabricated state, auto-task for an external agent.

## Gate 6 — WEB_E2E (release surface: web product)

- WHAT TO DO: 35-step flow in `CODECONCLAVE_WEB_ACCEPTANCE_WORKBOOK.md`.
- WHAT TO EXPECT: everything from chat through Control Plane behaves; the honest
  provider registry is respected end-to-end.
- WHERE TO RECORD: `WEB_E2E` entry + workbook sign-off.
- PASS: all 35 steps OK with honest provider states; no secrets in UI.
- FAIL: any step fails or a fake provider state is shown.

## Gate 7 — DESKTOP_E2E (release surface: desktop product)

- WHAT TO DO: 30-step flow in `CODECONCLAVE_DESKTOP_ACCEPTANCE_WORKBOOK.md` on
  the installed app (same backend as web).
- WHERE TO RECORD: `DESKTOP_E2E` entry + workbook sign-off.
- PASS: all 30 steps OK; hash matches; no linger/restart/offline regressions.
- FAIL: any step fails, hash mismatch, offline resume loses/duplicates data.

## Gate 8 — WEB_DESKTOP_PARITY (release surface: parity)

- WHAT TO DO: Same account, same backend, same prompts on web and desktop;
  verify shared state and identical AI/routing/entitlement behavior.
- WHERE TO RECORD: `WEB_DESKTOP_PARITY` entry.
- PASS: shared state identical; same responses via same backend.
- FAIL: divergence, desktop behaving like a separate product.

## Gate 9 — FULL_PRODUCT (release surface: aggregate)

- WHAT TO DO: Confirm gates 6, 7, 8 are all PASS; sign the aggregate workbook
  `CODECONCLAVE_FULL_PRODUCT_ACCEPTANCE_WORKBOOK.md`.
- WHERE TO RECORD: `FULL_PRODUCT` entry.
- PASS: gates 6, 7, 8 all PASS.
- FAIL: any of the three not PASS.

Sign-off: only when all nine gates carry real evidence and PASS in both the
evidence md and the JSON, and `npm run acceptance:status` reports 9/9.