# CodeConClave — Final Pre-Production Release Candidate

Status: **RELEASE CANDIDATE** (verification-complete; deployment still `NOT_ALLOWED`).

Product: CodeConClave Pro (Web + Windows Desktop, one shared backend).
Version: 0.1.0 (desktop workspace version tag). Mode: `MULTI_PROVIDER`.

Gate rule (unchanged): `DEPLOYMENT_ALLOWED = NO` until all four HUMAN_ONLY
acceptance items below are actually completed by a human on a real environment.
This document records **fresh, re-run evidence** (prompt 5/5 re-test rule — no
assumed PASS).

## Feature basis (Part 26)

- `FEATURE_DENOMINATOR = 336` — frozen canonical inventory
  (`docs/CODECONCLAVE_CANONICAL_FEATURE_INVENTORY.md`).
- `FEATURES_ADDED` this pass: 0 · `FEATURES_REMOVED`: **0** · `FEATURES_UNMAPPED`: **0**
  · `UNKNOWN`: 0.
- No registry edits, no new providers, no new models, no new engines were
  introduced during this release-candidate pass.

## Build matrix

| Artifact | Command | Result |
|---|---|---|
| shared package | `npm run build` (tsc) | PASS |
| backend dist | `npm run build` (tsc) | PASS |
| frontend dist | `npm run build` (vite) | PASS (chunk-size warning only) |
| desktop dist + preload | `tsc -p tsconfig.json && node scripts/bundle-preload.mjs` | PASS |
| Windows installer | `npm run package:desktop` (electron-builder --win, NSIS x64, asar) | PASS — `desktop/release/CodeConClave Setup 0.1.0.exe` (106.3 MB) + blockmap |
| Desktop integrity | asar list | only `dist/**`, `package.json`, `@codeconclave/local-agent`, `ws`; **no `.env`/.pem/.key/credentials** |
| Electron security | `desktop/src/electron/bootstrap.ts` + built `dist/electron/bootstrap.js` | `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`, `will-navigate` guard, window-open denied, permissions denied |

## Test matrix (re-run for this prompt)

| Suite | Files | Tests | Result |
|---|---|---|---|
| backend (full) | 156 | 2860 (2852 passed · 8 conditional skips) | **0 failed** |
| frontend (full) | 74 | 408 | **0 failed** |
| desktop (full) | 5 | 58 | **0 failed** |
| payment proof (`prove-payment.test.ts`) | 1 | 16 | **0 failed** |
| targeted AI/provider/control suites (8 files) | 8 | 238 | **0 failed** |

Typecheck: backend PASS · frontend PASS · desktop PASS · shared PASS.
(Note: the prior remediation run showed 2849/11-skipped; the fresh run shows
2852/8-skipped — the total is stable at 2860 and differences are conditional
skips, not removed tests.)

## Security & data hygiene

- Secret scan (fresh, run after packaging): **files=852 · skipped=0 · findings=0**.
- Only allowance: 12 deliberate `SecretGuard` redaction fixtures in
  `backend/src/foundation/memory.test.ts` (allowlisted).
- `.env` and `.env.*` are git-ignored (`.gitignore` lines 13–15; `.env.example`
  is not ignored). No secret values printed anywhere in this pass.
- Audit correlation (REM-01 fix): `audit_logs.correlation_id` present; live
  write+read verified on a booted server (previous pass); backend audit tests pass.
- git history: repository exists at `C:\Users\sride\CodeConClave-\.git`; local
  `git` executable is non-functional on this machine (`hermes` wrapper fork-bomb
  error), so history is verified only via the earlier secret-history audit docs.

## Database

- Migrations: **76 applied / 0 pending**, every on-disk `sha256` matches the
  `schema_migrations.sha256` record → **0 checksum drift**.
- RLS enabled on the full public schema table set (tenant isolation); no
  production data was mutated during verification (read-only queries only).
- `provider_health` rows: 12.

## Provider matrix (live `provider_health` ledger snapshot, this session)

