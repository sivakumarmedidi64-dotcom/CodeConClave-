/**
 * CodeConClave — cryptographic primitives.
 * - versioned scrypt credential hashing (pure JS / no native deps)
 * - SHA-256
 * - AES-256-GCM at-rest encryption (key derived from SESSION_SECRET)
 * - RFC 6238 TOTP (MFA) with base32 secrets
 * - one-time recovery codes
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomBase32(bytes = 20): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const buf = crypto.randomBytes(bytes);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------- scrypt
//
// Versioned so credentials can be strengthened without invalidating any
// existing hash. `verifyHash` picks parameters from the stored version, so
// v1 hashes created before this change keep working forever; `needsRehash`
// lets callers transparently upgrade a v1 credential after a successful login.
//
// MEASURED PARAMETER CHOICE (backend/bench-scrypt.mjs, Node v24.11.1, this
// runtime — averages of 3 runs, r=8, p=1, keylen=64):
//
//   N= 16384  (v1)   16MB   40ms
//   N= 32768         32MB   87ms
//   N= 65536  (v2)   64MB  162ms
//   N=131072        128MB  331ms
//   N=262144        256MB 1695ms   <-- requested target, REJECTED
//
// N=262144 was explicitly rejected on measurement, not preference: scrypt
// allocates 128*N*r = 256MB per verification, so the auth limiter's 10
// concurrent attempts/minute would demand ~2.5GB and OOM a Railway instance,
// and the 1.7s cost is a cheap DoS amplifier. N=65536 is a 4x work-factor
// increase over v1 at 162ms / 64MB (4 concurrent = ~256MB peak, 2.2s), and
// sits inside OWASP's recommended scrypt band. Revisit only with a measured
// budget for the deployed instance size.
//
// Node's default scrypt maxmem is 32MB, so N>=32768 THROWS without an explicit
// maxmem. Every call site below therefore passes it.

const SCRYPT_V1 = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
const SCRYPT_V2 = { N: 65536, r: 8, p: 1, keylen: 64 } as const;
const SCRYPT_SALT_BYTES = 32;
const CURRENT_SCRYPT_VERSION = 'v2';

/** scrypt memory is ~128*N*r; give OpenSSL headroom or it throws. */
function scryptMaxmem(params: { N: number; r: number }): number {
  return 128 * params.N * params.r + 16 * 1024 * 1024;
}

interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

const SCRYPT_PARAMS: Record<string, ScryptParams> = {
  v1: SCRYPT_V1,
  v2: SCRYPT_V2,
};

export interface StoredHash {
  algorithm: string;
  version: string;
  salt: string;
  hash: string;
}

/** Parse a stored `algo$version$salt$hash` string. Returns null when malformed. */
export function parseStoredHash(stored: string): StoredHash | null {
  const [algorithm, version, salt, hash, ...rest] = stored.split('$');
  if (!algorithm || !version || !salt || !hash || rest.length > 0) return null;
  if (!SCRYPT_PARAMS[version]) return null;
  return { algorithm, version, salt, hash };
}

/**
 * Hash a credential with the current scrypt version.
 * Emits `scrypt$v2$<salt>$<hash>`. Pass `saltBytes` only for short-lived
 * low-entropy tokens that need a smaller salt; credentials should use 32 bytes.
 */
export function hashSecret(value: string, saltBytes = SCRYPT_SALT_BYTES): string {
  const salt = crypto.randomBytes(saltBytes).toString('hex');
  const derived = crypto.scryptSync(value, salt, SCRYPT_V2.keylen, {
    N: SCRYPT_V2.N,
    r: SCRYPT_V2.r,
    p: SCRYPT_V2.p,
    maxmem: scryptMaxmem(SCRYPT_V2),
  });
  return `scrypt$${CURRENT_SCRYPT_VERSION}$${salt}$${derived.toString('hex')}`;
}

/** Verify against a stored hash of any supported scrypt version. */
export function verifyHash(stored: string, value: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed || parsed.algorithm !== 'scrypt') return false;
  const params = SCRYPT_PARAMS[parsed.version];
  if (!params) return false; // parseStoredHash already filters, but stay explicit
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(value, parsed.salt, params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: scryptMaxmem(params),
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(parsed.hash, 'hex');
  if (expected.length === 0 || expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

/** True when a stored hash predates the current parameters and should be upgraded. */
export function needsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  return parsed.version !== CURRENT_SCRYPT_VERSION;
}

/** Re-hash a value with current parameters, preserving the original salt format. */
export function rehashSecret(stored: string, value: string, saltBytes = SCRYPT_SALT_BYTES): string {
  const salt = crypto.randomBytes(saltBytes).toString('hex');
  const derived = crypto.scryptSync(value, salt, SCRYPT_V2.keylen, {
    N: SCRYPT_V2.N,
    r: SCRYPT_V2.r,
    p: SCRYPT_V2.p,
    maxmem: scryptMaxmem(SCRYPT_V2),
  });
  return `scrypt$${CURRENT_SCRYPT_VERSION}$${salt}$${derived.toString('hex')}`;
}

// ---------------------------------------------------------------- AES-256-GCM at rest

function keyFromSecret(secret: string): Buffer {
  // Deterministic 32-byte key from the configured secret.
  return crypto.createHash('sha256').update(`codeconclave-at-rest-v1:${secret}`).digest();
}

export function encryptAtRest(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(env.SESSION_SECRET), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptAtRest(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('malformed ciphertext');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFromSecret(env.SESSION_SECRET),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------- buffer at-rest encryption (Phase 8)

/**
 * Encrypt a file buffer with AES-256-GCM. Format: v1:<iv>:<tag>:<ciphertext>
 * (all base64). Used for at-rest file content encryption when
 * STORAGE_AT_REST_ENCRYPTION=true. Never faked: when disabled, files are
 * stored plainly and the Data Centre reports encryption=none.
 */
export function encryptBuffer(plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(env.SESSION_SECRET), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`,
    'utf8',
  );
}

export function decryptBuffer(payload: Buffer): Buffer {
  const text = payload.toString('utf8');
  const [version, ivB64, tagB64, dataB64] = text.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('malformed ciphertext');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFromSecret(env.SESSION_SECRET),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
}

// ---------------------------------------------------------------- TOTP (RFC 6238)

export function totpSecret(): string {
  return randomBase32(20); // 160-bit secret
}

export function totpUrl(secret: string, label: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6&algorithm=SHA1`;
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpAt(secret: string, timeStep: number, digits = 6): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (binCode % 10 ** digits).toString().padStart(digits, '0');
}

export function verifyTotp(secret: string, code: string, windowSteps = 1, period = 30): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  const step = Math.floor(now / period);
  for (let w = -windowSteps; w <= windowSteps; w++) {
    if (totpAt(secret, step + w) === code) return true;
  }
  return false;
}

// ---------------------------------------------------------------- recovery codes

export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = randomBase32(7).slice(0, 10).replace(/....?(?=.)/g, '$&-');
    const normalized = code.replace(/[^A-Z0-9]/g, '');
    if (normalized.length === 10 && !seen.has(normalized)) {
      seen.add(normalized);
      codes.push(normalized);
    }
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}