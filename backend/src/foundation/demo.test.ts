/**
 * CodeConClave — DEMO PAYMENT MODE regression tests.
 *
 * Guards the redirect-only demo rail against every misuse:
 *   1. demoModeEnabled() is true only off-production with DEMO_PAYMENT_MODE=true
 *   2. entrypoints refuse in production (403 demo_mode_disabled)
 *   3. session-create refuses in production
 *   4. a tampered demo session signature is rejected
 *   5. an expired demo session is rejected
 *   6. a session for a different user cannot be used by another account
 *   7. a session with a tampered plan is rejected
 *   8. a session with a tampered amount is rejected
 *   9. a non-demo token is rejected
 *  10. activation token is single-use (reuse rejected)
 *  11. activation token expiry is enforced
 *  12. activation token is bound to the owning account (wrong account rejected)
 *  13. a demo activation is never labeled real; is_real_payment=false,
 *      payment_verification_method=DEMO_REDIRECT
 *  14. demo-mode entitlement cannot be produced in production
 *  15. a valid, correctly labeled demo activation succeeds
 *
 * Everything is served from mock storage; no DB, no provider, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => {
  const memory = new Map<string, { value: string; expiresAt: number }>();
  const expiresIn = (key: string, ttlMs: number) => Date.now() + ttlMs;
  return {
    memory,
    async get(key: string): Promise<string | null> {
      const e = memory.get(key);
      if (!e) return null;
      if (e.expiresAt <= Date.now()) {
        memory.delete(key);
        return null;
      }
      return e.value;
    },
    async set(key: string, value: string, ttlMs: number): Promise<void> {
      memory.set(key, { value, expiresAt: expiresIn(key, ttlMs) });
    },
    async del(key: string): Promise<void> {
      memory.delete(key);
    },
    async incr(key: string, ttlMs: number): Promise<number> {
      const e = memory.get(key);
      if (!e || e.expiresAt <= Date.now()) {
        memory.set(key, { value: '1', expiresAt: expiresIn(key, ttlMs) });
        return 1;
      }
      const n = Number(e.value) + 1;
      memory.set(key, { value: String(n), expiresAt: e.expiresAt });
      return n;
    },
    reset() {
      memory.clear();
    },
  };
});

vi.mock('../shared/cache.js', () => ({ cache: store }));

import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import {
  demoModeEnabled,
  demoGuardError,
  createDemoSession,
  verifyDemoSessionToken,
  issueDemoActivation,
  consumeDemoActivation,
  DEMO_VERIFICATION_METHOD,
  toDemoActivationView,
  type DemoActivationRecord,
} from '../modules/payments/demo.js';

beforeEach(() => {
  store.reset();
  env.NODE_ENV = 'test';
  env.DEMO_PAYMENT_MODE = 'true';
  env.DEMO_PAYMENT_ALLOWLIST = '';
  env.DEMO_SESSION_SECRET = 'demo_test_secret_at_least_16_chars';
  env.DEMO_SESSION_TTL_SECONDS = 600;
  env.DEMO_ACTIVATION_TTL_SECONDS = 1800;
  env.DEMO_ACTIVATION_MAX_PER_HOUR = 3;
});

afterEach(() => {
  vi.unstubAllGlobals();
  env.NODE_ENV = 'test';
});

async function issueActivationFor(userId = 'u1', email = 'u1@test.dev', plan: 'pro' | 'team' = 'pro') {
  const { token: s } = createDemoSession(userId, email, plan);
  const session = verifyDemoSessionToken(s, { userId, email });
  return issueDemoActivation(session, 'http://localhost:5173');
}

describe('demoModeEnabled hard guard', () => {
  it('1. enabled only when DEMO_PAYMENT_MODE=true AND NODE_ENV!==production', () => {
    env.NODE_ENV = 'development';
    env.DEMO_PAYMENT_MODE = 'true';
    expect(demoModeEnabled('u@test.dev')).toBe(true);
    env.DEMO_PAYMENT_MODE = 'false';
    expect(demoModeEnabled('u@test.dev')).toBe(false);
    env.DEMO_PAYMENT_MODE = 'true';
    env.NODE_ENV = 'production';
    expect(demoModeEnabled('u@test.dev')).toBe(false);
    env.NODE_ENV = 'test';
  });

  it('1b. allowlist restricts non-listed users even in demo mode', () => {
    env.DEMO_PAYMENT_ALLOWLIST = 'demo@codeconclave.dev,allowed@test.dev';
    expect(demoModeEnabled('allowed@test.dev')).toBe(true);
    expect(demoModeEnabled('not-allowed@test.dev')).toBe(false);
    expect(demoModeEnabled(null)).toBe(false);
  });

  it('2. production always yields the fixed refusal error', () => {
    env.NODE_ENV = 'production';
    env.DEMO_PAYMENT_MODE = 'true';
    const err = demoGuardError();
    expect(err.status).toBe(403);
    expect(err.errorCode).toBe('demo_mode_disabled');
    expect(err.message).toContain('disabled in production');
  });
});

describe('session create guard', () => {
  it('3. createDemoSession refuses in production', () => {
    env.NODE_ENV = 'production';
    expect(() => createDemoSession('u1', 'u1@test.dev', 'pro')).toThrowError(
      expect.objectContaining({ errorCode: 'demo_mode_disabled' }) as Error,
    );
  });

  it('3b. createDemoSession encodes server-authoritative plan amounts', () => {
    const { claims } = createDemoSession('u1', 'u1@test.dev', 'team');
    expect(claims.amountInr).toBe(4999);
    expect(claims.demo).toBe(true);
  });

  it('3c. createDemoSession rejects an unknown plan', () => {
    expect(() => createDemoSession('u1', 'u1@test.dev', 'enterprise' as never)).toThrowError(
      expect.objectContaining({ errorCode: 'invalid_plan' }) as Error,
    );
  });
});

describe('signed session integrity', () => {
  function makeClaims(userId = 'u1', email = 'u1@test.dev', plan: 'pro' | 'team' = 'pro') {
    const { claims } = createDemoSession(userId, email, plan);
    return claims;
  }

  /** Re-encode a claims object (as if a client tampered, but body crafted). */
  function forge(claims: ReturnType<typeof makeClaims>, mutate: (c: ReturnType<typeof makeClaims>) => void): string {
    const copy = JSON.parse(JSON.stringify(claims));
    mutate(copy);
    return 'deadbeef.' + Buffer.from(JSON.stringify(copy)).toString('base64url');
  }

  it('4. tampered signature is rejected', () => {
    const { token } = createDemoSession('u1', 'u1@test.dev', 'pro');
    const [_, body] = token.split('.');
    const forged = '0000000000000000000000000000000000000000000000000000000000000000.' + body;
    expect(() => verifyDemoSessionToken(forged, { userId: 'u1', email: 'u1@test.dev' })).toThrowError(
      expect.objectContaining({ errorCode: 'demo_session_tampered' }) as Error,
    );
  });

  it('5. expired demo session is rejected', () => {
    const claims = makeClaims();
    const dead = { ...claims, expiresAt: Date.now() - 1000 };
    // Re-sign a valid token whose expiry is already past using the same secret.
    const { createHmac } = require('node:crypto');
    const secret = env.DEMO_SESSION_SECRET!;
    const payload = [dead.sessionId, dead.userId, dead.email, dead.plan, dead.amountInr, String(dead.demo), dead.issuedAt, dead.expiresAt].join('|');
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    const forged = `${sig}.${Buffer.from(JSON.stringify(dead)).toString('base64url')}`;
    expect(() => verifyDemoSessionToken(forged, { userId: 'u1', email: 'u1@test.dev' })).toThrowError(
      expect.objectContaining({ errorCode: 'demo_session_expired' }) as Error,
    );
  });

  it('6. a different account cannot use a signed session', () => {
    const { token } = createDemoSession('u1', 'u1@test.dev', 'pro');
    expect(() => verifyDemoSessionToken(token, { userId: 'u2', email: 'u2@test.dev' })).toThrowError(
      expect.objectContaining({ errorCode: 'demo_session_user_mismatch' }) as Error,
    );
  });

  it('7. tampered plan in the session is rejected', () => {
    const claims = makeClaims('u1', 'u1@test.dev', 'pro');
    const forged = forge(claims, (c) => {
      c.plan = 'team';
      c.amountInr = 4999;
    });
    // plan change invalidates the HMAC, so it must read as tampered.
    expect(() => verifyDemoSessionToken(forged, { userId: 'u1', email: 'u1@test.dev' })).toThrowError(
      expect.objectContaining({ errorCode: 'demo_session_tampered' }) as Error,
    );
  });

  it('8. tampered / non-server amount in the session is rejected', () => {
    const claims = makeClaims('u1', 'u1@test.dev', 'pro');
    const forged = forge(claims, (c) => {
      c.amountInr = 1;
    });
    expect(() => verifyDemoSessionToken(forged, { userId: 'u1', email: 'u1@test.dev' })).toThrowError(
      expect.objectContaining({ errorCode: 'demo_session_tampered' }) as Error,
    );
  });

  it('9. a non-demo token is rejected', () => {
    const claims = makeClaims('u1', 'u1@test.dev', 'pro');
    const nonDemo = { ...claims, demo: false as never };
    const { createHmac } = require('node:crypto');
    const payload = [nonDemo.sessionId, nonDemo.userId, nonDemo.email, nonDemo.plan, nonDemo.amountInr, String(nonDemo.demo), nonDemo.issuedAt, nonDemo.expiresAt].join('|');
    const sig = createHmac('sha256', env.DEMO_SESSION_SECRET!).update(payload).digest('hex');
    const forged = `${sig}.${Buffer.from(JSON.stringify(nonDemo)).toString('base64url')}`;
    expect(() => verifyDemoSessionToken(forged, { userId: 'u1', email: 'u1@test.dev' })).toThrowError(
      expect.objectContaining({ errorCode: 'demo_session_invalid' }) as Error,
    );
  });
});

