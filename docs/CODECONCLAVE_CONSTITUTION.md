# The CodeConClave Constitution

India's Constitution took the best ideas from many countries (parliament from the UK,
fundamental rights from the USA, directive principles from Ireland, emergency powers from
Germany) and adapted them to India. CodeConClave does the same with AI coworkers: it takes the
best idea from each of the 16 coding coworkers in the research guide (`pokiri.txt`: Claude Code,
OpenAI Codex, GitHub Copilot, Cursor, Windsurf / Devin Desktop, Gemini CLI, Amazon Q, JetBrains
Junie, Cline, Roo Code, Aider, Continue, OpenHands, Devin, Replit Agent, Zed) and adapts it to
CodeConClave's own rules.

Every status below was checked in the code and by tests on 2026-10-21. **Built** means the code
exists and a test proves it works; **Partial** means part of it exists; **Not yet** means it is not
built. Nothing here is a plan written as if it were done.

---

## Part I — The basic structure (can never be amended)

No user setting, plugin, rule, project file or prompt can change these:

1. **Built-in protections.** Agents can never read or write secret files (`.env`, keys,
   credentials), never run dangerous commands (`rm -rf /`, `mkfs`, `git push --force` …), never
   escape the workspace, and never act without a capability grant
   (`backend/src/modules/execution/policy.ts`).
2. **No live credentials written by agents** (Article 3 below).
3. **Risky actions ask first.** Deletes, HIGH/CRITICAL actions and anything a connector does
   (sending an email, posting, publishing) always need approval, in every mode and under every rule.
4. **No fake success.** Nothing is reported as done unless an executor result shows it. A missing
   key shows "not configured".
5. **Only CodeConClave AI.** Users never see other AI providers' names.
6. **Everything is on the record.** Every action is in the tamper-evident, hash-chained audit log.
7. **Emergency stop always works**, even without a paid plan.

---

## Part II — Articles adopted in this round (Built and tested)

### Article 1 — Permission rules: allow / ask / deny
**Borrowed from:** Claude Code (permission rules), Zed (tool permissions), Continue (tool
policies), Devin (CLI permissions).
**Adapted:** rules sit *below* the basic structure. `deny` blocks a matching action, `ask` forces an
approval even in Auto mode, `allow` skips the prompt — but only for LOW/MEDIUM actions, never for
a delete and never for a connector action (sending an email, posting, publishing always asks).
Precedence is deny > ask > allow. A blanket "allow everything" rule is refused (use Auto mode
instead). Rules are per user, stored in Postgres with row-level security, refreshed every
15 seconds, and every add/remove is audited.
**Where:** `backend/src/modules/control/permissionRules.ts`, `execution/policy.ts`
(`applyPermissionRules`), routes `GET/POST/DELETE /api/v1/control/permission-rules`, migration
`0160_permission_rules.sql`, screen: Control page → "Permission rules".
**Proof:** 13 unit tests (`control/permissionRules.test.ts`), 2 UI tests
(`PermissionRulesCard.test.tsx`), 6 checks on real Postgres (stored and read back under RLS, allow
works, deny works, delete works, audited).

### Article 2 — Project instructions file
**Borrowed from:** Claude Code (`CLAUDE.md`), Codex and Junie (`AGENTS.md`), Gemini CLI
(`GEMINI.md`), Cline (`.clinerules`), Cursor (`.cursorrules`).
**Adapted:** CodeConClave reads `CODECONCLAVE.md` first. If a project was made for another tool, it
also reads `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.clinerules` or `.cursorrules`, so repos work
without changes. The text joins the chat and every Cowork bot's prompt *below* CodeConClave's
rules. It can shape style and conventions, never safety. A file that tries to attack the model
(override rules, leak prompts, send secrets, run remote code) is **not loaded**, and the model is
told to say why. The text is capped at 8,000 characters.
**Where:** `backend/src/modules/projects/instructions.ts`, used in `conversations/chat.ts` and
`execution/coworkers.ts`.
**Proof:** 6 unit tests, 3 checks on real Postgres (no file → nothing added; `AGENTS.md` picked up;
`CODECONCLAVE.md` wins).

