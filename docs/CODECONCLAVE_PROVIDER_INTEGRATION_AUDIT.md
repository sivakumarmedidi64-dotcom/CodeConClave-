# CodeConClave Pro — Provider Integration Audit (Prompt 3)

## Verdict

**PROVIDER INTEGRATION GATE: CONDITIONAL_PASS**

Integration is complete and proven by tests + migrations for all six requested providers; _real_ API
calls verified three (google text/multimodal/models.list, qwen, gemma). Two providers are blocked only
by invalid stored credentials (ox_alpha, z_code_5_3); one is environment-blocked by the gate's
no-task-creating-call rule (manus). No deployment was performed; no audit exemption is claimed.

## Scope assertions

1. **No new AI engine.** Every new provider runs through the existing adapter abstraction in
   `backend/src/modules/ai/providers.ts` and the existing gateway/router. No parallel router exists.
2. **Routes flow through the verified helpers.** New arms reuse `sseReader`, `openAiMessages`,
   `httpError`, `classifyProviderError`, `deriveStatusFromFailure` — no bespoke error handling.
3. **Gemma uses the Gemini key.** No `GEMMA_API_KEY` invented; `gemma` maps to `env.GEMINI_API_KEY`.
4. **Z Code uses the verified vendor id.** Registry row is `glm-5.3` against `api.z.ai` (0071).
5. **Manus stays EXTERNAL_AGENT.** Registry row disabled; `supportsToolCalls: false`; adapter is a
   task-lifecycle wrapper, not a chat-completions client.
6. **Web + desktop share the backend contract.** `/models` exposes `imageGeneration`/`imageEditing`;
   `frontend/src/lib/types.ts` mirrors them. No separate AI client in desktop.
7. **No secret exposure.** Keys exist only in repo-root `.env` (gitignored) and request headers.
   Report/audit docs contain variable names and endpoints, never key material.
8. **No feature removal, no payment change.** `FEATURES_REMOVED = 0`, `FEATURES_UNMAPPED = 0`
   (denominator 336 unchanged).

## Verification

| Check | Evidence | Result |
| --- | --- | --- |
| Adapter contract for all new providers | provider-adapter-53 (PAI-53.1) | ✅ |
| Gemini multimodal input normalization | PAI-53.2 (inlineData base64, fileData URL, usageMetadata, x-goog-api-key) | ✅ |
| Routing to image-capable model; explicit capability flags | PAI-53.3/53.4 (image generation/editing), model-routing-51 | ✅ |
| Failure taxonomy + short-circuit honesty | PAI-53.5 (401→invalid_credentials/REQUIRES_REAUTH, 404→provider_error, abort) | ✅ |
| Token/cost accounting skips images | PAI-53.6 (`messageTextChars`) | ✅ |
| Capability flags reach web+desktop contract | PAI-53.7, model-routing-51 | ✅ |
| Key-config semantics (VERIFIED/KEY_INVALID/BLOCKED) | provider-key-config-52 | ✅ |
| getAdapter builds ox/z/manus arms; missing-key throws | provider-expansion-50 | ✅ |
| Registry/provider list transparency | provider-key-config-52, ai-transparency-26 | ✅ |
| Backend full suite | 152 files / 2814 passed / 8 skipped | ✅ |
| Payment proof suite | prove-payment: 16 passed | ✅ |
| Frontend suite | 73 files / 401 passed | ✅ |
| Desktop suite | 5 files / 58 passed | ✅ |
| Typecheck + build × (shared/backend/frontend/desktop) | all green | ✅ |
| Secret scan (repo-wide) | 846 files, 0 findings | ✅ |
| Migrations 0071 + 0072 | applied (migrate status `[x]`) | ✅ |

## Honest status table

| Provider | Adapter | Row state | Real call | Status |
| --- | --- | --- | --- | --- |
| google (text/multimodal) | gemini | enabled (gemini-3.7-flash) | yes ×2 | VERIFIED |
| google (image gen) | geminiImage | enabled (gemini-3-pro-image) | model confirmed live | VERIFIED (capability) |
| qwen | qwen | enabled | yes | VERIFIED |
| gemma | gemini (GEMINI key) | enabled (gemma-4-31b-it) | yes | VERIFIED |
| ox_alpha | openaiCompat→OpenRouter | disabled | no (401) | KEY_INVALID |
| z_code_5_3 | openaiCompat→api.z.ai | disabled | no (wrapped 401) | KEY_INVALID |
| manus | manus (v2 task) | disabled | no (blocked) | ENVIRONMENT_BLOCKED |

## Founder remediation (gates to a full PASS)

- Replace `OX_ALPHA_API_KEY` with a real OpenRouter key (`sk-or-v1-…`), re-run the verification
  script, and enable `ox_alpha` rows (registry + provider_health).
- Replace `Z_AI_API_KEY` with a genuine Z.ai key (GLM Coding Plan), re-verify `glm-5.3`, enable row.
- Provide a safe (read-only) verification path for Manus or explicit approval, then enable the row.
This change set is intentionally frozen after this gate per the stop rules.