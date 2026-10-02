# PKG-13 Implementation Plan — Visual Intelligence

## Audit Summary

### Existing Visual Foundations (Reuse These)
| Component | File | Lines | Status |
|---|---|---|---|
| Diagram Generation (12 Mermaid types) | `backend/src/modules/developer-productivity/flowDiagram.ts` | 850 | FULLY FUNCTIONAL |
| Architecture Visualization | `backend/src/modules/engineering-intelligence/architectureOracle.ts` | 475 | FULLY FUNCTIONAL |
| Screenshot Privacy Gate | `backend/src/modules/agent/screenshot.ts` | 83 | STUB (honest unavailable) |
| Image Upload/Files | `backend/src/modules/files/service.ts` | 1079 | WORKS (no analysis) |
| Visual Diff (text-based) | `backend/src/modules/preview/snapshots.ts` | 110 | TEXT-BASED ONLY |
| OCR Text Parser | `backend/src/modules/payments/evidence.ts` | 445 | TEXT PARSER ONLY |
| AI Gateway Vision Routing | `backend/src/modules/ai/gateway.ts` | 650 | ROUTING EXISTS, NO VISION MODELS |

### What Doesn't Exist (Honest)
- No real multimodal/vision model configured (`supports_vision=false` everywhere)
- No pixel-level image comparison
- No real OCR engine
- No image processing library (sharp/jimp/canvas)
- ChatMessage is text-only (no image_url content parts)

---

## Implementation Plan

### STEP 1: Create `backend/src/modules/visual-intelligence/types.ts`
Define all Zod schemas and TypeScript interfaces:
- `VisualAnalysisType` enum: `SCREENSHOT`, `UI`, `DIAGRAM`, `ARCHITECTURE`, `STATE_MACHINE`, `METADATA`
- `VisualCapabilityStatus` enum: `AVAILABLE`, `UNAVAILABLE`, `ENVIRONMENT_BLOCKED`, `NOT_IMPLEMENTED`
- `ImageMetadata` interface: dimensions, format, fileSize, colorSpace, hasAlpha, mimeType
- `VisualAnalysisRequest` schema: imageFileId, analysisType, options
- `VisualAnalysisResult` interface: type, findings, metadata, confidence, provider, limitations
- `ScreenshotAnalysisResult` interface: extends VisualAnalysisResult with regions, defects, components
- `UIAnalysisResult` interface: regions, components, text, hierarchy, layout, defects
- `CodeProposal` interface: language, code, description, evidence, assumptions, riskLevel
- `DiagramToCodeRequest` schema: diagramType, content, targetLanguage
- `VisualRegressionResult` interface: before/after/diff/changed (honest about availability)
- `ProviderCapabilityReport` interface: vision, ocr, pixelComparison, status, limitations
- `VisualCacheEntry` type extending CacheEntry pattern from knowledge module

### STEP 2: Create `backend/src/modules/visual-intelligence/security.ts`
Image validation and security:
- `validateImageFile(file)` — check MIME type, magic bytes, dimensions, file size
- `validateImageOwnership(fileId, userId, projectId)` — workspace isolation
- `detectPromptInjection(text)` — from knowledge module's security.ts pattern
- `sanitizeImageMetadata(metadata)` — strip potentially malicious metadata
- `MAX_IMAGE_SIZE_MB = 10` constant
- `ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']` constant
- `MAX_IMAGE_DIMENSIONS = { width: 4096, height: 4096 }` constant
- Reuse `safeFetch` pattern from knowledge module for external URLs

### STEP 3: Create `backend/src/modules/visual-intelligence/cache.ts`
TTL-aware cache for visual analysis results:
- Follow `KnowledgeCache` pattern from knowledge module
- Key namespace: `visual:{analysisType}:{fileId}:{hash}`
- Default TTL: 1 hour
- Max entries: 5,000 (smaller than knowledge, visual data is larger)
- LRU eviction, stats tracking

