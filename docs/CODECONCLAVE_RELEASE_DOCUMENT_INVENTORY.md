# CodeConClave — Release Document Inventory

Inventory of the release-critical documents, verified present on 2026-09-10
(Prompt 5/5). Every file below was checked with Test-Path on disk — presence is
verified, content is the honest current state, and nothing was regenerated from
memory where authoritative evidence existed elsewhere.

## Release audits

- `CODECONCLAVE_FINAL_RELEASE_CANDIDATE_AUDIT.md` / `.json` — final gate + all
  machine-readable fields (this prompt).
- `CODECONCLAVE_FINAL_RELEASE_READINESS_AUDIT.md` / `.json` — pre-gate readiness.
- `CODECONCLAVE_FINAL_RELEASE_HARDENING_AUDIT.md` / `.json` — hardening pass
  + findings classification (regenerated this session after a docs file-loss
  event; regeneration note embedded).
- `CODECONCLAVE_FINAL_ACCEPTANCE_PREPARATION_AUDIT.md` / `.json` — preparation
  pass, canonical-origin + matrix snapshot (json regenerated this session).
- `CODECONCLAVE_FINAL_RELEASE_CHECKLIST.md` — rolling release checklist.
- `CODECONCLAVE_FINAL_SYSTEM_AUDIT.md` / `.json`, `CODECONCLAVE_FINAL_AUDIT_MACHINE_READABLE.json`,
  `CODECONCLAVE_FINAL_INDEPENDENT_AUDIT.md` — system-wide audits.

## Provider audits

- `CODECONCLAVE_PROVIDER_RELEASE_STATUS.md` — honest provider ledger (new this
  prompt).
- `CODECONCLAVE_PROVIDER_FOUNDATION_AUDIT.md` / `.json` — prompt 1.
- `CODECONCLAVE_PROVIDER_KEY_PREPARATION_AUDIT.md` / `.json` — key prep.
- `CODECONCLAVE_PROVIDER_INTEGRATION_AUDIT.md` / `.json` — integration.
- `CODECONCLAVE_PROVIDER_FINAL_SECURITY.md` — provider-side security.
- `CODECONCLAVE_REAL_PROVIDER_VERIFICATION.md` / `.json` — real-call evidence.
- `CODECONCLAVE_FINAL_PROVIDER_STATUS.md` / `_MATRIX.md` / `_VERIFICATION.md` —
  provider status history.

## Routing audit

- `CODECONCLAVE_MODEL_ROUTING_AUDIT.md` / `.json` — routing gate.
- `CODECONCLAVE_MODEL_ROUTING_POLICY.md`, `CODECONCLAVE_MODEL_ROUTING_BASELINE.md`,
  `CODECONCLAVE_INTELLIGENT_ROUTING.md` — routing policy/design.

## Human acceptance (9 gates)

- `CODECONCLAVE_HUMAN_ACCEPTANCE_GUIDE.md` — founder procedures (new this prompt).
- `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` / `.json` — source of truth for the
  status engine (read by `npm run acceptance:status`).
- `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE_TEMPLATE.md` — blank template.
- `CODECONCLAVE_WEB_HUMAN_ACCEPTANCE.md` + `CODECONCLAVE_WEB_ACCEPTANCE_WORKBOOK.md`.
- `CODECONCLAVE_DESKTOP_HUMAN_ACCEPTANCE.md` + `CODECONCLAVE_DESKTOP_ACCEPTANCE_WORKBOOK.md`.
- `CODECONCLAVE_WEB_DESKTOP_PARITY_ACCEPTANCE.md`.
- `CODECONCLAVE_FULL_PRODUCT_HUMAN_ACCEPTANCE.md` + `CODECONCLAVE_FULL_PRODUCT_ACCEPTANCE_WORKBOOK.md`.
- `CODECONCLAVE_FINAL_HUMAN_ACCEPTANCE_CHECKLIST.md`.
- `CODECONCLAVE_FINAL_HUMAN_ACCEPTANCE_EXECUTION_PACK.md` / `.json`.

## Payment proof / security / desktop-install

- `CODECONCLAVE_LIVE_PAYMENT_INCIDENT.md` / `.json` — live-payment incident audit.
- `CODECONCLAVE_PAYMENT_RAIL_A_VALIDATION_GATE.md`,
  `CODECONCLAVE_PAYMENT_ZERO_ADMIN_FEASIBILITY_GATE.md`,
  `CODECONCLAVE_FINAL_ZERO_ADMIN_PAYMENT_ACCEPTANCE_TEST.md`,
  `FINAL_CONTROLLED_GMAIL_PAYMENT_ACCEPTANCE_TEST.md` — payment gates.
- `CODECONCLAVE_WINDOWS_INSTALL_ACCEPTANCE.md` — installer gate + hash.
- `CODECONCLAVE_PROVIDER_FINAL_SECURITY.md`, `CODECONCLAVE_GOOGLE_OAUTH_ACCEPTANCE.md`
  — security/OAuth acceptance.

## Installer hash docs (single current value)

- INSTALLER SHA256 (current build, rebuilt 2026-09-10):
  `52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`
- Verified on-disk across: `CODECONCLAVE_WINDOWS_INSTALL_ACCEPTANCE.md`,
  `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md`/`.json`,
  `CODECONCLAVE_DESKTOP_ACCEPTANCE_WORKBOOK.md`, `CODECONCLAVE_FINAL_RELEASE_CANDIDATE_AUDIT.md`/`.json`,
  `CODECONCLAVE_FINAL_HUMAN_ACCEPTANCE_EXECUTION_PACK.md`/`.json`,
  `CODECONCLAVE_FINAL_RELEASE_HARDENING_AUDIT.md`, `CODECONCLAVE_FINAL_ACCEPTANCE_PREPARATION_AUDIT.json`,
  `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE_TEMPLATE.md`, `CODECONCLAVE_DESKTOP_HUMAN_ACCEPTANCE.md`.
- No stale hash remains in the repository (grep-verified this prompt).

## Evidence JSON

- `CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json` — machine source read by
  `npm run acceptance:status`; each gate carries:
  id, title, status, evidence[], notes, performedBy, performedAt, requiredAction,
  expectedResult, actualResult, environment, evidenceReference, tester, blocker.

## Note on file integrity

- 2026-09-10 docs-lost incident (11 files) — all regenerated from verified
  evidence with embedded regeneration notes; no evidence was invented.
- 2026-09-10 release-artifact loss (installer exe + app.asar vanished) — the
  installer was rebuilt via `npm run package:desktop` and the hash was updated
  everywhere it was referenced (old hash removed, grep-verified).