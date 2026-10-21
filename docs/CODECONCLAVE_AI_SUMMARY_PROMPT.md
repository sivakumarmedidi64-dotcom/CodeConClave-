You are helping build **CodeConClave**, an AI coworker by a solo founder in India. Goal: be the No. 1 AI coworker, as good as Claude (claude.ai, Claude Code, Cowork) or better. It looks and works like Claude, with CodeConClave's own names.

**What it is:** an AI operating system for software and knowledge work. Tagline: MEMORY + EXECUTION + CONTINUITY + TEAM + CONTROL. It understands, plans, works, verifies, remembers and keeps working while you're away. Actions follow: intent → plan → policy → approval → execution → verification → saved result → audit.

**Stage:** building, not live. No domain, no real payment or AI provider keys yet; the founder adds them later. Build real features with config placeholders. Never fake success: a missing key shows as "not configured". The app runs locally in demo mode.

**Rules:** no fakes; the server decides plan, payments, usage and permissions; never commit secrets; never delete the payment or connector code; users only see "CodeConClave AI", never other provider names; add tests; ask before deploying, pushing, payments or big downloads.

**Tech:** npm monorepo, TypeScript. `backend/` Express + PostgreSQL (row-level security); `frontend/` React + Vite; `desktop/` Electron; `local-agent/` laptop agent; `database/migrations/`. On Windows, run tools with node directly: `node ../node_modules/vitest/vitest.mjs run` and `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`.

**Features built:**
- Claude-style dark design (charcoal and gold), logo, notification sound, first-run "What should we call you?", avatar picker.
- Chat: streaming, copy, listen (voice), retry, slash commands, artifacts with live preview, sessions list.
- Cowork: the user picks animated 3D bots: Plato (Planner), Archie (Architect), Cody (Coder), Sentry (Security), Tess (Tester), Turbo (Performance), Scout (Research), Doc (Docs), Rhea (Reviewer), Vera (Verify). States: idle, waiting, thinking, working, blocked, failed, done (bursts and disappears).
- Permission modes: Manual / Auto-accept edits / Auto. Effort: Low / Medium / High.
- Code review, local files (browser folder access), terminal, projects, tasks, memory, approvals, automation, remote, teams, control.
- Plugins (13 built-in skills plus custom ones, shareable with teams) and connectors (Gmail, Google, GitHub…).
- CodeConClave acts inside itself ("create a project called X").
- Settings like Claude's: General, Account, Privacy, Billing, Usage, Capabilities, Memory, Notifications / This computer / Customize (Skills, Connectors, Plugins) / Platform (API keys).
- Live usage like Claude's: 5-hour session (starts with your first message), weekly limit (resets Monday 12 AM IST), usage by product, auto-refresh.
- Account export and deletion; handle + keyword sign-in, MFA, security key.
- Incognito chats: not in history or search, never read or write memory, permanently deleted after 24 hours idle.
- Stop everything (top bar, Ctrl+Shift+.): cancels running tasks and laptop actions and holds schedules/automations until Resume; works even without a paid plan.
- Power Mode: Auto-accept edits or Auto for a set time (30 min / 2 h / 8 h), then back to the previous mode automatically (server-enforced).
- Tamper-proof activity log: every audit record is SHA-256 hash-chained per account; Settings → Privacy shows "Verified" or exactly where it was tampered.
- Injection Shield: attached files (and other outside content) are scanned for prompt-injection tricks, neutralized, fenced, and flagged to the AI and the audit log.
- Micro details: copy buttons with "Copied" feedback, Copy chat as Markdown, Jump to latest, token estimate in the composer, shortcuts (Ctrl+Shift+O new chat, Ctrl+/ shortcut list, Ctrl+B close/open sidebar).
- Answers like Claude: charts (```chart), downloadable files (```file:name), email drafts (```email, never sent); long pastes become a typed chip (JSON, CSV, log, code…); Home generates images inline; an empty Home shows 8 capability cards and "CodeConClave can make mistakes".
- Founder contact: "how do I reach the founder/support" answers instantly (0 tokens) with medidisaharsh@gmail.com.
- Chat / Cowork switch: Claude-style segmented switch with icons (Chat page also has Agent).
- Guided setup: type /setup (or Settings → Customize → Guided setup): role → install matching plugins → connect tools → try a skill.
- The CodeConClave Constitution (`docs/CODECONCLAVE_CONSTITUTION.md`): best ideas from 16 AI coworkers, adapted, with honest status. Built this round:
  - permission rules (allow/ask/deny)
  - `CODECONCLAVE.md` project instructions (also reads `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`)
  - agents can't write live credentials into files
  - `.codeconclaveignore`
  - Cowork "Plan first" with Approve/Reject
  - API credit alerts at ₹10,000, ₹2,500 and ₹0
  - Safe Workflow commands: `/feature`, `/bugfix`, `/second-review`, `/guard`

  - MCP tools (Settings → Customize → MCP servers; Chat "Tools" chip): read-only tools run, others ask (Allow once / Always allow / Deny), destructive tools always ask; approvals run exactly the approved call, once.

  Not built yet: user hooks, worktree isolation, issue→PR automation, live takeover, inline completion, auto browser testing, OS sandbox, local (stdio) MCP servers.
- Desktop built-in browser (Browser page): a sandboxed pane inside the app, own session, http(s) only; users choose built-in, system default, or an installed Chrome/Edge/Firefox/Brave.

**Pricing (no free tier — everyone pays):** Solo ₹999/month; Team ₹4,999/month; API Access ₹50,000 of prepaid credits (keys start with `SHA_live_`; each call debits credits; at zero calls stop with 402 until they pay ₹50,000 again; the top-right chip shows the live balance). Payments use Razorpay payment links and activate only on verified proof (not live yet).

**Execution pipeline v3 (how CodeConClave AI answers — `backend/src/engines/`, doc `docs/PIPELINE_V3.md`):** Intake (hashes + locked budget + cache key) → Cache hit (0 tokens) → Route·scout → Dispatch (ONE of 13 roles on 5 own models, versioned contract) → Gate (0 tokens; weapon-relevant nuclear asks denied; secrets redacted) → Specialist → Scientific Verification Kernel (pure software: exact CAS residual + seeded points, units, statistics, quantum state-vector, civil reactor physics; every proof hashed) → Judge (repair ≤ 2, 3rd failure escalates to a human) → Seal (receipt + proof hash). Every stage is a hash-linked ledger event; no ledger → no answer. Chat shows a live stage trace and a receipt under each answer; the Pipeline page shows the registry, runs (Escalated = operator console), each run's verified ledger, and a 0-token "Verify claims" box.

**AI:** one gateway handles every AI call (fallback, limits, real token logging). Own tuned models on Hugging Face (`SaharshMedidi/codeconclave-coder-lite`, `-scout`, `-fastqa`; reviewer and planner not public yet) need self-hosting (Ollama script ready, not run).

**Desktop:** Windows installer builds, but it isn't code-signed yet, so SmartScreen warns. Signing support is ready; a certificate is needed.

**Next to build:** Google OAuth sign-in; real API keys and payments end to end; team mail and money tracking; 24/7 remote control; record and schedule tasks; share Cowork by link; desktop with the same features plus signing; get the own models running; launch (domain, deploy, real keys).

Read the related code and tests before changing anything, match the existing style, keep routes and APIs stable, run typecheck and tests, and give the founder a short, simple summary of what changed.
