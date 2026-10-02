# CODECONCLAVE PRO — PROVIDER KEY PREPARATION GATE — AUDIT

**Directive:** CODECONCLAVE PRO — PROVIDER KEY PREPARATION + API ROUTE VERIFICATION (Pre-Prompt 3 Provider Configuration Gate)
**Date:** 2026-09-08
**Verdict:** **PASS** — all work items complete, no blockers.

## 1. Mandated provider reports (truth, nothing fabricated)

Vocabulary — `VERIFIED` (real call performed) / `ENVIRONMENT_BLOCKED` (identity+route+auth verified, no key → no real call) / `UNVERIFIED` (identity could not be established).

All seven are `ENVIRONMENT_BLOCKED`: identity, API route and auth method were verified from **official/public
vendor documentation**; no key is installed and no real call was performed, so nothing is falsely claimed as VERIFIED.

| Provider | Status | API_KEY_VARIABLE | API_KEY_SOURCE | BASE_URL | MODEL_ID | REAL_CALL | ENVIRONMENT_BLOCKED |
|---|---|---|---|---|---|---|---|
| Ox Alpha | ENVIRONMENT_BLOCKED | `OX_ALPHA_API_KEY` (stored value is an **OpenRouter** `sk-or-` key) | OpenRouter keys page; no first-party Ox Alpha dashboard | `https://openrouter.ai/api/v1` | `stealth/ox-alpha` (revealed ZAI GLM-5.3-Flash) | NO | YES |
| Google Gemini | ENVIRONMENT_BLOCKED | `GEMINI_API_KEY` | Google AI Studio / Vertex | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.7-flash` (enabled), `gemini-2.5-pro` (disabled) | NO | YES |
| Manus AI | ENVIRONMENT_BLOCKED | `MANUS_API_KEY` | Manus developer platform | `https://api.manus.ai` (v2 async task API) | `manus-1.6`, `manus-1.6-lite`, `manus-1.6-max` | NO | YES |
| Big Pickle | ENVIRONMENT_BLOCKED (prod NOT recommended) | `OPENCODE_ZEN_API_KEY` — **DO NOT ADD YET** (no key to obtain) | OpenCode Zen account | `https://opencode.ai/zen/v1` | `big-pickle` | NO | YES |
| Qwen | ENVIRONMENT_BLOCKED | `QWEN_API_KEY` | Alibaba Model Studio / DashScope Intl (`sk-` bearer) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3.7-plus` (default), `qwen3.8-max`, `qwen3-coder-next`, `qwen3.6-plus`, `qwen3.5-flash` | NO | YES |
| Gemma | ENVIRONMENT_BLOCKED | `GEMINI_API_KEY` (shared — **no** `GEMMA_API_KEY`) | Same as Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemma-3-27b-it` (seeded, enabled) | NO | YES |
| Z Code 5.3 (Z.ai GLM-5.3 / ZCode) | ENVIRONMENT_BLOCKED | `Z_AI_API_KEY` | Z.ai platform + GLM Coding Plan | `https://api.z.ai/api/v1` (also `/api/paas/v4`, `/api/anthropic`) | `glm-5.3` (⚠️ seeded row says `z-code-5-3` — MUST align in Prompt 3) | NO | YES |

Key honesty notes:
- **Z Code 5.3 is real.** Its earlier `UNVERIFIED` classification was corrected this gate (Z.ai GLM-5.3/ZCode, launched 2026-08-14, API live 2026-08-18) — but the seeded registry model_id `z-code-5-3` ≠ vendor `glm-5.3`, a Prompt 3 adapter-alignment item.
- **Ox Alpha** has no first-party offering; it is a stealth OpenRouter listing (revealed GLM-5.3-Flash). The founder's `OX_ALPHA_API_KEY` is documented to hold an OpenRouter key.
- **Big Pickle** identity/route verified via the opencode project, but it is a free smoke-test tier on the OpenCode Zen gateway (`NOT intended for production`); key intentionally **not added**.

