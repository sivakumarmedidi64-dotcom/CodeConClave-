/**
 * CodeConClave — continuity crypto helpers.
 * AES-256-GCM via WebCrypto. Payloads are sealed as `iv.b64(ct+tag)`:
 *   b64(12-byte iv) + ":" + b64(ct+tag)
 * The key is lazily derived via PBKDF2 from a random per-browser secret held
 * in localStorage, so reloads keep the cache readable and the plaintext never
 * leaves the browser. This is honest about its threat model: it protects the
 * IndexedDB rows from plaintext-at-rest inspection (e.g. a copied profile
 * directory or a casual dump of the LevelDB files). It does not claim
 * server-grade key management.
 */
const KEY_NS = 'codeconclave_continuity_key';
const IV_BYTES = 12;
const ITERATIONS = 120_000;

function subtle(): SubtleCrypto | null {
  const g = globalThis as { crypto?: { subtle?: SubtleCrypto } };
  return g.crypto?.subtle ?? null;
}

function toBuf(base64: string): ArrayBuffer {
  const raw = atob(base64);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function ab(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function fromU8(u8: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < u8.length; i += 1) raw += String.fromCharCode(u8[i]!);
  return btoa(raw);
}

export function continuityCryptoAvailable(): boolean {
  return subtle() !== null;
}

function readOrCreateSecret(host: Storage): string {
  let secret = host.getItem(KEY_NS);
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    host.setItem(KEY_NS, secret);
  }
  return secret;
}

/** Deterministic AES-GCM key derived from the per-browser secret (PBKDF2). */
export async function continuityCacheKey(host: Storage): Promise<CryptoKey | null> {
  const sub = subtle();
  if (!sub) return null;
  const material = new TextEncoder().encode(`codeconclave\0${readOrCreateSecret(host)}`);
  const base = await sub.importKey(
    'raw',
    ab(material),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey'],
  );
  return sub.deriveKey(
    {
      name: 'PBKDF2',
      salt: ab(new TextEncoder().encode('codeconclave-continuity')),
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const keyMemo = new WeakMap<Storage, Promise<CryptoKey | null>>();

export function getContinuityKey(host: Storage): Promise<CryptoKey | null> {
  let p = keyMemo.get(host);
  if (!p) {
    p = continuityCacheKey(host);
    keyMemo.set(host, p);
  }
  return p;
}

export function resetContinuityKey(host: Storage): void {
  keyMemo.delete(host);
  try {
    host.removeItem(KEY_NS);
  } catch {
    /* storage host unavailable */
  }
}

export async function encryptCacheText(plain: string, host: Storage): Promise<string | null> {
  const sub = subtle();
  const key = await getContinuityKey(host);
  if (!sub || !key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await sub.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return `${fromU8(iv)}:${fromU8(new Uint8Array(ct))}`;
}

export async function decryptCacheText(payload: string, host: Storage): Promise<string | null> {
  const sub = subtle();
  const key = await getContinuityKey(host);
  if (!sub || !key) return null;
  const idx = payload.indexOf(':');
  const iv = payload.slice(0, Math.max(0, idx === -1 ? payload.length : idx));
  const ct = payload.slice(idx === -1 ? payload.length : idx + 1);
  try {
    const pt = await sub.decrypt({ name: 'AES-GCM', iv: toBuf(iv) }, key, toBuf(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Plaintext passthrough matching the same string contract — only used when
 *  WebCrypto is unavailable (e.g. imports without a real crypto main thread). */
export function passthroughCache(): {
  encrypt(value: string): string | null;
  decrypt(value: string): string | null;
} {
  return { encrypt: (v: string) => v, decrypt: (v: string) => v };
}