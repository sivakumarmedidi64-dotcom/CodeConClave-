# CodeConClave Pro — PROMPT 5 FINAL AUDIT

Date: 2026-09-08. Sequence-final gate.

## PROMPT_5_GATE

```
CONDITIONAL_PASS
```

No critical/high code blockers; core product paths verified. Legitimate
environment/credential limitations remain (image-generation billing quota,
two invalid provider keys, external-agent live runs intentionally skipped) —
exactly the CONDITIONAL_PASS condition. NOT forced to PASS.

## Domain table

| Domain | Status | Evidence |
| --- | --- | --- |
| PROVIDER_FOUNDATION | PASS | adapters 0069/0070-73; PAI-53.* green |
| MODEL_ROUTING | PASS | model-routing-51 (all matrix intents + audit fields) |
| PROVIDER_INTEGRATION | PASS | real calls (google/qwen/gemma), adapters unified |
| EXTERNAL_AGENT | PASS | single arch; permission/approval/lifecycle/audit tests; live runs ENV_BLOCKED by rules |
| MULTIMODAL | PASS | REAL text+image 200 ×2; PAI-53.2/.3 |
| IMAGE_GENERATION | PARTIAL | flow implemented + component tests; REAL call → 429 quota 0 ⇒ ENVIRONMENT_BLOCKED |
| PROVIDER_UX | PASS | /models + /providers keyState; ModelPicker honest hints, never ONLINE |
| WEB_APP | PASS | 73 files / 402 tests, build ✓ |
| DESKTOP_APP | PASS | 5 files / 58 tests, tsc + NSIS package ✓ |
| WEB_DESKTOP_PARITY | PASS | same renderer/backend; no desktop keys/engine |
| SECURITY | PASS | 847 files / 0 findings; Electron hardened |
| AUTHORIZATION | PASS | owner-scoped files/conversations/audit; tenant feed |
| ISOLATION | PASS | cross-user/workspace denial propagation green |
| MEMORY | PASS | provider-agnostic memory; no keys stored |
| AUTONOMY | PASS | canonical router only; gates intact |
| COST_USAGE | PASS | logUsage + model_usage_logs (+capability/external_run_id) |
| DATABASE | PASS | 73 applied / 0 pending; schema untouched |
| PAYMENT_REGRESSION | PASS | 9 files / 193 tests; payment code unmodified |

## Provider status (final)

| Provider | Final State |
| --- | --- |
| GEMINI | VERIFIED (real text + multimodal + models.list) |
| GEMMA | VERIFIED (gemma-4-31b-it real 200; 27b real 404 ⇒ DISABLED) |
| QWEN | VERIFIED (real 200 ×2) |
| OX_ALPHA | KEY_INVALID (stored key not OpenRouter-format; disabled) |
| Z_AI_GLM_5_3 | KEY_INVALID (stored key not Z.ai-format; disabled, route/model correct) |
| DEVIN | CONFIGURED (preserved); live-path UNVERIFIED / ENVIRONMENT_BLOCKED |
| MANUS | EXTERNAL_AGENT / ENVIRONMENT_BLOCKED |
| OPENAI | CONFIGURED / QUOTA_EXHAUSTED (excluded) |
| ANTHROPIC | CONFIGURED / OFFLINE (excluded) |
| XAI_GROK | CONFIGURED / REQUIRES_REAUTH (excluded) |
| BIG_PICKLE | NOT INTEGRATED (no OPENCODE_ZEN_API_KEY; never advertised) |

## Exact counts (actual output this gate)

```
BACKEND_TEST_FILES 153  BACKEND_TESTS_PASSED 2823  BACKEND_TESTS_FAILED 0  BACKEND_TESTS_SKIPPED 8
FRONTEND_TEST_FILES 73  FRONTEND_TESTS_PASSED 402  FRONTEND_TESTS_FAILED 0
DESKTOP_TEST_FILES 5   DESKTOP_TESTS_PASSED 58    DESKTOP_TESTS_FAILED 0
PAYMENT_TEST_FILES 9   PAYMENT_TESTS_PASSED 193   PAYMENT_TESTS_FAILED 0
SECRET_SCAN_FILES 847  SECRET_SCAN_FINDINGS 0
MIGRATIONS_APPLIED 73  MIGRATIONS_PENDING 0
BACKEND_TYPECHECK PASS FRONTEND_TYPECHECK PASS DESKTOP_TYPECHECK PASS
BACKEND_BUILD PASS FRONTEND_BUILD PASS DESKTOP_BUILD PASS (tsc + NSIS installer)
REAL_PROVIDER_CALLS 8 positive HTTP-200 completions + 1 models.list + negative probes (gemma-27b 404, image-gen 429, ox/zai 401 from Prompt 3 carried)
REAL_MULTIMODAL_CALL YES ×2 (real 1×1 PNG input, 200)
REAL_IMAGE_GENERATION_CALL ATTEMPTED → ENVIRONMENT_BLOCKED (HTTP 429, free-tier quota limit 0)
REAL_EXTERNAL_AGENT_CALLS 0 (task creation intentionally forbidden)
```

