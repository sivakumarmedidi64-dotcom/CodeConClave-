# CodeConClave Pro — New Provider API Keys (Founder Guide)

**Directive:** CODECONCLAVE PRO — PROVIDER KEY PREPARATION + API ROUTE VERIFICATION (Pre-Prompt 3 Provider Configuration Gate).
**Date:** 2026-09-08

## What this guide is

This is the founder-facing manual for obtaining and storing the API keys for the **seven providers**
requested for Pro: **Ox Alpha, Google Gemini, Manus AI, Big Pickle, Qwen, Gemma, and Z Code 5.3**.
Every provider identity, API route and auth method below was **verified from public/official
documentation** — nothing was invented. No real call was performed yet because **no key is installed**,
so every provider is honestly `ENVIRONMENT_BLOCKED` (verified, but no key → no real call).

Single source of truth in code: `backend/src/modules/ai/providerKeySpec.ts` (used by tests + this doc).

## Verification status vocabulary

| Status | Meaning |
|---|---|
| `VERIFIED` | identity + API route + auth confirmed from vendor/official docs **and** a real call was performed |
| `ENVIRONMENT_BLOCKED` | verified identity/route/auth, but the API key is absent → no real call performed |
| `UNVERIFIED` | identity could not be established — **never** store a key for an unverified provider |

State is **NEVER** upgraded to `VERIFIED` without a successful real call (health or single inference).
`UNVERIFIED → VERIFIED` is impossible by documentation alone.

---

## The seven providers

