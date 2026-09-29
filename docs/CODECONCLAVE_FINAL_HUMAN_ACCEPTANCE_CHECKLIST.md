# CodeConClave — Final Human Acceptance Checklist

Regenerated during Prompt 5/5 after a file-recovery event; content re-derived
from verified session evidence. This file is the founder-executed checklist,
not a record of a passed gate.

INSTALLER SHA256 (current build, rebuilt 2026-09-10):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`

## Pre-flight (automated, verified)

- [x] (AUTOMATED_VERIFIED) Backend suite: 156 files / 2850 passed / 11 skipped / 0 failed.
- [x] (AUTOMATED_VERIFIED) Frontend suite: 74 files / 408 passed / 0 failed.
- [x] (AUTOMATED_VERIFIED) Desktop suite: 5 files / 58 passed / 0 failed.
- [x] (AUTOMATED_VERIFIED) Targeted smoke suites: 19 files / 411 passed / 0 failed.
- [x] (AUTOMATED_VERIFIED) Secret scan: 855 files, 0 findings, 0 skipped.
- [x] (AUTOMATED_VERIFIED) Migrations: 76 applied / 0 pending.
- [x] (AUTOMATED_VERIFIED) Payment proof: 16/16 (pipeline proof, not a live charge).
- [x] (AUTOMATED_VERIFIED) Payments regression: 134 passed / 3 skipped / 0 failed (gmail-claim suite load-flake passes 16/16 in isolation).
- [x] (AUTOMATED_VERIFIED) Backend/frontend/desktop builds + typechecks all PASS; installer rebuilt and signed with SHA256 `52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`.

## Human gates (founder only — nothing automated may fill these)

- [ ] GOOGLE_OAUTH_LOGIN — real Google login on the canonical origin + cross-browser check.
- [ ] PRODUCTION_PAYMENT — live hosted-link payment, exactly-once entitlement, no secrets exposed.
- [ ] WINDOWS_INSTALL — hash verify, clean install, launch, uninstall, reinstall on a real Windows machine.
- [ ] OFFLINE_MODE — disconnect → single offline state → reconnect → resume; close/reopen offline.
- [ ] PROVIDER_REPROBE — production statos surface matches the honest ledger (google/qwen/nemotron HEALTHY, etc.).
- [ ] WEB_E2E — 35-step flow (CODECONCLAVE_WEB_ACCEPTANCE_WORKBOOK.md).
- [ ] DESKTOP_E2E — 30-step flow (CODECONCLAVE_DESKTOP_ACCEPTANCE_WORKBOOK.md).
- [ ] WEB_DESKTOP_PARITY — both clients, same backend/data/AI/routing/entitlement.
- [ ] FULL_PRODUCT — aggregate workbook (CODECONCLAVE_FULL_PRODUCT_ACCEPTANCE_WORKBOOK.md), pass only when the three E2E gates pass.

## Sign-off

HUMAN_GATES = 0 / 9 (NOT_PERFORMED) · RELEASE_READY = NO.
Signed off: ______________ Date: ______________