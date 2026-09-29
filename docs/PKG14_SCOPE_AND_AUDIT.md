# PKG-14 — Static Code Quality & Correctness Intelligence — SCOPE & AUDIT

**Gate Series:** CodeConClave PRO (PKG-14)
**Auditor:** opencode
**Date:** 2026-09-03
**Derived from:** `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Group C) against the actual repository state — NOT a stale prompt.

---

## 1. Scope decision

PKG-14 implements one coherent theme from the 50 Group C Intelligence features:
**Static Code Quality & Correctness Analysis.** This cluster is fully deterministic
(server-authoritative heuristic source analysis — no external AI provider required),
builds on the existing secure file-loading path (`modules/files/service.ts`
`getFileContent`, which enforces owner/member/grant isolation), and reuses the
established module/route/test architecture forged in PKG-12/PKG-13.

The 5 capabilities are:

| Registry ID | Capability |
|---|---|
| #6 | Code Smell Agent |
| #7 | Concurrent Bug Detector |
| #8 | Memory Leak Hunter |
| #9 | Type Safety Enhancer |
| #10 | Invariant Keeper |

**Why this cluster?**
- It is the largest untouched, coherent Group-C subset that is **technically
  achievable today** (pure source-text heuristics, no fake AI, no missing
  provider).
- Every capability loads project files through the existing isolated files
  service, so no new access surface.
- Adjacent testing capabilities (#11 Flaky Hunter, #12 Regression Test
  Generator) were already found COMPLETE in the repo (`modules/engineering/
  flakeHunter.ts`, `developer-productivity/testingStrategy.ts`) and are
  explicitly kept **out of scope** to avoid rework.
- All 5 share the same deterministic analyzer core, so honest, evidence-backed
  findings with confidence scores are natural.

**What is NOT in scope (deliberately):**
- #1, #2, #4, #13–#17, #19–#24, #26, #29, #31–#35, #41–#50 (other clusters /
  future PKGs; not dropped, not deleted — tracked in registry as PARTIAL/ROADMAP).
- #11, #12, #18, #25, #27, #30, #36–#40, #47 — already COMPLETED by prior PKGs
  and the existing engineering/testing modules. Not reopened.
- Payment architecture and PKG-13 visual intelligence are NOT modified.

---

## 2. Capability audit (existing state → gap → plan)

| Registry ID | Capability | Existing State | Gap | Planned Implementation | Runtime Status |
|---|---|---|---|---|---|
| #6 | Code Smell Agent | PARTIAL — `engineering-intelligence/debtSlayer.ts:18` lists `type:'code_smell'` as a debt category template, but there is **no dedicated code-smell analyzer**; findings are generic debt items, not an evidence-backed smell detector | No dedicated analyzer; no per-file smell findings, severity, confidence, or remediation hints | New deterministic analyzer `smellAnalyzer` over source text: detects long-function heuristics, deep nesting, duplicate-ish blocks, magic numbers, poor naming (single-letter identifiers), missing error handling. Returns `[{file,line,rule,severity,confidence,detail}]` with honest confidence | IMPLEMENTED |
| #7 | Concurrent Bug Detector | NOT_FOUND — no race-condition / data-race detection anywhere | No concurrency-risk analysis | New deterministic analyzer `concurrencyAnalyzer`: flags shared mutable module-level state, async callbacks that mutate captured state without re-synchronization (heuristic), unchecked `Promise.all` aggregate failure, `setTimeout`/`setInterval` on shared state in the same file. Evidence-backed, confidence-based | IMPLEMENTED |
| #8 | Memory Leak Hunter | NOT_FOUND — only doc/comment references in `development-productivity/flowDiagram.ts:652` and test data | No leak-risk analysis | New deterministic analyzer `leakAnalyzer`: flags unbounded `Map`/`Set`/array appends without eviction, event-listener/subscription registrations without matching removal, closures that capture large object graphs and escape, timers not cleared. Evidence-backed | IMPLEMENTED |
| #9 | Type Safety Enhancer | PARTIAL — `refactoringWizard.ts:558` mentions "enhanced type safety" and `performanceOracle.ts:395` has a strategy hint; no real type-safety analyzer | No analyzer for unsafe TS/JS constructs | New deterministic analyzer `typeSafetyAnalyzer`: flags `: any`, `as any`, `!` non-null assertions, untyped object literals in signatures, `@ts-ignore`/`@ts-nocheck`, non-null assertion-heavy patterns, missing type annotations on exported vars (heuristic). Evidence-backed | IMPLEMENTED |
| #10 | Invariant Keeper | NOT_FOUND — no invariant detection | No invariant analysis | New deterministic analyzer `invariantAnalyzer`: flags checked-in invariants (assertions/preconditions) that are commented-out, `// promise:` / delayed invariants, functions with early `return` before declared preconditions on inputs, suspiciously-broad catch blocks that swallow invariant violations. Evidence-backed, advisory only | IMPLEMENTED |

