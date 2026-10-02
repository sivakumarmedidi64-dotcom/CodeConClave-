# CodeConClave — Google OAuth Acceptance

Status: IMPLEMENTED + AUTOMATED-TESTED. Live Google consent flow requires a human
with a valid Google Cloud OAuth client (see Human acceptance steps). No live token
exchange was performed in this remediation pass; nothing below claims otherwise.

## 1. What is implemented (verified in source)

### Backend (server-authoritative)
- `backend/src/modules/auth/google.ts`
  - `googleConfigured()` — true only when both `GOOGLE_CLIENT_ID` and
    `GOOGLE_CLIENT_SECRET` are present. Authorization/callback throw
    `google_not_configured` otherwise (503-ish unavailable, never a silent skip).
  - Authorization URL built from real env:
    `GOOGLE_REDIRECT_URI` (default `http://localhost:5173/api/v1/auth/google/callback`),
    `GOOGLE_OAUTH_CONSENT_MODE` (default `consent`), `GOOGLE_SCOPES`
    (gmail.send, gmail.readonly, drive.file, spreadsheets, calendar.events).
  - `googleStateToken(nonce)` / `verifyGoogleState` — HMAC-SHA256 signed with
    `JWT_SECRET`, 10-minute expiry. The client can never author the state claim.
  - `exchangeGoogleCode()` — calls `https://oauth2.googleapis.com/token`
    (timeout 10s) then `https://www.googleapis.com/oauth2/v3/userinfo` (timeout 10s).
    Any failure is mapped to a named error
    (`google_token_timeout`, `google_token_failed`, `google_userinfo_failed`,
    `google_no_email`) — never a fabricated identity.
  - User join/link: `INSERT … ON CONFLICT (google_sub) DO UPDATE` and
    `google_connections` row stores `refresh_token_encrypted` /
    `access_token_encrypted` / `token_expires_at`. Always an audit record
    (`AuditAction.AUTH_GOOGLE_LOGIN`).
- `backend/src/modules/auth/routes.ts`
  - `GET /api/v1/auth/google/authorize` — builds state, redirects to Google.
  - `GET /api/v1/auth/google/callback` — verifies state (HMAC + expiry), fails
    closed on `error`/missing params/state, sets a real session cookie, redirects to
    `${appUrl}/?google=ok`; on failure redirects to `?google=error=<code>`.
- Config: `backend/src/config/env.ts` — all `GOOGLE_*` vars declared and validated.

### Frontend
- `frontend/src/components/GoogleSignInButton.tsx` — anchor to
  `/api/v1/auth/google/authorize`, used on `LoginPage` and `RegisterPage`.
- `frontend/src/auth/AuthProvider.tsx` — on mount detects `?google=ok`, restores the
  session (`/api/v1/auth/me`) and cleans the URL marker; `?google=error=<code>` shows
  a labelled failure alert. No token handling on the client.

## 2. Automated verification (state as of this pass)

- Backend `auth.test.ts`, `describe('GOOGLE OAUTH — state validation')`:
  - state token round-trip accepted; tampered signature → `google_state_invalid`;
    expired → `google_state_expired`. (PASS)
- Frontend `auth/AuthProvider.test.tsx`, `describe('Google OAuth callback')`:
  - `?google=ok` restores the session and cleans the URL; error marker surfaces the
    code. (PASS)

## 3. Human acceptance steps (NOT yet performed; requires real OAuth client)

1. Create/verify a Google Cloud OAuth 2.0 client (Web application),
   redirect URI matching `GOOGLE_REDIRECT_URI`, consent screen + test users.
2. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the server env (never in repo).
3. Run backend + frontend; on the Login page click "Sign in with Google".
   - Accept: consent flow opens, signs in, lands on `/home`.
4. Sign out and repeat to confirm conflict-linking merges to the same user
   (`google_sub`) and the `google_connections` row is refreshed.
5. Deny consent once → expect `?google=error=access_denied` + labelled alert, not a crash.
6. With client unset → expect `/api/v1/auth/google/authorize` to return
   `google_not_configured`; the button is still visible but the server refuses.
7. Confirm no client token ever reaches localStorage/frontend memory.