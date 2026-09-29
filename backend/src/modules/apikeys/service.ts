/**
 * CodeConClave — user API key provisioning.
 *
 * CodeConClave issues per-user API keys (e.g. `cc_live_<random>`)
 * so projects and external clients can call the platform's AI endpoints
 * programmatically. Every key is generated entirely from cryptographically
 * secure random entropy; no brand suffix contributes to its entropy.
 * Security model mirrors the session token system:
 *   - the raw secret is returned exactly once at creation;
 *   - only its SHA-256 hash is stored server-side;
 *   - lookup/delete go by key id (never the raw key);
 *   - listing returns a masked view (prefix + hash suffix).
 *
 * SCOPE MODEL (launch decision): a key is intentionally a monolithic
 * CodeConClave access credential, NOT a granular scoped token. The immediate
 * product is "CodeConClave API Access"; per-key capability scopes are
 * DEFERRED / FUTURE and must not be added pre-launch (no placeholder scope
 * values — the feature simply does not exist yet). The key is never
 * unrestricted: it is bound to the owning user's resources, the owning user's
 * API entitlement, existing capability/policy checks, the API allowlist,
 * non-admin operations, and the rate limits below.
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../../shared/crypto.js';
import { queryMany, queryOne, withTenant } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { recordAudit } from '../audit/service.js';
import { env } from '../../config/env.js';

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_SECRET_BYTES = 24;
/**
 * Brand prefix: every CodeConClave key starts with the fixed literal
 * `cc_live_` (product-design constant, §6). The value after the prefix is
 * entirely random — no constant or brand suffix is embedded in the secret
 * entropy, so keys are instantly recognizable as CodeConClave keys while the
 * secret itself stays purely random. `SAHARSH` is metadata (key name / label)
 * only and never appears in the raw secret.
 */
const MAX_ACTIVE_KEYS = Math.max(1, Number.isFinite(Number(env.MAX_ACTIVE_API_KEYS_PER_USER)) ? Number(env.MAX_ACTIVE_API_KEYS_PER_USER) : 20);

/** Entitlement plan that unlocks API key provisioning (add-on API Access). */
export const API_ACCESS_PLAN = 'api';

export interface UserApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface CreatedUserApiKey extends UserApiKeyView {
  key: string;
}

interface UserApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

/**
 * Generate a cryptographically random API key secret.
 * Uses rejection sampling to avoid modulo bias: bytes >= 252 (256 - 256%36)
 * are discarded, ensuring uniform character distribution across the alphabet.
 */
export function makeApiKeySecret(): string {
  const alphabet = KEY_ALPHABET;
  const limit = 256 - (256 % alphabet.length); // 252 for 36-char alphabet
  const entropy = randomBytes(KEY_SECRET_BYTES * 2); // over-allocate for rejects
  let out = '';
  for (const byte of entropy) {
    if (byte >= limit) continue; // reject biased byte
    out += alphabet[byte % alphabet.length];
    if (out.length >= KEY_SECRET_BYTES) break;
  }
  // Fallback: extremely unlikely to need, but guard against edge cases
  while (out.length < KEY_SECRET_BYTES) {
    const extra = randomBytes(1);
    const b = extra[0]!;
    if (b < limit) out += alphabet[b % alphabet.length];
  }
  return `cc_live_${out}`;
}

function toView(row: UserApiKeyRow): UserApiKeyView {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    revokeReason: row.revoke_reason,
  };
}

