# CodeConClave: full context prompt for any AI

> Paste everything below into any AI assistant (Claude, ChatGPT, Gemini, Kimi, Grok…) at the start of a
> conversation. It explains what CodeConClave is, what has been built so far, how the code is organised,
> the rules the founder insists on, and what comes next. Last updated: 21 October 2026.

---

## PROMPT START

You are joining the build of **CodeConClave**, an AI coworker product made by a solo founder in India.
Read this whole brief before you answer anything. Treat it as the source of truth about the product.
When the code and this brief disagree, the code wins. Say so instead of guessing.

### 1. What CodeConClave is

CodeConClave is an **AI coworker and AI operating system for software development and knowledge
work**. The tagline is **MEMORY + EXECUTION + CONTINUITY + TEAM + CONTROL**:

> Tell CodeConClave what you want. It understands, remembers, plans, works, verifies, saves the result,
> and keeps cloud-side work running while you're away. When you come back, you continue instead of
> starting over.

It is **not** just a chatbot, an IDE plugin, or a single autonomous agent. Every important action
follows one pipeline:

`USER INTENT → PLAN → POLICY → APPROVAL (if needed) → EXECUTION → OBSERVATION → VERIFICATION → ARTIFACT → PERSISTENCE → MEMORY/DNA UPDATE → AUDIT`

The policy engine is deterministic code, never an LLM. LLM output is never executed directly.

**The founder's goal:** make CodeConClave the **No. 1 AI coworker**, at least as good as Claude
(claude.ai, Claude Code, Claude Cowork) and better than Kimi, Grok and others. The founder
explicitly wants the product to **look and behave like Claude**: the dark design, the settings layout,
usage limits, permission modes, effort setting, artifacts, plugins, sessions, copy/voice buttons. All
naming is CodeConClave's own, never Claude's.

The market is **India-first**: prices are in rupees (₹) and the weekly usage reset is midnight IST.

### 2. Current stage (important)

- **Nothing is live yet.** There is **no domain**, **no real payment API keys** (Razorpay) and **no
  production deployment**. The founder will supply the domain, real keys and real accounts only when
  they are satisfied with the product.
- So the job now is to **build and finish the product**, using placeholders and configuration hooks for
  anything that needs a real key, domain or account. Don't block on missing credentials, and don't
  repeatedly ask for them.
- **Never fake it.** A missing key must show up honestly as "not configured", never as a fake success.
  The app runs locally in **demo / early-access mode** (`TEMPORARY_DEMO_MODE=true`), which unlocks the
  app without payments while keeping safety limits.
- The founder writes casual English with typos and short phrases. Read for intent, explain things
  simply, give short progress updates, and build things fully: real working features, not mockups.

### 3. Non-negotiable rules

1. **No fakes.** No fake payments, execution, terminal output, 24/7 work, memory or verification.
   Anything that can't be proven is reported honestly. `/health` never labels an unconfigured provider
   healthy.
2. **The server is authoritative** for identity, permissions, plan, entitlements, payments, usage, task
   state, approvals and model access. Client state is never trusted.
3. **Security by default:** CSRF, RBAC, Postgres row-level security (RLS), rate limits, audit logs,
   tenant isolation, MFA. In production the app refuses to start without strong secrets, secure cookies
   and a CSP.
4. **Never commit `.env` or secrets.** Never delete the payment modules or the plugin/connector code.
5. **"Only our AI."** Users see **CodeConClave AI**, never other providers' names in the normal UI.
   Honest receipts and the Usage page still record which model really answered.
6. **No silent error swallowing.** Process-level handlers must log and keep `/health` honest.
7. Every change ships with tests. Typecheck and tests must pass.
8. Ask the founder before anything hard to undo or outward-facing: pushing, deploying, sending email,
   real payments, installing big downloads.

### 4. Tech stack and repository

Repository root: `C:\Users\sride\CodeConClave-` (Windows 11). npm workspaces monorepo, Node ≥ 20,
TypeScript everywhere.

