# CodeConClave Pro — Image Generation (Prompt 4)

## Summary

Image generation is a canonical, non-bypassing gateway operation, invoked ONLY
by explicit user intent (composer **Image mode → `imageRequest: true`**). The
produced image is persisted server-side as a project file attached to the
assistant message; the client receives only `{ fileId, mimeType }` via the SSE
`image` event and streams the bytes from the project file content endpoint.

## Canonical op (`gateway.ts`)

`generateImageCompletion(ctx, prompt, opts)`:

- routes with `taskType: IMAGE_GENERATION`,
  `capability: 'IMAGE_GENERATOR'`, `imageGeneration: true` (compute class B)
  through the SAME gateway rails as every other completion;
- `eligibleModels` requires `imageGeneration` → only explicitly-registered
  image models (e.g. `gemini-3-pro-image`) are candidates;
- `logUsage` records the capability, task type and routing preference;
- `onChunk` surfaces `delta` + `image` chunks to the caller.

## Persistence (`files/service.ts`)

`persistGeneratedImage(user, project, { dataB64, mimeType, messageId?, prompt? })`:

- stores bytes through the existing storage gateway (encryption honored),
- inserts the `files` row (category `image`, preview metadata), a `file_versions`
  row (v1, `change_reason='generated'`), and a `file_references` row
  (`ref_type='message'`) when a message id is attached,
- increments storage usage and audits `ai.image_generated`.

## Chat pipeline (`chat.ts`)

`sendImageGeneration` is a dedicated, honest path:

1. Requires a selected project (mirrors the attachments rule) — otherwise
   `project_required`.
2. Persists user message + assistant message (STREAMING).
3. Runs the canonical image op; on `image` → `persistGeneratedImage` →
   `events.onImage`.
4. Writes COMPLETED with `imageFileId`/`imageMime`, tokens/cost usage, `done`.
5. Failure → FAILED message + `ai.image_generation_failed` audit.

`messages`/`Message` gains `image_file_id` + `image_mime` (0073); conversation
mode gaines `'IMAGE'` (constraint widened additively).

## Frontend (Web = Desktop)

- Composer **Image** toggle (CHAT mode, requires a project), placeholder
  switches to “Describe the image to generate…”, model pin is dropped for the
  image op (AUTO routing picks the image generator).
- SSE parser maps `image` events; the assistant bubble renders an inline
  `<img>` (max ~420px) with a **Download** link to the project file content.
- Replay/continuity: loaded messages restore `imageFileId`/`imageMime` from the
  message contract.

## Honest state (this gate)

- ✓ Adapter/op/persistence/UX: implemented and covered by unit tests.
- ✓ Registry: `gemini-3-pro-image` present in the live Gemini model list.
- ✗ A REAL generation round-trip was NOT executed from this codebase in this
  gate (no founder key exercised against the image endpoint here). Capability is
  therefore recorded as implemented + tested, real-call **pending**; no
  fabricated “works” claim. `providerKeyState` for google is VERIFIED (text +
  multimodal + model enumeration proven), independent of the image call.