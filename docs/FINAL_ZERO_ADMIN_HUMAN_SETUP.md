# FINAL ZERO-ADMIN HUMAN SETUP

> This is the operator checklist. **Never** paste secrets, OAuth tokens, Google
> client secrets, or access tokens into chat, logs, or code. Enter them only
> into the Railway environment (web console) or the local `.env`.

## Mailbox model (source-verified)

- The payment Gmail rail reads **one controlled mailbox** via a server-side
  OAuth token (env `GMAIL_OAUTH_ACCESS_TOKEN`, or refresh token + client id/
  secret). It calls `users/me/messages` on that account.
- `MAILBOX_OWNER = the Razorpay notification mailbox you control`
- `MAILBOX_PURPOSE = receive Razorpay payment-confirmation emails so the
  server can auto-verify and auto-activate payments with zero admin`
- This is distinct from the app's "Sign in with Google" login OAuth
  (per-user `google_connections`); the payment rail intentionally uses a
  single operator-controlled mailbox token so it can run unattended.

---

## 1. Google Cloud project

**WHERE:** https://console.cloud.google.com
- Create/select the project that will hold the OAuth client.
- **Do not share** the Google Cloud project number/ID beyond what is needed
  for the OAuth client config.

## 2. OAuth consent screen

**WHERE:** Google Cloud Console → APIs & Services → OAuth consent screen
- User type: **External** (or Internal if you have Google Workspace).
- Fill app name, support email, developer contact.
- Under **Scopes**, add `https://www.googleapis.com/auth/gmail.readonly`
  (and — only if the implementation also uses them — the scopes already in
  `GOOGLE_SCOPES` default: gmail.send, drive.file, spreadsheets,
  calendar.events). **Do not request broader than the code needs**; the
  payment rail needs `gmail.readonly`.
- For a token that works unattended (offline), add yourself as a **test user**
  so you can complete the consent grant for the controlled mailbox.

## 3. Enable Gmail API

**WHERE:** Google Cloud Console → APIs & Services → Library
- Search **Gmail API** → Enable.

## 4. OAuth client (Desktop/Web application)

**WHERE:** Google Cloud Console → APIs & Services → Credentials → Create
credentials → OAuth client ID
- Application type: **Web application** (or Desktop for a manual token flow).
- **Authorized redirect URI** (Web app):
  `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`
  (this route exists: `backend/src/modules/auth/routes.ts` →
  GET `/api/v1/auth/google/callback`; note it is shared with the app login
  OAuth — reuse the SAME OAuth client/redirect, do not create a second one).
- **Not to share:** the generated `Client ID` and `Client Secret` go into
  env vars only.

## 5. Mailbox authorization (obtain the server token)

The server needs an OAuth token for the **Razorpay notification mailbox**.
Flow (Google OAuth 2.0 for installed apps, offline access):
- **WHERE:** a browser session, one time, signed in as the mailbox owner.
- **WHAT:** authorize with `gmail.readonly` (and the configured scopes) and
  `access_type=offline` so a **refresh token** is returned.
- **WHAT TO ENTER:** the returned `access_token` (short-lived) and
  `refresh_token` (long-lived) values.
- **WHAT NOT TO SHARE:** do not paste these into chat. Provision them into
  the environment (step 7).
- Alternative that fits the existing code: set the workbook so the server can
  use the **refresh-token path** (`GMAIL_OAUTH_REFRESH_TOKEN` +
  `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`), which lets it mint fresh
  access tokens automatically. Prefer this over a static access token.

## 6. Razorpay configuration (required for correlation)

For a static Payment Link payment to be **auto-verifiable**, the Razorpay
payment-confirmation email must carry the CodeConClave payment reference.
Requirements:
- Razorpay must have **email notifications** enabled (default sends a
  payment-confirmation on `payment.captured`) to the controlled mailbox.
- The unique per-intent reference must appear in that email. Static links
  (`https://rzp.io/rzp/sAgHIpxS`, `https://rzp.io/rzp/3ioXlCxd`) do NOT carry
  per-user identity, so exact user correlation requires either:
  - a **unique per-intent payment link** created via the Razorpay **API**
    (`RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`, which put the reference in
    the link's notes/description so the email contains it), OR
  - the customer manually appending the CodeConClave reference to the
    payment description (weak; the pipeline still requires exact match).
- Without the reference in the email, a static-link receipt cannot be
  attributed to a user safely and stays PENDING/REVIEW (correct behaviour —
  no fake auto-activation).

## 7. Railway environment variables

**WHERE:** Railway project (`82dd1698-e7f6-4912-8cd6-299a1bc95557`) → backend
service → **Variables / Settings** (web console)
**WHAT TO ENTER (names only — values go in the console, never in chat):**
Backend (all names match the env schema `backend/src/config/env.ts`):
- `DATABASE_URL` — required; no `.env`-default may remain in production
- `DATABASE_SSL=true`
- `SESSION_SECRET` — strong random; production refuses the weak dev default
- `JWT_SECRET` — strong random; production refuses the weak dev default
- `REDIS_URL` — only if `QUEUE_PROVIDER=redis`
- `QUEUE_PROVIDER` — `memory` or `redis`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=`https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback
- `GOOGLE_SCOPES=` (must include `https://www.googleapis.com/auth/gmail.readonly`)
- `GMAIL_OAUTH_ACCESS_TOKEN=` **or** `GMAIL_OAUTH_REFRESH_TOKEN=` + the above
  client id/secret for the refresh path
- `RAZORPAY_KEY_ID=` and `RAZORPAY_KEY_SECRET=` (needed for unique per-intent
  links / exact static->user correlation)
- `RAZORPAY_PRO_PAYMENT_LINK=` and `RAZORPAY_TEAM_PAYMENT_LINK=` only if you
  change the links (keep the current ₹999/₹4999 values)

Frontend: only browser-safe values (no secrets).
**WHAT NOT TO SHARE:** the actual values / tokens / secrets.

## 8. Verification step

- Confirm the OAuth grant returns a working token and the controlled mailbox
  receives a Razorpay payment-confirmation email.
- Run one real test payment against the flow and confirm the intent becomes
  ACTIVE automatically (the watchdog's `mailboxReceipts` sweep polls it).
- If it stays REVIEW, check that the reference actually appeared in the email
  and that the Gmail scope/token are valid.

---

## Human actions remaining (summary)

1. Google Cloud: create/select project, enable **Gmail API**, configure
   **OAuth consent screen** with `gmail.readonly` (add the mailbox as a test
   user).
2. Create an **OAuth client** with redirect URI
   `https://backend-production-95faa.up.railway.app/api/v1/auth/google/callback`.
3. Run the **offline consent** for the Razorpay notification mailbox and
   obtain the refresh/access token.
4. **Razorpay:** enable email notifications to that mailbox AND (required for
   exact correlation) enable **API keys** so unique per-intent links carry the
   reference, OR use manual references (weak).
5. Put all values into **Railway Variables** (never in chat).
6. Redeploy, verify one real (or sandbox) payment auto-activates.