# CODECONCLAVE PRO — FINAL CREDENTIAL PRESENCE REPORT

**Repository:** C:\Users\sride\CodeConClave-  
**Audit Date:** 2026-08-27  
**Auditor:** opencode (read-only verification)  

---

## CREDENTIAL PRESENCE MATRIX

| Variable | Service | Required? | Present? | Configuration Valid? | Live Test | Status |
|----------|---------|-----------|----------|----------------------|-----------|--------|
| SESSION_SECRET | Application | YES | ✅ PRESENT | ✅ VALID (64+ chars) | N/A | PASS |
| JWT_SECRET | Application | YES | ✅ PRESENT | ✅ VALID (64+ chars) | N/A | PASS |
| DATABASE_URL | Database | YES | ✅ PRESENT | ❌ INVALID (malformed) | BLOCKED | FAIL |
| DATABASE_SSL | Database | YES | ✅ PRESENT (false) | ❌ INVALID (Supabase requires SSL) | BLOCKED | FAIL |
| REDIS_URL | Redis | YES | ✅ PRESENT | ❌ INVALID (malformed) | BLOCKED | FAIL |
| QUEUE_PROVIDER | Queue | YES | ✅ PRESENT (memory) | ✅ VALID | N/A | PASS |
| GOOGLE_CLIENT_ID | Google OAuth | YES | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| GOOGLE_CLIENT_SECRET | Google OAuth | YES | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| GOOGLE_REDIRECT_URI | Google OAuth | YES | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| ANTHROPIC_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| OPENAI_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| GEMINI_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| MISTRAL_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| GROK_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| DEEPSEEK_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| KIMI_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| NVIDIA_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| COHERE_API_KEY | AI | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| RESEND_API_KEY | Email | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | UNTESTED | PRESENT |
| RESEND_FROM_EMAIL | Email | REQUIRED | ✅ PRESENT | ⚠️ USES example.com | UNTESTED | PARTIAL |
| RESEND_ENABLED | Email | OPTIONAL | ✅ PRESENT (false) | ✅ VALID | N/A | DISABLED |
| RAZORPAY_MODE | Payments | REQUIRED | ✅ PRESENT | ✅ "payment_link" | N/A | PASS |
| RAZORPAY_KEY_ID | Payments | CONDITIONAL | ❌ EMPTY | N/A (mode=link) | N/A | OPTIONAL |
| RAZORPAY_KEY_SECRET | Payments | CONDITIONAL | ❌ EMPTY | N/A (mode=link) | N/A | OPTIONAL |
| RAZORPAY_WEBHOOK_SECRET | Payments | CONDITIONAL | ❌ EMPTY | N/A (mode=link) | N/A | OPTIONAL |
| RAZORPAY_PRO_PAYMENT_LINK | Payments | REQUIRED | ✅ PRESENT | ✅ VALID (https://rzp.io/rzp/sAgHIpxS) | N/A | PASS |
| RAZORPAY_TEAM_PAYMENT_LINK | Payments | REQUIRED | ✅ PRESENT | ✅ VALID (https://rzp.io/rzp/3ioXlCxd) | N/A | PASS |
| RAZORPAY_WEBHOOK_SECRET | Payments | CONDITIONAL | ❌ EMPTY | N/A (mode=link) | N/A | OPTIONAL |
| RAZORPAY_MODE | Payments | REQUIRED | ✅ PRESENT | ✅ "payment_link" | N/A | PASS |
| CLOUDFLARE_* | Cloudflare | CONDITIONAL | ❌ ALL EMPTY | N/A | N/A | OPTIONAL |
| STORAGE_PROVIDER | Storage | REQUIRED | ✅ PRESENT (memory) | ✅ VALID (dev) | N/A | PASS |
| S3_* / R2_* | Storage | CONDITIONAL | ❌ EMPTY (dev values) | N/A (provider=memory) | N/A | OPTIONAL |
| SENTRY_DSN | Monitoring | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | N/A | PRESENT |
| SENTRY_ENABLED | Monitoring | OPTIONAL | ✅ PRESENT (false) | ✅ VALID | N/A | DISABLED |
| CSP_ENABLED | Security | REQUIRED | ✅ PRESENT (true) | ✅ VALID | N/A | PASS |
| SESSION_COOKIE_SECURE | Security | REQUIRED* | ✅ PRESENT (false) | ⚠️ DEV VALUE | N/A | DEV MODE |
| MFA_REQUIREMENT_LEVEL | Auth | REQUIRED | ✅ PRESENT (0) | ❌ NOT ENFORCED | N/A | PARTIAL |
| MFA_MAX_ATTEMPTS | Auth | REQUIRED | ✅ PRESENT (5) | ✅ VALID | N/A | PASS |
| SENTRY_DSN | Monitoring | OPTIONAL | ✅ PRESENT | ✅ VALID FORMAT | N/A | PRESENT |
| SENTRY_ENABLED | Monitoring | OPTIONAL | ✅ PRESENT (false) | ✅ VALID | N/A | DISABLED |
| GITHUB_* | GitHub | OPTIONAL | ❌ ALL EMPTY | N/A | N/A | OPTIONAL |
| CLOUDFLARE_* | Cloudflare | CONDITIONAL | ❌ ALL EMPTY | N/A | N/A | OPTIONAL |
| S3_* / R2_* | Storage | CONDITIONAL | ❌ EMPTY (dev values) | N/A (provider=memory) | N/A | OPTIONAL |

---

## SUMMARY

| Category | Required | Present | Missing | Status |
|----------|----------|---------|---------|--------|
| Application Core | 3 | 3 | 0 | ✅ PASS |
| Database | 2 | 2 | 0 | ❌ FAIL (malformed URL, SSL=false) |
| Redis | 1 | 1 | 0 | ❌ FAIL (malformed URL) |
| Queue | 1 | 1 | 0 | ✅ PASS |
| Google OAuth | 3 | 3 | 0 | ✅ PRESENT |
| AI Providers | 9 | 9 | 0 | ✅ PRESENT |
| Email | 3 | 3 | 0 | ⚠️ PARTIAL |
| Payments (Razorpay) | 5 | 3 | 2 | ⚠️ PARTIAL |
| Razorpay Links | 2 | 2 | 0 | ✅ PASS |
| Cloudflare | 7 | 0 | 7 | ❌ MISSING |
| Cloudflare R2/S3 | 7 | 0 | 7 | ❌ MISSING |
| Sentry | 2 | 2 | 0 | ⚠️ DISABLED |
| Security | 3 | 3 | 0 | ⚠️ PARTIAL |
| GitHub | 5 | 0 | 5 | OPTIONAL |
| S3/R2 Storage | 7 | 0 | 7 | OPTIONAL |

---

## CRITICAL BLOCKERS

1. **DATABASE_URL** — Malformed: `postgresql:postgresql://...` (double protocol)
2. **REDIS_URL** — Malformed: `REDIS_URL="rediss://...` (double assignment)
3. **DATABASE_SSL=false** — Supabase pooler requires SSL (`true`)

---

## PAYMENT VERIFICATION

| Plan | Amount | Link | Status |
|------|--------|------|--------|
| PRO | ₹999 | https://rzp.io/rzp/sAgHIpxS | ✅ CORRECT |
| TEAM | ₹4999 | https://rzp.io/rzp/3ioXlCxd | ✅ CORRECT |

No fallback to wrong link detected. Server-side entitlement remains authoritative.

---

## GIT SECURITY

| Check | Result |
|-------|--------|
| Current tree secret scan | ✅ CLEAN |
| Git history (d6743fb) | ⚠️ EXPOSED — file "GitHub URL - httpsgithub.commedidis.md" contains 30+ live secrets |
| .gitignore covers .env* | ✅ YES |

---

*Report generated: 2026-08-27*  
*Auditor: opencode (read-only verification)*  
*No secret values disclosed in this report.*