### STEP 4: Create `backend/src/modules/visual-intelligence/service.ts`
VisualIntelligenceService class:
- Constructor with config (enable/disable providers, max concurrent analyses)
- `analyzeImage(request)` — main entry point, delegates to appropriate analyzer
- `analyzeScreenshot(request)` — honest about capabilities
- `analyzeUI(request)` — heuristic analysis, honest about limitations
- `generateCodeProposal(analysis)` — advisory, returns CodeProposal for B1 review
- `generateDiagram(request)` — delegates to existing flowDiagram.ts
- `generateDiagramCode(diagram)` — parse diagram → code proposal → B1 required
- `getArchitectureVisualization(request)` — delegates to existing architectureOracle.ts
- `getStateMachineVisualization(request)` — uses flowDiagram.ts state type
- `getVisualRegression(before, after)` — honest NOT_IMPLEMENTED
- `getProviderCapabilities()` — honest capability detection
- `clearCache(pattern)` — cache invalidation
- Export singleton: `visualIntelligenceService`

### STEP 5: Create `backend/src/modules/visual-intelligence/analyzers.ts`
Individual analysis implementations:
- `extractImageMetadata(file)` — dimensions, format, color space from buffer headers (PNG/JPEG/WebP header parsing, no external library)
- `heuristicUIAnalysis(metadata)` — based on dimensions, aspect ratio, metadata only; honest about limitations
- `buildCodeProposal(analysis)` — structured proposal with evidence, requires B1 review
- `parseDiagramToStructure(diagram)` — Mermaid text → structured model
- `diagramToCode(model, targetLanguage)` — structured model → code proposal
- Environment capability detection:
  - `getVisionCapability()` → `UNAVAILABLE` (no vision model configured)
  - `getOCRCapability()` → `UNAVAILABLE` (no OCR engine)
  - `getPixelComparisonCapability()` → `NOT_IMPLEMENTED`
  - `getMultimodalCapability()` → `ENVIRONMENT_BLOCKED`

### STEP 6: Create `backend/src/modules/visual-intelligence/routes.ts`
Express Router factory:
- `POST /analyze` — analyze image/screenshot/UI
- `POST /code-proposal` — generate code proposal from analysis
- `POST /diagram/generate` — generate diagram (reuses flowDiagram.ts)
- `POST /diagram/to-code` — parse diagram → code proposal
- `POST /architecture` — architecture visualization (reuses architectureOracle.ts)
- `POST /state-machine` — state machine visualization
- `POST /regression` — visual regression (honest not-implemented)
- `GET /capabilities` — provider capability report
- `POST /cache/clear` — cache invalidation
- `GET /cache/stats` — cache statistics
- All routes require auth via `requireAuth` middleware
- All routes use `asyncRoute` wrapper

### STEP 7: Register in `backend/src/app.ts`
Add route mount:
```typescript
import { visualIntelligenceRoutes } from './modules/visual-intelligence/routes.js';
app.use('/api/v1/visual-intelligence', visualIntelligenceRoutes());
```

### STEP 8: Create `backend/src/modules/visual-intelligence/visual.test.ts`
20-area test suite (target: 40+ tests):

1. **Image Validation** — valid/invalid types, oversized, bad dimensions
2. **Image Authorization** — unauthorized access rejected
3. **Workspace Isolation** — cross-project images rejected
4. **Screenshot Ingestion** — accepts valid images, stores metadata
5. **Screenshot Capability** — honest `UNAVAILABLE` when no vision model
6. **OCR Capability** — honest `UNAVAILABLE` when no OCR engine
7. **Multimodal Capability** — honest `ENVIRONMENT_BLOCKED` when no provider
8. **UI Heuristic Analysis** — metadata-based, honest limitations
9. **Visual Debugging** — honest `ENVIRONMENT_BLOCKED` without vision
10. **UI-to-Code Proposal** — advisory, includes evidence/assumptions
11. **Diagram Generation** — reuses existing flowDiagram.ts
12. **Diagram-to-Code** — structured parse → code proposal
13. **Architecture Visualization** — reuses existing architectureOracle.ts
14. **State-Machine Visualization** — uses flowDiagram.ts state type
15. **Visual Regression** — honest `NOT_IMPLEMENTED`
16. **Malicious Image Handling** — rejects bad files
17. **Prompt Injection** — detects/rejects injection attempts
18. **ResourceGovernor Limits** — enforces bounds
19. **B1 Enforcement** — code proposals require review, never auto-apply
20. **Audit/Persistence** — correlation IDs, cache persistence, recovery

### STEP 9: Create Frontend `frontend/src/components/VisualIntelligencePanel.tsx`
Mirror TeamCollabPanel pattern:
- Image upload with preview
- Analysis type selector
- Results display with findings, confidence, limitations
- Code proposal display (advisory, not applied)
- Diagram viewer (Mermaid rendering)
- Capability status display (honest about blocked/unavailable)

