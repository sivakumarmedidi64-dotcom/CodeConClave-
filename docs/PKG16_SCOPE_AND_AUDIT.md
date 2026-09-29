# CodeConClave — PKG-16 — Performance, Capacity & Cost Optimization Intelligence

**Derived from:** `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Group C Intelligence)
**Approved to implement:** yes (after PKG-15 COMPLETE + GATED)
**Scope:** 4 coherent Group C capabilities — #16 Performance Timeline, #17 Database Query
Optimizer, #19 Batch Processing Optimizer, #20 Cost-Aware Refactoring.

These four form a single coherent theme: **how a workspace is performing, where its
queries/batches are wasteful, and which refactoring pays for itself**. They share one
base module (`modules/optimization-intelligence/`) and *consume* the existing
`engineering-intelligence` `performanceOracle`/`debtSlayer` and `production-intelligence`
`costAnalysis` analyzers as read-only inputs — never duplicating them.

> **Honesty model:** Every capability reports explicit state (VERIFIED = literal match /
> HEURISTIC = pattern, confidence < 1.0) and a truthfulness state on every finding. No
> capability claims runtime profiling, a real compile, or a real spend forecast it does
> not perform. Assessments are deterministic and advisory; plans are suggestions, never
> auto-applied.

## Capability table

| Registry ID | Capability | Current Status | Existing Implementation | Gap | Planned Work | Runtime Status |
|---|---|---|---|---|---|---|
| #16 | Performance Timeline | PARTIAL | `performanceOracle.ts` `generatePerformanceReport` yields `slowFunctions[]` + `apiLatencyRisks[]` (per-endpoint/per-risk analysis) + `detectPerformanceRegressions`. No temporal operation sequence. | No source-level **ordered** timeline of operations (which await/call runs, in what order, duration, parent, hot-path attribution) | `timeline.ts` consumes the existing report and project source to emit an ordered `Operation[]` chain with per-op approximate duration, parent linkage, and time-heavy path attribution | IMPLEMENTED (code-level, ESTIMATED, advisory) |
| #17 | Database Query Optimizer | PARTIAL | `performanceOracle` `dbQueryRisks[]` (crude keyword scan) + runtime pg-stat path in `production-intelligence/dbPerformance.ts` (missing indexes, seq scans). Static column-parsing optimizer does not exist. | No precise static SQL parse: unindexed FK JOIN columns, `NOT IN`, leading-wildcard `LIKE`, SELECT-needed-columns → actionable DDL per query | `queryOptimizer.ts` consumes `dbQueryRisks[]` and parses query text to emit per-query rewrite/index guidance + concrete `CREATE INDEX` DDL | IMPLEMENTED (static heuristics, advisory) |
| #19 | Batch Processing Optimizer | NOT_FOUND | `performanceOracle` `nPlusOnes[]` emits only a *string* suggestion ("batch fetch / DataLoader"); `quality-intelligence` concurrency analyzer is advisory-only. No real batch-rewrite planner. | No concrete, quantified batch rewrite plan (bulk `WHERE IN (…)`, `Promise.all`, chunked concurrency, query-count reduction) | `batchOptimizer.ts` consumes `nPlusOnes[]` and emits structured `BatchRewritePlan` per site with projected query count reduction | IMPLEMENTED (plan generation, advisory) |
| #20 | Cost-Aware Refactoring | NOT_FOUND | `production-intelligence/costAnalysis.ts` measures cost (`getCostBreakdown`/`getTopCostDrivers`, DB-backed) and `debtSlayer.ts` `analyzeTechnicalDebt` surfaces refactor opportunities. Nothing links cost drivers to refactor ROI. | No cost→refactor correlation: which refactoring reduces which cost driver, by how much, with what ROI/priority | `costRefactoring.ts` consumes `getCostBreakdown` (`topCostDrivers`, `byCategory`) + `analyzeTechnicalDebt` (`items`/`estimatedImpact.performance`) and emits per-refactor estimated cost reduction, ROI, priority | IMPLEMENTED (consumes real cost data, advisory ROI) |

## Out of scope (preserved — NOT removed / NOT silently moved)
- All other Group C items: #1–#4, #11–#15, #26, #28, #29, #31–#35, #41–#46, #48, #49, #50
  remain PARTIAL/NOT_FOUND for future PKGs. (#44/#48 are intentionally NOT rebuilt here;
  #48 (forecast) and #44 (hotspot) stay out of PKG-16 scope to keep the package coherent
  and avoid overlap with `performanceOracle`.)
- Group D Record Skill (all 12) — separately FLAGGED (`os/p2/skills.ts`); not this package.
- #5–#11, #18, #21–#25, #27, #30, #36–#40, #47 already COMPLETED (prior packages); not
  reopened.
- Payment architecture (POLICY B), PKG-13 visual, PKG-14 quality, PKG-15 security-ops:
  not modified.
- `engineering-intelligence` (`performanceOracle`/`debtSlayer`) and
  `production-intelligence` (`costAnalysis`) are reused read-only (imports), not modified.

## Deliverables
- `backend/src/modules/optimization-intelligence/` — `types.ts`, `schemaUtil.ts`
  (shared SQL parsing), `timeline.ts` (#16), `queryOptimizer.ts` (#17),
  `batchOptimizer.ts` (#19), `costRefactoring.ts` (#20), `security.ts` (source
  containment), `service.ts`, `routes.ts`, `optimization-intelligence.test.ts`.
- Wiring: `app.ts` mount `/api/v1/optimization-intelligence`. No new DB tables — all
  analyses are on-demand, advisory, and consume existing tables; **no migration is
  needed** (mirrors PKG-13's non-persisted model).
- Frontend: `OptimizationIntelligencePanel.tsx` + test (capability-rails pattern,
  mirroring PKG-13/14/15 panels).
- Docs: `docs/CODECONCLAVE_PKG16_GATE.md`.

## Security model
- All routes `requireAuth` + project ownership via `assertProjectAccess` (`projects` RLS),
  and the isolated files service for any source intake.
- Source intake for #16/#17/#19 reuses the quality-intelligence text-allowlist +
  prompt-injection containment; binaries are skipped, never executed.
- #20 consumes existing `costAnalysis`/`debtSlayer` outputs (already owner-scoped); any
  optional write is idempotent and audit-logged.
- No secrets are returned; reports are aggregated. Cost values are advisory ROI/estimates
  on top of existing measured/estimated cost data.