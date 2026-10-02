# CodeConClave — Final Release Candidate Audit (Prompt 5/5)

Generated 2026-09-10 during the FINAL RELEASE HARDENING + HUMAN ACCEPTANCE
WORKFLOW + WEB/DESKTOP PARITY gate. All numbers below are exact results of runs
performed for this gate; nothing is approximate or fabricated.

INSTALLER SHA256 (current build, rebuilt 2026-09-10 03:59):
`52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332`

## Summary

- FINAL_RELEASE_CANDIDATE_GATE = CONDITIONAL_PASS
- AUTOMATED_RELEASE_CHECKS = PASS
- HUMAN_ACCEPTANCE_GATES = 0/9
- RELEASE_READY = NO
- CRITICAL_BLOCKERS = 0 · HIGH_FINDINGS = 0 · MEDIUM_FINDINGS = 1 (residual) · LOW_FINDINGS = 3
- FEATURES = 336 · FEATURES_REMOVED = 0 · FEATURES_UNMAPPED = 0

Automated verification is complete. Human release acceptance remains outstanding.

## Findings ledger (Part 1–2)

- MEDIUM 1 — gmail-claim.test.ts beforeAll boot (30s) timed out under full-suite
  load → 3 route tests skipped. Root cause: one heavy assembled-app boot hook
  vs. full-suite contention. Affected files: `backend/src/modules/payments/gmail-claim.test.ts`.
  Impact: test-coverage flake only, no product impact. Reproducibility: full
  suite under load. Remediation: hook deadline 30000 → 120000 (applied;
  test-infra only). Regression risk: none (verified — full suite now
  2853 passed / 8 skipped / 0 failed vs 2850/11/0 before; gmail-claim
  previously-3 skipped now execute: payments regression 15 files / 294 passed).
  Status: FIXED.