### Reuse (no rebuild)
- **Secure source intake:** `modules/files/service.ts` `getFileContent(userId, projectId, fileId)` → `{buffer, mimeType, name}`; `listFiles(userId, projectId)` enumerates workspace files. These already enforce owner/member/grant isolation (`assertFileAccess` at `files/service.ts:281`).
- **Text extraction:** only text MIMEtypes (`text/*`, `application/javascript`, `application/json`, `+json`, `application/typescript`, `application/x-typescript`, `application/yaml`, `application/xml`, `application/x-sh`) are analyzed; binaries are skipped, never executed.
- **Prompt-injection containment:** `modules/knowledge/security.ts` `detectPromptInjection` reused (source content is treated as untrusted data, never instructions).
- **Server-authoritative shape:** mirrors `modules/visual-intelligence/` (routes/service/types/tests) and `modules/knowledge/`.
- **Shared constants:** `@codeconclave/shared` `AuditAction` / `NotificationType` const-enums.

---

## 3. State model (honest, no fake success)

Every analyzer returns findings with an explicit truthfulness model:

- `VERIFIED` — a finding is a hard, deterministic match (e.g. literal `: any`).
- `HEURISTIC` — pattern-based with a confidence score < 1.0 (most findings).
- `UNAVAILABLE` — no source matched / analyzer could not run for this input.
- `ENVIRONMENT_BLOCKED` — analyzer can never run in this deployment (not expected here).
- `NOT_IMPLEMENTED` — surfaced honestly if a capability is queried but not built.

No analyzer claims to compile, execute, or "prove" a bug. Findings are advisory
signals for a human/agent to review. No test is fabricated; generated artifacts
are marked as templates/plans, never as passing results.

---

## 4. Security posture

- All routes behind `requireAuth` + `asyncRoute`; user id from `req.ctx.user`.
- Files are ONLY accessed via the isolated files service (owner/member/grant).
- Text input is bounded (per-file byte cap) and scanned with
  `detectPromptInjection`; source content is never concatenated into a prompt
  as instructions.
- Findings are advisory and never auto-apply code changes.
- No new tenant-crossing surface; all results scoped to the requesting user's
  project.

---

## 5. Deliverables

- Backend module `backend/src/modules/quality-intelligence/`:
  `types.ts`, `security.ts`, `analyzers.ts`, `service.ts`, `routes.ts`,
  `quality.test.ts`.
- Wiring: `backend/src/app.ts` mount `/api/v1/quality-intelligence`; add
  `PREFIX.QUALITY_ANALYSIS: 'qlt'` to `backend/src/shared/ids.ts`.
- Frontend `frontend/src/components/QualityIntelligencePanel.tsx` (+ `.test.tsx`)
  with honest capability rails.
- Registry update: #6, #7, #8, #9, #10 → COMPLETED.
- This doc + `docs/CODECONCLAVE_PKG14_GATE.md`.

*No schema change required (deterministic in-memory analysis; no new tables). If a
registry/allowlist is needed it lives in the module config, not the DB.*