## 2. No rules violated
- No credentials pasted into chat; `.env` values never read; key names only.
- Provider keys are **env/config**, NOT stored as ordinary DB records. **No DB migration required** (migration state untouched, 70/70 baseline preserved).
- No features removed/replaced/redesigned: **FEATURES_REMOVED=0, FEATURES_UNMAPPED=0, FEATURE_DENOMINATOR=336** (frozen).
- No second AI engine introduced; no new adapter wired; `AI_PROVIDERS_ENABLED=anthropic,openai,grok,nemotron` unchanged → live routing pool identical.
- Real-call VERIFICATION deferred honestly until keys arrive (Prompt 3).

## 3. What changed (this gate)
- `backend/src/modules/ai/providerKeySpec.ts` (NEW) — single source of truth: `EXISTING_PROVIDER_IDS` (12), `NEW_PROVIDER_KEY_SPEC` (7 rows), `providerKeySpecById()`, `isProviderVerified()`; statuses ENVIRONMENT_BLOCKED, realCall NO, env-blocked YES.
- `backend/src/modules/ai/registry.ts` — added `isValidProviderKey(value, strict)` (fail-closed parser), `resolveConfiguredProviders(enabled, keys, {strict})`; `configuredProviders()` refactored to delegate (behavior identical); `computeModelAvailability({configured, health, computeClass, entitled, budgetRemaining})` shared predicate.
- `backend/src/modules/ai/routes.ts` — `/api/v1/ai/models` now uses `computeModelAvailability`.
- `backend/src/modules/core/env.ts` — added optional `OX_ALPHA_API_KEY`, `MANUS_API_KEY`, `Z_AI_API_KEY`.
- `backend/src/modules/ai/providers.ts` — corrected Z Code error message ('UNVERIFIED' → honest 'identity verified — adapter wiring deferred').
- `backend/src/modules/ai/secretGuard/service.ts` — added OpenRouter pattern `\bsk-or-v1-[0-9A-Za-z_-]{32,}\b` (confidence 0.95).
- `.env` (gitignored) + `.env.example` — added verified-empty placeholders + Big Pickle DO-NOT-ADD comment; `.env` confirmed to contain no `OPENCODE_ZEN_API_KEY` line.
- `backend/src/foundation/provider-key-config-52.test.ts` (NEW) — 32 tests.
- `backend/src/foundation/provider-expansion-50.test.ts` — updated Z Code assertion to the corrected message.
- Docs: `docs/CODECONCLAVE_NEW_PROVIDER_API_KEYS.md`, `docs/CODECONCLAVE_NEW_PROVIDER_MATRIX.md`, and this audit + JSON.

## 4. Verification evidence

| Check | Result |
|---|---|
| Backend typecheck (`tsc --noEmit`) | **PASS** |
| Backend full vitest | **151 files / 2786 passed / 8 skipped / 0 failed** (baseline 150/2754/8/0; +1 file/+32 tests) |
| Payment regression (8 files incl. prove:payment + billing-14) | **8 files / 182 passed** |
| Secret scan repo-wide (`secret:scan`) | **844 files scanned, findings=0** |
| Migration state | untouched (70/70 baseline; no migration added) |
| Frontend typecheck | **PASS** |
| Frontend vitest (single-threaded) | **73 files / 401 passed / 0 failed** |
| Frontend build (`vite build`) | **PASS** (chunk-size warning is pre-existing, non-blocking) |
| Desktop typecheck | **PASS** |
| Desktop vitest | **5 files / 58 passed** |
| Desktop build (`tsc` + bundle-preload) | **PASS** |
| Runtime environment probe (plain tsx) | `enabledProviders` & `configuredProviders` = `[anthropic, openai, grok, nemotron]`; GEMINI/QWEN/etc. not configured (empty keys) — unchanged |
| DB model registry (live) | 12 provider groups; qwen/gemma/google/z_code present; z_code row `z-code-5-3` disabled (mismatch flagged) |