### 1. Google Gemini — `ENVIRONMENT_BLOCKED`
- **API key variable:** `GEMINI_API_KEY`
- **Where to get it:** Google AI Studio → API keys (https://aistudio.google.com/apikey). Can also be provisioned through Google Cloud Vertex.
- **Base URL:** `https://generativelanguage.googleapis.com/v1beta` (an OpenAI-compatible endpoint exists at `/v1beta/openai`).
- **Model IDs (seeded):** `gemini-3.7-flash` (enabled), `gemini-2.5-pro` (disabled). Current official families also include Gemini 3.6/3.5/3.1 Flash, 3.1 Pro and 3 Flash — verify current ids before Prompt 3.
- **Capability:** `MODEL` (chat/vision). Image generation is a separate track (Nano Banana 2 / `gemini-3-pro-image`) — do not feed a chat model an image-generation task.
- **Real call:** NO · **Environment blocked:** YES.

### 2. Qwen — `ENVIRONMENT_BLOCKED`
- **API key variable:** `QWEN_API_KEY`
- **Where to get it:** Alibaba Cloud **Model Studio / DashScope** (bailian.console.aliyun.com) for mainland, or the QwenCloud platform (platform.qianwenai.com) / DashScope Intl for international. Key is a `sk-*` Bearer token.
- **Base URL:** `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions` (Intl, OpenAI-compatible).
- **Model IDs (all five already seeded + enabled):** `qwen3.8-max` (flagship, thinking default-on), `qwen3.7-plus` (vendor-recommended default), `qwen3-coder-next` (coding), `qwen3.6-plus`, `qwen3.5-flash`.
- **Capability:** `MODEL`. **Real call:** NO · **Environment blocked:** YES.
- **Note:** the adapter already exists (`qwen` → QWEN_URL); only the key is missing. Readiness: **add key + append `qwen` to `AI_PROVIDERS_ENABLED`**.

### 3. Gemma — `ENVIRONMENT_BLOCKED`
- **API key variable:** `GEMINI_API_KEY` — **there is NO separate `GEMMA_API_KEY`.** Gemma is served through Google's LLM API.
- **Where to get it:** identical to Google Gemini (above).
- **Base URL:** `https://generativelanguage.googleapis.com/v1beta` (Gemini-compatible model routes; wired via the `geminiAdapter`).
- **Model IDs (seeded):** `gemma-3-27b-it` (enabled today, provider health currently DOWN because no key). Newer official variants (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) exist — verify regional availability before Prompt 3.
- **Capability:** `MODEL`. **Real call:** NO · **Environment blocked:** YES.
- **Note:** adding `GEMINI_API_KEY` also activates the `google` provider; `gemma` additionally needs to be in `AI_PROVIDERS_ENABLED`.

### 4. Manus AI — `ENVIRONMENT_BLOCKED`
- **API key variable:** `MANUS_API_KEY`
- **Where to get it:** Manus developer platform (manus.ai) API keys page; optional OAuth clients.
- **Base URL:** `https://api.manus.ai` — **v2 async task API** (`task.create`, `task.listMessages`, `task.sendMessage`, `task.confirmAction`, `task.stop`). Auth via the `x-manus-api-key` header or OAuth bearer with scopes `create_task` / `manage_all_tasks`.
- **Model/agent profiles:** `manus-1.6`, `manus-1.6-lite`, `manus-1.6-max`.
- **Capability:** **`EXTERNAL_AGENT`** — structurally an autonomous-agent/task API (like Devin), NOT a chat-completions model.
- **Real call:** NO · **Environment blocked:** YES.
- **Note for Prompt 3:** must follow the `devinAdapter` pattern and never be a chat fallback — it requires `allowExternalAgents: true` at the call site. (An OpenAI-compatible route at `api.manus.im` exists but is NOT the canonical v2 task API.)

### 5. Ox Alpha — `ENVIRONMENT_BLOCKED`
- **API key variable:** `OX_ALPHA_API_KEY` (founder naming)
- **IMPORTANT — what the key actually is:** Ox Alpha is served through **OpenRouter** as the stealth listing `stealth/ox-alpha`; its architecture was revealed as **ZAI GLM-5.3-Flash**. **There is no first-party Ox Alpha dashboard** — the value stored in `OX_ALPHA_API_KEY` is an **OpenRouter API key** obtained at **https://openrouter.ai/keys** (format `sk-or-v1-...`).
- **Base URL:** `https://openrouter.ai/api/v1` (OpenAI-compatible, Bearer auth).
- **Model ID:** `stealth/ox-alpha` (free preview tier; ~1M context; streaming + tool calling supported by the gateway).
- **Capability:** `MODEL`. **Real call:** NO · **Environment blocked:** YES.
- **Secret-guard note:** an `OpenRouter API key` pattern (`sk-or-v1-...`) was added to the secret guard in this gate so these values are redacted everywhere.

### 6. Big Pickle — `ENVIRONMENT_BLOCKED` (production NOT recommended)
- **API key variable (intended):** `OPENCODE_ZEN_API_KEY`
- **Where to get it:** OpenCode Zen account + billing (https://opencode.ai/zen).
- **Base URL:** `https://opencode.ai/zen/v1` (OpenAI-compatible `chat/completions`).
- **Model ID:** `big-pickle`.
- **Capability:** `MODEL`. **Real call:** NO · **Environment blocked:** YES.
- **⚠️ DO NOT ADD THIS KEY YET.** Big Pickle is a free/stealth **smoke-test tier** on the OpenCode Zen gateway — **NOT intended for production workloads**, and at least one aggregator lists it disabled since 2026-08-14. Treat it as a preview. No `OPENCODE_ZEN_API_KEY` line has been added to `.env`/`.env.example` — only a comment explaining why.
- **Verification honesty:** identity/API route are verified from the opencode project itself; production suitability is **not** — hence the key stays out.

### 7. Z Code 5.3 (Z.ai GLM-5.3 / ZCode) — `ENVIRONMENT_BLOCKED`
- **API key variable:** `Z_AI_API_KEY`
- **Where to get it:** Z.ai platform (https://z.ai) API key. At launch the coding API requires a **GLM Coding Plan** subscription.
- **Base URL:** `https://api.z.ai/api/v1` (OpenAI chat completions); also `/api/paas/v4` and `/api/anthropic`.
- **Model ID:** **`glm-5.3`** — 1M context, reasoning always-on with `reasoning_effort` ∈ {low, high, max}, launched 2026-08-14, API live 2026-08-18.
- **Capability:** `MODEL`. **Real call:** NO · **Environment blocked:** YES.
- **⚠️ Model-ID mismatch that MUST be fixed in Prompt 3:** the existing DB registry row uses `model_id = 'z-code-5-3'`, which is **NOT** the vendor API id (`glm-5.3`). The row is currently disabled. Aligning this is Prompt 3 work, not this gate.

---

## Rules you (the founder) must follow

1. **Never paste a key into a chat or support request.** Keys are inserted **only** into the server `.env` (or the deploy environment's secret store).
2. **Never commit a key.** `.env` is git-ignored; `.env.example` must always contain **empty** (`VAR=`) placeholders only.
3. Storing a real key in `.env` is not enough: the provider must also be on the **`AI_PROVIDERS_ENABLED`** allow-list, or it stays inert (configured-but-not-enabled, never called).
4. **Do not enable a provider before its adapter exists** (Prompt 3). Until then, keeping `AI_PROVIDERS_ENABLED` unchanged means nothing new can be routed or called.
5. `UNVERIFIED` providers never get a key — full stop.
6. After adding any key: run the backend typecheck, the AI/registry tests, and the secret scan before restarting the server.

## .env placeholders added in this gate (all verified-empty)

```
GEMINI_API_KEY=
QWEN_API_KEY=
OX_ALPHA_API_KEY=
MANUS_API_KEY=
Z_AI_API_KEY=
```

Plus a `# DO NOT ADD OPENCODE_ZEN_API_KEY YET` comment for Big Pickle (see `docs/CODECONCLAVE_NEW_PROVIDER_MATRIX.md` for the full comparison).