# CodeConClave — PKG-24 — AI Developer Copilot — Scope & Audit

**Package:** PKG-24 (CodeConClave PRO)
**Theme:** AI DEVELOPER COPILOT — CONTEXT-AWARE CODING ASSISTANCE + EXPLANATION + TEST GENERATION + FAILURE DIAGNOSIS + MEMORY-AWARE SUGGESTIONS
**Status:** Active (set by this document)

PKG-24 turns the *existing* AI Gateway (PKG-06+) + memory (PKG-23) + workspace (PKG-22)
+ B1 review workflow into a genuinely useful **AI Developer Copilot**. The core loop:
SELECT CODE → UNDERSTAND CONTEXT → RETRIEVE RELEVANT MEMORY → ANALYZE → SUGGEST →
REVIEW → APPLY THROUGH SAFE WORKFLOW → TEST → LEARN OUTCOME.

It is an **additive coordinator layer** over the existing gateway/memory/workspace/
cowork/B1 foundations. It does **NOT** rebuild the AI gateway (no second gateway), does
**NOT** rebuild memory (no second memory system), does **NOT** auto-apply source changes,
does **NOT** bypass B1, does **NOT** touch payment architecture, does **NOT** weaken
tests, and does **NOT** start PKG-25.

**Hard truth constraints honored throughout:**
- NEVER fabricate AI responses or provider availability.
- NEVER claim deterministic heuristics are LLM reasoning (evidence-backed, honest sources).
- NEVER expose secrets to models/users (prompt/context isolation + redaction).
- Repository text is **DATA**, never privileged instructions (prompt-injection containment).
- NEVER auto-apply source changes (safe B1 review proposals only).
- Reuse existing AI Gateway, PKG-22 workspace, PKG-23 memory, reviews/B1, runtime, developer-workflow.

---

## Canonical registry scope

The canonical records are `CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` and
`FINAL_FEATURE_MATRIX.md`. The copilot-theme intelligence features in the registry's
50-intelligence list that remain **NOT COMPLETED** (the gaps this package delivers):

- **12 Regression Test Generator** — test generation that proposes regression coverage
  (without ever claiming coverage it did not measure).
- **11 Test Flakiness Predictor** — surfacing deterministic/heuristic signals around
  flaky/verifying fixes, plus an honest failure-diagnosis path.
- **26 Design Pattern Recommender** — recommending patterns from code + project memory.

Foundations reused (already PASS): `F14/F15/F16/F52/F53` (memory system + embeddings +
corrections), `F05` (sessions), `F22/F24` (task engine), `C-4` (patterns), the AI Gateway
(G-*), PKG-22 workspace, PKG-23 `memorycoding` (coding context, runtime/deployment memory,
feedback).

The new **AI Developer Copilot** coordinator layer is claimed as `REGISTRY_IDS_NEW`
(honest; no fabricated ID). Registry gaps 11/12/26 are anchored without inventing IDs.

**IDs NOT implemented / honestly reported:** true semantic-AI retrieval and real
LLM-reasoning are reported only when a real provider/model is available
(`LIVE_PROVIDER`/`LOCAL_MODEL`); otherwise modes report `PROVIDER_REQUIRED`/`UNAVAILABLE`
honestly. Coverage is **never claimed** because generation cannot measure it.

---

## Scope & audit table

| Registry ID | Capability | Current State | Existing Foundation | Gap | Required Work | Runtime Status |
|---|---|---|---|---|---|---|
| 12 (registry) | Regression test generator | NOT COMPLETED | AI Gateway (`completeWithFallback`), codeworkspace `readFileEntry`, developer-workflow tests | Propose test cases (happy/edge/invalid/error/regression) per target | `MCP::testgen` — 5 kinds, PROPOSALS only, `measuredCoverage:null` (never claims coverage) | VERIFIED (new, 12) |
| 11 (registry) | Test flakiness predictor | NOT COMPLETED | runtime memory, developer-workflow `contextualDebug` + `errorRunbook`, quality analyzers | Diagnose failing/flaky surfaces honestly | `MCP::diagnose` — clue synthesis + verification plan; heuristic, never a fake root cause | VERIFIED (new, 11) |
| 26 (registry) | Design pattern recommender | NOT COMPLETED | `cross_project_patterns` (C-4, PKG-23), coding context, related files | Recommend conventions/patterns from code + project memory | `MCP::suggest` — memory-aware suggestions (source MODEL/HEURISTIC/MEMORY) with rationale + evidence | VERIFIED (new, 26) |
| — | Context-aware assistance | PARTIAL | editor + gateway + coworkers exist; no single SELECT→CONTEXT→SUGGEST loop | One bounded copilot context assembly | `MCP::context` — bounded (64KiB) context: code, diagnostics, related, memory, runtime | VERIFIED (new) |
| — | Code explanation | PARTIAL | no unified explain with honest source tagging | Explain selected code, separate sources | `MCP::explain` — OBSERVED / INFERRED / MODEL-GENERATED separation | VERIFIED (new) |
| — | Ask-CodeConClave | PARTIAL | gateway + memory retrieval exist | Question → evidence-cited answer | `MCP::ask` — evidence-cited answer; never fabricated without a provider | VERIFIED (new) |
| — | Safe change application | PARTIAL | B1 review + PKG-22 diff exist; no copilot proposal flow | Draft B1 reviews from copilot output | `MCP::propose` — drafts B1 review (createReview), **never auto-applies** | VERIFIED (new) |
| — | Memory feedback loop | PARTIAL | PKG-23 `learnFromFeedback` + FeedbackLevel | Copilot→memory learning signal | `MCP::feedback` — wraps PKG-23 feedback; INFERRED never persisted | VERIFIED (new) |
| — | Capability truth | PARTIAL | gateway `eligibleModels`/`configuredProviders` | Honest provider + mode report | `MCP::capabilities` — provider state + per-mode VERIFIED/PROVIDER_REQUIRED/HEURISTIC/BLOCKED/UNAVAILABLE | VERIFIED (new) |

**Scope guardrails honored:**
- NO second AI gateway, NO second memory system, NO provider/secret exposure.
- NO deterministic-heuristic-pretends-to-be-LLM; every claim carries a source.
- NO auto-apply; all source changes go through B1 review (`MCP::propose`).
- NO bypass of B1; NO payment architecture change; NO test weakening.
- NO PKG-22/23 rebuild; reuse is additive.
- Feature-gated: `AIOS_P2_COPILOT` env flag (default OFF, reversible); when OFF all
  routes except `GET /capabilities` throw `feature_disabled` and never mutate.
- Does NOT start PKG-25.