## 5. Findings

| Severity | Finding | Status |
|---|---|---|
| LOW | Typo in `env.ts` comment ('AdaptErs') | cosmetic; fix at Prompt 3 |
| LOW | Typo in `providerKeySpec.ts` ox_alpha note ('effectivelhy') | cosmetic; fix at Prompt 3 |
| LOW | Duplicate `LOG_LEVEL` key in `backend/vitest.config.ts` `env:` (lines ~30/126) → startup warning | cosmetic; fix at Prompt 3 |
| NOTE | Fire-and-forget `OPENCODE_ZEN_API_KEY` (Big Pickle) is free/stealth tier, some aggregators list it disabled since 2026-08-14 — key intentionally NOT added | intentional |
| NOTE | Seeded `z-code-5-3` model_id ≠ vendor `glm-5.3`; row disabled | Prompt 3 adapter work |
| NOTE | First parallel frontend test+build run showed 3 transient failures; isolated single-threaded re-run fully green (401/401) — resource contention, not a code defect | re-verified |

## 6. FOUNDER ACTIONS — AFTER THIS GATE

1. **Obtain and store keys** (values never typed in chat; insert directly into the server `.env` or the deploy secret store, keys are git-ignored):
   - `GEMINI_API_KEY` (Google AI Studio / Vertex) → enables `google` **and** `gemma`.
   - `QWEN_API_KEY` (Alibaba Model Studio / DashScope Intl).
   - `MANUS_API_KEY` (Manus developer platform, v2 task API).
   - `OX_ALPHA_API_KEY` — store an **OpenRouter** key (`sk-or-v1-…`) from https://openrouter.ai/keys.
   - `Z_AI_API_KEY` (Z.ai, requires GLM Coding Plan).
   - Big Pickle: **do NOT add `OPENCODE_ZEN_API_KEY`** until production viability is confirmed; treat as a smoke-test.
2. After keys are added, restart the backend and run the AI health sweep — providers with keys become HEALTHY/configured and can be exercised for real-call VERIFICATION. Auto-enable (via `AI_PROVIDERS_ENABLED`) **only after** their adapters exist.
3. **Prompt 3 (Provider Configuration Gate) must:** wire adapters for `ox_alpha`, `manus` (EXTERNAL_AGENT via Devin pattern + `allowExternalAgents`), `big_pickle`, `z_code_5_3`; **align the `z-code-5-3` → `glm-5.3` model id**; map capability (Ox Alpha = MODEL only; Manus = EXTERNAL_AGENT only, never a chat fallback); enable providers; verify with real calls; update `providerKeySpec.ts` statuses to VERIFIED where real calls succeed.
4. Sanity after key enablement: backend typecheck + AI/registry tests + `secret:scan` (findings must stay 0) + payment regression — none of the key additions may touch payment.

## 7. Final gate checklist

- ✅ 7/7 providers classified honestly (all ENVIRONMENT_BLOCKED)
- ✅ required per-provider report fields present
- ✅ EXISTING_PROVIDERS_PRESERVED (adapter-free, keys empty, allow-list untouched)
- ✅ ROUTING_COMPATIBILITY (shared /models + /providers contracts, computeModelAvailability unit-tested, web+desktop)
- ✅ SECRET_HYGIENE (gitignored .env, empty placeholders, secret scan findings=0, OpenRouter pattern added)
- ✅ PAYMENT_REGRESSION (182 passed; architecture frozen)
- ✅ typecheck / tests / build ×3 (backend, frontend, desktop)
- ✅ migration untouched, 336/0/0
- ✅ founder guide + matrix + audit written
- ✅ Stack: **PASS**

**GATE OUTPUT: `PROVIDER KEY PREPARATION GATE: PASS`** — STOP (Prompt 3 NOT started).