# KUBERNS DEMO TALK TRACK — CodeConClave

Companion to `SATURDAY_DEMO_RUNBOOK.md`. Every claim below is backed by a live observation recorded in `SATURDAY_DEMO_GATE_REPORT.md`. If a line has no evidence behind it, do not say it.

**Tone:** calm, specific, evidence-first. Quote numbers you actually measured. When something is unfinished, say so — the honesty *is* the pitch.

---

## 1. The 20-second opener

> "This is the live production URL — not a mock, not a local build. I register an account, create a project, and hand the system a real task. Watch what happens next."

Point at the URL bar. Then register. Registration returns in ~2 seconds with **no email verification wall** — say that plainly:

> "Straight into a working account. No card, no confirmation email, no paywall."

## 2. Positioning — what this is

Use these four, in this order. Each is a measured fact.

| Say | Evidence |
| --- | --- |
| **"It is a project-first workbench, not a chat box."** | Project → task → plan → specialist runs → timeline → artifacts → audit are separate, inspectable surfaces. |
| **"Specialist agents execute a plan, they do not just talk."** | Live task produced a 2-stage plan (`RESEARCH`, `DOCS`), each stage with its own acceptance criteria, executed as separate coworker runs. |
| **"Verification is real, and it is allowed to say no."** | Gate requires no `FAIL`, all required verdicts `PASS`, and a deliverable. Across this pass, tasks that did not earn it were parked in `REQUIRES_REVIEW` with the reviewer's actual written finding — and **no artifact was published**. |
| **"Every action leaves a record."** | Audit trail returned 6+ genuine events (`task.created`, `project.created`, `dna.created`, `notification.created`, `auth.login`) — real rows, not a counter. |

## 3. Narration, step by step

**While the plan forms (first ~5 seconds after submit)**
> "It is not answering me — it is planning. Two stages, each with acceptance criteria it will be judged against later."

**While the specialists run (86–275 seconds)**
> "Those are separate specialist runs, streaming their state changes over SSE — you can see it move from running to verifying. If the stream drops, it falls back to polling and you lose nothing."

**At the verdict**
> "RESEARCH: pass. DOCS: pass. And the artifact itself carries verification: pass. The word 'verified' is earned here — it is not a label we stamp on output."

**On the artifact**
> "A real persisted artifact, hashed, tied to the run and the attempt that produced it. It survives reload, it survives logout and back in."

**On memory being empty**
> "That is genuinely empty — this account is ninety seconds old. I would rather show you an honest empty state than a fabricated one."

## 4. If the task lands in `REQUIRES_REVIEW` on stage

Do not apologise. Reframe in one sentence:

> "That is the system doing its job. It found the work did not meet the criteria, so it refused to publish an artifact. Here is exactly what it objected to."

Open the coworker run and read the reviewer's real finding. Then either retry once or move to the §8 backup in the runbook.

**Never** claim the task completed when it did not.

## 5. Kuberns framing — say it precisely

**The approved line:**

> "Kuberns is our planned strategic deployment boundary. The control plane runs as a managed service today; moving execution onto Kubernetes is a deliberate next step, and we are not pretending it is finished."

**Supporting points you can defend:**
- The system is built with a clean separation between the control plane (what you are using) and the execution substrate (where the work runs) — which is exactly what makes a Kubernetes move tractable rather than a rewrite.
- Containerised, stateless API with external Postgres and Redis means the same code target a cluster without redesign.
- The workbench, verification gate, artifacts and audit are substrate-independent — they do not change when the substrate does.

**Do not say:** that CodeConClave runs on Kubernetes today, that a Kuberns migration is complete, tested, in staging, or benchmarked, or that any specific cluster topology exists. It does not, and nothing in this pass created one.

## 6. Payment and Google OAuth — the demo line

> "This environment is running in temporary demo mode: no payment, no entitlement wall, no card. Google sign-in is off the customer surface for this preview — it exists only for plugin connectors."

This is true and verifiable on stage: the access endpoint returns `temporaryDemoMode=true, paymentRequired=false, purchaseEnabled=false`, and the deployed bundle contains **zero** occurrences of `PaymentGateModal`, `Sign in with Google`, `accounts.google`, `checkout`, `Upgrade`, `402`, or `payment_required`.

## 7. Do NOT say — hard list

- No uptime, availability, SLA, or "always on" claims. The host sleeps when idle; cold starts up to ~45s were observed.
- No "99.9%", no "24/7 autonomy" as a shipped capability.
- No LOCAL execution, preview environments, or Kubernetes/Kuberns runtime as working features.
- No claim that every task completes. Across 14 live task runs, 4 reached `COMPLETED` and the rest honestly parked.
- No claim of a completed migration, a running cluster, or a benchmarked deployment.
- Do not present the memory feature as populated — it is empty on a new account.

## 8. Anticipated questions

**"Is that really production?"**
Yes — `https://codeconclave-api.onrender.com`, commit `96b4241`, health endpoint reports Database, Redis, Queue, Worker, AI providers and Storage all healthy.

**"Why did that task not finish?"**
Because verification refused to certify it. The gate publishes only when every required stage passes and a deliverable exists. I can show you the reviewer's exact objection.

**"How long does a real task take?"**
86 to 275 seconds for this task shape on the live instance, single attempt, no retries.

**"Does it actually execute code?"**
This task is research and documentation. The execution substrate for code tasks is a separate path, and I will not claim more than the environment can show today.

**"What about my data / privacy?"**
The audit trail is on by default and every action is recorded with actor, scope and resource. Memory on a brand-new account is empty — nothing is pre-seeded.

**"Is Kuberns live?"**
No. It is the planned deployment boundary. Today the control plane runs as a managed service.

**"What happens if the model provider fails?"**
The task fails honestly — I observed one live case where a provider-capability error dead-lettered a task after three attempts rather than silently producing unverified output.

**"Can I see the code?"**
Yes, but I am not touching git, deploys or infrastructure during the demo.

## 9. Closing line

> "Three things to take away: a project-first workbench rather than a chat window; specialists that execute a plan with criteria attached; and a verification gate that is allowed to say no. Everything you just saw was the live URL, with no payment and no seeded data."
