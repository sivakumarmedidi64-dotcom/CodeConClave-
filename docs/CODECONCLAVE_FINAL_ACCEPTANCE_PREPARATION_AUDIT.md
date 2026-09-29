# CodeConClave — FINAL ACCEPTANCE PREPARATION AUDIT

Gate: **FINAL ACCEPTANCE PREPARATION GATE: CONDITIONAL_PASS** — automation ready, release
blocked only by the 9 human gates. `RELEASE_READY = NO` · `DEPLOYMENT_ALLOWED = NO`.
No deployment, no payment changes, no new AI engine/router, no feature removal.

Generated: 2026-09-09

---

## 1. Gate verdict and summary

| Item | Value |
|---|---|
| Acceptance scripts | PASS (3 new scripts + npm wiring) |
| Human evidence system | PASS (9-gate md + json + `acceptance:status`) |
| Acceptance harness docs | PASS (6 workbooks + template) |
| Real provider re-probe | PASS (matrix below; not a human gate pass) |
| Acceptance preflight | PASS (oauth) / PASS (payment read-only) |
| Full test/build matrix | PASS (0 failed) |
| Human gates | 0 / 9 PASS — all HUMAN_REQUIRED |
| RELEASE_READY | NO |
| DEPLOYMENT_ALLOWED | NO |

## 2. Automatable hardening completed

1. Acceptance preflight script `backend/src/scripts/acceptance-preflight.ts` — canonical
   origin, Google OAuth config, single-origin guard, cookie-secure policy, payment link pool
   state. Never prints a secret. (npm: `acceptance:preflight`, `acceptance:oauth:preflight`).
2. Evidence gate status script `backend/src/scripts/acceptance-status.ts` — reads the shared
   evidence JSON, prints 9 gate statuses + RELEASE_READY; a gate with absent/invalid evidence
   can never be auto-promoted. (npm: `acceptance:status`). Verified: 0 / 9, RELEASE_READY = NO.
3. Real provider re-probe script `backend/src/scripts/provider-reprobe.ts` — single-token real
   call per configured provider, honest persistence to `provider_health`, safe-only output.
   (npm: `provider:reprobe`). Hardened mid-run: config-derived states (NOT_CONFIGURED/LIMITED)
   are no longer persisted to `provider_health` (schema constraint does not include them).
4. Evidence log + template — 9 records (md + json), all NOT_PERFORMED, no fabrication.
5. Harness workbooks — Windows install, Web 35-step, Desktop 30-step, Parity, Full-product.

Prior-prompt hardening retained: cross-browser auth regression test
(`backend/src/foundation/auth.test.ts` CROSS-BROWSER), time-of-day greeting regex fix
(frontend `|night`), payment exactly-once proof suite.

## 3. Acceptance preflight results (read-only)

```
CANONICAL_ORIGIN   = http://localhost:5173            (default/dev)
AUTH_PREFLIGHT     = PASS
  PASS GOOGLE_OAUTH_CLIENT_CONFIG  client id + secret present
  PASS GOOGLE_REDIRECT_URI         http://localhost:5173/api/v1/auth/google/callback
  PASS REDIRECT_ORIGIN_IN_CORS     allowed by CORS_ORIGINS
  WARN SINGLE_CANONICAL_ORIGIN     single origin today; production MUST pin one canonical
  PASS AUTH_COOKIE_DOMAIN          not configured (OK for single-origin)
  PASS SESSION_COOKIE_SECURE       false now; REQUIRED true when serving https
PAYMENT_PREFLIGHT   = PASS (read-only; live payment HUMAN-gated)
  PASS PAYMENT_LINK_CONFIG         pro + team hosted links configured
  WARN PAYMENT_PROOF_REPORTED      16/16 proof suite verified separately
  WARN PAYMENT_POOL_STATE          reservations = 0 (no orphan growth)
PREFLIGHT_TOTAL    = PASS
```

Production requirements (founder, at deploy time, never asked to paste secrets): one canonical
origin; `GOOGLE_REDIRECT_URI` for that origin registered in Google Cloud Console;
`CORS_ORIGINS` = that origin; `SESSION_COOKIE_SECURE=true`.

## 4. Real provider re-probe (2026-09-09, no secrets printed)