## Findings

| Class | Finding | Location | Impact | Blocking? | Env-blocked? | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| CRITICAL | none | — | — | — | — | — |
| HIGH | none | — | — | — | — | — |
| MEDIUM | Current GEMINI_API_KEY has zero image-generation quota (real 429, `limit: 0`) | root `.env`; `gemini-3-pro-image` row | Image-mode feature cannot complete a generation with founder's key; fails honestly (message FAILED + audit), core chat unaffected | No (image feature only) | Yes (billing) | Founder upgrades key to billing-enabled plan, then re-runs one generation |
| MEDIUM | No dedicated end-to-end automated test for `sendImageGeneration` (route→persistGeneratedImage→SSE image→message image columns); components are covered (PAI-53.4, routing, files/visual, sse types) | `backend/src/modules/conversations/chat.ts:555` | Regression guard gap on a prompt-delivered path | No | No | Add route-level test when image generation is promoted to VERIFIED |
| LOW | Frontend bundle 1.04 MB (`>500 kB` chunk warning) | `frontend` vite build | Perf/load cosplay | No | No | Optional code-splitting |
| LOW | `.gitignore` whitelists `!.env.test.example` but file absent | root | none | No | No | Delete the whitelist entry or add the file |
| LOW | Transient provider capacity during verification: Google 503 ×1, Gemma timeout + 500 ×1 (retried → 200) | live endpoints | Availability dips only | No | Yes (provider capacity) | Monitor; polite-retry already handles |
| NOTE | `gemini-3-pro-image` row health=HEALTHY reflects route/model presence, not generation entitlement (separate 429) | registry | none | No | Yes | Recheck after key upgrade |
| NOTE | Backend full suite is CPU-sensitive (`gmail-claim.test.ts` beforeAll hook can time out when heavy suites run concurrently; vitest.config caps pool at 4 forks) | vitest.config.ts | CI flakes under contention only | No | No | Run backend suite without simultaneous heavy suites |
| NOTE | OpenAI/Anthropic/Grok pre-existing unhealthy states (QUOTA_EXHAUSTED/OFFLINE/REQUIRES_REAUTH) | provider_health | excluded from routing; honest UI | No | Yes (credentials/billing) | Founder renews if those tiers are needed |

## Changes made in this gate (Prompt 5)

1. `frontend/src/components/Toast.tsx` — clear toast auto-dismiss timers on
   unmount (fixes vitest leaked-timer teardown error).
2. `frontend/src/components/ModelPicker.tsx` — surface provider `keyState`
   (KEY INVALID / ENVIRONMENT BLOCKED / UNVERIFIED / …) from
   `/api/v1/ai/providers` as honest, non-cluttering hints; never `ONLINE`.
3. `frontend/src/components/ModelPicker.test.tsx` — added key-state hint test
   (401 → 402 frontend tests).
4. `docs/CODECONCLAVE_WEB_DESKTOP_AI_PARITY.md` — updated (final).
5. `docs/CODECONCLAVE_FINAL_PROVIDER_MATRIX.md` — new.
6. `docs/CODECONCLAVE_FINAL_AI_VERIFICATION.md` — new.
7. `docs/CODECONCLAVE_PROVIDER_FINAL_SECURITY.md` — new.
8. `docs/CODECONCLAVE_PROMPT5_FINAL_AUDIT.md` / `.json` — new.

No backend, payment, or schema changes were required (schema already correct —
no new migration). No deployment was performed.

## FOUNDER_ACTIONS

1. Replace `OX_ALPHA_API_KEY` with a real OpenRouter key (`sk-or-v1-…`), then
   enable the `stealth/ox-alpha` registry row. Do not claim it live before a
   real 200.
2. Replace `Z_AI_API_KEY` with a genuine Z.ai (GLM Coding Plan) key, then
   enable `glm-5.3`. Do not claim it live before a real 200.
3. Decide on Manus: when ready, provide a Manus credential and a safe read-only
   probe before enabling; keep `ENVIRONMENT_BLOCKED` until then.
4. Optional real image-generation test: upgrade the Gemini key to a
   billing-enabled plan and run one real generation to promote
   `IMAGE_GENERATION_REAL_CALL` to VERIFIED (the flow is implemented and
   component-tested).
5. Renew OpenAI/Anthropic/Grok keys or billing if those tiers are to be used.
6. None of these require secrets in chat; re-run `secret:scan` +
   `db:migrate:status` after any key change.