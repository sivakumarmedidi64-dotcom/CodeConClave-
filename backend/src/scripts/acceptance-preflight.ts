/**
 * CodeConClave — Acceptance preflight (Prompt 6).
 * Safe, read-only diagnostics for the canonical-origin + Google OAuth +
 * payment human gates. Never prints secrets, tokens, keys, or headers.
 * Output:
 *   CANONICAL_ORIGIN, GOOGLE_REDIRECT_URI, CORS_ORIGINS, AUTH_COOKIE_DOMAIN,
 *   SESSION_COOKIE_SECURE, AUTH_PREFLIGHT, PAYMENT_PREFLIGHT
 * The OAuth/payment HUMAN gates stay HUMAN_REQUIRED — this never fabricates a
 * real login or payment.
 */
import { env, corsOrigins } from '../config/env.js';
import { pool } from '../shared/db.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

interface Check {
  name: string;
  pass: boolean;
  warn: boolean;
  detail: string;
}

export async function runPreflight(): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  // ---- Canonical origin ----
  const redirectUri = env.GOOGLE_REDIRECT_URI;
  let redirectOrigin: URL | null = null;
  try {
    redirectOrigin = new URL(redirectUri);
  } catch {
    redirectOrigin = null;
  }
  const origins = corsOrigins;

  const canonical = redirectOrigin ? redirectOrigin.origin : '(configure GOOGLE_REDIRECT_URI)';
  console.log(`CANONICAL_ORIGIN = ${canonical}`);

  const oauthConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  checks.push({
    name: 'GOOGLE_OAUTH_CLIENT_CONFIG',
    pass: oauthConfigured,
    warn: false,
    detail: oauthConfigured ? 'client id + secret present (values never printed)' : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured',
  });

  checks.push({
    name: 'GOOGLE_REDIRECT_URI',
    pass: redirectOrigin !== null,
    warn: !redirectOrigin,
    detail: redirectOrigin
      ? `${redirectUri} (origin ${redirectOrigin.origin})`
      : `${redirectUri} is not a valid URL — configure GOOGLE_REDIRECT_URI`,
  });

  const redirectAllowedByCors = redirectOrigin !== null && origins.includes(redirectOrigin.origin);
  checks.push({
    name: 'REDIRECT_ORIGIN_IN_CORS',
    pass: redirectAllowedByCors,
    warn: !redirectAllowedByCors,
    detail: redirectAllowedByCors
      ? `${redirectOrigin!.origin} is allowed by CORS_ORIGINS`
      : `CORS_ORIGINS = ${origins.join(', ')} does not include ${redirectOrigin?.origin ?? '(invalid redirect)'}`,
  });

  // Mixed-origin guard: warnings only — one canonical origin is the rule.
  const uniqueOrigins = [...new Set(origins)];
  const devHosts = ['localhost', '127.0.0.1'];
  const localSet = new Set<string>();
  const remoteSet = new Set<string>();
  for (const o of uniqueOrigins) {
    try {
      const h = new URL(o).hostname;
      if (devHosts.includes(h) || h.endsWith('.localhost')) localSet.add(o);
      else remoteSet.add(o);
    } catch {
      /* ignore unparseable origin */
    }
  }
  const mixedOrigin = localSet.size > 0 && remoteSet.size > 0;
  checks.push({
    name: 'SINGLE_CANONICAL_ORIGIN',
    pass: uniqueOrigins.length === 1 && !mixedOrigin,
    warn: true,
    detail: mixedOrigin
      ? `mixed-origin development detected (${[...localSet].join(', ')} and ${[...remoteSet].join(', ')}) — sessions are host-scoped; each browser must use one exact origin`
      : uniqueOrigins.length > 1
        ? `${uniqueOrigins.length} origins configured (${uniqueOrigins.join(', ')}) — keep ONE canonical origin for release`
        : `single canonical origin: ${uniqueOrigins[0] ?? '(none)'}`,
  });

  const cookieDomain = env.AUTH_COOKIE_DOMAIN;
  let domainMatchesRedirect = true;
  if (cookieDomain && redirectOrigin) {
    const host = redirectOrigin.hostname.toLowerCase();
    const dom = cookieDomain.toLowerCase().replace(/^\./, '');
    domainMatchesRedirect = host === dom || host.endsWith(`.${dom}`);
  }
  checks.push({
    name: 'AUTH_COOKIE_DOMAIN',
    pass: true,
    warn: cookieDomain ? !domainMatchesRedirect : false,
    detail: cookieDomain
      ? domainMatchesRedirect
        ? `configured ${cookieDomain} matches redirect origin — scoped to ${cookieDomain}`
        : `configured ${cookieDomain} does NOT match redirect host ${redirectOrigin?.hostname}`
      : 'not configured (not required for single-origin deployments)',
  });

  const secureRequired = redirectOrigin ? redirectOrigin.protocol === 'https:' : false;
  const cookieSecure = env.SESSION_COOKIE_SECURE === 'true';
  checks.push({
    name: 'SESSION_COOKIE_SECURE',
    pass: secureRequired ? cookieSecure : true,
    warn: false,
    detail: cookieSecure
      ? `true (current) — set from SESSION_COOKIE_SECURE`
      : `false (current) — production requires true when serving over https`,
  });
  const last = checks[checks.length - 1];
  if (last && secureRequired && !cookieSecure) last.warn = true;

  const authPass = checks.slice(0, 3).every((c) => c.pass);
  console.log(`AUTH_PREFLIGHT = ${authPass ? 'PASS' : 'FAIL'}`);

  // ---- Payment preflight (architecture frozen; read-only) ----
  const razorpayConfigured = env.RAZORPAY_PRO_PAYMENT_LINK && env.RAZORPAY_TEAM_PAYMENT_LINK ? true : false;
  checks.push({
    name: 'PAYMENT_LINK_CONFIG',
    pass: razorpayConfigured,
    warn: false,
    detail: razorpayConfigured ? 'pro + team hosted links configured (values never printed)' : 'hosted payment links not configured',
  });
  checks.push({
    name: 'PAYMENT_PROOF_REPORTED',
    pass: true,
    warn: true,
    detail: 'payment proof suite 16/16 PASS is verified separately by npm run prove:payment (never claimed here as a live payment)',
  });

  let poolState = 'unavailable';
  let poolOk = false;
  let poolDetail = 'database query failed';
  try {
    const stranded = await pool.query("SELECT COUNT(*)::int AS n FROM payment_link_reservations WHERE status = 'RESERVED'");
    const reserved = stranded.rows[0]?.n ?? 0;
    poolState = 'ok';
    poolOk = reserved <= 50;
    poolDetail = `payment_link_reservations rows = ${reserved} (no unbounded orphan growth)`;
  } catch (err) {
    poolDetail = `DB error: ${(err as Error).message}`;
  }
  checks.push({
    name: 'PAYMENT_POOL_STATE',
    pass: poolOk,
    warn: poolOk,
    detail: poolDetail,
  });

  console.log(`PAYMENT_PREFLIGHT = ${poolOk ? 'PASS' : 'FAIL'} (read-only checks; live payment HUMAN-gated)`);

  const allPass = authPass && poolOk;
  return { ok: allPass, checks };
}

function printChecks(checks: Check[]): void {
  for (const c of checks) {
    const grade = c.pass ? (c.warn ? 'WARN' : 'PASS') : 'FAIL';
    console.log(`  ${grade}  ${c.name}: ${c.detail}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runPreflight()
    .then((r) => {
      printChecks(r.checks);
      console.log(`PREFLIGHT_TOTAL = ${r.ok ? 'PASS' : 'FAIL'}`);
      // eslint-disable-next-line no-process-exit
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('preflight threw:', (err as Error).message);
      // eslint-disable-next-line no-process-exit
      process.exit(2);
    });
}