# CodeConClave — PKG-15 — Security & Compliance Operational Intelligence

**Derived from:** `docs/CODECONCLAVE_FINAL_MASTER_FEATURE_REGISTRY.md` (Group C Intelligence)
**Approved to implement:** yes (after PKG-14 COMPLETE + GATED)
**Scope:** 4 coherent Group C capabilities — #21 Security Incident Response, #22 API Rate Limit Awareness, #23 Network Resilience Checker, #24 Workspace Compliance Checker.

These four form a single coherent theme: **operational security & compliance** — how a
workspace triages incidents, understands its API rate-limit exposure, verifies network
resilience, and tracks compliance. They share one base module
(`modules/security-operations-intelligence/`) and reuse the existing
`security-intelligence` analyzers (`securityAnalysis`, `apiSecurity`, `securityPosture`,
`supplyChain`, `secretIntelligence`) plus workspace isolation, audit logging, and the
files service for static scans.

> **Honesty model:** Every finding carries an explicit state (VERIFIED = literal match /
> HEURISTIC = pattern, confidence < 1.0). No capability claims compiler, network, or
> runtime proof it does not have. Assessments are deterministic and advisory.

## Capability table

| Registry ID | Capability | Current Status | Existing Implementation | Gap | Planned Work | Runtime Status |
|---|---|---|---|---|---|---|
| #21 | Security Incident Response | PARTIAL | `security-intelligence/securityAnalysis.ts` `VulnerabilityFinding` triage lifecycle (OPEN/ACKNOWLEDGED/IN_PROGRESS/FIXED/FALSE_POSITIVE/WONT_FIX) + `vulnerabilityManagement.ts` update/assign; no dedicated incident entity | No project-scoped incident lifecycle with response actions, severity, containment, notes, audit trail | New `secops_incidents` entity: create/triage/assign/respond/contain/resolve/close/reopen + `recordAudit`; derives an incident snapshot from scan findings | IMPLEMENTED (DB-backed) |
| #22 | API Rate Limit Awareness | PARTIAL | `security-intelligence/apiSecurity.ts` `runApiSecurityScan` reports `RateLimitSecurity { enabled, strategy, limits[], failClosed }` per endpoint | No aggregate "rate-limit awareness" view: coverage %, uncovered endpoints, per-endpoint limits/window, fail-closed audit | `rateLimitAwareness.ts` aggregates endpoints into awareness report (covered/uncovered/coverage/fail-closed), honest states | IMPLEMENTED (read-only aggregation) |
| #23 | Network Resilience Checker | NOT_FOUND | `securityPosture.ts` has a single infrastructure network-policy check; no dedicated resilience checker | No per-facet network-resilience static assessment (circuit-breaker, retry/backoff, timeouts, health checks, dependency resilience) | `networkResilience.ts` static-text checker over workspace files; per-facet PASS/WARN/FAIL with evidence + VERIFIED/HEURISTIC | IMPLEMENTED (deterministic static) |
| #24 | Workspace Compliance Checker | PARTIAL | `securityPosture.ts` `assessSecurityPosture`/`getFailingChecks` + `supplyChain.ts` + `secretIntelligence.ts` existing | No compliance aggregation crossing posture + supply chain + secrets into a score with per-category status and persisted history | `compliance.ts` aggregates posture/benchmarks/failing checks + supply chain + secret exposure into compliance report, persists bounded history to `secops_compliance_reports` | IMPLEMENTED (DB-backed history) |

## Out of scope (preserved — NOT removed / NOT silently moved)
- Group D Record Skill (all 12) — separately FLAGGED in the registry (`os/p2/skills.ts`); not part of this package.
- #1, #2, #3, #4, #12–#20, #26, #28, #29, #31–#35, #41, #42, #44, #45, #46, #48, #49, #50 remain PARTIAL/ROADMAP for future PKGs.
- #5–#11, #18, #25, #27, #30, #36–#40, #47 already COMPLETED (prior packages); not reopened.
- Payment link-pool (POLICY B), PKG-13 visual intelligence, PKG-14 quality intelligence: not modified.
- The existing `security-intelligence` module is reused read-only (imports), not modified.

## Deliverables
- `backend/src/modules/security-operations-intelligence/` — `types.ts`, `security.ts`,
  `incidents.ts` (#21), `rateLimitAwareness.ts` (#22), `networkResilience.ts` (#23),
  `compliance.ts` (#24), `service.ts`, `routes.ts`, `security-operations-intelligence.test.ts`.
- Migration `database/migrations/0060_secops_intelligence.sql` — `secops_incidents`,
  `secops_compliance_reports`.
- Wiring: `app.ts` mount `/api/v1/security-operations`; `ids.ts` new prefixes.
- Frontend: `SecurityOperationsPanel.tsx` + test (capability-rails pattern, mirroring
  PKG-13/14 panels).
- Docs: `docs/CODECONCLAVE_PKG15_GATE.md`.

## Security model
- All routes `requireAuth` + workspace/project ownership via `assertProjectAccess`
  (`projects` RLS) and the isolated files service.
- `#22`/`#24` reuse `security-intelligence` functions that already enforce ownership.
- `#23` source intake reuses the quality-intelligence text-allowlist + prompt-injection
  containment; binaries are skipped, never executed.
- Incident/compliance writes are idempotent by id and owner-scoped; audit-logged.
- No secrets are returned; reports are aggregated and redacted.