### STEP 10: Create Frontend Test `frontend/src/components/VisualIntelligencePanel.test.tsx`
4 tests:
- Renders with honest capability status
- Handles upload correctly
- Displays analysis results
- Shows error state

### STEP 11: Update `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md`
Update Group C items:
- #30 Dependency Graph Visualizer → COMPLETED (architectureOracle + visual-intelligence)
- #27 State Machine Validator → COMPLETED (flowDiagram state type + visual-intelligence)

### STEP 12: Create `docs/CODECONCLAVE_PKG13_VISUAL_INTELLIGENCE_GATE.md`
Complete gate documentation.

### STEP 13: Run Tests and Typecheck
- `npx tsc --noEmit` for backend, frontend
- `npx vitest run --maxWorkers 2` for backend
- Frontend test suite

---

## Capability Mapping

| PKG-13 Capability | Implementation | Status |
|---|---|---|
| Screenshot Understanding | `analyzers.ts` + honest ENVIRONMENT_BLOCKED | ENVIRONMENT_BLOCKED |
| UI Analysis | `analyzers.ts` heuristic (metadata-based) | PARTIAL (honest) |
| UI → Code | `service.ts` codeProposal → B1 review | PARTIAL (advisory) |
| Visual Debugging | `service.ts` + honest ENVIRONMENT_BLOCKED | ENVIRONMENT_BLOCKED |
| Diagram Generation | Reuse `flowDiagram.ts` | COMPLETED |
| Diagram → Code | `analyzers.ts` parse → code proposal | COMPLETED |
| Architecture Visualization | Reuse `architectureOracle.ts` | COMPLETED |
| State-Machine Visualization | `flowDiagram.ts` state type | COMPLETED |
| Visual Regression | `service.ts` honest NOT_IMPLEMENTED | NOT_IMPLEMENTED |
| Image Ingestion | `security.ts` validation | COMPLETED |
| Provider Detection | `analyzers.ts` capability detection | COMPLETED |

---

## Files to Create/Modify

### New Files (backend)
1. `backend/src/modules/visual-intelligence/types.ts` (~200 lines)
2. `backend/src/modules/visual-intelligence/security.ts` (~180 lines)
3. `backend/src/modules/visual-intelligence/cache.ts` (~120 lines)
4. `backend/src/modules/visual-intelligence/service.ts` (~250 lines)
5. `backend/src/modules/visual-intelligence/analyzers.ts` (~300 lines)
6. `backend/src/modules/visual-intelligence/routes.ts` (~200 lines)
7. `backend/src/modules/visual-intelligence/visual.test.ts` (~500 lines)

### New Files (frontend)
8. `frontend/src/components/VisualIntelligencePanel.tsx` (~150 lines)
9. `frontend/src/components/VisualIntelligencePanel.test.tsx` (~80 lines)

### New Files (docs)
10. `docs/CODECONCLAVE_PKG13_VISUAL_INTELLIGENCE_GATE.md`

### Modified Files
11. `backend/src/app.ts` — add route mount
12. `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` — update Group C items

---

## Key Design Decisions

1. **No external image processing library** — parse PNG/JPEG/WebP headers directly for metadata
2. **Honest capability reporting** — every provider check returns real status
3. **Reuse existing systems** — diagram, architecture, state-machine all delegate
4. **Advisory code proposals** — never auto-apply, always B1 review required
5. **Prompt injection detection** — detect and reject malicious metadata/text
6. **Cache follows PKG-12 pattern** — bounded TTL, LRU, stats
7. **Tests prove honest unavailable** — for blocked providers, tests verify the honest status

---

## Estimated Effort

- Backend module: ~1,750 lines across 7 files
- Frontend: ~230 lines across 2 files
- Tests: ~500 lines (40+ tests)
- Documentation: ~300 lines
- Total: ~2,780 lines

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| No vision model configured | Honest ENVIRONMENT_BLOCKED, tests prove it |
| No OCR engine | Honest UNAVAILABLE, tests prove it |
| No pixel comparison | Honest NOT_IMPLEMENTED, tests prove it |
| Image metadata injection | sanitizeImageMetadata strips malicious content |
| B1 bypass | Code proposals always require approval |
| Resource exhaustion | ResourceGovernor limits enforced |