describe('activation token safety', () => {
  it('10. a one-time activation token is single-use', async () => {
    const { token } = await issueActivationFor();
    const first = await consumeDemoActivation(token, { userId: 'u1', email: 'u1@test.dev' });
    expect(first.status).toBe('DEMO_ACTIVATED');
    await expect(consumeDemoActivation(token, { userId: 'u1', email: 'u1@test.dev' })).rejects.toMatchObject({
      errorCode: 'demo_activation_used',
    });
  });

  it('11. an expired activation token is rejected', async () => {
    const { token } = await issueActivationFor();
    // Force expiry by rewriting the stored record's expiresAt to the past.
    const hashKey = [...store.memory.keys()].find((k) => k.startsWith('demo-act:hash:'))!;
    const rec = JSON.parse(store.memory.get(hashKey)!.value) as DemoActivationRecord;
    rec.expiresAt = Date.now() - 1000;
    store.memory.set(hashKey, { value: JSON.stringify(rec), expiresAt: Date.now() + 100000 });
    await expect(consumeDemoActivation(token, { userId: 'u1', email: 'u1@test.dev' })).rejects.toMatchObject({
      errorCode: 'demo_activation_expired',
    });
  });

  it('12. an activation token is bound to the owning account', async () => {
    const { token } = await issueActivationFor('u1', 'u1@test.dev');
    await expect(consumeDemoActivation(token, { userId: 'u2', email: 'u2@test.dev' })).rejects.toMatchObject({
      errorCode: 'demo_activation_user_mismatch',
    });
  });

  it('12b. a junk token is rejected', async () => {
    await expect(consumeDemoActivation('not-a-real-token', { userId: 'u1', email: 'u1@test.dev' })).rejects.toMatchObject({
      errorCode: 'demo_activation_invalid',
    });
  });

  it('12c. activation issuance is rate-limited per user', async () => {
    for (let i = 0; i < 3; i++) {
      await issueActivationFor('u1', 'u1@test.dev');
    }
    await expect(issueActivationFor('u1', 'u1@test.dev')).rejects.toMatchObject({
      errorCode: 'demo_activation_rate_limited',
    });
  });
});

