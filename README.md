# CodeConClave

**MEMORY + EXECUTION + CONTINUITY + TEAM + CONTROL**

> Tell CodeConClave what you want. It understands. It remembers. It plans. It works. It verifies. It preserves the result. It keeps cloud-side work running while you are away. When you return, you continue instead of starting over.

CodeConClave is a complete AI operating system for software development and knowledge work. It is **not** a chatbot, a code editor, an IDE assistant, a browser extension, or a single autonomous agent.

## Repository layout

```
CodeConClave-/
├── frontend/        React + Vite + TypeScript web application (RTL-tested)
├── backend/         Modular-monolith API (Express + TypeScript + PostgreSQL)
│   └── src/foundation/  All automated suites: unit, integration, security, failure, performance, E2E
├── local-agent/     Local CLI agent (npx codeconclave-agent init) — Windows/macOS/Linux
├── shared/          Shared domain types, schemas, and constants
├── database/        Migrations (0001–0038) + RLS policy source of truth
├── docs/            Reports, acceptance matrix, security/payment/provider/deployment guides, runbook
└── docker-compose.yml  Local dev: PostgreSQL(pgvector) + Redis + MinIO + backend + frontend
```

## Core principles

- **Repository-first**: the repo is the source of implementation truth.
- **Modular monolith**: modules are independently bounded and future-extractable; no microservice sprawl, no Kubernetes requirement locally.
- **Security by default**: client-side state is never authoritative for identity, permissions, plan, entitlements, payments, usage, task state, approvals, or model access. MFA/TOTP, recovery codes, RBAC, RLS, rate limiting, CSRF, audit logging, and tenant isolation. A Phase 18 fail-fast guard refuses to start in production without strong secrets, secure cookies, and CSP.
- **No LLM output → direct execution**: every important action flows through `USER INTENT → PLAN → POLICY → APPROVAL IF REQUIRED → EXECUTION → OBSERVATION → VERIFICATION → ARTIFACT → PERSISTENCE → MEMORY/DNA UPDATE → AUDIT`. The policy engine is deterministic, never an LLM.
- **No fakes**: no fake payments, fake execution, fake terminal output, fake 24/7 work, fake memory, or fake verification. Anything that cannot be proven is reported honestly (`/health` never labels an unconfigured provider healthy).
- **Cost survival**: compute governance on the server; cheapest qualified model first, premium constrained → qualified cheaper model → continue.

## Quick start (local development)

Prerequisites: Node.js ≥ 20, Docker (for Postgres/Redis/MinIO) or an existing Supabase/Upstash setup.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#   fill in DATABASE_URL / REDIS_URL / at least one AI provider key

# 3. Start local infrastructure (Postgres, Redis, MinIO)
docker compose up -d

# 4. Migrate the database
npm run db:migrate

# 5. Run backend + frontend
npm run dev:backend   # http://localhost:4000
npm run dev:frontend  # http://localhost:5173
```

## Verification

```bash
npm run typecheck
npm run lint
npm run test          # backend 920/920 + frontend 221/221 (Phase 18 gate)
```

Operational endpoints: `GET /healthz` (liveness), `GET /ready` (readiness,
200/503), `GET /health` (full honest check list), and
`GET /api/v1/operations/diagnostics` (owner/admin).

## Documentation

| Document | Purpose |
| --- | --- |
| `docs/ACCEPTANCE_MATRIX.md` | Final Phase 18 acceptance matrix (functional/security/persistence/recovery/observability/performance/audit/testing/cost/providers/deployment) |
| `docs/PHASE_17_REPORT.md`, `docs/PHASE_18_REPORT.md` | Final phase reports |
| `docs/DEPLOYMENT_GUIDE.md` | Production topology, endpoints, validation checklist (Vercel deferred) |
| `docs/ENVIRONMENT_VARIABLES.md` | Every env var, defaults, and the production checklist |
| `docs/SECURITY_GUIDE.md` | Security model and controls |
| `docs/PAYMENT_CAPABILITY.md` | Razorpay: Payment Link only; honest verification rules |
| `docs/PROVIDER_INTEGRATION_GUIDE.md` | AI/email/Google/GitHub/Razorpay/Cloudflare/Sentry/plugins — capability + live status |
| `docs/RUNBOOK.md` | Incident, recovery, backup, restore, rollback, secret rotation |
| `docs/KNOWN_LIMITATIONS.md` | Honest list of unproven/unimplemented items |

## Status of external services (honest inventory, Phase 18)

| Service | Status | Notes |
| --- | --- | --- |
| PostgreSQL | Configured (local/Supabase) | Runtime validation **BLOCKED** in this environment; migrations 0001–0038 + RLS static-verified |
| Redis | Configured | Runtime validation **BLOCKED**; `QUEUE_PROVIDER=memory` in dev |
| AI providers (Anthropic/OpenAI/Google/Mistral) | Configured | Live calls **BLOCKED** (no keys here); contract-tested |
| Resend (email) | Configured | Live delivery **BLOCKED**; outbox/idempotency contract-tested |
| Google (OAuth/Gmail/Drive/Sheets/Calendar) | Configured | Live **BLOCKED**; OAuth state machine security-tested |
| GitHub (CodeConClave Pro App) | Credentials stored | Webhook deferred; live **BLOCKED** |
| Razorpay | **Payment Link only** | API/webhook OFF without real credentials; no fabricated transactions |
| Cloudflare Worker + KV | Configured | Not validated (no token) |
| Cloudflare R2 | **Deferred** | `R2_NOT_CONFIGURED`; provider-agnostic storage abstraction used instead |
| Sentry | Credential available | Not enabled until `SENTRY_DSN` + `SENTRY_ENABLED=true` |
| Frontend deployment (Vercel) | **Deferred** | Explicitly not started (Phase 18 instruction) |

## License

Proprietary. Unlicensed — see the repository owner.