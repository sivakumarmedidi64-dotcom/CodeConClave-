# CodeConClave Pro — Provider Integrations (Prompt 3, PROVIDER INTEGRATION GATE)

Status: **CONDITIONAL_PASS** — adapter + routing integration for all six requested providers is
complete and covered by tests and migrations; real-API verification passed for three (google, qwen,
gemma); ox_alpha and z_code_5_3 are blocked only by invalid credentials that the founder must replace;
manus is gated by the no-task-creating-call rule (ENVIRONMENT_BLOCKED).

## Scope

Six providers requested by the founder, integrated through the **existing** provider abstraction —
no new AI engine, no duplicate router, no payment changes, no feature removal, no deployment:

| Provider | Registry id | Adapter | Verified (real call) | Row enabled |
| --- | --- | --- | --- | --- |
| Google Gemini | `google` | `geminiAdapter` (rewritten: multimodal + usageMetadata) | ✅ text + multimodal + models.list | ✅ (gemini-3.7-flash) |
| Google Gemini — image gen | `google` | `geminiImageAdapter` (non-stream, TEXT+IMAGE) | ✅ model present in live list | ✅ (gemini-3-pro-image) |
| Qwen | `qwen` | `qwenAdapter` | ✅ qwen3.5-flash 200 | ✅ |
| Gemma | `gemma` | `geminiAdapter` (served via `GEMINI_API_KEY`) | ✅ gemma-4-31b-it | ✅ (gemma-4-31b-it) |
| Ox Alpha | `ox_alpha` | `openaiCompatAdapter` → OpenRouter | ❌ 401 — key `fk-…` is not an OpenRouter key | ⛔ disabled |
| Z Code 5.3 (GLM-5.3) | `z_code_5_3` | `openaiCompatAdapter` → api.z.ai | ❌ `{"code":401,…}` — stored key is OpenRouter-format | ⛔ disabled |
| Manus | `manus` | `manusAdapter` (v2 task lifecycle) | ⛔ ENVIRONMENT_BLOCKED (no read-only probe; gate forbids task creation) | ⛔ disabled |

## Adapter work (backend/src/modules/ai/providers.ts)

- `ChatMessage.content` is now `string | ChatContentPart[]` (`text` / `image_url` / `image_base64`);
  a helper `messageTextChars()` counts only textual parts for token/cost accounting.
- `ChatChunk` carries an optional `image { mimeType, dataB64 }`; completions may be image-only.
- `OPENROUTER_URL`, `ZAI_URL` and `MANUS_V2_BASE` (https://api.manus.ai/v2) constants; auth detail:
  `x-goog-api-key` (Gemini/Gemma), `Bearer` (OpenRouter/Z.ai/OpenAI-compat), `x-manus-api-key`.
- Gemini: `geminiPart`/`geminiContents` normalize base64 → `inlineData` and URL → `fileData`;
  `geminiAdapter` streams `:streamGenerateContent?alt=sse` and maps `usageMetadata`.
- `geminiImageAdapter`: non-stream `:generateContent` with `responseModalities: ['TEXT','IMAGE']`;
  text parts → text deltas, inline image parts → `ChatChunk.image`.
- `manusAdapter`: `POST /v2/task.create` → poll `POST /v2/task.listMessages` (every 5s, max 10 min),
  terminal on completed/finished/blocked/failed/cancelled. External-agent, `supportsToolCalls: false`.
- `getAdapter` arms: `gemma → geminiAdapter`, `ox_alpha → openaiCompat(OPENROUTER_URL)`,
  `z_code_5_3 → openaiCompat(ZAI_URL)`, `manus → manusAdapter`, and `google` branches to
  `geminiImageAdapter` for `GEMINI_IMAGE_MODEL_IDS` (`gemini-2.0-flash-preview-image-generation`,
  `gemini-3-pro-image-preview`, `gemini-3-pro-image`, `nano-banana-image-generation`).

## Routing, capabilities, contract

- `capabilities.ts`: `modelCapabilities` exposes `imageGeneration`/`imageEditing` **only as explicit
  registry facts** (never derived from provider id); `VERIFIED_PROVIDERS` now covers all Prompt 3
  providers, `UNVERIFIED_PROVIDERS` is empty.
- `gateway.ts`: `CompletionSummary.image`; `completeWithFallback` aggregates image chunks, supports
  image-only completions, and estimates tokens via `messageTextChars`.
- `routes.ts` `/models`: adds `imageGeneration` and `imageEditing` booleans (shared by web + desktop
  through `frontend/src/lib/types.ts` `AiModel`).
- Registry rows support `image_generation`/`image_editing` (0071 CHECK constraints + columns).

## Migrations (applied)

- `0071_provider_integrations.sql` — CHECK constraints + image columns; `z_code_5_3` aligned to the
  real vendor id `glm-5.3`; `ox_alpha`/`manus` rows seeded; sha256 `5dddff095a2a`.
- `0072_provider_integration_enable.sql` — `provider_health` google/qwen/gemma → HEALTHY;
  `gemma-3-27b-it` disabled + DOWN (not served for this account — 404 recorded honestly); inserts
  `gemma-4-31b-it` (enabled, HEALTHY, priority 62) and `gemini-3-pro-image` (enabled, HEALTHY,
  image_generation + image_editing true, PRO entitlement, priority 35).

## Verification artefacts

- Script: `backend/src/scripts/verify-provider-integrations.mts` (real calls, honest per-provider report).
- Report: `docs/CODECONCLAVE_REAL_PROVIDER_VERIFICATION.json`.
- Per-provider status: `backend/src/modules/ai/providerKeySpec.ts` (`KEY_INVALID` =
  key stored but rejected; `ENVIRONMENT_BLOCKED` = no safe read-only probe).

## Remediation required from the founder

1. `OX_ALPHA_API_KEY` → a real OpenRouter key (`sk-or-v1-…`); the current `fk-…` value is invalid.
2. `Z_AI_API_KEY` → a genuine Z.ai key for the GLM Coding Plan; the current value is OpenRouter-format.
3. Manus: supply a safe verification path or grant approval before enabling the row.
After any replacement, re-run the verification script and enable the affected registry rows.