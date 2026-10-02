/**
 * CodeConClave — screenshot privacy gate tests (PHASE 4B).
 * The privacy contract is explicit and testable:
 *   - capture requires an ACTIVE, un-revoked, un-expired remote session;
 *   - capture requires a fresh explicit screenshot authorization (15 min);
 *   - revocation (remote session) kills delivery even with a fresh grant;
 *   - the typed capture adapter is present but honestly unavailable on this
 *     platform — no simulated images are ever produced.
 */
import { describe, it, expect } from 'vitest';
import {
  assertScreenshotAuthorized,
  screenshotSource,
  sensitiveRegionsFor,
  UnavailableScreenshotSource,
} from '../modules/agent/screenshot.js';
import { AppError } from '../shared/errors.js';

const NOW = Date.now();

function freshAuth(overrides: Record<string, unknown> = {}): {
  state: string;
  expiresAt: string;
  revokedAt: string | null;
  screenshotAuthorized: boolean;
  screenshotAuthExpiresAt: string | null;
} {
  return {
    state: 'ACTIVE',
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    revokedAt: null,
    screenshotAuthorized: true,
    screenshotAuthExpiresAt: new Date(NOW + 900_000).toISOString(),
    ...overrides,
  };
}

function expectDenied(session: ReturnType<typeof freshAuth>, code: string): void {
  try {
    assertScreenshotAuthorized(session, NOW);
    expect.unreachable(`expected denial ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).errorCode).toBe(code);
  }
}

describe('assertScreenshotAuthorized — privacy gate', () => {
  it('allows a fresh authorization on an ACTIVE session', () => {
    expect(() => assertScreenshotAuthorized(freshAuth(), NOW)).not.toThrow();
  });

  it('denies without an explicit screenshot authorization', () => {
    expectDenied(freshAuth({ screenshotAuthorized: false }), 'screenshot_not_authorized');
  });

  it('denies when the 15-minute authorization grant has expired', () => {
    expectDenied(
      freshAuth({ screenshotAuthExpiresAt: new Date(NOW - 1000).toISOString() }),
      'screenshot_authorization_expired',
    );
  });

  it('denies when the 8-hour remote session has expired', () => {
    expectDenied(freshAuth({ expiresAt: new Date(NOW - 1000).toISOString() }), 'remote_session_expired');
  });

  it('denies after remote-session revocation even with a fresh grant — no delivery', () => {
    expectDenied(
      freshAuth({ revokedAt: new Date(NOW - 5000).toISOString(), screenshotAuthExpiresAt: new Date(NOW + 900_000).toISOString() }),
      'remote_session_revoked',
    );
  });

  it('denies on any non-ACTIVE state', () => {
    expectDenied(freshAuth({ state: 'EXPIRED' }), 'remote_session_not_active');
  });

  it('denies when the session row is missing entirely (not found)', () => {
    expectDenied(freshAuth({ state: 'MISSING' }), 'remote_session_not_active');
  });
});

describe('typed capture adapter — honesty over simulation', () => {
  it('provides a source that is available=false and captures null (never fake bytes)', async () => {
    const source = screenshotSource();
    expect(source).toBeInstanceOf(UnavailableScreenshotSource);
    expect(source.name).toBe('unavailable');
    expect(source.available).toBe(false);
    expect(await source.capture('dev_1', 'rms_1')).toBeNull();
  });

  it('exposes a masked-region contract without inventing data', () => {
    expect(sensitiveRegionsFor('C:\\Users\\alice\\.ssh\\id_rsa')).toEqual([]);
  });
});