### Article 3 — No live credentials written by agents
**Borrowed from:** GitHub Copilot's cloud-agent safeguards (secret scanning on agent changes).
**Adapted:** a file write by an agent (in the cloud or on the user's own computer) that contains a
live credential (GitHub/Slack/Google/Stripe keys, private keys, JWTs, a database URL with a real
password on a real host) is blocked by the policy engine with a plain reason. The reason names the
kind of secret and never the secret itself. Placeholders, docs and local development URLs
(`postgres://postgres:postgres@localhost/…`, `${DB_PASSWORD}`) still work. No rule can override it.
**Where:** `execution/policy.ts` (`credentialFindings`).
**Proof:** 3 unit tests, 1 check on real Postgres.

### Article 4 — Ignore file
**Borrowed from:** JetBrains Junie (`.aiignore`), Devin (respects `.gitignore` by default).
**Adapted:** `.codeconclaveignore` (or `.aiignore`) at the project root uses `.gitignore` syntax
(`*`, `**`, `?`, `folder/`, `!negation`, comments). The agent's own `file_list` hides matching files
and says how many were hidden. `file_read` refuses them with `ignored_by_project`. Files the user
attaches themselves still work, because the user chose them. **Not yet:** files the Local Agent reads
on the user's own computer. The ignore file covers project files stored in CodeConClave; the
Local Agent still uses only its own workspace grants.
**Where:** `projects/instructions.ts` (`parseIgnore`, `isIgnored`), `execution/tools.ts`.
**Proof:** 4 unit tests, 3 checks on real Postgres.

### Article 5 — Plan first, then act
**Borrowed from:** Cursor (Plan mode), Cline (Plan/Act), Junie (Plan mode), Windsurf / Devin Local
(plan approval), Replit (Plan mode).
**Adapted:** in Cowork, turn on **Plan first**. The team's plan is written straight away and shown
in the chat as a card: each bot (Archie the Architect, Cody the Coder …) and when its step counts as
done. **Nothing runs until you press Approve.** Approve releases the task, and the worker runs
exactly that saved plan (it is not regenerated). Reject cancels the task. The approval is a real
approval record, so it also appears on the Approvals page, shown as steps rather than raw JSON. It
stays open for 30 minutes. The task is created already locked, so the worker cannot start it while
the plan is still being written. If the planner is unavailable, the card says so: "this is the
standard team plan".
**Where:** `execution/orchestrator.ts` (`createPlanFirstTask`), `conversations/chat.ts`
(`planFirst`), `frontend/src/components/PlanApproval.tsx`, Home Cowork "Plan first" chip.
**Proof:** 3 + 5 + 1 tests, plus 8 checks on real Postgres: held for approval, cannot be claimed,
approve releases it, same plan runs, reject cancels, and a short chat message with Plan first on
still files a plan.

### Article 6 — Spend alerts for API credits
**Borrowed from:** Replit (usage budgets and alerts), GitHub Copilot (budgets).
**Adapted:** API Access credits (₹50,000 blocks) notify the owner, in the app and by email, when the
balance falls to ₹10,000, then ₹2,500, then ₹0. Each level fires once per top-up, even when many
calls arrive at the same moment. Amounts are rounded **down**, so an alert never shows more money
than is left. An alert that fails to send never fails the API call.
**Where:** `apikeys/credits.ts` (`crossedAlertLevels`).
**Proof:** 1 unit test covering all levels, no repeats, and the ₹0 message.

### Article 7 — Safe Workflow prompt library
**Borrowed from:** the guide's "safer than asking one AI and trusting it" workflow and its prompt
templates, plus Codex's and Copilot's separate review step.
**Adapted:** a built-in plugin, **Safe Workflow**, with four slash commands, written for
CodeConClave:
- `/feature`: inspect read-only, small plan, small change, tests, exact results
- `/bugfix`: read-only diagnosis with evidence, then a fix plus a regression test that fails first
- `/second-review`: an independent review that **never edits files**, findings by severity, no
  invented findings
- `/guard`: list files and commands first; no deletes, deploys, payments or secrets without
  approval

The guided setup (`/setup`) installs it for the Developer and Security roles.
**Where:** `skillplugins/catalog.ts`.
**Proof:** 4 tests (commands exist, expansion is correct, no name clashes).

### Article 8 — MCP tools
**Borrowed from:** Claude Code, OpenAI Codex, Gemini CLI, Cline, Zed and OpenHands. All of them can
use tools through MCP (Model Context Protocol), the open standard for connecting AI to outside tools.
**Adapted:**
- **Connecting a server.** Connect remote MCP servers on **Settings → Customize → MCP servers**
  (`/mcp`). CodeConClave speaks Streamable HTTP (JSON or SSE replies), discovers each server's
  tools, and shows how each tool is treated. You can try a tool right there.
- **Tools in Chat.** Turn on **Tools** in Chat (the chip appears only when a connected server has
  tools) and CodeConClave AI may use them.
- **The same safety rules as everything else.** Every call goes through the policy engine:
  - tools the server marks **read-only** run without asking
  - other tools **ask first** with an in-chat card: *Allow once*, *Always allow* (saves an allow
    rule for `server/tool`) or *Deny*
  - tools the server marks as changing or deleting data **always ask** (HIGH risk; *Always allow*
    is never offered, and no rule can waive it)
  - your **deny rules** block any tool (`mcp_call` rules match `server/tool`)
- **Who decides the labels.** The read-only and destructive labels come from the server's own tool
  list, saved when the tools are discovered, never from what the AI claims. The AI can only call
  tools the server actually listed.
- **What you approve is what runs.** An approval stores the exact server, tool and arguments; only
  that call can run, and only once.
- **Tool output is untrusted.** It goes to the AI fenced and shielded (Injection Shield).
- **Audit.** Every call is in the audit log, with argument *names* only, never the values.
- **Security.** The server's address is checked at connect time, so a name that resolves to a
  private, loopback or cloud-metadata address is blocked. Production requires https; redirects are
  never followed; every request has a hard time limit and a size cap. The auth header is stored
  encrypted (AES-256-GCM), never sent back to the browser, and can't replace headers the protocol
  needs. Incognito chats never use tools.
- **Tool descriptions are outside text too.** A description that tries to instruct the AI is hidden
  by the Injection Shield, and tool names must follow the MCP naming rule. The AI keeps its
  CodeConClave AI identity in tool chats.

**Not yet:** local MCP servers that run as a program on your computer (stdio, through the Local
Agent), MCP OAuth sign-in (paste a token as the auth header instead), and MCP resources and
prompts (tools only for now).
**Where:**
- backend: `backend/src/modules/mcp/` (`client.ts`, `service.ts`, `chatLoop.ts`, `routes.ts`),
  `execution/policy.ts` (`mcp_call`), migration `0161_mcp_servers.sql`
- screens: `frontend/src/pages/McpPage.tsx`, `components/ToolApprovalCard.tsx`, Home "Tools" chip
**Proof:**
- 23 backend tests, including the real protocol against a small MCP server (JSON and SSE replies,
  paging, sessions, auth, errors), the network guard, and the chat loop with a scripted model
- 12 frontend tests
- 17 checks on real Postgres with a real MCP server: discovery, encrypted auth, read-only runs,
  approval then exactly-once run, destructive at HIGH, allow and deny rules, unknown tools refused,
  turned-off servers unused, audit without values, an unreachable server shown as FAILED
- 4 checks that Chat with Tools on takes the MCP path

---

## Part III — Articles CodeConClave already had (checked in code)

| Idea | Borrowed from | CodeConClave | Status |
| --- | --- | --- | --- |
| Permission modes (Manual / Auto-accept edits / Auto) | Claude Code, Codex, Junie (Safe/Auto/Brave) | Permission mode + **Power Mode** (time-boxed) | Built |
| Session and weekly usage limits | Claude | 5-hour session + weekly meters, by product | Built |
| Prepaid usage credits | Replit, Copilot AI Credits | API Access ₹50,000 credits, 402 at ₹0 | Built |
| Skills, plugins, slash commands | Claude Code, Cline, Roo | 14 built-in plugins + custom + team plugins | Built |
| Several specialists working in parallel | Claude Code subagents, Cursor Explore | Cowork bot team with parallel groups | Built |
| Visible session log | Copilot session logs, OpenHands | Pipeline v3 ledger (hash-linked) + receipts | Built |
| Hunk-level review, apply/undo | Zed, Windsurf diff zones | Review loop (`/api/v1/reviews`, Review pages) | Built |
| Checkpoints and time travel | Cline, Roo, Replit | Task checkpoints (`recovery/checkpoints.ts`) | Built |
| Prompt-injection defence | Claude Code security guidance | Injection Shield | Built |
| Built-in browser | Cursor, Devin, Cline browser tools | Desktop built-in browser pane | Built (desktop) |
| Long-task runtime cap | Copilot (59-minute session) | 15-minute task timeout + retries + dead-letter queue | Built |
| Guided setup | Claude `/setup-claude` | `/setup` wizard | Built |
| Own and local models | Aider, Cline, Zed (local models) | 5 own tuned models via Ollama | Partial: built, not running on this laptop |
| Sandbox for local commands | Codex, Gemini, Devin | Local Agent workspace containment + command policy | Partial: no OS-level sandbox |
| App testing in a real browser | Replit App Testing, Junie `/demo` | Agent browser tasks on a paired device | Partial: not run automatically after Cowork |

---

## Part IV — Directive principles (not built yet, honest list)

These are good ideas from the guide that CodeConClave **does not have yet**:

1. **User hooks** (run a check before or after a tool call), from Claude Code and Cline
   (`PreToolUse`).
2. **Git worktree isolation** for parallel agent tasks, from Zed and Devin Desktop.
3. **Issue → pull request automation** (label an issue, get a PR back), from Copilot, OpenHands
   and Devin.
4. **Watch and take over** a running agent session live, from Devin.
5. **Inline code completion** while typing, from Copilot, Cursor and Zed. CodeConClave is not an
   editor.
6. **Automatic browser testing with a recording** after a Cowork build, from Replit and Junie.
7. **An OS-level sandbox** for commands on the user's computer, from Codex, Gemini and Devin.
8. **MCP extras:** local (stdio) MCP servers through the Local Agent, MCP OAuth sign-in, and MCP
   resources and prompts. MCP *tools* are built (Article 8).

---

## Part V — Honesty audit (what was wrong, and what was fixed)

Checked on 2026-10-21:

- **No fake data on screen.** Every random value in the frontend and backend is used only for IDs
  or an eye-blink animation. There are no testimonials, invented user counts or made-up statistics
  on the landing page.
- **Fixed — Cowork never asked the planner.** The code comment and the bot-team screen both said
  "the Planner picks the team", but every Cowork task from chat silently used one fixed team. Now
  the planner really picks the team. If it is unavailable, it falls back to that same team, so the
  worst case is unchanged.
- **Fixed — the bot team could crash the chat.** A malformed task-status reply blanked the chat.
  It now shows an error instead.
- **Fixed — a credit alert could overstate the balance.** ₹9,999.50 was shown as "₹10,000 left".
  Alerts now round down.
- **Honest plan source.** Plan-first says when the planner was unavailable and the standard team
  plan is being used.

**Found during the live check** (web app + API + real Postgres, in the browser):
- **Fixed — Cowork on Home said "Deep work needs a project".** This happened when the project list
  hadn't loaded yet or the account had none. Cowork now uses the latest project, or starts one
  called "My work".
- **Fixed — a failed answer left an empty bubble** in the Home chat.
- **Fixed — the top bar overflowed by 17 px at laptop width (1,024 px).** The search box now shrinks
  instead.
- **Fixed — plan notes showed literal `_underscores_`.** They now render in italics.
- **Verified live:**
  - Control → Permission rules saves a rule to Postgres.
  - Home → Cowork → Plan first shows the plan card; Approve moves the task to PLANNED with its
    approval APPROVED.
  - The sidebar closes with its button and reopens with Ctrl+B.
  - The Chat/Cowork switch shows the right hint.

---

## How to check it yourself

```
npm run db:migrate            # applies 0160 (permission rules) and 0161 (MCP servers), plus 0155–0159 if not yet applied
cd backend  && node ../node_modules/vitest/vitest.mjs run src/modules/control src/modules/projects src/modules/execution src/modules/apikeys src/modules/skillplugins
cd frontend && node ../node_modules/vitest/vitest.mjs run src/components/PlanApproval.test.tsx src/components/PermissionRulesCard.test.tsx src/components/HomeChat.test.tsx
```

In the app:
1. **Control → Permission rules:** add "Never allow · Run a command · `npm publish*`".
2. **Home → Cowork → Plan first:** ask for a change, read the plan, then Approve or Reject.
3. Upload a `CODECONCLAVE.md` to a project. Its conventions now shape chat and Cowork answers.
4. Upload a `.codeconclaveignore`. The agent no longer reads those files.
5. Type `/second-review`, `/bugfix`, `/feature` or `/guard` once Safe Workflow is installed.
6. **Settings → Customize → MCP servers:** connect a server, try a read-only tool, then turn on
   **Tools** in Chat.
