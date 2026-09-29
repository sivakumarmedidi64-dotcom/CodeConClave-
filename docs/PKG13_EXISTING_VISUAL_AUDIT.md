# PKG-13 — EXISTING VISUAL AUDIT

Status: COMPLETE (reference for the visual-intelligence module).
Scope: audit-only; documents what exists, what is reusable, what is missing, and
what must stay truthful. No existing functionality is deleted or modified by this
audit.

---

## 1. Diagrams — `backend/src/modules/developer-productivity/flowDiagram.ts`

- PURPOSE: Generate Mermaid-syntax diagrams (12 types: flowchart, sequence,
  architecture, dependency, database, class, state, er, gantt, pie, gitgraph,
  journey) from real project evidence.
- CURRENT_IMPLEMENTATION: `generateDiagram(userId, options): Promise<GeneratedDiagram>`.
  Data-driven for flowchart/dependency/database/class/gantt/pie; template-based
  for sequence/architecture/journey; hardcoded FSM for `state`; honest mock for
  gitgraph (explicit warning).
- REUSABLE: YES — `generateDiagram` and all `DiagramType`s, especially `state`
  for state-machine visualization. `escapeMermaid`, `sanitizeId` available.
- MISSING: no general-purpose state-machine ANALYSIS (state type is a hardcoded
  execution-engine FSM); no pixel rendering (text-only Mermaid).
- SECURITY_RISK: LOW (parameterized SQL); `assertProjectAccess` checks project
  existence but not membership in some paths.
- REAL_RUNTIME_STATUS: FUNCTIONAL (text output); some types template-based.

## 2. Architecture Visualization — `engineering-intelligence/architectureOracle.ts`

- PURPOSE: Architecture-level analysis: dependency graph, circular-dependency
  detection (proper DFS), impact analysis, risk detection, change history.
- CURRENT_IMPLEMENTATION: `getArchitectureSummary`, `getDependencyGraph`,
  `analyzeImpact`, `detectArchitectureRisks`, `getArchitectureChangeHistory`.
- REUSABLE: YES — `getDependencyGraph` returns typed `DependencyGraph` nodes/edges
  ideal for rendering as a Mermaid architecture diagram.
- MISSING: no visual output (produces data structures).
- SECURITY_RISK: LOW (parameterized SQL).
- REAL_RUNTIME_STATUS: FUNCTIONAL (heuristic, evidence-based, not AST-level).

## 3. Screenshots / Privacy — `backend/src/modules/agent/screenshot.ts`

- PURPOSE: Privacy foundation for remote screenshots: capture adapter, privacy
  gate, sensitive-region masking.
- CURRENT_IMPLEMENTATION: `assertScreenshotAuthorized()` (fully functional — 5
  checks), `ScreenshotSource`/`UnavailableScreenshotSource` (capture returns null),
  `sensitiveRegionsFor()` (stub → []), `screenshotSource()` (returns unavailable).
- REUSABLE: YES — `assertScreenshotAuthorized` privacy gate + adapter pattern.
- MISSING: no real capture source; no image decode; sensitiveRegions stub.
- SECURITY_RISK: LOW (privacy gate is solid).
- REAL_RUNTIME_STATUS: CAPTURE = honest unavailable; PRIVACY GATE = functional.

## 4. Visual Diff / Snapshots — `backend/src/modules/preview/snapshots.ts`

- PURPOSE: Capture preview snapshots at build transitions; provide before/after
  comparison.
- CURRENT_IMPLEMENTATION: `capturePreviewSnapshot`, `previewVisualDiff` (returns
  two most recent snapshots or `{available:false}`), `snapshotOnTransition`.
- REUSABLE: YES — snapshot/metadata before/after diff model + honest
  `available:false` pattern. NOT pixel comparison.
- MISSING: pixel-level image comparison (text/metadata only).
- SECURITY_RISK: LOW.
- REAL_RUNTIME_STATUS: FUNCTIONAL (text/metadata), NOT pixel-level.

## 5. Files / Image Ingestion — `backend/src/modules/files/service.ts`

- PURPOSE: Provider-agnostic file storage, upload, download, versions, security.
- CURRENT_IMPLEMENTATION: `uploadFile(userId, projectId, path, buffer, mime, opts)`
  and `getFileContent(userId, projectId, fileId) -> { buffer, mimeType, name }`.
  Full security: path traversal rejection, protected-name blocking, executable
  blocking, MIME inference/blocking, size limit (`MAX_UPLOAD_MB`), SHA-256
  integrity, at-rest encryption, per-project isolation, audit.
- REUSABLE: YES — image upload security and ownership/isolation are production-grade.
  Visual intelligence will reuse `getFileContent` for secure buffer access.
