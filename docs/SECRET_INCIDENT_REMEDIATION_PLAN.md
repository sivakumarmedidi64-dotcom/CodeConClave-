# SECRET INCIDENT — EMERGENCY REMEDIATION PLAN

**Date:** 2026-08-25
**Severity:** CRITICAL
**Repository:** `C:\Users\sride\CodeConClave-`
**Remote:** `https://gitlab.com/coders3305634/codeconclave-pro/` (branch: `main`)

---

## Incident

A tracked file named `GitHub URL - httpsgithub.commedidis.md` was committed in the initial repository commit and has remained tracked through all subsequent commits. This file contains **real production credentials** in plaintext, including API keys, tokens, passwords, and a Sentry DSN. The file exists in git HEAD and has been pushed to the GitLab remote.

**Status:** The file has been **deleted from the working tree** and the deletion has been **staged** (ready for commit). No commit has been made yet. No force-push has been performed.

---

## Exposed Credential Inventory

| # | Category | Variable/Service Name | In File? | In Git History? | Rotation Required? |
|---|----------|----------------------|----------|-----------------|-------------------|
| 1 | AI Provider Key | `ANTHROPIC_API_KEY` | YES | YES | YES |
| 2 | AI Provider Key | `OPENAI_API_KEY` | YES | YES | YES |
| 3 | AI Provider Key | `GEMINI_API_KEY` | YES | YES | YES |
| 4 | AI Provider Key | `MISTRAL_API_KEY` | YES | YES | YES |
| 5 | Redis Credential | `REDIS_URL` (contains Upstash token) | YES | YES | YES |
| 6 | Redis Credential | Upstash REST Token | YES | YES | YES |
| 7 | Email Credential | `RESEND_API_KEY` | YES | YES | YES |
| 8 | Cloudflare Token | `CLOUDFLARE_API_TOKEN` | YES | YES | YES |
| 9 | Cloudflare Account | `CLOUDFLARE_ACCOUNT_ID` | YES | YES | Not rotatable (account ID) |
| 10 | Monitoring DSN | `SENTRY_DSN` (full DSN with key) | YES | YES | YES |
| 11 | OAuth Secret | `GITHUB_CLIENT_SECRET` | YES | YES | YES |
| 12 | Database Credential | Supabase password (in connection string) | YES | YES | YES |
| 13 | Plugin Key | Supabase Publishable Key | YES | YES | YES |

---

## Credentials Already Replaced

| Variable | Status | Location | Date |
|----------|--------|----------|------|
| `SESSION_SECRET` | **ROTATED** | `.env` | 2026-08-25 |
| `JWT_SECRET` | **ROTATED** | `.env` | 2026-08-25 |

---

## Credentials Requiring Replacement

### CRITICAL — Rotate Immediately

| Variable | Service | Dashboard/Location | Action | Production Impact | Verification |
|----------|---------|-------------------|--------|-------------------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic | console.anthropic.com → API Keys | REVOKE + CREATE NEW | AI features will fail until updated | Test with models list API |
| `OPENAI_API_KEY` | OpenAI | platform.openai.com → API Keys | REVOKE + CREATE NEW | AI features will fail until updated | Test with models list API |
| `GEMINI_API_KEY` | Google AI | aistudio.google.com → API Keys | REVOKE + CREATE NEW | AI features will fail until updated | Test with chat completion |
| `MISTRAL_API_KEY` | Mistral | console.mistral.ai → API Keys | REVOKE + CREATE NEW | AI features will fail until updated | Test with chat completion |
| `REDIS_URL` / Upstash Token | Upstash | console.upstash.com → token | REVOKE + CREATE NEW | Queue/cache will fail until updated | Test with PING |
| `RESEND_API_KEY` | Resend | resend.com → API Keys | REVOKE + CREATE NEW | Email will fail until updated | Test with domains API |
| `CLOUDFLARE_API_TOKEN` | Cloudflare | dash.cloudflare.com → My Profile → API Tokens | REVOKE + CREATE NEW | Worker/KV operations will fail | Test with token verify API |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth | github.com → Settings → OAuth Apps → Client Secret | RESET | GitHub login will fail until updated | Test with token endpoint |
| `SENTRY_DSN` | Sentry | sentry.io → Project Settings → Client Keys (DSN) | REVOKE + CREATE NEW | Error tracking will fail | Send test event |
| DATABASE_PASSWORD | Supabase | app.supabase.com → Project → Settings → Database → Reset Password | PASSWORD RESET | All DB connections fail until updated | Test with psql connection |
| Supabase Publishable Key | Supabase | app.supabase.com → Project → Settings → API | REGENERATE | Client auth will fail | Test with Supabase client |

### MEDIUM — Rotate When Convenient

| Variable | Service | Dashboard/Location | Action | Notes |
|----------|---------|-------------------|--------|-------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare | dash.cloudflare.com → Dashboard | NOT ROTATABLE | Account identifier, not a secret. Consider Cloudflare account-level rotation if token is compromised. |

---

## Current Environment Comparison

### `.env` (Local Development)

