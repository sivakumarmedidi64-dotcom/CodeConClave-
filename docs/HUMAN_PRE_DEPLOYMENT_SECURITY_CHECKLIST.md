# Human Pre-Deployment Security Checklist

**Date:** 2026-09-05 (CodeConclave PRO — FINAL SECRET RESET + GIT HYGIENE).
Dual columns: what opencode already completed (`OPEN_CODE_COMPLETED`) and what a human must do before deploying (`HUMAN_REQUIRED`). No secret values are written here.

---

## 1. Environment hygiene

| Check | Status |
|-------|--------|
| `.env` present at repo root, gitignored | `OPEN_CODE_COMPLETED` (ignore rules verified in `.gitignore`, `.dockerignore`, `.railwayignore`) |
| App-owned signing secrets (`SESSION_SECRET`, `JWT_SECRET`) rotated to fresh CSPRNG values | `OPEN_CODE_COMPLETED` (2026-09-05; values never printed/committed) |
| External/provider credentials preserved | `OPEN_CODE_COMPLETED` (byte-for-byte, 88 lines) |
| Stale secret artifacts removed (`.env.bak*`, `shared-secret*.txt`) | `OPEN_CODE_COMPLETED` (0 remaining) |
| Whole-tree + `secret-scan` clean | `OPEN_CODE_COMPLETED` (files=827, findings=0, exit 0; planted-fake detection PASS) |
| Rotate every externally-issued credential at its provider dashboard | `HUMAN_REQUIRED` (see `SECRET_ROTATION_CHECKLIST.md` — AI keys, RESEND, DB, OAuth, webhook HMACs, Razorpay, storage) |
| `REDIS_URL` valid / reachable (currently an unparseable URL — boot aborts with `Invalid URL` at `initCache`) | `HUMAN_REQUIRED` (fix value or unset → in-memory dev fallback) |
| Confirm `.env` untracked + history clean with a working git | `HUMAN_REQUIRED` (git on this host is broken; see `SECRET_GIT_HISTORY_STATUS.md` — currently UNVERIFIED) |
| Clean/delete root `*.txt` scratch transcripts if they contain old config references | `HUMAN_REQUIRED` (user-owned files; not part of app) |

---

## 2. Build & verification gates

| Check | Status |
|-------|--------|
| Backend typecheck | `OPEN_CODE_COMPLETED` — PASS (exit 0) |
| Frontend typecheck | `OPEN_CODE_COMPLETED` — PASS (exit 0) |
| Backend build (tsc emit) | `OPEN_CODE_COMPLETED` — PASS (exit 0) |
| Frontend build (vite) | `OPEN_CODE_COMPLETED` — PASS (exit 0) |
| Frontend `dist/` contains no server secrets | `OPEN_CODE_COMPLETED` — NONE (grepped asset JS/CSS/HTML) |
| Config loads with freshly rotated `.env` | `OPEN_CODE_COMPLETED` — PASS (`env` schema parse, strong-secret guard idle, `DATABASE_URL` parses) |
| Server boot smoke | `OPEN_CODE_COMPLETED` — config boots; cache step fails on the pre-existing malformed `REDIS_URL` (recorded above); DB gate not reached |
| Full live boot + migration check | `HUMAN_REQUIRED` (database/Redis reachable in target env; payments live test held by policy) |

---

## 3. Payments (policy-constrained)

| Check | Status |
|-------|--------|
| Payment rail untouched (no logic/registry/entitlement changes) | `OPEN_CODE_COMPLETED` |
| `prove:payment` suit (16 INVARIANTs, NO_FAKES) | `OPEN_CODE_COMPLETED` — 16/16 PASS, exit 0 (re-run after secret rotation) |
| Razorpay credentials NOT rotated by machine | `OPEN_CODE_COMPLETED` (preserved; human rotation optional per checklist) |
| Real live payment flow (Razorpay dashboard + test/real INR) | `HUMAN_REQUIRED` — explicitly unverified in this environment |

---

## 4. Post-mission guarantee

- No code/feature/product/architecture changes; no new providers; no registry or `PaymentEntitlement` modification; no deployment performed; no real transaction; no git history rewrite. All locked down to security-automation only.

## Steps before deploy (human)

1. Fix `REDIS_URL`; verify `redis` reachable, responds `PING`→`PONG`.
2. Rotate all `ROTATION_REQUIRED = YES` credentials at provider dashboards (list per category in `SECRET_ROTATION_CHECKLIST.md`), especially the two webhook HMACs and Razorpay if desired.
3. With a working git: `git status`/`git ls-files` confirm `.env` ignored; run history exposure audit (see `SECRET_GIT_HISTORY_STATUS.md`); purge if needed.
4. Re-run: `npm run secret:scan`, backend+frontend typecheck & build, `npm run prove:payment`; confirm zero findings.
5. Boot the deployed (or staging) config and confirm `database ready`, Redis connected, listening log, and a successful `/healthz`.