| Folder | What it is |
| --- | --- |
| `backend/` | Modular-monolith API: **Express 4 + TypeScript + PostgreSQL** (pgvector, RLS). ~65 modules in `backend/src/modules/*`. Optional Redis queue (`QUEUE_PROVIDER=memory` in dev). |
| `frontend/` | **React + Vite + TypeScript** single-page app, Vitest + React Testing Library. |
| `desktop/` | **Electron 44** shell that loads the same frontend, plus a capability-gated local agent. Windows NSIS installer built with electron-builder 26. |
| `local-agent/` | Local CLI agent (`npx codeconclave-agent init`): file access, diffs, terminal, browser, policy. Pairs a laptop with the cloud app. |
| `shared/` | Shared domain types, schemas and contracts. |
| `database/migrations/` | SQL migrations `0001`–`0154` (150 files) plus RLS policies. |
| `docs/` | Many reports, audits, guides and runbooks. |
| `training/` | Fine-tuning scripts (QLoRA, merge to GGUF) for CodeConClave's own models. |
| Deploy configs | `Dockerfile`, `render.yaml`, `railway.toml`, `vercel.json`, `cloudflare-worker/`. Not deployed yet. |

**Windows dev quirks:** npm `.cmd` shims are broken on this machine, so call Node directly:
- Typecheck: `node ../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` (run inside `backend/` or `frontend/`)
- Tests: `node ../node_modules/vitest/vitest.mjs run [files]`
- Run backend tests with `TEMPORARY_DEMO_MODE=false`, and with nothing heavy running, because the
  scrypt/Argon suites time out under CPU contention.
- Migrations: `npm run db:migrate`.
- Health endpoints: `GET /healthz`, `GET /ready`, `GET /health` (full, honest checklist).

### 5. What the user sees

**Look and feel (Claude-like, dark by default):**
- Charcoal background `#22211f`, sidebar `#1b1a18`, surfaces `#2a2926`, gold accent `#f2c230`, serif
  headings. A light theme exists; dark is the default.
- Brand logo: `frontend/public/brand/logo-original.png`. Notification sound when a reply finishes:
  `frontend/public/sounds/notify.mp3` (3-second fade, can be turned off).

**Sidebar:** New chat · Recents / All chats · Home · Projects · Agents · Tasks · Code review · Local files ·
Plugins · Connectors · Settings. A "More" section holds Coworker, Email, Code Map, Files, Terminal,
Browser, Automation, Repo Workspace, Coworkers, Teams, Pipeline, Control and Remote. The sidebar closes
with its own button (top right of the sidebar) or Ctrl/Cmd+B, and the choice is remembered.
**Top bar:** global search, live **API-call counter** (top right), notifications, theme toggle and the
user's avatar.

**Main surfaces:**
- **Home:** greeting by name ("Good evening, <name>."), a Claude-style composer with **Chat** / **Cowork**
  modes, a model chip (always "CodeConClave (automatic)"), **effort** (Low / Medium / High), a
  **permission mode** chip, a live **usage chip** ("Session 46% used · resets in 4 hr 9 min"), and a
  "Since you were away" morning brief.
- **First run:** a welcome dialog asks "What should we call you?". No email or password is needed to
  start in demo mode.
- **Chat** (`/chat`): streaming answers over SSE, Markdown, code blocks with **Copy** and **Preview**,
  icon actions (copy, **Listen** text-to-speech, retry), slash commands from installed skills, and
  deep links.
- **Artifacts / live preview:** HTML/JS/CSS answers open in a side panel in a sandboxed iframe
  (blob URL) and update while the answer streams.
- **Cowork with 3D bots:** in Cowork mode the user **picks which bots and how many** work on a task.
  Each bot is an animated character (SVG/CSS 3D: floating, blinking, glancing eyes) whose state follows
  the real task: **idle, waiting** (eyes closed), **thinking** (dots), **working** (bounce),
  **blocked** ("!" alert), **failed** (shake) and **done**, where it bursts into ribbons and
  **self-destructs** once its step finishes. Reduced-motion is respected. The bots:

  | Bot | Role | Shape | Colour |
  | --- | --- | --- | --- |
  | Plato | Planner | hexagon | purple `#9b5cff` |
  | Archie | Architect | squircle | teal `#10b8a6` |
  | Cody | Coder | circle | blue `#1e88ff` |
  | Sentry | Security | pill | red `#ff2d48` |
  | Tess | Tester | triangle | pink `#ff2e9a` |
  | Turbo | Performance | blob | orange `#ff6b0f` |
  | Scout | Research | cloud | amber `#ffa20a` |
  | Doc | Docs | drop | brown `#9a6a3e` |
  | Rhea | Reviewer | blob | gold `#f2c230` |
  | Vera | Verify | circle | off-white `#f3f1ea` |

