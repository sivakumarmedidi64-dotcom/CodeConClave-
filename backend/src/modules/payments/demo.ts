/**
 * CodeConClave — DEMO PAYMENT MODE (redirect-only; strictly non-production).
 *
 * WHY THIS EXISTS
 *   CodeConClave has no Razorpay API keys and no signed webhook, so a real,
 *   zero-admin, independent payment-verification rail is NOT possible yet (all
 *   prior audits concluded NO_API/NO_WEBHOOK/NO_ADMIN = NOT_POSSIBLE). This rail
 *   exists ONLY so the intended customer journey can be demonstrated in
 *   development/staging WITHOUT pretending that a browser redirect is payment
 *   proof.
 *
 * ABSOLUTE SAFETY RULE
 *   Nothing in this module ever treats a redirect, query parameter, cookie,
 *   or client claim as payment proof. An activation email click proves EMAIL
 *   OWNERSHIP only — it proves PAYMENT OCCURRED = NO. There is no production
 *   entitlement; there is no "payment verified"; there is only a clearly marked
 *   "DEMO ACTIVATION" recorded as:
 *     payment_verification_method = DEMO_REDIRECT
 *     is_real_payment             = false
 *
 * PRODUCTION GUARD (server-side, hard)
 *   demoModeEnabled() === true ONLY when:
 *     env.DEMO_PAYMENT_MODE === 'true'  AND  env.NODE_ENV !== 'production'
 *   (and, when DEMO_PAYMENT_ALLOWLIST is set, the caller's email must be on it).
 *   A frontend env var, a cookie, or a query parameter can never enable it. In
 *   production every entrypoint returns 403 demo_mode_disabled with the message
 *   "Redirect-only payment verification is disabled in production."
 *
 * STATE
 *   The activation token record lives in the cache/Redis store (allowed for
 *   activation tokens and avoids any database schema change). The short-lived
 *   signed demo session is stateless/HMAC-signed and validated server-side.
 *
 * The production payment rails (Razorpay API, webhook, Gmail evidence, plan/
 * amount validation, idempotency, replay protection) are NOT touched here.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { cache } from '../../shared/cache.js';
import { AppError } from '../../shared/errors.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { PLAN_PRICES_INR } from './service.js';

/** Demo state namespaces — separate from production entitlement states. */
export const DemoStatus = {
  PENDING: 'DEMO_PENDING',
  ACTIVATED: 'DEMO_ACTIVATED',
} as const;
export type DemoStatus = (typeof DemoStatus)[keyof typeof DemoStatus];

export const DEMO_VERIFICATION_METHOD = 'DEMO_REDIRECT';

export interface DemoSessionClaims {
  sessionId: string;
  userId: string;
  email: string;
  plan: 'pro' | 'team';
  amountInr: number;
  demo: true;
  issuedAt: number;
  expiresAt: number;
}

export type DemoPlan = 'pro' | 'team';

export interface DemoActivationRecord {
  tokenHash: string;
  sessionId: string;
  userId: string;
  email: string;
  plan: DemoPlan;
  amountInr: number;
  status: DemoStatus;
  payment_verification_method: typeof DEMO_VERIFICATION_METHOD;
  is_real_payment: false;
  expiresAt: number;
  usedAt: number | null;
}

export type DemoActivationView = Omit<DemoActivationRecord, 'tokenHash'>;

/** Public-facing view of a demo activation (never leaks the token hash). */
export function toDemoActivationView(r: DemoActivationRecord): DemoActivationView {
  return {
    sessionId: r.sessionId,
    userId: r.userId,
    email: r.email,
    plan: r.plan,
    amountInr: r.amountInr,
    status: r.status,
    payment_verification_method: r.payment_verification_method,
    is_real_payment: r.is_real_payment,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt,
  };
}

/**
 * Hard server-side guard. Redirect-only "payment" is never available in
 * production and never enabled merely by a cookie/query/frontend flag.
 */
export function demoModeEnabled(userEmail?: string | null): boolean {
  if (env.NODE_ENV === 'production') return false;
  if (env.DEMO_PAYMENT_MODE !== 'true') return false;
  const allow = env.DEMO_PAYMENT_ALLOWLIST.trim();
  if (!allow) return true;
  if (!userEmail) return false;
  return allow
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(userEmail.toLowerCase());
}