---

## Verification update — 2026-09-05 (post manual rotation attempt)

Full evidence in `docs/API_SECRET_ROTATION_VERIFICATION.md`. Status of the manual rotation: **INCOMPLETE**.

### Still blocking (verified)

| Item | Status |
|------|--------|
| Rotate/re-add external credentials | `HUMAN_REQUIRED — INCOMPLETE` — after the rotation attempt these are EMPTY or MISSING: `GEMINI_API_KEY` (google provider is ENABLED), `RESEND_API_KEY`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`; `S3_SECRET_ACCESS_KEY` is present but below normal length (suspect placeholder) |
| `REDIS_URL` | `HUMAN_REQUIRED` — still unparseable (`Invalid URL`); boot aborts at `initCache` |
| Database schema | `HUMAN_REQUIRED` — DB authentication now PASSES (rotated creds accepted, verified read-only), but **65 migrations pending** (fresh/empty DB) → run `npm run db:migrate` before boot |
| Git tracking/history | `HUMAN_REQUIRED` — still UNVERIFIED (git binary broken on this host) |

### Verified PASS (do not redo)

Backend full suite 2697 passed (exit 0), frontend 396/396, `prove:payment` 16/16 exit 0, backend+frontend typecheck & build PASS, `secret:scan` files=827 findings=0 exit 0, planted-fake leakage test PASS, frontend `dist/` contains zero server-secret names, `.env` present + gitignored, app-owned `SESSION_SECRET`/`JWT_SECRET` strong and loaded, no secret value printed/logged/broadcast during verification.

### Rule appended after this verification

The credential-rotation task is marked DONE **only** when rows above flip to `OPEN_CODE_COMPLETED` in a subsequent verification — do not mark live Razorpay verification complete until a human performs it in a real environment.

---

## 2026-09-05 (part 2) — ENVIRONMENT REPAIR verdict

### HUMAN_REQUIRED_NOW (unblocks boot)

- **`REDIS_URL`** — the value on the line is a 148-char NON-Redis string (misplaced credential). Either:
  - replace the line with a real Redis connection string (`redis://localhost:6379` or `rediss://user:token@host:6379` for Upstash), or
  - **remove the `REDIS_URL` line entirely** → the app falls back to its documented in-memory store and boots (single-process dev).
  Do NOT paste the value into chat. Report back when done for parse/init verification.
- **Database migrations** — DB authentication now PASSES, but all **65 migrations are pending** (fresh/empty database). Run:
  `npm run db:migrate`
  (additive, transactional, zero destructive DDL — verified). After it completes, I must re-verify applied=65, pending=0, schema sanity.

### HUMAN_REQUIRED_NOW (only if the feature is used)

- `RAZORPAY_KEY_SECRET` — REQUIRED by the CURRENT static payment-link rail to verify payment callbacks (`payments/pool/callback.ts`, HMAC). Without it, real payment completions fail. Not a boot blocker.
- `GEMINI_API_KEY` — provider `google` is ENABLED in `AI_PROVIDERS_ENABLED` but the key is missing → google requests fail at runtime. Add the key, or remove `google` from `AI_PROVIDERS_ENABLED`.

### HUMAN_REQUIRED_BEFORE_DEPLOY (revised from part 1 — most are now optional)

Following code-inspection, these are OPTIONAL integrations, not deploy blockers:
- `RESEND_API_KEY` (email currently `RESEND_ENABLED=false`) — only if email is needed in prod.
- `GITHUB_CLIENT_SECRET` / `GITHUB_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` — GitHub adapter works with a stored user token or `GITHUB_APP_ID`+`GITHUB_PRIVATE_KEY`; webhooks are declared-off. Only if GitHub is set up.
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY` / `S3_SECRET_ACCESS_KEY` — `STORAGE_PROVIDER=memory`; only if switching to s3/r2.
- Full git tracking/history audit — requires a working git (still UNVERIFIED).

### OPTIONAL_LATER

- `RAZORPAY_KEY_ID` (no-API rail), `RAZORPAY_WEBHOOK_SECRET` (`RAZORPAY_WEBHOOK_ENABLED=false`), DeepSeek/NVIDIA/Mistral/Grok/Kimi/Cohere keys (only if enabled in `AI_PROVIDERS_ENABLED`).
- Remove `google` from `AI_PROVIDERS_ENABLED` if Gemini is intentionally unused.

### Re-verification 2026-09-05 (repeat run) — UNCHANGED, action list still applies

Confirmed no repairs were applied since part 2. The **only boot blocker** is `REDIS_URL` (replace the line with a real `redis://`/`rediss://` URL, or **delete the line** → in-memory fallback). Then run **`npm run db:migrate`** (65 pending, verified additive/non-destructive). Then the API check stands at FAIL. Re-verify after repairs.