# CodeConClave Pro — Gemini Multimodal (Prompt 4)

## Summary

Gemini is the verified multimodal route into the product. Multimodal input is a
**first-class, server-normalized capability** — pixels are sent to a model that
is guaranteed vision-capable, never guessed onto a text-only contract.

## Provenance (Prompt 3 real verification)

- `google` (geminiAdapter): text + genuine image input + `models.list` all
  returned 200 with the real route/API key.
- Image-generation registered (0071) and enabled as `gemini-3-pro-image`
  (present in the live model enumeration); served by the dedicated
  `geminiImageAdapter`.

## Input normalization

`ChatContentPart` includes the canonical image part type used across the
pipeline:

```ts
{ type: 'image_base64', data: string /* base64 */, mimeType: string }
```

- `resolveImageParts` (chat.ts) converts image attachments to these parts
  (ownership enforced through the files gateway: `getFileContent`).
- `geminiPart` maps parts to Gemini `inlineData` (base64, mimeType); text parts
  stay in `text`.
- Text-only requests keep the plain-string message path entirely unchanged
  (regression-safe).

## Vision routing

- `needsVision: true` is set when image parts are present, so the ENTIRE
  fallback chain stays inside `supportsVision` models — a text-only fallback can
  never receive pixels.
- Attack surface is reduced: the last user message becomes parts only when an
  image is actually attached; otherwise history remains strings.
- Capability class: `supportsVision` ⇒ `MULTIMODAL_MODEL` (rendered as a
  `vision` chip in the model picker).

## Honest boundary

A model that accepts image input is `MULTIMODAL_MODEL`, never an image
**generator**. Image generation is a separate, explicitly-registered marker
(`imageGeneration`/`imageEditing` + `IMAGE_GENERATOR` class) routed through the
dedicated gateway op (see `CODECONCLAVE_IMAGE_GENERATION.md`). The two classes
never overlap in the UI or router.