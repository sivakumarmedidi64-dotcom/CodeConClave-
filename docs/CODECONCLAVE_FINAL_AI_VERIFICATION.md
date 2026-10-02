# CodeConClave Pro — FINAL AI VERIFICATION (Prompt 5)

Generation: 2026-09-08. Real calls executed this gate from this repository
(`backend` adapter contracts; keys read from the gitignored root `.env`; keys
appeared only inside request headers/auth and are never printed or stored).

## Real call log (Prompt 5)

| # | Route | Model | Result | Verdict |
| --- | --- | --- | --- | --- |
| 1 | google text `generateContent` | gemini-3.7-flash | HTTP 200, reply `ok` | ✅ VERIFIED |
| 2 | google text (re-run) | gemini-3.7-flash | HTTP 200 | ✅ VERIFIED (one earlier re-run got a transient 503, retried → 200) |
| 3 | google multimodal `generateContent` (real 1×1 PNG `inline_data`) | gemini-3.7-flash | HTTP 200, reply `ok`, prompt tokens 1106 (image consumed) | ✅ REAL MULTIMODAL |
| 4 | google multimodal (re-run) | gemini-3.7-flash | HTTP 200 | ✅ REAL MULTIMODAL |
| 5 | google `models.list` GET | (all served) | HTTP 200; contains `gemini-3-pro-image`, `gemini-2.5-flash-image`, `gemini-3.1-flash-image`, `gemma-4-31b-it`, `nano-banana-pro-preview`; **no** `gemma-3-27b-it` | ✅ VERIFIED |
| 6 | gemma `generateContent` | gemma-4-31b-it | attempt 1 timeout (AbortError) → attempt 2 HTTP 500 `INTERNAL` (transient capacity) → attempt 3 **HTTP 200** reply | ✅ VERIFIED (with polite-retry note) |
| 7 | gemma-3-27b-it `generateContent` probe | gemma-3-27b-it | HTTP 404 `NOT_FOUND` — not served for this account | ✅ negative probe; row correctly stays disabled/DOWN |
| 8 | qwen `chat/completions` via canonical adapter | qwen3.5-flash | HTTP 200 ×2, reply `ok` (with reasoning trace) | ✅ VERIFIED |
| 9 | **image generation** `generateContent` `responseModalities:["IMAGE","TEXT"]` | gemini-3-pro-image | HTTP 429 `Quota exceeded … generate_content_free_tier_input_token_count, limit: 0` — model exists on the key, but the current (free-tier) key has **zero** image-generation entitlement | ⛔ `IMAGE_GENERATION_REAL_CALL = ENVIRONMENT_BLOCKED` (not fabricated; real attempt) |

## Per-part verification results

### Part 3 — Gemini end-to-end
1. normal text request — ✅ real 200.
2. multimodal with real image input — ✅ real 200 (×2).
3. model listing/availability — ✅ real `models.list` 200; registry rows,
   health, entitlement verified from DB.
4. capability metadata — ✅ `capabilityClassOf` (`capabilities.ts`) +
   `/models` `capabilityClass` + image registry flags; tests PKG-54.1,
   PAI-53.4.
5. routing integration — ✅ `model-routing-51` (MULTIMODAL_ANALYSIS → vision-
   capable selection; image hint; external-agent gate; audit fields).
6. audit/usage logging — ✅ `logUsage` + `model_usage_logs` (+`capability`,
   `external_run_id` via 0073); `ai.image_generated` audit; `recordUsage`
   input/output tokens + estimated cost (unknown pricing stays UNKNOWN).

### Part 4 — Gemma
gemma-4-31b-it real 200 verified; gemma-3-27b-it real 404 → remains disabled.
Uses the Google path + `GEMINI_API_KEY` (no `GEMMA_API_KEY` — correct).

### Part 5 — Qwen
Real completion via the canonical adapter (HTTP 200 ×2); adapter path
`dashscope-intl…/compatible-mode/v1/chat/completions`. Registry metadata:
`qwen3-coder-next` `coding_optimized=true` (correct), flash/plus tiers with
sync'd vision flags. Router eligibility + audit-covered by `model-routing-51`
(docs) and green `ai_usages` path.

