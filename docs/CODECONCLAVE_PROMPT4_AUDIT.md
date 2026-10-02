# CodeConClave Pro — Prompt 4 Audit (External Agents + Multimodal/Image + Provider Experience)

## Verdict

**PROMPT 4 GATE: CONDITIONAL_PASS**

External-agent canonical abstraction, multimodal input, the image-generation
foundation + user-facing workflow, and the honest provider-experience contract
are implemented, migration-applied, and regression-proven. Real-call status is
reported per provider with no fabricated claims; image **generation** itself is
implemented + tested but its real round-trip call is pending founder execution
(this gate ran no image endpoint call). No deployment, no payment change, no
feature removal.

## Scope assertions (Prompt 4)

1. **No new AI engine / no parallel router.** External agents ride the existing
   adapter abstraction in `providers.ts`; image generation rides the existing
   gateway (`generateImageCompletion`); routing stays in `router.ts`/`gateway`.
   `devin-session` and `manus-1.6` are EXTERNAL_AGENT registry rows with
   session/task lifecycle wrappers — not chat clients.
2. **External agents only via explicit intent; never silently substituted.**
   A pinned external agent requires: enabled in registry + provider configured
   (`agent_not_configured` otherwise). Not routable in a normal text chain.
3. **Vision vs image generation vs image editing are distinct facts.**
   `supportsVision` ⇒ MULTIMODAL_MODEL; `imageGeneration|imageEditing` ⇒
   IMAGE_GENERATOR; EXTERNAL_AGENT category dominates. `needsVision` keeps the
   whole fallback chain vision-capable.
4. **Image generation is a canonical, non-bypassing op.** `imageRequest` is
   explicit (composer Image mode); server persists to project file,
   message-attached, audited; client only ever holds `{fileId, mimeType}` and a
   content URL.
5. **Honest key-state machine.** Six states; `KEY_INVALID` is NEVER
   auto-upgraded to `ENVIRONMENT_BLOCKED`; `big_pickle` is permanently
   `ENVIRONMENT_BLOCKED` (never-add-key). Keys exist only in the gitignored
   root `.env`; report/audit docs contain variable names + endpoints, never
   key material.
6. **Web + Desktop = same backend, same renderer.** All new surfaces are
   REST/SSE; Desktop needs zero additional code for the new flows.
7. **No feature removal / no payment change.** `FEATURES_REMOVED = 0`,
   `FEATURES_UNMAPPED = 0` (denominator 336 unchanged). Payment regression
   suite green.

## Code changes

- `shared/src/contracts.ts` — `imageRequest`; `domain/models.ts` — `Message`
  image fields + `CapabilityClass`.
- `database/migrations/0073_external_agents_images.sql` — `messages`
  `image_file_id`/`image_mime`; `model_usage_logs` `capability`/`external_run_id`;
  `conversations.mode` CHECK widened (CHAT/COWORK/IMAGE). **Applied.**
- `backend/src/modules/ai/capabilities.ts` — `capabilityClassOf` (+ vision/vs
  image derivation untouched).
- `backend/src/modules/ai/providers.ts` — `ExternalRunInfo`, `ChatChunk.image`,
  devin/manus running→finished `externalRun` chunks.
- `backend/src/modules/ai/gateway.ts` — `RouteOptions` image/capability,
  image-gen/editing eligibility filters, `logUsage` capability +
  external_run_id, `CompletionSummary.externalRun`, `generateImageCompletion`.
- `backend/src/modules/ai/providerKeySpec.ts` — `providerKeyState` machine.
- `backend/src/modules/ai/routes.ts` — `/models` `capabilityClass`;
  `/providers` per-provider `keyState`.
- `backend/src/modules/files/service.ts` — `persistGeneratedImage`.
- `backend/src/modules/conversations/service.ts` + `chat.ts` — Message
  image columns, vision parts, image-generation path, external-agent path +
  audits; mode `IMAGE`.
- `conversations/routes.ts` — SSE `image` + `external_agent` events.
- `frontend/src/lib/sse.ts` (+ types), `ChatPage.tsx` (Image mode,
  render/download, agent status), `ModelPicker.tsx` (capability chips).
- New tests `foundation/provider-experience-54.test.ts` (9).

## Verification

| Check | Evidence | Result |
| --- | --- | --- |
| capabilityClassOf truthful classification | PKG-54.1 (agent/image/multimodal/normal, no heuristics) | ✅ |
| providerKeyState honest machine | PKG-54.2 (big_pickle ENV_BLOCKED, unknown MISSING, canonical values, KEY_INVALID≠ENV_BLOCKED) | ✅ |
| DB-free env pinning | vitest.config (AI_PROVIDERS_ENABLED pinned) | ✅ |
| Backend full suite | 153 files / **2823 passed** / 8 skipped | ✅ |
| Payment regression | 7 files / **166 passed** | ✅ |
| Frontend suite | 73 files / **401 passed** | ✅ |
| Desktop suite | 5 files / **58 passed** | ✅ |
| Typecheck × shared/backend/frontend | green (shared rebuilt) | ✅ |
| Secret scan | 847 files, **0 findings** | ✅ |
| Migrations 0071–0073 | applied (`[x]` per migrate status) | ✅ |

## Real-call status (honest)

| Provider | Capability | Real-call in this gate? | State |
| --- | --- | --- | --- |
| google | text + real multimodal input + models.list | YES (Prompt 3, 200) | VERIFIED |
| qwen | text | YES (Prompt 3, 200) | VERIFIED |
| gemma | text via GEMINI key | YES (Prompt 3, 200) | VERIFIED |
| google | image GENERATION op | NO (endpoint not exercised here) | implemented+tests, real-call pending |
| devin | external-agent run | NO (no task-creating call permitted) | adapter tested; real run UNVERIFIED |
| manus | external-agent run | NO (no safe probe) | adapter tested; ENVIRONMENT_BLOCKED |
| ox_alpha / z_code_5_3 | — | NO (rejected) | KEY_INVALID (never auto-upgraded) |

## Gate exit conditions (Prompt 5)

1. Founder runs a real image-generation call (any environment) to move
   image-gen capability to VERIFIED (optional, does not block shipping).
2. Founder supplies valid keys for Devin (and/or Manus) if external-agent runs
   are to be exercised for real.
3. Recommend `npm run secret:scan` + `db:migrate:status` after any key change.
4. **STOP:** Prompt 5 is NOT started from this session.