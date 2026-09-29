# OPERATOR RUNBOOK — CodeConClave

Safe, read-only operational procedures for the live production deployment.
**No secrets are used or printed in this document. All URLs are public endpoints.**

Live endpoints:
- Frontend: `https://frontend-production-e367.up.railway.app`
- Backend: `https://backend-production-95faa.up.railway.app`

Railway references (per environment production):
- Project: `82dd1698-e7f6-4912-8cd6-299a1bc95557`
- Environment: `2957bdcd-e168-4e8a-b9c5-04a817221843`
- Backend service: `25f5893f-75c5-4c83-996f-e025f8ebd70e`
- Frontend service: `1041fc15-8d40-429b-b87e-577807c12412`
- Railway CLI: `node "C:\Users\sride\AppData\Roaming\npm\node_modules\@railway\cli\bin\railway.js"`

## 1. Check frontend
```powershell
curl.exe -s -o NUL -w "%{http_code}" https://frontend-production-e367.up.railway.app/
# expect 200
```
Also probe `/login`, `/pricing`, `/agents`, `/projects` (expect 200 via SPA fallback).
Verify security headers present on `/`:
```powershell
curl.exe -s -D - -o NUL https://frontend-production-e367.up.railway.app/ | Select-String -Pattern "content-security-policy|strict-transport-security|x-content-type-options|x-frame-options|referrer-policy|permissions-policy"
```

## 2. Check backend
```powershell
curl.exe -s -o NUL -w "%{http_code}" https://backend-production-95faa.up.railway.app/
```
A non-1xx/2xx or connection failure from the backend public domain indicates it is not reachable.

## 3. Check /healthz (process liveness)
```powershell
curl.exe -s -w " [%{http_code}]" https://backend-production-95faa.up.railway.app/healthz
# expect 200 {"ok":true}
```
Also via the FE proxy (confirms proxy path):
```powershell
curl.exe -s -w " [%{http_code}]" https://frontend-production-e367.up.railway.app/health
```

## 4. Check /health (component health)
```powershell
curl.exe -s https://backend-production-95faa.up.railway.app/health
```
Interpretation:
- Core checks `api`, `database`, `cache` (Redis), `queue`, `worker`, `ai` = `HEALTHY` → core system green.
- `storage` NOT_CONFIGURED, `local-agent` DEGRADED (no agent online), `plugins`/`sentry` NOT_CONFIGURED → expected/optional, NOT launch blockers.
- Any core check = `FAILED` (e.g., database unreachable) → incident; investigate Railway logs + Neon.

## 5. Inspect Railway logs (backend)
```powershell
node "C:\Users\sride\AppData\Roaming\npm\node_modules\@railway\cli\bin\railway.js" logs -s 25f5893f-75c5-4c83-996f-e025f8ebd70e -e 2957bdcd-e168-4e8a-b9c5-04a817221843 --lines 400
```
Look for (count, do not print secrets):
- `FATAL`, `uncaughtException`, `UnhandledRejection`, `ECONNREFUSED`, `ETIMEDOUT` → expect 0.
- Repeated app 5xx (e.g., `planner generation failed` is a graceful WARN, not an incident).
- Startup lines: `redis connected`, `database ready`, `task worker started` → expect present near service start.

## 6. Inspect Railway logs (frontend)
```powershell
node "C:\Users\sride\AppData\Roaming\npm\node_modules\@railway\cli\bin\railway.js" logs -s 1041fc15-8d40-429b-b87e-577807c12412 -e 2957bdcd-e168-4e8a-b9c5-04a817221843 --lines 200
```
- Healthcheck passes (`/`) → service healthy; no restart loops expected (`restartPolicyType ON_FAILURE`, max retries 10).

## 7. Inspect Neon status
- No direct live DB query endpoint from this runbook.
- Backend `/health` `database` check = `HEALTHY` is the first signal.
- Confirm migration/file state in source only (56/56 in `backend/migrations`); do not mutate.
- For deeper runtime checks use Neon console (owner), but do not print connection strings.

## 8. Inspect Redis status
- Backend `/health` `cache` and `queue` checks = `HEALTHY` → Redis reachable.
- Backend logs contain `redis connected` at startup (this runbook never prints the URL).
- `QUEUE_PROVIDER=redis` (named mode only; treat value as config, not secret).

## 9. Identify AI-provider quota failures
In backend logs, search for:
```
ai.attempt_failed  provider="anthropic"|provider="openai"  reason="billing"
```
- `reason="billing"` on anthropic/openai = provider account billing/quota issue. **Not a source-code blocker.** Google/Gemini is the functioning provider (`ai.completed ... model="gemini-3.7-flash"`).
- `reason="provider_unavailable"` / `reason="timeout"` on google = transient; retry normally succeeds.
- `embedding failed ... HTTP 429` = memory-embedding rate limit; memory storage still works, semantic search may be sparse.

## 10. Identify payment-review events
- Payment automation is currently zero-admin **blocked** (no Razorpay API/webhook/admin).
- Expected normal signal: `/api/v1/payments/capabilities` reports `payment-link mode` and sessions stay `PENDING` until provider confirmation.
- A "payment-review event" today means a customer followed a static payment link; there is no automatic reconciliation. Watch email/support (human path) for such customers. Do NOT claim automatic activation.
- When a trusted provider verification path is added (see ZERO_ADMIN_PAYMENT_ROADMAP.md), add a check here for signed webhook/API events, then verify entitlement flips PRO_VERIFIED.

## Ground rules
- Never trust a single source over the system's own evidence (`/health`).
- No fake success: if a check cannot be run, report BLOCKED/UNKNOWN.
- Do not restart/redeploy unless diagnosing a genuine core-health FAILED.
