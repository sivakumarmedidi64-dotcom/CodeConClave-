# CodeConClave Pro — Real Provider Verification (Prompt 3)

Honest per-provider verification with **real API calls** (no mocked responses; no secret is ever
printed — keys appear only inside request headers). Machine-readable export:
`docs/CODECONCLAVE_REAL_PROVIDER_VERIFICATION.json` (generated 2026-09-07T20:52:57Z).

| Provider | Mode | Endpoint | Model | HTTP | Verdict |
| --- | --- | --- | --- | --- | --- |
| google | text | `…/models/gemini-3.7-flash:generateContent` | gemini-3.7-flash | 200 ("OK") | ✅ VERIFIED |
| google | multimodal input | same | gemini-3.7-flash | 200 ("Coral") | ✅ VERIFIED |
| google | models.list | `…/models?pageSize=500` | (all) | 200 | ✅ VERIFIED |
| qwen | text | `dashscope-intl…/v1/chat/completions` | qwen3.5-flash | 200 ("OK") | ✅ VERIFIED |
| gemma | text | `…/models/gemma-4-31b-it:generateContent` | gemma-4-31b-it | 200 | ✅ VERIFIED |
| ox_alpha | text | `openrouter.ai/api/v1/chat/completions` | stealth/ox-alpha | 401 | ❌ FAILED / KEY_INVALID |
| z_code_5_3 | text | `api.z.ai/api/v1/chat/completions` | glm-5.3 | 200-wrapped 401 | ❌ FAILED / KEY_INVALID |
| manus | none | `api.manus.ai/v2` | manus-1.6 | — | ⛔ ENVIRONMENT_BLOCKED |

## Details worth recording

- **Gemma:** the previously seeded `gemma-3-27b-it` is **not served** for this account (404). The
  official served variant on this key is `gemma-4-31b-it`, which passed with a correct reply.
  `0072` disables the 27b row and inserts the 4-31b row. A transient 503 high-demand response was
  handled with polite retries; route + auth are otherwise valid.
- **Live Gemini model list (Google-served, relevant ids)**: `gemini-2.5-flash-image`,
  `gemini-3-pro-image`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image`,
  `gemini-3.1-flash-image-preview`, `gemini-3.1-flash-lite-image`, `gemma-4-26b-a4b-it`,
  `gemma-4-31b-it`, `nano-banana-pro-preview`.
- **Ox Alpha:** 401 `Missing Authentication header`. The stored `OX_ALPHA_API_KEY` begins with `fk-`;
  OpenRouter requires `sk-or-v1-…`. The route and `stealth/ox-alpha` model id are correct — only the
  credential is wrong.
- **Z Code 5.3:** HTTP 200 wrapping `{"code":401,"msg":"token expired or incorrect","success":false}`.
  The stored `Z_AI_API_KEY` is OpenRouter-format (`sk-or-v1-…`); api.z.ai rejected it. The low-level
  `/api/v1/chat/completions` route is correct — only the credential is wrong.
- **Manus:** the v2 task API has no read-only probe. A real request (`task.create`) would create an
  agent task — the gate rule forbids that from this codebase. Adapter wiring is tested with mocks;
  identity is documented in `CODECONCLAVE_NEW_PROVIDER_MATRIX.md`. Requires founder approval + a safe
  probe before enabling the row.

## Re-running

Real re-verification (after founder supplies replacements): run the script from the backend workspace
with the repo-root `.env` present. Keys are read from env; nothing is echoed.