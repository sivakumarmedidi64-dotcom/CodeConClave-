/**
 * CodeConClave — screenshot privacy foundation (Phase 4B).
 * Remote screenshots are governed by strict privacy invariants:
 *   - never captured without an explicit, fresh authorization on an ACTIVE
 *     remote session (15-minute grant, 8-hour session);
 *   - never delivered after revocation (device or remote session);
 *   - never persisted by the cloud — the transport is a live stream only;
 *   - sensitive regions are masked before any display (foundation interface;
 *     byte-level masking needs a decoding adapter).
 * This platform does not provide a real capture source (server has no desktop
 * session), so the typed adapter is present and honestly returns
 * unavailable — no simulated images are ever produced.
 */
import { AppError } from '../../shared/errors.js';

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Typed capture adapter: implementations must produce real bytes or null. */
export interface ScreenshotSource {
  readonly name: string;
  readonly available: boolean;
  capture(deviceId: string, sessionId: string): Promise<Uint8Array | null>;
}

/** Honest no-capture adapter for platforms without a real desktop source. */
export class UnavailableScreenshotSource implements ScreenshotSource {
  readonly name = 'unavailable';
  readonly available = false;

  async capture(): Promise<Uint8Array | null> {
    return null;
  }
}

/** Masking foundation: a region map derived from a path (e.g. secret files). */
export function sensitiveRegionsFor(_path: string): ScreenshotRegion[] {
  // Byte-level masking requires an image-decoding adapter on the capture
  // platform; the region contract exists so a real adapter can apply it.
  return [];
}

export interface RemoteSessionAuthState {
  state: string;
  expiresAt: string;
  revokedAt: string | null;
  screenshotAuthorized: boolean;
  screenshotAuthExpiresAt: string | null;
}

/**
 * Privacy gate: a screenshot may only be requested when the remote session is
 * ACTIVE and un-revoked, and the explicit screenshot authorization is fresh.
 */
export function assertScreenshotAuthorized(session: RemoteSessionAuthState, now = Date.now()): void {
  if (session.state !== 'ACTIVE') {
    throw AppError.forbidden('remote_session_not_active', 'Remote session is not active');
  }
  if (session.revokedAt) {
    throw AppError.forbidden('remote_session_revoked', 'Remote session was revoked — no delivery');
  }
  if (new Date(session.expiresAt).getTime() <= now) {
    throw AppError.forbidden('remote_session_expired', 'Remote session expired');
  }
  if (!session.screenshotAuthorized || !session.screenshotAuthExpiresAt) {
    throw AppError.forbidden(
      'screenshot_not_authorized',
      'Explicit screenshot authorization required before any capture',
    );
  }
  if (new Date(session.screenshotAuthExpiresAt).getTime() <= now) {
    throw AppError.forbidden(
      'screenshot_authorization_expired',
      'Screenshot authorization expired — authorize again',
    );
  }
}

export const screenshotSource = (): ScreenshotSource => new UnavailableScreenshotSource();