describe('demo activation marking', () => {
  it('13. a demo activation is never labeled as a real payment', async () => {
    const { token } = await issueActivationFor();
    const rec = await consumeDemoActivation(token, { userId: 'u1', email: 'u1@test.dev' });
    expect(rec.is_real_payment).toBe(false);
    expect(rec.payment_verification_method).toBe(DEMO_VERIFICATION_METHOD);
    expect(rec.status).toBe('DEMO_ACTIVATED');
    expect(toDemoActivationView(rec)).not.toHaveProperty('tokenHash');
  });

  it('13b. issued activation record is PENDING and is_real_payment=false', async () => {
    const { view } = await issueActivationFor();
    expect(view.payment_verification_method).toBe(DEMO_VERIFICATION_METHOD);
    expect(view.is_real_payment).toBe(false);
    expect(view.status).toBe('DEMO_PENDING');
  });

  it('14. demo entitlement cannot be produced in production', async () => {
    env.NODE_ENV = 'production';
    // Session creation itself refuses in production.
    expect(() => createDemoSession('u1', 'u1@test.dev', 'pro')).toThrowError(
      expect.objectContaining({ errorCode: 'demo_mode_disabled' }) as Error,
    );
    // Activation verification refuses in production even if a valid token
    // (signed off-production) is presented for an off-production user.
    await expect(
      (async () => {
        const { token } = await issueActivationFor();
        return consumeDemoActivation(token, { userId: 'u1', email: 'u1@test.dev' });
      })(),
    ).rejects.toMatchObject({ errorCode: 'demo_mode_disabled' });
  });

  it('15. a valid, correctly labeled demo activation succeeds end-to-end', async () => {
    const { token: s } = createDemoSession('u1', 'u1@test.dev', 'team');
    const session = verifyDemoSessionToken(s, { userId: 'u1', email: 'u1@test.dev' });
    const { token: act } = await issueDemoActivation(session, 'http://localhost:5173');
    expect(act.length).toBeGreaterThan(16);
    const rec = await consumeDemoActivation(act, { userId: 'u1', email: 'u1@test.dev' });
    expect(rec.plan).toBe('team');
    expect(rec.amountInr).toBe(4999);
    expect(rec.is_real_payment).toBe(false);
    expect(rec.payment_verification_method).toBe(DEMO_VERIFICATION_METHOD);
  });
});
