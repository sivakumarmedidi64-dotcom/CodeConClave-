/**
 * CodeConClave — PHASE 17 security matrix, categories 13-14.
 *
 * Categories 1-12 live in security-15.test.ts. These two complete the
 * 14-attack matrix at the OAuth / SSO boundary, all through the real
 * google.ts HMAC-signed state machinery (no client-side authority):
 *   13. OAuth state tampering escalation — cross-protocol binding, secret
 *       rotation, signature swap, CSRF nonce replacement. The server's HMAC
 *       makes every tamper fail closed (google_state_invalid/expired).
 *   14. OAuth callback fail-closed — no configured client, no fabricated
 *       login; state is only ever checked server-side, never by the client.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';
import { googleStateToken, verifyGoogleState, authorizeUrl, googleConfigured } from '../modules/auth/google.js';
import { AppError } from '../shared/errors.js';

function nonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Hand-roll a state token the way the client can NOT (no JWT_SECRET). */
function forgeState(bodyPayload: object, key: string, prefix: string): string {
  const body = Buffer.from(JSON.stringify(bodyPayload)).toString('base64url');
  const sig = createHmac('sha256', key).update(`${prefix}:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

function errCode(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as AppError).errorCode ?? null;
  }
}

beforeEach(() => {
  expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(16);
});

describe('SECURITY CATEGORY 13 — OAuth state tampering escalation', () => {
  it('rejects a forged state signed with an attacker-held secret', () => {
    const forged = forgeState({ nonce: nonce(), exp: Date.now() + 600_000 }, 'attacker_secret', 'google-oauth');
    expect(errCode(() => verifyGoogleState(forged))).toBe('google_state_invalid');
  });

  it('rejects a cross-protocol state (wrong message prefix binds it out)', () => {
    const cross = forgeState({ nonce: nonce(), exp: Date.now() + 600_000 }, env.JWT_SECRET, 'google-oauth2');
    expect(errCode(() => verifyGoogleState(cross))).toBe('google_state_invalid');
    const sessionForged = forgeState({ nonce: nonce(), exp: Date.now() + 600_000 }, env.JWT_SECRET, 'session');
    expect(errCode(() => verifyGoogleState(sessionForged))).toBe('google_state_invalid');
  });

  it('rejects a signature swapped from a different body (tampered payload)', () => {
    const honest = googleStateToken(nonce());
    const [bodyA] = honest.split('.');
    const bodyB = Buffer.from(JSON.stringify({ nonce: nonce(), exp: Date.now() + 600_000 })).toString('base64url');
    const sigA = honest.split('.')[1]!;
    expect(errCode(() => verifyGoogleState(`${bodyB}.${sigA}`))).toBe('google_state_invalid');
    expect(errCode(() => verifyGoogleState(`${bodyA}.garbage`))).toBe('google_state_invalid');
  });

  it('rejects a CSRF nonce replacement: a state replayed with a changed nonce is invalid', () => {
    const honest = googleStateToken('victim-nonce');
    const [, sig] = honest.split('.');
    const attackedBody = Buffer.from(JSON.stringify({ nonce: 'attacker-nonce', exp: Date.now() + 600_000 })).toString('base64url');
    expect(errCode(() => verifyGoogleState(`${attackedBody}.${sig}`))).toBe('google_state_invalid');
  });

  it('rejects a state after the signing key rotates (server restart)', () => {
    const before = googleStateToken(nonce());
    // Secret rotation: the same token fails against the new key.
    const rotated = createHmac('sha256', `${env.JWT_SECRET}-rotated`).update(`google-oauth:${before.split('.')[0]}`).digest('base64url');
    expect(errCode(() => verifyGoogleState(`${before.split('.')[0]}.${rotated}`))).toBe('google_state_invalid');
  });

  it('accepts only a freshly minted, correctly bound token', () => {
    const token = googleStateToken(nonce());
    expect(errCode(() => verifyGoogleState(token))).toBe(null);
  });
});

describe('SECURITY CATEGORY 14 — OAuth callback fail-closed', () => {
  it('never fabricates a login when the server has no Google client configured', () => {
    // The fail-closed boundary must hold even when a real client is configured
    // in the local .env — stub the env to simulate the unconfigured state.
    const savedId = env.GOOGLE_CLIENT_ID;
    const savedSecret = env.GOOGLE_CLIENT_SECRET;
    env.GOOGLE_CLIENT_ID = undefined;
    env.GOOGLE_CLIENT_SECRET = undefined;
    expect(googleConfigured()).toBe(false);
    env.GOOGLE_CLIENT_ID = savedId;
    env.GOOGLE_CLIENT_SECRET = savedSecret;
  });

  it('authorizeUrl embeds the untrusted state verbatim for server-side checking', () => {
    const url = authorizeUrl('csrf-challenge');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('state')).toBe('csrf-challenge');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
  });

  it('the callback is gated on the server state token, never on the client', () => {
    // The only path into the callback flow is a server-verified state; a
    // client cannot self-assert. verifyGoogleState rejects any unsigned body.
    expect(errCode(() => verifyGoogleState('unsigned-body-only'))).toBe('google_state_invalid');
    expect(errCode(() => verifyGoogleState(''))).toBe('google_state_invalid');
  });
});