```
PROVIDER  | MODEL                          | HEALTH              | REAL_CALL | ERROR_CLASS        | CAPABILITY
anthropic | claude-opus-4-1                | OFFLINE             | failed    | bad_request        | MODEL
openai    | gpt-4o                         | QUOTA_EXHAUSTED     | failed    | rate_limited       | MODEL
google    | gemini-3.7-flash               | HEALTHY             | ok        | -                  | MODEL
mistral   | mistral-large-2411             | NOT_CONFIGURED      | failed    | provider_not_configured | MODEL
grok      | grok-4.6                       | REQUIRES_REAUTH     | failed    | invalid_credentials | MODEL
deepseek  | deepseek-v4-pro                | QUOTA_EXHAUSTED     | failed    | billing/quota      | MODEL
kimi      | kimi-k3                        | REQUIRES_REAUTH     | failed    | invalid_credentials | MODEL
nemotron  | nvidia/nemotron-3-ultra-550b    | HEALTHY             | ok        | -                  | MODEL
north     | north-mini-code-1.0            | NOT_CONFIGURED      | failed    | provider_not_configured | MODEL
qwen      | qwen3.8-max                    | HEALTHY             | ok        | -                  | MODEL
gemma     | gemma-4-31b-it                 | OFFLINE             | failed    | provider_unavailable | MODEL
devin     | devin-session                  | UNVERIFIED          | skipped   | ENVIRONMENT_BLOCKED (external agent; never auto-run) |
ox_alpha  | (none)                         | NOT_CONFIGURED      | skipped   | NO_REGISTRY_ENTRY  | MODEL
manus     | (none)                         | UNVERIFIED          | skipped   | ENVIRONMENT_BLOCKED (task API; never auto-run) |
z_code_5_3| (none)                         | NOT_CONFIGURED      | skipped   | NO_REGISTRY_ENTRY  | MODEL
big_pickle| (none)                         | NOT_CONFIGURED      | skipped   | ENVIRONMENT_BLOCKED | NOT_INTEGRATED
```

Healthy: google, qwen, nemotron. Quota/creds to remediate by founder: openai (429 → quota),
deepseek (billing), anthropic (bad request), grok + kimi (credentials rejected), gemma
(unreachable). External agents never auto-run. No keys/tokens/headers in output.

## 5. Platform evidence (automated)

| Area | Result |
|---|---|
| SECRET_SCAN | 855 files scanned · 0 findings · 0 skipped (includes 3 new scripts) |
| RLS / tables | RLS PASS; entitlements + reservations RLS-enabled (unchanged) |
| AUTHORIZATION | control-26g + security-22 targeted = 91 passed (owner authz, control-plane auth, workspace isolation, IDOR) |
| ELECTRON_SECURITY | contextIsolation:true, sandbox, nodeIntegration:false, webSecurity; navigation allow-list = configured origin only; IPC origin gating (source + built dist) |
| DATABASE | migrations 76 applied / 0 pending / 0 drift |

## 6. Test / build matrix

```
COMPONENT   FILES    TESTS                  RESULT
backend     156      2861 total → 2850 passed · 11 skipped · 0 failed
                      (note: gmail-claim route block skipped 3 tests under full-suite
                       load — app-boot beforeAll deadline; passes 16/16 in isolation;
                       this is a load-sensitive test hook, not a product regression)
frontend    74       408 passed · 0 failed
desktop     5        58 passed · 0 failed
payment     1        prove-payment 16/16 PASS (exactly-once evidence)
typecheck   backend PASS · frontend PASS · desktop PASS
builds      backend PASS (tsc) · frontend PASS (vite, 1.0 MB chunk warning) · desktop PASS (tsc + preload)
```

## 7. Feature freeze

`FEATURE_DENOMINATOR = 336` · `FEATURES_REMOVED = 0` · `FEATURES_UNMAPPED = 0`. No new AI
engine/router, no payment changes, no migration created, no feature removed in this prompt.

## 8. Human gates (REMAINING — founder-only, 0 / 9)

1. GOOGLE_OAUTH_LOGIN — sign in on the canonical origin + cross-browser/2nd-host check.
2. PRODUCTION_PAYMENT — live Razorpay hosted-link, exactly-once, no credential exposure.
3. WINDOWS_INSTALL — SHA256 verify, clean install, launch, uninstall, reinstall.
4. OFFLINE_MODE — disconnect/reconnect/resume/close-reopen without corruption.
5. PROVIDER_REPROBE — production status surface matches the ledger above.
6. WEB_E2E — 35-step web flow.
7. DESKTOP_E2E — 30-step desktop flow.
8. WEB_DESKTOP_PARITY — same backend/data/entitlement on both clients.
9. FULL_PRODUCT — aggregate of gates 6–8 plus platform gates.

Each gate requires the founder to record real evidence in
`docs/CODECONCLAVE_HUMAN_ACCEPTANCE_EVIDENCE.md` AND `.json` (set status PASS, performedBy,
performedAt). `npm run acceptance:status` (in backend/) reflects the honest count.
Never paste credentials; evidence = screenshots/logs/references only.

## 9. Findings

- CRITICAL: 0.
- HIGH: 0 (both release blockers — OAuth + payment — are human gates, not code).
- MEDIUM: (a) gmail-claim.test.ts beforeAll app-boot hook is load-sensitive — 3 route tests
  skip under full-suite contention (pass 16/16 isolated); (b) provider_health schema constraint
  omits NOT_CONFIGURED/LIMITED — reproduce script now guards; gateway persists only classified
  runtime states.
- LOW: (a) frontend single JS chunk ~1.0 MB (500 kB warning) — cosmetic/performance;
  (b) prod deployment MUST pin one canonical origin (GOOGLE_REDIRECT_URI default is
  localhost); (c) openai/anthropic/grok/kimi/deepseek keys need founder rotation or quota
  wastage before launch.

## 10. Conclusion

All automatable acceptance hardening for Prompt 6 is done and verified. The only remaining
items are the 9 human gates, which by rule belong to the founder. Release and deployment
remain blocked until `HUMAN_ACCEPTANCE_COUNT = 9 / 9`.