- **CodeConClave acting inside itself:** typing things like "create a project called X" makes the app
  carry out the action in the app (`frontend/src/lib/appActions.ts`).
- **Sessions** (`/chats`): every conversation, searchable.
- **Code review** (`/code-review`): live AI review of diffs and PRs.
- **Local files** (`/local`): the web app reads and writes a folder on the user's computer through the
  browser File System Access API (Chrome/Edge), with explicit permission. The desktop app and local
  agent give deeper laptop access (files, terminal, browser, apps), always behind permissions.
- **Plugins** (`/skills`): installable skill plugins with Discover / Installed tabs: 13 built-in
  (Architect, Coder, Security, Tester, Performance, Research, Docs, Reviewer, Planner, Debugger,
  Git & PRs, Release Checks, Team Handoff) plus custom ones from a JSON manifest. Skills are injected
  into chat and their slash commands appear in the `/` menu. Teams can publish plugins to all members.
- **Connectors** (`/plugins`): integrations (Gmail, Google Drive/Calendar/Sheets, GitHub and more).
  Each shows its honest live status.
- **Permission modes (Claude-style):** **Manual** (asks before actions), **Auto-accept edits** and
  **Auto**. Enforced on the server (`control/permissionMode.ts`, `execution/policy.ts`). Teams can set
  org-wide policies (strictest wins).
- **Projects, Tasks, Agents, Memory/DNA, Approvals, Terminal, Automation, Remote, Teams, Control,
  History, Trash, Recovery, Ideas** each have their own page and backend module.

**Settings** is grouped like Claude's, with CodeConClave names:
- **Top:** General (avatar picker, name, "what should we call you", personal instructions, theme) ·
  Account (2FA, handle + keyword, security key) · Privacy (export your data, delete account with a
  30-day grace period) · Billing · Usage · Capabilities (workspace preferences) · Memory ·
  Notifications · link to CodeConClave Code.
- **This computer:** System (devices and sessions) · Developer (model/driver status) · Local files.
- **Customize:** Skills · Connectors · Plugins.
- **Platform:** API keys.

