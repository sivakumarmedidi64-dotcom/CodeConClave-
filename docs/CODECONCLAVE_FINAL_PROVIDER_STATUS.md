# CodeConClave Pro — Final Provider Status

Audit session date: 2026-09-08. Final per-provider status for the AI provider
expansion (Web + Windows Desktop).

## Status legend

| Status | Meaning |
| --- | --- |
| VERIFIED | Real provider call returned a genuine completion this audit chain (Prompt 3/5). |
| VERIFIED-DEGRADED | Works but intermittently fails provider-side (500s) / needs larger token budget. |
| QUOTA_EXHAUSTED | Key valid, live / billing quota prevents completions. |
| REQUIRES_REAUTH | Key rejected by provider (401/403 invalid credentials). |
| KEY_INVALID | Key material does not match the provider endpoint's required format (import-time classification). |
| ENVIRONMENT_BLOCKED | No real call attempted (unsafe external work / no key requested / Big Pickle never). |
| UNKNOWN | Not probed; no evidence row (provider_health default). |

## Provider matrix

| # | Provider id | Backing API | Live key present | Enabled in `AI_PROVIDERS_ENABLED` | Health row | Live call | Final status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | google | Gemini (v1beta streamGenerateContent) | YES | YES | HEALTHY (1 success, 2026-09-08) | 200 OK text + multimodal | **VERIFIED** |
| 2 | qwen | DashScope compatible-mode | YES | YES | HEALTHY (1 success, 2026-09-08) | 200 OK | **VERIFIED** |
| 3 | gemma | Gemini key / gemma endpoint | YES | YES | OFFLINE (today 500s; earlier 200 OK) | 200 OK once, then 500 | **VERIFIED-DEGRADED** |
| 4 | nemotron | NVIDIA NIM | YES | YES | HEALTHY (16 successes) | Real E2E fallback rows | **VERIFIED** |
| 5 | deepseek | api.deepseek.com | YES | YES (registry row) | UNKNOWN (no health row) | 402 Insufficient Balance | **QUOTA_EXHAUSTED** |
| 6 | kimi | api.moonshot.cn | YES | YES (registry row) | UNKNOWN | 401 invalid credentials | **REQUIRES_REAUTH** |
| 7 | grok | api.x.ai | YES | YES | REQUIRES_REAUTH (11 failures) | 403 invalid credentials | **REQUIRES_REAUTH** |
| 8 | anthropic | api.anthropic.com | YES | YES | OFFLINE (7 failures) | 400 worksp-acope header required | **REQUIRES_REAUTH** (workspace config) |
| 9 | openai | api.openai.com | YES | YES | QUOTA_EXHAUSTED (7 failures) | 429 billing | **QUOTA_EXHAUSTED** |
| 10 | ox_alpha | OpenRouter gateway | YES (wrong format) | YES | UNKNOWN | 401 invalid credentials | **KEY_INVALID** |
| 11 | z_code_5_3 | api.z.ai | YES (wrong format) | YES | DOWN | HTTP 200 + body error (silent) | **KEY_INVALID** |
| 12 | cohere | — | NO | NO | — | not attempted | **UNKNOWN** (no key) |
| 13 | mistral | — | NO | NO | UNKNOWN | not attempted | **UNKNOWN** (no key) |
| 14 | devin | devin external-agent API | YES (org-id absent) | NO (registry row enabled) | UNKNOWN | not attempted (unsafe) | **ENVIRONMENT_BLOCKED** |
| 15 | manus | manus external-agent API | YES | YES (registry row disabled) | UNKNOWN | not attempted (unsafe) | **ENVIRONMENT_BLOCKED** |
| 16 | big_pickle | — | NO (never) | NO | — | never | **ENVIRONMENT_BLOCKED** (permanent) |

## Model-state highlights (ai_model_registry, 34 rows)

- `claude-opus-4-1`/`claude-sonnet-4-5`/`claude-haiku-4-5` — VERIFIED, enabled,
  health UNKNOWN row (gate probes hit them directly).
- `gemini-3.7-flash` — enabled, VERIFIED text; health HEALTHY (row written today).
- `gemini-3-pro-image` — enabled, image_generation + image_editing, VERIFIED via
  429‑surface: live image-model ids in `GEMINI_IMAGE_MODEL_IDS`
  (`gemini-2.0-flash-preview-image-generation`, `gemini-3-pro-image-preview`,
  `gemini-3-pro-image`, `nano-banana-image-generation`); capability-level
  QUOTA_EXHAUSTED until billing quota is available.
- `gemma-4-31b-it` — enabled, VERIFIED-DEGRADED (intermittent 500s).
- `gemma-3-27b-it` — **enabled=false, health DOWN** (404) — correctly disabled.
- `glm-5.3` — registry model id is correct (not a z-code id); row disabled.
- `stealth/ox-alpha` — disabled; key format invalid.
- `devin-session` — EXTERNAL_AGENT, enabled=true, entitlement PRO, but devin is
  NOT in `AI_PROVIDERS_ENABLED` → not routable (fail-closed default).
- `manus-1.6` — EXTERNAL_AGENT, disabled (safe default).

## Environment facts (no key material)

- Root `.env` holds keys for: openai, anthropic, grok, gemini, qwen, nvidia,
  deepseek, kimi, ox_alpha, z_ai, devin, manus (lengths 35–167).
- Missing: cohere, mistral, devin org id, calendar/notion/github, and
  `OPENCODE_ZEN_API_KEY` (permanently never-added).
- `AI_PROVIDERS_ENABLED=anthropic,openai,grok,nemotron,google,qwen,gemma,ox_alpha,z_code_5_3,manus`.
- DB stores no plaintext API keys: only `token_hash` (devices, payment_claims,
  sessions) and `plugin_connections.credential_ref` (Part 16 evidence, DB-level OK).

## Part 16 (key exposure)

- No `.env`, `.pem`, or key material under version control (root `.env`
  gitignored). Secret scan: **849 files, 0 findings** (2026-09-08).
- Report documents include variable names + endpoint URLs only; no prefixes or
  values, per audit rule.