async function assertWithinKeyLimit(ownerId: string): Promise<void> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_api_keys WHERE owner_id = $1 AND revoked_at IS NULL`,
    [ownerId],
  );
  if ((row?.n ?? 0) >= MAX_ACTIVE_KEYS) {
    throw AppError.conflict('api_key_limit_reached', `You already have ${MAX_ACTIVE_KEYS} active API keys.`);
  }
}

/**
 * API Access is a SEPARATE purchasable product (one-time ₹9,999, plan_id 'api').
 * Creating API keys is gated on a VERIFIED 'api' entitlement — a Solo/Team plan
 * does not include it and no amount/link inference can ever grant it.
 *
 * EXPIRY: this gate is evaluated at request time. Bug fix: it previously
 * compared only `state`, so an 'api' entitlement that had passed its
 * `expires_at` (or been refunded/charged back without a state rewrite) kept
 * working until a background sweep rewrote the row. `entitled` now requires
 * state === 'PRO_VERIFIED' AND not past expires_at. A present-but-unparseable
 * expires_at is corruption and FAILS CLOSED.
 */
export async function apiAccessEntitlementState(
  ownerId: string,
): Promise<{ state: string | null; expiresAt: string | null; entitled: boolean }> {
  const row = await queryOne<{ state: string; expires_at: Date | string | null }>(
    `SELECT state, expires_at FROM entitlements WHERE user_id = $1 AND plan_id = $2 ORDER BY updated_at DESC LIMIT 1`,
    [ownerId, API_ACCESS_PLAN],
  );
  const state = row?.state ?? null;
  let entitled = false;
  let expiresAt: string | null = null;
  if (row?.expires_at != null) {
    const millis = new Date(row.expires_at).getTime();
    // A present-but-unparseable expires_at is corruption. Treat it as EXPIRED
    // (fail closed) and report no expiry rather than throwing or granting.
    if (Number.isFinite(millis)) {
      expiresAt = new Date(millis).toISOString();
      entitled = state === 'PRO_VERIFIED' && millis > Date.now();
    }
  } else {
    // No expiry set (founder/complimentary grants).
    entitled = state === 'PRO_VERIFIED';
  }
  return { state, expiresAt, entitled };
}

/** Frontend-facing access view: entitled when a live (unexpired) PRO_VERIFIED 'api' entitlement exists. */
export async function apiAccessStatus(ownerId: string): Promise<{ planId: string; entitled: boolean; state: string | null }> {
  const { state, entitled } = await apiAccessEntitlementState(ownerId);
  return { planId: API_ACCESS_PLAN, entitled, state };
}

async function assertApiAccessEntitled(ownerId: string): Promise<void> {
  const { entitled } = await apiAccessEntitlementState(ownerId);
  if (!entitled) {
    throw AppError.paymentRequired(
      'api_access_required',
      'API key creation requires the API Access product (₹9,999). Go to Billing to purchase it separately — a Solo/Team plan does not include API keys.',
    );
  }
}

export async function createUserApiKey(ownerId: string, name: string, ttlDays: number | null = null): Promise<CreatedUserApiKey> {
  const cleanName = name.trim().slice(0, 80);
  if (!cleanName) throw AppError.badRequest('api_key_name_required', 'An API key name is required.');
  await assertApiAccessEntitled(ownerId);
  await assertWithinKeyLimit(ownerId);

  const key = makeApiKeySecret();
  const id = newId('ak');
  const expiresAt = ttlDays && ttlDays > 0 ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) : null;

  // P0-2: writes run inside a tenant-scoped transaction so app.current_user_id is
  // established for the RLS key. The owner is the authenticated principal, never
  // a client-supplied value.
  const row = await withTenant<UserApiKeyRow | null>(ownerId, async (q) => {
    await q.query(
      `INSERT INTO user_api_keys (id, owner_id, name, key_hash, key_prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key_hash) DO NOTHING`,
      [id, ownerId, cleanName, sha256Hex(key), key.slice(0, 12), expiresAt],
    );
    const inserted = await q.query<UserApiKeyRow>(`SELECT * FROM user_api_keys WHERE id = $1 AND owner_id = $2`, [
      id,
      ownerId,
    ]);
    return inserted.rows[0] ?? null;
  });
  if (!row) throw AppError.conflict('api_key_create_conflict', 'Could not provision the API key. Try again.');

  await recordAudit({
    action: 'api_key.created',
    actorUserId: ownerId,
    scope: 'USER',
    tenantId: ownerId,
    resourceType: 'user_api_key',
    resourceId: id,
    detail: { name: cleanName },
  });

  return { ...toView(row), key };
}

export async function listUserApiKeys(ownerId: string): Promise<UserApiKeyView[]> {
  const result = await withTenant(ownerId, (q) =>
    q.query<UserApiKeyRow>(`SELECT * FROM user_api_keys WHERE owner_id = $1 ORDER BY created_at DESC`, [ownerId]),
  );
  return result.rows.map(toView);
}

export async function revokeUserApiKey(ownerId: string, keyId: string, reason?: string): Promise<UserApiKeyView> {
  const cleanReason = (reason ?? '').trim().slice(0, 200) || null;
  // P0-2: check, mutate and re-read in ONE tenant-scoped transaction so the
  // owner filter cannot be lost between statements, and the re-read is also
  // owner-scoped (it previously relied on the preceding update to imply it).
  const result = await withTenant<{ row: UserApiKeyRow | null; updated: UserApiKeyRow | null }>(ownerId, async (q) => {
    const existing = await q.query<UserApiKeyRow>(
      `SELECT * FROM user_api_keys WHERE id = $1 AND owner_id = $2`,
      [keyId, ownerId],
    );
    const row = existing.rows[0] ?? null;
    if (!row) return { row: null, updated: null };
    if (row.revoked_at) return { row, updated: null };

    await q.query(
      `UPDATE user_api_keys SET revoked_at = now(), revoke_reason = $3 WHERE id = $1 AND owner_id = $2`,
      [keyId, ownerId, cleanReason],
    );
    const after = await q.query<UserApiKeyRow>(
      `SELECT * FROM user_api_keys WHERE id = $1 AND owner_id = $2`,
      [keyId, ownerId],
    );
    return { row, updated: after.rows[0] ?? null };
  });

  if (!result.row) throw AppError.notFound('API key');
  if (result.row.revoked_at) return toView(result.row);
  const updated = result.updated;
  if (!updated) throw AppError.notFound('API key');

  await recordAudit({
    action: 'api_key.revoked',
    actorUserId: ownerId,
    scope: 'USER',
    tenantId: ownerId,
    resourceType: 'user_api_key',
    resourceId: keyId,
    detail: { reason: cleanReason },
  });

  return toView(updated);
}

/**
 * Resolve a raw bearer API key to its owner id. Returns null when the key is
 * unknown, revoked, or expired — used by future authenticated-by-key routes.
 * NEVER returns the hash or the raw key.
 */
export async function resolveUserApiKey(rawKey: string): Promise<{ ownerId: string; keyId: string } | null> {
  const hash = sha256Hex(rawKey);
  const row = await queryOne<{ owner_id: string; id: string; revoked_at: Date | null; expires_at: Date | null }>(
    `SELECT id, owner_id, revoked_at, expires_at FROM user_api_keys WHERE key_hash = $1`,
    [hash],
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null;
  queryMany(`UPDATE user_api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => undefined);
  return { ownerId: row.owner_id, keyId: row.id };
}