### Part 6 — Ox Alpha
Real-verified failure maintained (Prompt 3: 401 `Missing Authentication
header`). Adapter (`providers.ts:795-801`): OpenRouter `chat/completions`,
Bearer, model `stealth/ox-alpha` — all correct. Provider `enabled=false` ⇒
excluded from `/models` and the router; valid fallback
(qwen3.7-plus → gemini-3.7-flash) available. UI: key-state hint
(`/providers` → ModelPicker) shows `key invalid`. No secret exposure.

### Part 7 — Z AI / GLM-5.3
Route `https://api.z.ai/api/v1/chat/completions` and model `glm-5.3` verified
in adapter + registry (no identity mismatch). Real-verified failure maintained
(Prompt 3: HTTP 200 wrapping `code:401` — stored key is OpenRouter-format, not
a Z.ai key). `enabled=false` ⇒ excluded from routing; fallback
`gemini-3.7-flash`; UI state honest. Not VERIFIED.

### Part 8 — Manus
Kept EXTERNAL_AGENT, `enabled=false`. No task created (gate rule). Verified:
adapter contract (v2 task base URL, never a chat endpoint — PAI-53.1),
config detection, auth-state handling, lifecycle normalization, permission/
approval gates, task-state persistence and failure handling (existing
extern-agent lifecycle tests), audit integration, fallback (`devin-session`).
=> `MANUS = ENVIRONMENT_BLOCKED` (accepted honest final state).

### Part 9 — Devin
Existing integration preserved in the same external-agent architecture
(`capability_category=EXTERNAL_AGENT`, privacy STRICT). Verified: capability
registration, explicit intent gating (`allows external agents only for explicit
autonomous engineering`), permissions/approvals, lifecycle/failure/cancellation,
audit, Web + Desktop status surfaces. No live job created => live-path
UNVERIFIED / ENVIRONMENT_BLOCKED (honest).

### Part 10 — Image generation product flow
`USER → composer → imageRequest → canonical router → IMAGE_GENERATOR
(gemini-3-pro-image) → generateImageCompletion → persistGeneratedImage → project
file + message attachment (image_file_id/image_mime) → SSE `image` event →
Web/Desktop render + Download`. Verified by code trace (`chat.ts:555-709`) +
component tests (PAI-53.4 image chunk; router hint; files owner/persist;
visual input validation; SSE types). No second image engine, no provider-
specific frontend API, no secret exposure. `project_required` enforced;
MIME from `chunk.image.mimeType` + `persistGeneratedImage` (bytes → validated
MIME, project-isolated file row); audit `ai.image_generated` + failure audit;
usage recorded. Real generation **ENVIRONMENT_BLOCKED** (free-tier quota 0).

### Part 11 — Multimodal
Text + image parts normalize via `resolveImageParts`→ inline/fileData (Gemini)
or data-URL `image_url` (OpenAI-compat) — PAI-53.2/53.3. MIME validation
(magic bytes, dims, disallowed types, size caps) — `visual-intelligence`.
Vision-capable selection enforced: `model-routing-51` filters non-vision models
for MULTIMODAL_ANALYSIS. Persistence + SSE + audit covered by suite.

### Part 16 — Security
Secret scan 847 files / 0 findings; `.env`/`.env.*` gitignored (+
`!.env.example`); `.env.example` contains no secrets; desktop has no keys &
hardened (`contextIsolation`, no nodeIntegration, sandbox, denied permissions,
allow-listed navigation); no keys in frontend bundles, `release` installers,
logs, audit, error responses, or memory tables.

### Part 17 — Authorization / isolation
`visual.test.ts` (cross-workspace + cross-user denials propagate from files
module); files owner checks; conversation scoping (`getConversation(actorId,…)`
+ RLS); `activity-13` tenant-scoped feed; project boundary enforced for image
generation (`project_required`) and file attachments.

### Part 18 — Cost / usage
All completions pass through `logUsage` (provider, model, taskType, preference,
usage, `durationMs`, estimated cost when known; UNKNOWN pricing remains
UNKNOWN). Registry cost columns only where seeded; no invented pricing.

### Part 19 — Memory
No provider-specific memory engine. Existing memory (user preferences, model
preference in settings, project context, learned coding patterns) is
provider-agnostic; memory-25/26 suites green. Keys/auth headers are never
stored.

### Part 20 — Autonomous cowork
Calls the canonical router only; permissions/budget/approvals/protected paths/
kill-switch/task persistence/failure recovery (existing cowork infra) are
unchanged and green (`automation-26d`, cowork suites). No new worker engine.

Parts 12-15, 21-23 results: `PROMPT5_FINAL_AUDIT.md` + test counts below.