| Variable | Old Exposed | New Present | Status |
|----------|-------------|-------------|--------|
| `SESSION_SECRET` | COMPROMISED | ROTATED | **DONE** |
| `JWT_SECRET` | COMPROMISED | ROTATED | **DONE** |
| `ANTHROPIC_API_KEY` | COMPROMISED | EMPTY (dev default) | awaiting rotation |
| `OPENAI_API_KEY` | COMPROMISED | EMPTY (dev default) | awaiting rotation |
| `GEMINI_API_KEY` | COMPROMISED | EMPTY (dev default) | awaiting rotation |
| `MISTRAL_API_KEY` | COMPROMISED | EMPTY (dev default) | awaiting rotation |
| `REDIS_URL` | COMPROMISED | localhost default | awaiting rotation |
| `RESEND_API_KEY` | COMPROMISED | EMPTY | awaiting rotation |
| `CLOUDFLARE_API_TOKEN` | COMPROMISED | EMPTY | awaiting rotation |
| `GITHUB_CLIENT_SECRET` | COMPROMISED | EMPTY | awaiting rotation |
| `SENTRY_DSN` | COMPROMISED | EMPTY | awaiting rotation |

### `.env.production` (Production)

| Variable | Old Exposed | New Present | Status |
|----------|-------------|-------------|--------|
| `SESSION_SECRET` | COMPROMISED | EMPTY | awaiting rotation |
| `JWT_SECRET` | COMPROMISED | EMPTY | awaiting rotation |
| `DATABASE_URL` | COMPROMISED | EMPTY | awaiting rotation |
| `REDIS_URL` | COMPROMISED | EMPTY | awaiting rotation |
| `ANTHROPIC_API_KEY` | COMPROMISED | EMPTY | awaiting rotation |
| `OPENAI_API_KEY` | COMPROMISED | EMPTY | awaiting rotation |
| `GEMINI_API_KEY` | COMPROMISED | EMPTY | awaiting rotation |
| `MISTRAL_API_KEY` | COMPROMISED | EMPTY | awaiting rotation |
| `RESEND_API_KEY` | COMPROMISED | EMPTY | awaiting rotation |
| `GITHUB_CLIENT_SECRET` | COMPROMISED | EMPTY | awaiting rotation |
| `CLOUDFLARE_API_TOKEN` | COMPROMISED | EMPTY | awaiting rotation |
| `SENTRY_DSN` | COMPROMISED | EMPTY | awaiting rotation |

### `.env.deploy-ready`

**DOES NOT EXIST** — file was never created.

---

## Current Tree Cleanup

| Action | Status |
|--------|--------|
| File deleted from working tree | **DONE** |
| Deletion staged in git | **DONE** |
| File still tracked in HEAD | YES (pending commit) |
| No other tracked files contain secrets | **CONFIRMED** |
| `.env` gitignored | **YES** |
| `.env.production` gitignored | **YES** |
| Frontend build assets clean | **YES** |
| Backend source clean | **YES** (test dummies only) |
| STAGE_20 reports clean | **YES** (references only, no values) |

---

## Git History Analysis

| Metric | Value |
|--------|-------|
| Earliest commit with file | `d6743fb` ("init: CodeConClave Pro — production ready") |
| Latest commit with file | `d6743fb` (same — only touched once) |
| Total commits in repo | 20 |
| Branches containing file | `main` |
| Tags containing file | None |
| Pushed to GitLab remote | **YES** (`origin/main` contains the file) |
| File ever deleted from history | **NO** — added in `d6743fb`, never removed |

---

## GitLab Exposure

| Check | Result |
|-------|--------|
| File exists in `origin/main` | **YES** |
| Commit `d6743fb` pushed to GitLab | **YES** |
| GitLab repo visibility | Unknown (assume public for worst case) |
| Anyone with repo access can see secrets | **YES** (via `git show` or web UI) |

---

## History Cleanup Plan

### Option A: Filter-Repo Rewrite (Recommended)

```bash
# Remove the file from ALL commits
git filter-repo --path "GitHub URL - httpsgithub.commedidis.md" --invert-paths
```

**Impact:**
- Rewrites all 20 commits
- Changes commit hashes for ALL commits
- Removes the file from every commit in history
- All collaborators must re-clone
- All existing clones are invalidated

### Option B: New Repository

1. Create new GitLab repo (e.g., `codeconclave-pro-v2`)
2. Push clean history (after filter-repo)
3. Delete old repo or make private
4. Update all deployment configs with new remote

### Option C: Accept Exposure + Rotate

1. Delete file from HEAD (commit the staged deletion)
2. Rotate ALL exposed credentials immediately
3. Leave git history as-is
4. Accept that old values are permanently in history

**Recommendation:** Option C is fastest and sufficient if all credentials are rotated. The file itself is removed from HEAD, and rotated credentials are useless even if found in history.

---

## Required Remote Force-Update

**NOT PERFORMED** — waiting for explicit approval.

If history rewrite is chosen:
```bash
git push --force origin main
```

All collaborators must re-clone after force-push.

---

## Post-Cleanup Verification

After rotation and commit:
1. `git ls-tree HEAD` — confirm file is gone
2. `git status` — confirm clean working tree
3. Scan all tracked files — confirm no secrets
4. Test all rotated credentials — confirm services work
5. Verify `.env` and `.env.production` are gitignored

---

## Deployment Status

# **BLOCKED**

Deployment is blocked until:
1. The tracked file is committed as deleted
2. All exposed credentials are rotated
3. New values are placed in `.env` / `.env.production`
4. Application validates with new credentials

---

## Summary

| Item | Status |
|------|--------|
| File deleted from working tree | DONE |
| Deletion staged | DONE |
| Commit pending | YES (waiting for approval) |
| Credentials rotated | 2 of 13 (SESSION_SECRET, JWT_SECRET) |
| Credentials pending | 11 |
| Git history rewrite | NOT PERFORMED (waiting for approval) |
| Force push | NOT PERFORMED (waiting for approval) |
| Deployment | BLOCKED |
| GitLab exposure | YES (file + history on remote) |