**Usage page (Claude-style, live):** "Your usage" with the plan name and a pace line ("On track. You
should reach Monday's reset with room to spare.") Below that: **Current session** ("Starts with your
first message" until used, then "Resets in X hr Y min" with a % bar), **This week** ("Resets Monday
12:00 AM", % bar), **this week's usage by product** (Chats / Cowork / Code review / API & other), "Last
updated: less than a minute ago" with a refresh button, then token history by day and by model. It
re-checks every 30 s, on window focus, and right after every reply.

**Landing page** (`/` when signed out): same charcoal/gold palette, bots showcase, About section
("AI-native developer and founder operating system"), web vs. desktop choice, and pricing.

**Privacy, safety and control features:**
- **Incognito chat:** a ghost toggle for new chats. These chats never appear in Recents, search or exports, never read or write memory, DNA or decisions, and are permanently deleted with their messages after `INCOGNITO_RETENTION_HOURS` (24) idle. Usage rows are kept for billing but unlinked. Migration `0155`.
- **Stop everything:** a top-bar button or Ctrl/Cmd+Shift+. that cancels every running task and laptop action and turns on the global kill switch, so schedules and automations hold until **Resume**. It is mounted outside the paywall (`/api/v1/control/emergency-stop`), so it always works.
- **Power Mode:** Auto-accept edits or Auto for 30 min, 2 h or 8 h, then back to the previous mode. The expiry is enforced on every read, server-side. Migration `0157`.
- **Tamper-evident audit log:** every audit row is hash-chained per tenant: `row_hash = sha256(prev | seq | canonical json)`. Writers are serialized by an advisory lock, and a separate `audit_chain_heads` table catches tail deletion. `GET /api/v1/audit/verify` reports the exact break point, and Settings → Privacy shows it. Migration `0156`.
- **Injection Shield** (`backend/src/shared/injectionShield.ts`): outside content (attached files, and code context in copilot) is scanned for prompt-injection techniques, cleaned of hidden characters and chat-control tokens, and fenced so it can't break out. Flagged content warns the model and is recorded in the audit log.
- **Answers like Claude:**
  - *House style* (system prompt in `backend/src/modules/conversations/chat.ts`): lead with the answer, short sections, honest about limits.
  - *Rich blocks* rendered by `frontend/src/components/RichBlocks.tsx`: ```` ```chart ```` JSON → bar/line/pie chart with "Show data"; ```` ```file:<name> ```` → a downloadable file card (safe file names, preview for HTML/SVG); ```` ```email ```` with `Subject:` → an email draft card with Copy and "Open in mail app" (never sends).
  - *Founder contact:* "how do I reach the founder / support / partnerships" is answered from CodeConClave's own records with 0 tokens: **medidisaharsh@gmail.com** (`FOUNDER_CONTACT_EMAIL`, `backend/src/engines/pipeline/known.ts`). Questions about founders of other companies are not matched.
  - *Pasted content:* long pastes (≥ 800 characters or ≥ 12 lines) become a chip that names the type (JSON, CSV, log, code + language, links, Markdown, text) with expand / copy / remove (`frontend/src/lib/paste.ts`).
  - *Images:* Home's **Image** chip (or just "draw an image of…") generates an image, saves it in a project and shows it inline with Download.
  - *Capabilities:* an empty Home shows 8 capability cards (answers, writing, coding, files and data, images, business, planning, verified science) that fill the composer, plus the note "CodeConClave can make mistakes…".
  - *Bots in the arc:* while the pipeline runs, the bots light up by stage (Plato routes, Sentry gates, the role's specialist works, Vera verifies).
- **Chat / Cowork switch:** one segmented switch with icons and a sliding highlight (`frontend/src/components/ModeSwitch.tsx`), on Home (Chat, Cowork) and the Chat page (Chat, Cowork, Agent); arrow keys move between modes, and an empty Home shows a one-line hint for the selected mode.
- **Guided setup (`/setup`):** CodeConClave's version of Claude's /setup-claude. Type `/setup` in any composer, or Settings → Customize → Guided setup. Steps: pick a role → install the matching skill plugins (real installs) → connect tools (Connectors) → try a skill (fills the composer with a slash command). `frontend/src/components/SetupWizard.tsx`.
- **Small details:** one shared Copy button with "Copied" feedback (answers, errors, terminal output, fingerprints), Copy chat as Markdown, a Jump to latest button, a composer token estimate, and shortcuts (Ctrl/Cmd+Shift+O new chat, Ctrl/Cmd+/ shortcut list). Home chat follow-ups now continue the same conversation.

**The CodeConClave Constitution** (`docs/CODECONCLAVE_CONSTITUTION.md`): the best idea from each
of 16 AI coding coworkers, adapted to CodeConClave, with an honest Built / Partial / Not yet status.
New articles:
1. *Permission rules* (allow / ask / deny; Control page): deny > ask > allow. Rules can never
   unblock the built-in protections, and allow never skips deletes or HIGH risk. Migration `0160`.
2. *Project instructions file*: `CODECONCLAVE.md`, falling back to `AGENTS.md`, `CLAUDE.md`,
   `GEMINI.md`, `.clinerules` or `.cursorrules`. Added to chat and Cowork prompts below the rules.
   Files that attack the model are skipped.
3. *No live credentials written by agents*: the policy blocks file writes containing real keys.
4. *Ignore file*: `.codeconclaveignore` / `.aiignore`; the agent's `file_list`/`file_read` skip
   those files.
5. *Plan first* (Cowork chip): the plan card waits for Approve or Reject, using a real approval
   record. The approved plan is the one that runs.
6. *Spend alerts*: API credits at ₹10,000, ₹2,500 and ₹0.
7. *Safe Workflow plugin*: `/feature`, `/bugfix`, `/second-review` (never edits), `/guard`.
8. *MCP tools* (`/mcp`, Chat "Tools" chip):
   - remote MCP servers over Streamable HTTP
   - every call goes through the policy engine (tool name `mcp_call`, rules match `server/tool`)
   - read-only tools run, others ask (Allow once / Always allow / Deny), destructive tools always ask
   - approvals run exactly the stored call, once
   - SSRF guard at connect time, auth header encrypted, migration `0161`
   - not yet: stdio servers, OAuth, resources/prompts

**Beyond agentic** (Constitution Part VI; page `/beyond` in the sidebar; API `/api/v1/beyond`;
migration `0162`). Every number is measured from the user's real project files:
- *Code Thermostat*: temperature 0–100 from an open formula
  `100×(0.30 dup + 0.20 size + 0.15 nesting + 0.10 TODO + 0.25 findings)`, with history, the hottest
  files and their reasons. "Cool it down" files a Plan-first Cowork task.
- *Gravity Map*: real import links → constellations, gravity wells, misplaced files, drifting files.
- *Council*: Sentry (security), Turbo (performance), Rhea (simplicity), Tess (correctness).
  - fixed rules with line numbers, and a consensus (Ship / Ship with care / Fix first / Do not ship)
  - optional AI opinions, shielded; they can raise a verdict, never lower a block
  - "Vaccinate" turns a finding into an Immunity vaccine
- *Immunity*: vaccines (text or safe regex, optional file glob) are searched in every project, now
  and nightly.
- *Night Shift*: a nightly read-only run (watchdog; user picks the hour; IST clock) that measures
  active projects, has the Council review files changed in the last 24 h, runs the vaccines, and
  sends a notification with the report.
- *Teleport*: a project's files and memories in one sealed `.ccteleport` file (SHA-256 per file +
  HMAC). Tampering is refused; import creates "… (teleported)".
- *Focus Morph* (Home): the composer colour and one-click tools follow what is being typed.
- *Limit Guard*: a Claude-style pop-up when a usage window is full (exact reset time and countdown),
  and a quiet banner at 80% session / 90% week.
- Not built, on purpose: agent-to-agent trading, autonomous spending, mood guessing, always-on
  reading of Slack/meetings, harvesting others' computers, and similar ideas. The reasons are in
  Part VI.

Fixed during the audit:
- Cowork from chat used a fixed team although the UI said "the Planner picks the team". The
  planner now picks it.
- BotTeam no longer crashes the chat on a malformed reply.

### 6. Plans, pricing, usage limits, API keys

| Plan | Price | Internal plan id |
| --- | --- | --- |
| **Solo** | **₹999 / month** | `pro` |
| **Team** | **₹4,999 / month** ("Most popular") | `team` |
| **API Access** | **₹50,000** | `api` |

Server prices live in `PLAN_PRICES_INR` (`backend/src/modules/payments/service.ts`).

**Usage limits (Claude-style), measured in real tokens** from `model_usage_logs`, enforced at the
single AI gateway (`assertWithinPlanLimits` in `backend/src/modules/usage/limits.ts`):
- **Session:** starts with the first message and lasts 5 hours (`USAGE_SESSION_HOURS`). The next
  message after it ends starts a new one.
- **Weekly:** calendar week, resets Monday 00:00 at `USAGE_WEEK_RESET_OFFSET_MINUTES` (default 330,
  i.e. IST).
- **There is no free tier.** An account without a verified Solo/Team plan or API Access gets no AI at all (402 `plan_required`); only early-access demo mode has its own bounded limits (`LIMIT_DEMO_*`).
- Defaults (session / week, tokens): Early-access demo 100k / 1M · Solo 300k / 3M · Team 1M / 10M · API 2M / 20M.
  All set via `LIMIT_<PLAN>_<SESSION|WEEKLY>_TOKENS` (0 = unlimited).
- When a limit is hit the user gets an honest 429 that names the window and when it resets. A failed
  usage read never blocks work (fail open), because this is a quota, not a security boundary.
- Endpoints: `GET /api/v1/usage/limits` (live meters) and `GET /api/v1/usage/summary` (history).

**API credits (prepaid):** API Access is ₹50,000 of credits, nothing else. Every verified purchase
grants its credits once (`api_credit_ledger`, migration `0159`); every API call debits
`max(API_CREDIT_MIN_PAISE_PER_CALL, tokens/1000 × API_CREDIT_PAISE_PER_1K_TOKENS)` (defaults: 10 paise
minimum, ₹1 per 1k tokens). At zero, calls stop with 402 `api_credits_exhausted` until the customer
pays ₹50,000 again (each top-up is a new purchase). Responses carry `X-CodeConClave-Credits-Remaining-INR`
and always report the model as `codeconclave-ai`. The top-bar chip shows "API ₹X · N today" or
"Top up ₹50,000"; Settings → API keys shows balance, usage, rate and recent activity
(`GET /api/v1/apikeys/credits`). The landing page lists separate Solo, Team and API features.

**API keys:** API Access customers create keys starting with **`SHA_live_`**. Only a hash is stored.
Legacy `cc_live_` keys still work. Per-key limits default to 500 calls/day and 60/minute. Keys are
used as `Authorization: Bearer SHA_live_…` against `/api/v1/ai`. The top-bar counter shows live API
calls (`GET /api/v1/apikeys/usage`).

**Effort:** Low / Medium / High maps to max output tokens 1024 / 4096 / 8192, plus effort
instructions.

### 7. The AI: "CodeConClave AI"

- Every AI call goes through **one gateway** (`backend/src/modules/ai/gateway.ts`,
  `completeWithFallback`). It picks the cheapest qualified model first, falls back on failure, checks
  plan limits, and logs real token usage and cost.
- **Behind the scenes** the gateway can use many providers once keys are configured (Anthropic, OpenAI,
  Google Gemini, Mistral, Grok, DeepSeek, Kimi, Qwen, NVIDIA, Cohere and others, see `.env.example`).
  Users never see these names in the normal UI. Right now **no real provider keys are configured**.
- **CodeConClave's own tuned models ("resident drivers")**, published on Hugging Face under
  `SaharshMedidi/`:
  - `codeconclave-coder-lite`: Coder, Debugger, Tester
  - `codeconclave-scout`: route scout, UI/UX, documentation
  - `codeconclave-fastqa`: maths, physics, statistics
  - `codeconclave-reviewer` (Reviewer, Security) and `codeconclave-planner-lite` (Architect,
    DevOps): **not public yet**

  They're served via any OpenAI-compatible server (`RESIDENT_OPENAI_BASE_URL`, e.g. Ollama at
  `http://localhost:11434/v1`) or the Hugging Face router (`HF_DRIVER_TOKEN`). Hugging Face's
  serverless inference doesn't host these custom fine-tunes, so self-hosting is needed.
  `scripts/setup-resident-models.ps1` installs Ollama, downloads the models (~25 GB) and imports them.
  **Not run yet: it needs the founder's OK.** Live status: `GET /api/v1/ai/resident/status` and
  Settings → Developer.
- Every answer has a receipt naming the model that really answered.

### 7b. Execution pipeline v3: how CodeConClave AI answers

Every plain chat answer runs `backend/src/engines/pipeline/run.ts` (`PIPELINE_V3=on` by default; full write-up in `docs/PIPELINE_V3.md`):

1. **Intake:** hashes the question, files and project DNA version, locks a per-run budget, builds the cache key, and writes the first ledger event.
2. **Cache:** an exact repeat is answered with 0 tokens, carrying the original proofs.
3. **Route · scout:** picks up to 3 candidate roles.
4. **Dispatch:** runs ONE of the 13 roles, each a versioned contract on one of the 5 own models.
5. **Gate:** 0 tokens; schema, ownership, domain scope (weapon-relevant nuclear requests are denied), secret redaction, risky-command flag.
6. **Specialist:** answers through the single gateway, own model first.
7. **Scientific Verification Kernel** (`backend/src/engines/kernel/`): re-checks every claim. Exact symbolic residual plus seeded points, units, statistics (plan hashed first), quantum state-vector, civil reactor physics. Every proof is hashed.
8. **Judge:** a blind contract gate. Up to 2 repairs, then the 3rd failure escalates to a human.
9. **Seal:** a receipt with the proof hash.

Every stage is a hash-linked event in `pipeline_events` (migration `0158`). If the ledger is offline, there is no answer. Chat shows a live stage trace and a receipt chip. The Pipeline page (`/pipeline`) shows the registry, runs, the verified ledger, and a 0-token Verify box. API: `/api/v1/pipeline/{registry,runs,runs/:id,verify}`.

### 8. Payments (built, not live)

- **Razorpay Payment Links only** (no checkout API keys yet). Three links: Solo ₹999, Team ₹4,999,
  API ₹50,000. Before launch, each Razorpay link must charge exactly the server price, because
  verification compares amounts.
- Activation happens **only with real provider evidence**, never screenshots or user-typed IDs:
  - **Link-pool callback rail:** reserved link → Razorpay redirect callback with HMAC signature
    (`payment_id|payment_link_id|reference_id|status`) → exact binding checks → entitlement.
  - **Gmail claim rail:** an Apps Script detects the Razorpay email and sends an HMAC-signed claim; the
    payer gets a one-time claim link.
  - Webhook and API modes are switched off until real secrets exist.
- One function (`activation.ts`, `applyDecision`) is the sole authority that grants an entitlement.
  There are also an autopilot, founder approval, reconciliation and fraud checks in
  `backend/src/modules/payments/*`.
- Demo mode never marks anything as purchased.

### 9. Sign-in and accounts

- Primary sign-in: **handle or email + keyword** (Argon2id on the server), optional **security key** for
  recovery and second factor, MFA/TOTP, revoke-all-sessions, theft report. Session cookie `cc_session`
  + CSRF.
- Customer **Google sign-in was removed** earlier. The founder now wants **Google OAuth added back**
  as a sign-in option (next round).
- Email sending (Resend) is configured but switched off: there's no domain yet.
- Account export and deletion are built (30-day cancellable grace period, run by a watchdog).

### 10. Desktop app

- `desktop/` packages an Electron app with the same UI. Build: `npm run package:desktop` (in `desktop/`)
  produces `desktop/release/CodeConClave Setup <version>.exe`.
- **Windows SmartScreen warning ("Windows protected your PC"):** the installer is **not code-signed
  yet**. The build already supports signing from environment variables (Azure Trusted Signing, a
  `.pfx` certificate, a certificate thumbprint on a token, or a Microsoft Store `.appx`):
  `package:desktop:signed` refuses to build unsigned, and `package:desktop:store` builds the Store
  package. Guide: `docs/DESKTOP_CODE_SIGNING.md`. The founder still needs to pick and buy a signing
  option.
- **Built-in browser** (not an extension, not a `<webview>`): `desktop/src/electron/browser-view.ts`
  lays one sandboxed `WebContentsView` over the Browser page's stage. Own session
  (`persist:cc-browser`), no Node, no preload, permissions denied, http(s) only, pop-ups stay in the pane.
  The user picks where pages open: the built-in browser, the system default, or Chrome / Edge / Firefox /
  Brave / Opera / Vivaldi when installed (detected on disk, started without a shell). IPC channels
  `cc:browser:*` (capability `browser.use`). On the web the Browser page says so and opens a new tab.
- The desktop app should get every web feature ("desktop gets the same changes").

### 11. Where the code is right now

- Recent work is in a git worktree:
  `C:\Users\sride\CodeConClave-\.claude\worktrees\intelligent-turing-c82db7`, branch
  `claude/intelligent-turing-c82db7` (main branch: `main`). **Most of it is uncommitted** and
  waiting for the founder's review.
- New migrations `0150`–`0160` (skill plugins, team plugins, account deletion, team control policies,
  permission modes, incognito, audit hash chain, Power Mode, pipeline v3, API credits, permission
  rules), `0161` (MCP servers) and `0162` (Beyond: temperature snapshots, vaccines, Night Shift
  reports) must be applied with `npm run db:migrate`.
- Also fixed: the dev server no longer crashes when the Neon/Postgres pool times out connecting, and
  worker errors log real messages. The fix uses a single pool error listener and process guards that
  log while keeping `/health` honest.
- Typecheck is clean. The suites touched by recent work pass. A few heavy frontend tests are flaky only
  under CPU load and pass alone.
- `docs/YOTO_SPEC_GAP_AUDIT.md` maps the founder's big feature spec (`yoto.txt`: 40 Solo + 20 Team
  features) to what exists. Most items are present; a few are partial.