| Provider | State | Real calls recorded | Notes |
|---|---|---|---|
| google | AVAILABLE | 1 success | gemini-3.7-flash + image model enabled; verified real calls in earlier sessions |
| qwen | AVAILABLE | 1 success | 5 registry models enabled |
| nemotron | DEGRADED | 22 success · 2 failure | last `NVIDIA NIM error 410`; avg latency ≈ 60 s. Historically AVAILABLE (21 success); board changed by a single 410 since the last audit snapshot — live truth |
| openai | DEGRADED | 7 consecutive 429 | billing quota exhausted — surfaced honestly |
| anthropic | DEGRADED | 7 consecutive 400 | surface honestly |
| grok | DEGRADED | 11 consecutive credentials rejected | avg 605 ms |
| gemma | DEGRADED | 1 · 500 | `gemma-4-31b-it` enabled (working variant); `gemma-3-27b-it` disabled (404 model); transient server error |
| mistral / deepseek / kimi / north | NOT_CONFIGURED | 0 | keys not configured in this env |
| devin | NOT_CONFIGURED | 0 | EXTERNAL_AGENT; UNVERIFIED (never issued a real session — by design) |
| ox_alpha | CONFIGURED (never attempted) | 0 | spec `KEY_INVALID`: stored key is not an OpenRouter key; `stealth/ox-alpha` disabled; never auto-retried |
| manus | CONFIGURED (never attempted) | 0 | EXTERNAL_AGENT; `manus-1.6` disabled; **ENVIRONMENT_BLOCKED** (no safe read-only probe; never task-creating) |
| z_code_5_3 | OFFLINE | 0 this pass (400-wrapped 401 in earlier real probe) | registry model `glm-5.3` (0 obsolete `z-code-5-3` rows); spec `KEY_INVALID`: stored key is not a Z.ai key; disabled; never auto-retried |
| big_pickle | NOT_INTEGRATED / ENVIRONMENT_BLOCKED | 0 | DO NOT ADD KEY (`OPENCODE_ZEN_API_KEY` never added) |

`REAL_PROVIDER_CALLS`: google text+multimodal (earlier verified 200), qwen (200),
nemotron SSE (200, real persisted chat rows), gemini image-gen real attempt → 429
(quota — never faked as success), Z Code real-route probe (401-wrapped, honest).
`KEY_INVALID` = ox_alpha, z_code_5_3 (stays KEY_INVALID until credentials
corrected; not auto-converted to ENVIRONMENT_BLOCKED).
`ENVIRONMENT_BLOCKED` = manus, big_pickle. `UNVERIFIED` = devin.

## Human acceptance gate (Part 24) — 4 items, all NOT PERFORMED

1. `GOOGLE_OAUTH_CONSENT_FLOW` — STATUS `NOT_PERFORMED` · `HUMAN_ONLY = YES`
2. `LIVE_RAZORPAY_HOSTED_LINK` — STATUS `NOT_PERFORMED` · `HUMAN_ONLY = YES`
3. `WINDOWS_NSIS_INSTALL_AND_OFFLINE_RESUME` — STATUS `NOT_PERFORMED` · `HUMAN_ONLY = YES`
   (`NSIS_INSTALL = HUMAN_ONLY`, `OFFLINE_RESUME_AUTOMATED = PASS`,
   `OFFLINE_RESUME_HUMAN = NOT_PERFORMED`)
4. `PRODUCTION_PROVIDER_REPROBE` — STATUS `NOT_PERFORMED` · `HUMAN_ONLY = YES`

`HUMAN_ACCEPTANCE_ITEMS = 4` · completed = 0 · remaining = **4**.

## Decision

- Final gate: `CONDITIONAL_PASS` (all automated verification green; 0 open
  code-level findings).
- `DEPLOYMENT = NOT_ALLOWED` (granted only after all 4 human acceptance items).
- This doc supersedes no historical evidence; earlier audits remain untouched.

_Signed as OpenCode verification record — findings are automatable evidence only._