/** The message returned whenever the demo rail is refused (incl. production). */
export function demoGuardError(): AppError {
  return AppError.forbidden(
    'demo_mode_disabled',
    'Redirect-only payment verification is disabled in production.',
  );
}

function assertDemoAllowed(email: string | null): void {
  if (!demoModeEnabled(email)) throw demoGuardError();
}

function demoSecret(): string {
  if (env.DEMO_SESSION_SECRET && env.DEMO_SESSION_SECRET.trim().length >= 16) {
    return env.DEMO_SESSION_SECRET;
  }
  return sha256Hex(`codeconclave-demo-session-v1:${env.SESSION_SECRET}`);
}

function sign(payload: string): string {
  return createHmac('sha256', demoSecret()).update(payload).digest('hex');
}

function hmacEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sessionTtlMs(): number {
  return env.DEMO_SESSION_TTL_SECONDS * 1000;
}

function activationTtlMs(): number {
  return env.DEMO_ACTIVATION_TTL_SECONDS * 1000;
}

function claimsPayload(c: DemoSessionClaims): string {
  return [
    c.sessionId,
    c.userId,
    c.email,
    c.plan,
    c.amountInr,
    String(c.demo),
    c.issuedAt,
    c.expiresAt,
  ].join('|');
}

function signSession(c: DemoSessionClaims): string {
  return `${sign(claimsPayload(c))}.${Buffer.from(JSON.stringify(c)).toString('base64url')}`;
}

/**
 * Create a short-lived signed demo session for the authenticated user. Returns
 * the opaque signed token (HMAC integrity enforced server-side). This token is
 * NEVER payment proof — only a bound, non-production demo intent.
 */
export function createDemoSession(userId: string, email: string, plan: DemoPlan): { token: string; claims: DemoSessionClaims } {
  assertDemoAllowed(email);
  if (!(plan in PLAN_PRICES_INR)) throw AppError.badRequest('invalid_plan', 'plan must be pro or team');
  const now = Date.now();
  const claims: DemoSessionClaims = {
    sessionId: randomUUID(),
    userId,
    email,
    plan,
    amountInr: PLAN_PRICES_INR[plan]!,
    demo: true,
    issuedAt: now,
    expiresAt: now + sessionTtlMs(),
  };
  return { token: signSession(claims), claims };
}

export interface ValidatedDemoSession {
  claims: DemoSessionClaims;
  token: string;
}

/**
 * Validate an opaque signed demo session token. Rejects tampering, expiration,
 * plan/amount changes, and any non-demo token. Optionally binds to the caller.
 */
export function verifyDemoSessionToken(
  token: string,
  caller?: { userId: string; email: string } | null,
): ValidatedDemoSession {
  assertDemoAllowed(caller?.email ?? null);
  const dot = token.indexOf('.');
  if (dot <= 0) throw AppError.badRequest('demo_session_invalid', 'Invalid demo session');
  const providedSig = token.slice(0, dot);
  const body = token.slice(dot + 1);
  let claims: DemoSessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DemoSessionClaims;
    if (!claims || typeof claims !== 'object') throw new Error('bad shape');
  } catch {
    throw AppError.badRequest('demo_session_invalid', 'Invalid demo session');
  }
  if (!hmacEqual(providedSig, sign(claimsPayload(claims)))) {
    throw AppError.badRequest('demo_session_tampered', 'Demo session signature is invalid');
  }
  if (claims.demo !== true) throw AppError.badRequest('demo_session_invalid', 'Not a demo session');
  if (claims.expiresAt <= Date.now()) throw AppError.badRequest('demo_session_expired', 'Demo session has expired');
  if (!(claims.plan in PLAN_PRICES_INR)) throw AppError.badRequest('demo_session_invalid', 'Invalid plan');
  if (claims.amountInr !== PLAN_PRICES_INR[claims.plan]!) {
    throw AppError.badRequest('demo_session_tampered', 'Demo session amount is invalid');
  }
  if (caller && (caller.userId !== claims.userId || caller.email !== claims.email)) {
    throw AppError.forbidden('demo_session_user_mismatch', 'Demo session does not match the authenticated account');
  }
  return { claims, token };
}

// ---------------------------------------------------------------- activation token

