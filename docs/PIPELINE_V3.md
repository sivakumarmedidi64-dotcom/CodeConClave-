# CodeConClave execution pipeline v3: the verifiable engine

Objective in, verified outcome out. Every plain chat answer runs this pipeline
(`PIPELINE_V3=on`, the default). Code: `backend/src/engines/pipeline/` and
`backend/src/engines/kernel/`.

```
Intake → [Cache hit? → stream, 0 tokens] → Route·scout → Dispatch·maker (1 role · 1 run)
       → Gate·sentinel (0 tokens) → Specialist → Scientific Verification Kernel
       → Verify·judge (repair ≤ 2, the 3rd failure escalates) → Act → Commit·seal
```

| Stage | What it does | Where |
|---|---|---|
| Intake | Normalizes the question. Hashes question, files and project DNA version. Locks the per-run budget. Builds the cache key. Writes the first ledger event. | `run.ts`, `ledger.ts` (`dnaVersion`) |
| Cache hit | Same question + files + DNA version + budget tier + chat history → streams the sealed answer with 0 tokens, carrying the original proofs. Never used in incognito. | `ledger.ts` (`cacheGet`/`cachePut`) |
| Route · scout | Picks lane, risk, complexity and up to 3 candidate roles. Uses the resident scout model (≤ 300 tokens, strict JSON guard) when it is reachable, otherwise a deterministic keyword router. The ledger records which one ran. | `scout.ts` |
| Dispatch · maker | Runs ONE role. Each role is bound to its own-model slot, tool allow-list, allowed claim kinds and a versioned contract. | `contracts.ts` |
| Specialist registry | 13 roles on 5 own models: Architect, Coder, Debugger, Reviewer, Tester, Security, DevOps, UI/UX, Documentation, plus the science roles Quantum Physics, Nuclear Physics, Computational Math and Statistics. | `contracts.ts`, `modules/ingest/drivers.ts` |
| Gate · sentinel | Deterministic, 0 tokens: schema, ownership, domain scope (weapon-relevant nuclear requests are denied for every role), high-confidence secrets redacted before the model sees them, and destructive commands flagged. Denials are explained, recorded and never retried. | `gate.ts` |
| Specialist | The single AI gateway with `residentRole`: the role's own model runs first, and a cloud engine is the fallback. Streams live; `claims` blocks are hidden from the stream. | `run.ts` (`ClaimsStreamFilter`) |
| Scientific Verification Kernel | Pure software that re-derives every claim deterministically, seeded where random. Each proof is hashed. | `engines/kernel/*` |
| Verify · judge | Blind contract gate (sees claims and proofs only). A science answer needs ≥ 1 claim, and every proof must PASS. Other roles: any claims present must pass, and with no claims the answer is UNVERIFIED (said plainly). | `judge.ts` |
| Repair / Escalate | A failure triggers repair with the kernel's exact findings (the client clears the streamed text). The 3rd failure is ESCALATED: the answer is labelled "Not verified" with the findings, and the run waits for a human (Pipeline page → Escalated). | `run.ts`, `judge.ts` |
| Act | Chat is answer-only. Writes, sends, deploys and paid calls go through the task engine's approvals. | `run.ts` |
| Commit · seal | Final text hash + kernel rollup → proof hash. The receipt has role, contract, engine label, attempts, tokens vs budget, proofs and gate checks. A `pipeline.sealed` audit event joins the account's tamper-evident chain. | `run.ts`, `ledger.ts` |

## Kernel verifiers

| Claim kind | Verifier | How it decides |
|---|---|---|
| `identity` | CAS | Exact symbolic residual over the rationals (polynomials and rational functions), plus ≥ 3 seeded numeric points every time. Transcendental expressions are checked numerically and labelled as such. |
| `derivative`, `integral` | CAS | Symbolic differentiation; an integral is checked as d/dx of the antiderivative. |
| `numeric` | CAS | Evaluates the expression and compares it within the stated tolerance. |
| `units` | Dimensional analysis | SI base dimensions. Sums must match, `sqrt` halves dimensions, and other functions need dimensionless arguments. |
| `stats` | Statistics | The plan is hashed first. Then Welch / one-sample t-tests, Student-t confidence intervals, Cohen's d, Holm correction across a run, and a seeded bootstrap. |
| `circuit` | Quantum | Exact state-vector simulation (≤ 12 qubits). Every gate is checked for unitarity and normalization after every step. Optional seeded shots. |
| `reactor` | Civil reactor physics | Six-factor formula; one-group bare reactor (slab, sphere, cube, cylinder) with a neutron-balance check; radioactive decay. |

## Ledger and policy

- `pipeline_runs`, `pipeline_events` and `pipeline_answer_cache` live in migration `0158`, all owner-only under RLS.
- Every stage is an event: `event_hash = sha256(parent | seq | stage | canonical payload)`. `GET /api/v1/pipeline/runs/:id` re-verifies the chain, and the Pipeline page shows ✓ or the broken event.
- **Offline rule:** if the ledger can't be written at Intake, the run refuses to answer (`ledger_offline`).
- **Budget governor:** per-run cap = min(tier cap, 300 + 3 × effort tokens). An attempt that would exceed the cap never starts (`NEEDS_BUDGET`).
- **Stop / kill switch:** an abort halts the run and seals it as `HALTED`, with state saved.
- **No free tier:** a run without Solo, Team or API Access (or early-access demo) is refused before Intake.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/pipeline/registry` | The 13 roles, contract versions, own-model readiness |
| `GET /api/v1/pipeline/runs[?status=ESCALATED]` | Recent runs; the Escalated filter is the operator console |
| `GET /api/v1/pipeline/runs/:id` | Receipt, events and chain verification |
| `POST /api/v1/pipeline/verify` | `{ claims: [...] }` → kernel proofs (0 tokens) |

## Known limits (honest)

- The CAS is exact only for polynomial and rational expressions. Anything with sin, exp and similar functions is checked at seeded points, not proven symbolically.
- Code answers are UNVERIFIED in chat. Code is verified when it runs: tests through the task engine.
- Your own models are not running yet (`scripts/setup-resident-models.ps1`), so specialists fall back to cloud engines when keys exist. With neither, the run fails honestly.