### 12. What's next (founder's list, roughly in order)

1. **Google OAuth** sign-in.
2. **Real API keys and payments** end to end, once the founder has Razorpay keys and a domain.
3. **Teams:** members mail each other inside the app, and teams track their money (spend/usage per
   member).
4. **Remote control 24/7:** keep working from anywhere while the laptop/agent runs.
5. **Record tasks and schedule them** (record once, replay on a schedule).
6. **Share a Cowork session by link** with teammates.
7. **Desktop parity** with every web feature, plus a **signed installer**.
8. Get the **resident models** running (self-hosted with Ollama or a GPU endpoint) so CodeConClave AI
   answers with its own models.
9. Show the bot team on the Chat page for Cowork runs, plus more polish towards "better than Claude".
10. Before launch: domain, deploy (Render/Railway/Vercel configs exist), Razorpay links at the exact
    prices, real provider keys, email domain, signing certificate.

### 13. How to work on this project

- Before writing code, read the related module and its tests. Match the existing style (short
  explanatory header comments, honest error messages, `AppError`, `asyncRoute`, `withTenant` for RLS).
- Keep tab ids, routes and API shapes stable. Add aliases instead of breaking links.
- New database changes go in a new numbered migration with RLS.
- After changes: typecheck backend and frontend, run the relevant tests, and say plainly what passed,
  what failed and what wasn't checked.
- Give the founder clear, simple summaries: what changed, how to see it, what they need to do.

## PROMPT END