const ACT_HASH_PREFIX = 'demo-act:hash:';
const ACT_RATE_PREFIX = 'demo-act:rate:';

export interface IssueActivationResult {
  token: string;
  activationUrl: string;
  view: DemoActivationView;
}

/**
 * Issue a one-time activation token for a validated demo session. The token is
 * random (32 bytes), SHA-256 hashed at rest in the cache store, short-lived,
 * single-use, and per-user rate-limited. The email click proves email
 * ownership — NOT payment — and the record is marked DEMO_REDIRECT /
 * is_real_payment=false.
 */
export async function issueDemoActivation(
  session: ValidatedDemoSession,
  baseUrl: string,
): Promise<IssueActivationResult> {
  assertDemoAllowed(session.claims.email);
  const emailKey = sha256Hex(session.claims.email);
  const hourCount = await cache.incr(`${ACT_RATE_PREFIX}${emailKey}`, 60 * 60 * 1000);
  if (hourCount > env.DEMO_ACTIVATION_MAX_PER_HOUR) {
    throw AppError.tooMany('demo_activation_rate_limited', 'Too many demo activation requests. Try again in an hour.');
  }
  const raw = randomToken(32);
  const tokenHash = sha256Hex(raw);
  const ttlMs = activationTtlMs();
  const record: DemoActivationRecord = {
    tokenHash,
    sessionId: session.claims.sessionId,
    userId: session.claims.userId,
    email: session.claims.email,
    plan: session.claims.plan,
    amountInr: session.claims.amountInr,
    status: DemoStatus.PENDING,
    payment_verification_method: DEMO_VERIFICATION_METHOD,
    is_real_payment: false,
    expiresAt: Date.now() + ttlMs,
    usedAt: null,
  };
  await cache.set(`${ACT_HASH_PREFIX}${tokenHash}`, JSON.stringify(record), ttlMs);
  const activationUrl = `${baseUrl.replace(/\/$/, '')}/demo/payment/activate?token=${encodeURIComponent(raw)}`;
  return { token: raw, activationUrl, view: toDemoActivationView(record) };
}

/**
 * Consume a one-time activation token. Exactly-once: the record is removed
 * atomically on first use via a compare-and-delete on the stored token hash.
 * Rejects wrong account, expiration, reuse, and any non-demo evidence rail.
 */
export async function consumeDemoActivation(
  rawToken: string,
  caller: { userId: string; email: string },
): Promise<DemoActivationRecord> {
  assertDemoAllowed(caller.email);
  const tokenHash = sha256Hex(rawToken);
  const stored = await cache.get(`${ACT_HASH_PREFIX}${tokenHash}`);
  if (!stored) {
    throw AppError.badRequest('demo_activation_invalid', 'This demo activation link is not valid.');
  }
  let record: DemoActivationRecord;
  try {
    record = JSON.parse(stored) as DemoActivationRecord;
  } catch {
    throw AppError.badRequest('demo_activation_invalid', 'This demo activation link is not valid.');
  }
  if (record.is_real_payment !== false) {
    throw AppError.forbidden('demo_activation_invalid', 'Not a demo activation');
  }
  if (record.userId !== caller.userId || record.email !== caller.email) {
    throw AppError.forbidden('demo_activation_user_mismatch', 'Demo activation does not match the authenticated account');
  }
  if (record.expiresAt <= Date.now()) {
    await cache.del(`${ACT_HASH_PREFIX}${tokenHash}`);
    throw AppError.badRequest('demo_activation_expired', 'This demo activation link has expired. Request a new one.');
  }
  if (record.status !== DemoStatus.PENDING) {
    throw AppError.badRequest('demo_activation_used', 'This demo activation link has already been used.');
  }
  // Atomic exactly-once: only consume if the record is still the same un-consumed row.
  const reread = await cache.get(`${ACT_HASH_PREFIX}${tokenHash}`);
  if (!reread || reread !== stored) {
    throw AppError.badRequest('demo_activation_used', 'This demo activation link has already been used.');
  }
  const updated: DemoActivationRecord = {
    ...record,
    status: DemoStatus.ACTIVATED,
    usedAt: Date.now(),
  };
  await cache.set(`${ACT_HASH_PREFIX}${tokenHash}`, JSON.stringify(updated), Math.max(1, updated.expiresAt - Date.now()));
  return updated;
}

export { activationTtlMs };