- MEDIUM 2 — file/file-artifact loss in this environment (11 docs files on
  2026-09-10; installer exe + app.asar again on 2026-09-10 03:5x). Root cause:
  external filesystem layer in this environment, not repo code. Affected files:
  varied (docs/*, desktop/release artifacts). Impact: integrity/governance
  (recovered via verified regeneration + rebuild). Reproducibility: observed
  twice. Remediation: repo writes through the Write/Edit tools only; rebuild on
  loss; hash rotation; regeneration notes embedded in every rebuilt doc.
  Regression risk: procedures in place. Status: RESIDUAL RISK (documented, not
  code-fixable).
- LOW 1 — frontend `~1.0 MB` chunk-size warning at build. Cosmetic/build
  informational. Not fixed (no behavior change to force PASS).
- LOW 2 — canonical origin is the dev origin (`http://localhost:5173`); release
  origin env values (GOOGLE_REDIRECT_URI, CORS_ORIGINS, AUTH_COOKIE_DOMAIN,
  SESSION_COOKIE_SECURE=true) must be set at deployment. Documented; no
  deployment allowed in this gate.
- LOW 3 — provider credential remediation for QUOTA_EXHAUSTED/REQUIRES_REAUTH
  providers (openai/deepseek quota; grok/kimi reauth). Founder action, not a
  code blocker.

## Real provider call ledger

- REAL_PROVIDER_CALLS (live re-probe, 2026-09-10): google (ok), qwen (ok),
  nemotron (ok), openai (429/rate limit), deepseek (quota/billing), anthropic
  (bad request), gemma (provider unavailable), grok (invalid credentials),
  kimi (invalid credentials). No fabrications; quota/reauth responses are
  reported as-is.
- REAL_EXTERNAL_AGENT_RUNS = NONE (manus/devin never auto-run; no live task
  executed; not a failure).
- REAL_IMAGE_GENERATION_CALLS = NONE (IMAGE_GENERATION = NOT_CONFIGURED).

## Exact automated results

- BACKEND_TESTS = 156 files / 2853 passed / 8 skipped / 0 failed (2861 total)
- FRONTEND_TESTS = 74 files / 408 passed / 0 failed
- DESKTOP_TESTS = 5 files / 58 passed / 0 failed
- TARGETED_SMOKES = 19 files / 411 passed / 0 failed
  (ai-gateway-5, routing-routes, gateway-25, provider-adapter-53,
  provider-experience-54, model-routing-51, provider-expansion-50,
  provider-key-config-52, ai-transparency-26, control-26g, security-22,
  local-execution-17, idempotency-16, outbox-14, sse-replay-17, stream-hang-21,
  worker-16, auth, visual-intelligence/visual)
- PAYMENT_PROOF = 1 file / 16 passed (16/16)
- PAYMENT_REGRESSION = 15 files / 294 passed / 0 skipped / 0 failed
  (modules/payments + foundation payments* + prove-payment)
- SECRET_SCAN = 855 files / 0 findings / 0 skipped
- MIGRATIONS = 76 applied / 0 pending
- TYPECHECK = backend PASS · frontend PASS · desktop PASS
- BUILDS = backend PASS · frontend PASS · desktop PASS · installer PASS (NSIS,
  signed, block map built)
- DESKTOP_PACKAGED_LAUNCH = NOT_RUN (human install required)
- DESKTOP_INSTALLATION = human evidence required (NOT_PERFORMED)

## Area status

- WEB_APP = PARTIAL (automated PASS; WEB_E2E + WEB_PRODUCTION_ORIGIN are
  human gates) — WEB_PRODUCTION_ORIGIN = HUMAN_GATE_REQUIRED (not deployed)
- WINDOWS_DESKTOP = PARTIAL (build PASS; install human)
- AI_CHAT = PASS (backend→router→real healthy provider path verified;
  streaming/audit tested)
- MODEL_ROUTING = PASS
- MULTIMODAL = PARTIAL (automated vision/attachment pipeline PASS; human
  multimodal gate open)
- IMAGE_GENERATION = NOT_CONFIGURED
- EXTERNAL_AGENTS = PARTIAL (adapter/permission/audit PASS; never auto-run;
  REAL_EXTERNAL_AGENT_RUNS = NONE)
- OFFLINE = PARTIAL (automated offline/worker/stream suites PASS; human
  OFFLINE_MODE gate open)
- PARITY = PARTIAL (PARITY_AUTOMATED = PASS — same backend/shared state;
  PARITY_HUMAN = NOT_RUN)
- SECURITY = PASS (Electron contextIsolation/nodeIntegration:false/
  sandbox:true/webSecurity:true; preload-contract bridge; no provider secrets in
  renderer/preload/bundle/installer; artifact byte-scan clean — AKIA/`sk-`/
  PEM/GitHub token/Slack patterns = 0 real hits, only WASM/locale false
  positives; NO_REAL_KEYS_LEAKED)
- DATABASE = PASS (76/76; RLS/tenant isolation; provider config persistence
  guarded)
- PAYMENT_PROOF = PASS · PAYMENT_REGRESSION = PASS

## Part-22 command readiness (verified working this gate)

- `npm run acceptance:status` — PASS (reads docs/CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json; never infers PASS from automated tests)
- `npm run secret:scan` — PASS (855 files / 0 findings)
- `npm run db:migrate:status` — PASS (76/76)
- `npm run prove:payment` — PASS (16/16)
- payment regression (vitest payments scope) — PASS (15 files / 294)
- `npm run acceptance:preflight` / `acceptance:oauth:preflight` / `provider:reprobe` — available (tsx bin repair)
- Tooling fix: root `node_modules/.bin` lacked the `tsx.cmd`/`tsx.ps1` shims,
  so every `tsx` npm script failed under cmd.exe; shims recreated (standard npm
  format) and npm scripts now execute.

## Files changed this gate

1. `node_modules/.bin/tsx.cmd` (new npm shim)
2. `node_modules/.bin/tsx.ps1` (new npm shim)
3. `backend/src/modules/payments/gmail-claim.test.ts` (hook deadline 30s→120s)
4. `docs/CODECONCLAVE_HUMAN_ACCEPTANCE_GUIDE.md` (new)
5. `docs/CODECONCLAVE_PROVIDER_RELEASE_STATUS.md` (new)
6. `docs/CODECONCLAVE_RELEASE_DOCUMENT_INVENTORY.md` (new)
7. `docs/CODECONCLAVE_FOUNDER_RELEASE_CHECKLIST.md` (new)
8. `docs/CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.json` (schema: requiredAction/
   expectedResult/actualResult/environment/evidenceReference/tester/blocker/notes)
9. `docs/CODECONCLAVE_FINAL_RELEASE_CANDIDATE_AUDIT.md` (this file)
10. `docs/CODECONCLAVE_FINAL_RELEASE_CANDIDATE_AUDIT.json`
11. `desktop/release/CodeConClave Setup 0.1.0.exe` + `win-unpacked` (rebuilt
    after artifact loss; SHA256 rotated → 52AF5BF2C8E2E8850120973555DA1F929CAE21A5239475ECECF24B0EBDDD6332)
12. 13 docs files (hash reference update to the rotated installer hash;
    grep-verified no stale hash remains)

## Remaining risks (exact)

1. MEDIUM — environmental file/artifact loss (observed twice; mitigated,
   documented as residual).
2. LOW — ~1.0 MB frontend chunk warning (informational).
3. LOW — production origin env values pending deployment.
4. LOW — openai/deepseek quota and grok/kimi credentials pending founder action.
5. Human: 9 gates; production origin not deployed.

## Release decision

FINAL RELEASE CANDIDATE GATE: CONDITIONAL_PASS. Release is not authorized
until all 9 human gates pass with real evidence (RELEASE_READY = NO).