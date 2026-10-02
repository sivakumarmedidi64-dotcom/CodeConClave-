# CodeConClave Pro — Final Provider Verification (real-call evidence)

Audit session date: 2026-09-08. Every live call below is a real HTTP round-trip
against the provider endpoint with the key present in the root `.env`; no call
was fabricated and no result was inflated. Harnesses were run with `node
--import tsx` from the repo root (temp scripts in the opencode temp dir).

## Live calls (summary table)

| Provider / model | Endpoint exercised | HTTP / transport result | Evidence | Verdict |
| --- | --- | --- | --- | --- |
| google — `gemini-3.7-flash` text | Gemini v1beta streamGenerateContent | 200 OK, streamed deltas | 2+ chars; health row written 2026-09-08 (1 success) | VERIFIED |
| google — multimodal (1×1 red PNG) | streamGenerateContent with image part | 200 OK, 5-char delta | intake of real image bytes | VERIFIED |
| google — `gemini-3-pro-image` | image generation endpoint | 429 insufficient billing quota | provider returned an explicit quota error | QUOTA_EXHAUSTED (capability-level; text route unaffected) |
| qwen — `qwen3.7-plus` | DashScope compatible-mode | 200 OK, 2–3-char delta | health row 2026-09-08 (1 success) | VERIFIED |
| gemma — `gemma-4-31b-it` | gemma chat endpoint | 200 OK once (27-char delta), then 500 ×2 | intermittent provider-side 500s; api round trips real | VERIFIED-DEGRADED |
| nemotron — `nvidia/nemotron-3.5-lightning-30b-a3b` | NVIDIA NIM | 200 OK, 16 recorded successes | real E2E fallback rows in `model_usage_logs` (grok failed → nemotron succeeded) | VERIFIED |
| deepseek — `deepseek-v4-flash` | api.deepseek.com | 402 with `{"error":{"message":"Insufficient Balance"}}` | explicit billing body | QUOTA_EXHAUSTED |
| kimi — `kimi-k2.6` | api.moonshot.cn | 401 invalid credentials | provider rejection | REQUIRES_REAUTH |
| grok — `grok-4.3` | api.x.ai | 403 invalid credentials | provider rejection; 11-failure health row | REQUIRES_REAUTH |
| anthropic — `claude-haiku-4-5` | api.anthropic.com | 400: request must include `anthropic-workspace-id` header (personal key) | explicit message; fix landed (see below) | REQUIRES_REAUTH / workspace config |
| openai — `gpt-4o-mini` | api.openai.com | 429 billing | provider rejection; 7-failure health row | QUOTA_EXHAUSTED |
| ox_alpha — `stealth/ox-alpha` | OpenRouter gateway | 401 invalid credentials | key content is invalid for the endpoint | KEY_INVALID |
| z_code_5_3 — `glm-5.3` | api.z.ai/chat/completions | HTTP 200 with body `{"code":401,"msg":"token expired or incorrect","success":false}` | adapter now surfaces this (see fix 3) | KEY_INVALID |
| devin / manus | session creation endpoints | NOT exercised (unsafe external work) | adapters lifecycle-tested only | ENVIRONMENT_BLOCKED |

## Gemini thinking-model note

`gemini-3.7-flash` is a thinking model. With `maxTokens=12` the entire budget
is consumed by reasoning → adapter reports MAX_TOKENS with 0 output text. With
≥512 tokens the completion streams normally. This is a model behavior, not an
adapter defect; the adapter path is correct.

## Legitimate fixes landed during this audit (all test-covered)

1. **402 → billing classification.** `httpError` now maps HTTP 402 to
   `provider_billing` (QUOTA_EXHAUSTED) and the billing-body regex includes
   `/insufficient[ _-]?balance/`. DeepSeek's 402 is no longer misread as a
   generic unavailable. (`backend/src/modules/ai/providers.ts`)
2. **Empty-completion guard for HTTP 200 failures.** The OpenRouter-compatible
   SSE reader now tracks whether any `delta` was seen; a stream that ends with
   zero output tokens (Z.ai-style `200` + error body, or a lone `[DONE]`)
   throws `provider_error` instead of returning an empty success.
3. **Anthropic workspace-header support.** `env.ts` adds optional
   `ANTHROPIC_WORKSPACE_ID`; the Ant anthropic adapter sends
   `anthropic-workspace-id` inside `headers` when configured (personal-key
   calls take effect).
4. **New proof file** `backend/src/foundation/provider-verification-audit-55.test.ts`
   — 6 tests (402→billing; Z-style silent 200→provider_error; `[DONE]`-only→
   provider_error; healthy chunk passes through; workspace header added only
   when configured). 6/6 green.
5. No other production code changed. No new migration. Frontend and Desktop
   needed no changes (server-authoritative ModelPicker remained the single
   source of provider truth).

## Honest caveats

- gemma is VERIFIED-DEGRADED: one real 200 OK, two 500s this session; the
  provider_health row honestly records the latest failure.
- Anthropic live success requires the founder to either supply
  `ANTHROPIC_WORKSPACE_ID` or a workspace-scoped key; the header path is now
  implemented and unit-proven.
- z_code_5_3 is DOWN even though the transport returned 200 — the fixed
  adapter now sees the error body; this makes previously silent incidents loud.