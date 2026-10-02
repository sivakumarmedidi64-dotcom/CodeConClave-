# CodeConClave — FINAL RELEASE CHECKLIST

Generated: 2026-09-08. Companion: `CODECONCLAVE_FINAL_RELEASE_READINESS_AUDIT.md` (+ .json).

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Feature denominator 336 preserved | PASS | `CODECONCLAVE_FINAL_RELEASE_FEATURE_RECONCILIATION.md` |
| 2 | No features removed / unmapped / unknown | PASS | 0 / 0 / 0 |
| 3 | Auth + sessions + persistence | PASS | auth suite + live route flows |
| 4 | Google sign-in (button + authorize 302 + callback) | PASS | live 302 to accounts.google.com |
| 5 | Cross-user isolation (convs/files/projects/tasks/memories/runs/approvals/control/integrations) | PASS | owner-scoped 404/403; task IDOR 6/6 live |
| 6 | Onboarding: display name → Home; greeting 4 time slots | PARTIAL | greeting night added this gate; role/use-case by-design absent |
| 7 | Real AI chat (not faked) | PASS | nemotron/chat 200, 413B SSE, persisted |
| 8 | Model routing (22 categories, 4 policies, fallback) | PASS | router tests 203 |
| 9 | Multimodal (text/image/text+image routing) | PASS | requiredCaps enforced |
| 10 | Image generation foundation + real attempt | ENV_BLOCKED | google gemini-3-pro-image 429 quota |
| 11 | All providers honest states | PASS | live api/providers |
| 12 | Manus + Devin external-agent envelope | PASS (honest) | manus ENV_BLOCKED, devin UNVERIFIED |
| 13 | Autonomous cowork (retry/DLQ/kill-switch/budget/approvals/idempotency) | PASS | suites + status 200 |
| 14 | Control plane (auth + isolation, no unsafe DB mutation) | PASS | control-26g |
| 15 | Coworkers = policy layer over same engine | PASS | owner-scoped runs |
| 16 | Code workspace (stale-write 409, diff, search) | PASS | codeworkspace suite |
| 17 | Terminal classification + production guard + redaction | PASS | safety.ts:45, preflight:142 |
| 18 | Memory (owner-scoped, secrets redaction exists) | PASS | memory suites |
| 19 | Integrations (OAuth state, webhook HMAC, replay, at-rest secrets) | PASS | automations/integration suites |
| 20 | Free usage rolling window (no midnight reset) | PASS | live limit_reached SSE |
| 21 | Payment regression (frozen, no change) | PASS | 207 payment tests |
| 22 | Database: migrations + RLS | PASS | 74/0 pending; 24 pols correct |
| 23 | Security: secret scan, CSP, CORS, cookies, prod defaults | PASS | 849 files / 0 findings |
| 24 | Six hardening items remain fixed | PASS | re-verified live this gate |
| 25 | Web app (all surfaces, no dead nav) | PASS | 402 frontend tests, build 19.83s |
| 26 | Desktop (build + installer) | PASS | Setup exe built; dist+asar clean (0 keys) |
| 27 | Web/Desktop parity | PASS | one backend, same endpoints |
| 28 | UI/UX / a11y | PASS (notes) | skip-link added; aria toggles documented |
| 29 | Performance/reliability | PASS (notes) | bounded polling/SSE |
| 30 | Test matrix + typechecks + builds + scans | PASS | see audit Part 26 |
| 31 | Release artifact (installer + web build, no creds) | PASS | 59 files scanned, 0 matches |
| 32 | Blockers classified | PASS | CRITICAL 0 / HIGH 0 / MEDIUM 4 / LOW 5 / ENV 5 / UNV 2 |
| 33 | Manual human acceptance captured | OPEN | founder sign-off required (25-item checklist) |
| 34 | Deployment | NO | gate rule — do not deploy |

## Sign-off

Founder sign-off required on the 25-item
`CODECONCLAVE_MANUAL_ACCEPTANCE_CHECKLIST.md`, Google OAuth browser E2E,
packaged desktop launch, and visual/UX acceptance before deployment is manual
and permitted outside this gate.

**FINAL RELEASE READINESS GATE: CONDITIONAL_PASS**