- MISSING: no image metadata extraction (dimensions, EXIF); image previews are
  honest `UNAVAILABLE`.
- SECURITY_RISK: LOW (robust).
- REAL_RUNTIME_STATUS: FUNCTIONAL.

## 6. Image Metadata — (none)

- PURPOSE: extract dimensions/format/colorspace from image buffers.
- CURRENT_IMPLEMENTATION: NOT PRESENT. No sharp/jimp/canvas/pngjs dependency.
  `package.json` has NO image-processing library.
- REUSABLE: NO (nothing exists).
- MISSING: full metadata extraction. PKG-13 will add deterministic header parsing
  (PNG/JPEG/WebP/GIF) without an external library.
- SECURITY_RISK: N/A.
- REAL_RUNTIME_STATUS: UNAVAILABLE today.

## 7. OCR — `backend/src/modules/payments/evidence.ts` (`parseOcrText`)

- PURPOSE: extract payment signals from already-extracted text.
- CURRENT_IMPLEMENTATION: `parseOcrText(text)` is a REGEX TEXT PARSER, not OCR.
  It runs on pre-extracted text; image-to-text is an external step that is not
  present.
- REUSABLE: PARTIAL — only as a text-parser reference; must NOT be called OCR.
- MISSING: a real OCR engine.
- SECURITY_RISK: LOW.
- REAL_RUNTIME_STATUS: TEXT PARSER = functional; REAL OCR = UNAVAILABLE.

## 8. Vision-Provider Routing — `backend/src/modules/ai/gateway.ts`

- PURPOSE: AI model routing + compute governance; select models by plan,
  health, capability, privacy, cost.
- CURRENT_IMPLEMENTATION: `routeModels(userId, { needsVision })`,
  `completeWithFallback`, `eligibleModels`. `needsVision: true` filters to
  `supports_vision` models. NO vision-capable model is configured in this
  environment (`supports_vision=false` in the registry); `ChatMessage` is
  text-only (no image_url content parts).
- REUSABLE: YES — vision routing API exists and must be used (never bypass the
  gateway with ad-hoc provider calls). But real vision is ENVIRONMENT_BLOCKED.
- MISSING: configured vision model + image content parts in the message format.
- SECURITY_RISK: LOW (entitlement + budget gated).
- REAL_RUNTIME_STATUS: ROUTING = functional; REAL VISION = ENVIRONMENT_BLOCKED.

## 9. Frontend Visual Surfaces

- PURPOSE: render visual/analysis panels.
- CURRENT_IMPLEMENTATION: `TeamCollabPanel.tsx` pattern (read-only, honest
  states); `SettingsPage.tsx` billing; `DemoPaymentActivatePage.tsx`.
- REUSABLE: YES — Panel conventions (useState + `api()` + load on mount + honest
  loading/error).
- MISSING: a visual-intelligence panel.
- SECURITY_RISK: LOW.
- REAL_RUNTIME_STATUS: FUNCTIONAL (frontend patterns).

## 10. B1 Review / Remediation — `backend/src/modules/reviews/`

- PURPOSE: cowork safety review loop; code changes go through DRAFT→READY→
  APPLIED→TEST→COMMIT and never auto-apply without acceptance.
- CURRENT_IMPLEMENTATION: `createReview(userId, projectId, { taskId, files, ... })`
  and the full review lifecycle; `ReviewStatus`/`HunkStatus` state machines.
- REUSABLE: YES — PKG-13 code proposals must route through `createReview` and the
  B1 flow; the module never auto-edits source.
- SECURITY_RISK: LOW (server-authoritative).
- REAL_RUNTIME_STATUS: FUNCTIONAL.

---

## Cross-Cutting Notes for PKG-13
- No real multimodal/vision provider, no real OCR engine, no pixel comparison
  library, no image-processing library exist. PKG-13 must keep these states
  truthful: MULTIMODAL_VISION=ENVIRONMENT_BLOCKED/UNAVAILABLE, OCR=UNAVAILABLE,
  PIXEL_VISUAL_COMPARISON=ENVIRONMENT_BLOCKED (unless pixels derivable),
  SCREENSHOT_UNDERSTANDING=HEURISTIC_ONLY (no semantic understanding of arbitrary
  images without a real vision provider).
- Reuse: `generateDiagram` (flow/architecture/state), `architectureOracle`
  (`getDependencyGraph`), `files` (`getFileContent`/`uploadFile` for secure image
  intake + isolation), `knowledge/security` (`detectPromptInjection`),
  `knowledge/cache` (cache pattern), `reviews` (B1 proposal), `ai/gateway`
  (`routeModels` with `needsVision` when a vision model exists), `preview/snapshots`
  (honest diff model).
