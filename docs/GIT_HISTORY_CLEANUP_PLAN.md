# GIT HISTORY CLEANUP PLAN — CodeConClave Pro

**Date:** 2026-08-27
**Severity:** HIGH — exposed-secret history remediation (execution PENDING this session)
**Repository:** `C:\Users\sride\CodeConClave-`
**Remote:** `origin` → `https://gitlab.com/coders3305634/codeconclave-pro.git`

> **IMPORTANT:** This is a *plan only*. The rewrite is NOT executed in this session —
> it must be explicitly authorized, and all credentials must be rotated regardless.

---

## Incident Summary

A tracked file named `GitHub URL - httpsgithub.commedidis.md` was added in the **initial
commit** and contained 13 real production credentials in plaintext. The file has been
**removed from the working tree and staged for deletion** (prior remediation), but it
**remains in git history** at commit `d6743fb`. Anyone with access to the remote history
can still read the secrets.

Deleting the file in a future commit does NOT remove it from history — the credential is
recoverable from `git show d6743fb:...`.

---

## Affected History

| Item | Detail |
| ---- | ------ |
| Affected commit | `d6743fb8db40c543eb5fb6f8293e134f55b4e1fa` ("init: CodeConClave Pro — production ready", 2026-08-23) |
| Affected file | `GitHub URL - httpsgithub.commedidis.md` (13 plaintext credentials) |
| Added in | `d6743fb` (the initial commit — first commit in history) |
| Present in | Only commit `d6743fb` (verified via `git log --all`) |
| Total commits on `main` | 20 |
| Branches | `main` (only branch; `origin/main` tracking) |
| Refs | `main`, `origin/main`, `origin/HEAD` |
| Remote | GitLab `origin` (single) |
| Collaborators | Assumed solo (single author) — **verify before force-push** |

---

## Stage 0 — NON-NEGOTIABLE PREREQUISITE: ROTATE ALL CREDENTIALS

**History rewrite does NOT protect you.** The secrets were in the public remote history.
You MUST rotate every exposed credential regardless of cleanup:

- `SESSION_SECRET`, `JWT_SECRET` — regenerate (done locally, but re-run after rewrite)
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY` — regenerate at each provider
- `REDIS_URL` (Upstash token) — regenerate token in Upstash Console
- `RESEND_API_KEY` — regenerate in Resend
- `CLOUDFLARE_API_TOKEN` — regenerate in Cloudflare
- `SENTRY_DSN` — rotate DSN in Sentry
- `GITHUB_CLIENT_SECRET` — regenerate in GitHub
- Supabase DB password + publishable key — rotate in Supabase

See `docs/PRODUCTION_CREDENTIAL_INVENTORY.md` and `docs/SECRET_ROTATION_CHECKLIST.md`.

---

## Working-Tree Safety Confirmation (already done)

- `.env`, `.env.production`, `.env.deploy-ready` are git-ignored (`git check-ignore` → all matched)
- Only `.env.example` (safe template, no secrets) is tracked
- The secret `.md` file is **absent from the current working tree** (verified)
- No real credentials tracked in source — only dummy test placeholders

---

## Recommended Approach: `git filter-repo`

The only affected commit is the **first commit** (`d6743fb`), so the file must be purged
from the root of history.

### 1. Backup the repository (MANDATORY)

Before any rewrite, create a full `--mirror` backup:

```
git clone --mirror . /c/Users/sride/AppData/Local/Temp/opencode/codeconclave-backup.git
```

### 2. Install `git-filter-repo`

`git filter-repo` is the maintained replacement for `git filter-branch` (faster, safer,
recommended). Install via pip:

```
pip install git-filter-repo
```

### 3. Purge the file from all history

Run from the repo root:

```
git filter-repo --invert-paths --path "GitHub URL - httpsgithub.commedidis.md"
```

This rewrites every commit that touched the file, removing it entirely.

### 4. (Recommended) Also purge the other stray scratch `.txt` files

They are harmless content-wise, but they are unrelated scratch notes that clutter history.
Optional but clean:

```
git filter-repo --invert-paths --path-glob '*.txt'
```

> Note: several stray `.txt` files are already staged-deleted; the above would remove
> them from history too. Only do this if you want a fully clean history.

---

## Verification Steps (AFTER rewrite, before push)

1. Confirm the file is gone from all history:
   ```
   git log --all --oneline -- "GitHub URL - httpsgithub.commedidis.md"
   # expect: (no output)
   ```
2. Confirm no credential pattern remains anywhere in history:
   ```
   git log --all -G 'api[_-]?key|secret|API_KEY' --oneline -p | less   # review manually
   git grep -n -E 'sk-[A-Za-z0-9]{20}' $(git rev-list --all)            # automated scan
   ```
3. Confirm current working tree is intact and tests still pass (re-run Part 16).

---

## GitLab Remote Implications

- After `filter-repo`, the local `origin` remote is **removed** (filter-repo strips remotes
  by default). Re-add it:
  ```
  git remote add origin https://gitlab.com/coders3305634/codeconclave-pro.git
  ```
- The remote repo still contains the OLD history with the secrets. You must **force-push**
  to overwrite, then the old commits become unreachable:
  ```
  git push --force --all origin
  git push --force --tags origin   # if any tags exist (none confirmed)
  ```

## Force-Push Implications

- Rewrites commit SHAs for `main` (the initial commit + all descendants). Any open PRs,
  local clones, or CI pipelines based on old SHAs will break.
- If this is a **solo repo** with no other clones/PRs, a force-push is safe after backup.
- If anyone else has cloned or based work on the repo, they must re-clone and discard old
  history (the old history still contains the secrets — warn them to rotate + not reuse).

---

## Critical Consequence of Rewriting the FIRST commit

Because `d6743fb` is the initial commit, its parent is empty. Rewriting it rewrites the
entire branch (all 20 commits get new SHAs). This is expected and fine — but it means the
**entire history fingerprint changes**, so coordinate with any CI/webhook that watched
commit SHAs.

---

## Post-Cleanup Checklist

- [ ] All 13 exposed credentials rotated (MANDATORY — do this regardless)
- [ ] Local `git filter-repo` backup created
- [ ] File purged from history
- [ ] Verification scans clean (file absent, no credential patterns)
- [ ] Tests re-run and passing (Part 16)
- [ ] `origin` re-added
- [ ] Force-push `--all` to GitLab
- [ ] Confirm remote no longer shows the file via GitLab UI/API
- [ ] Confirm no other clones exist (or re-clone them)

---

## Do NOT perform this rewrite from an automated session without explicit user consent.

The rewrite, force-push, and remote coordination carry real risk. They must be executed
by the user (or with explicit live confirmation) after backing up and after rotating
credentials.
