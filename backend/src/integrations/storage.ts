/**
 * CodeConClave — storage abstraction (provider-agnostic).
 * memory = local disk (dev only — ephemeral on hosted deployments, every
 * redeploy wipes it); postgres = object_blobs table on the existing
 * PostgreSQL database (durable, Rs 0, default); s3 = S3-compatible
 * (MinIO dev); r2 = Cloudflare R2 (deferred until billing is activated —
 * adapter is config-driven and ready).
 * Never fakes a provider: when no production store is configured, operations
 * use the honest local adapter and large-file ops are labeled accordingly.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { queryOne, withSystem } from '../shared/db.js';
import { sha256Hex } from '../shared/crypto.js';
import { StorageProviderStatus } from '@codeconclave/shared';

export interface StorageAdapter {
  readonly kind: 'memory' | 's3' | 'r2' | 'postgres';
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  size(key: string): Promise<number>;
  health(): Promise<boolean>;
}

/** Server-generated storage keys only: no traversal, no absolute, no UNC. */
export function assertStorageKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) {
    throw AppError.badRequest('storage_key_invalid', 'Invalid storage key');
  }
  if (
    key.includes('..') ||
    key.startsWith('/') ||
    key.includes('\\') ||
    /^[a-zA-Z]:/.test(key) ||
    key.includes('\u0000')
  ) {
    throw AppError.badRequest('storage_key_invalid', 'Invalid storage key');
  }
}

class MemoryStorage implements StorageAdapter {
  readonly kind = 'memory' as const;
  private root: string;

  constructor() {
    this.root = path.resolve(process.cwd(), 'data', 'storage');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private safePath(key: string): string {
    // Defend against path traversal: keys are server-generated storage keys.
    assertStorageKey(key);
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
    const target = this.safePath(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }

  async get(key: string): Promise<Buffer> {
    return fsp.readFile(this.safePath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.safePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fsp.unlink(this.safePath(key));
    } catch {
      /* already gone */
    }
  }

  async size(key: string): Promise<number> {
    const stat = await fsp.stat(this.safePath(key));
    return stat.size;
  }

  async health(): Promise<boolean> {
    try {
      await fsp.access(this.root);
      return true;
    } catch {
      return false;
    }
  }
}

type S3Client = {
  putObject: (args: { Bucket: string; Key: string; Body: Buffer; ContentType?: string }) => Promise<unknown>;
  getObject: (args: { Bucket: string; Key: string }) => Promise<{ Body?: { transformToByteArray: () => Promise<Uint8Array> } }>;
  deleteObject: (args: { Bucket: string; Key: string }) => Promise<unknown>;
  headObject: (args: { Bucket: string; Key: string }) => Promise<{ ContentLength?: number }>;
};

let s3Client: S3Client | null = null;
let s3Bucket = '';
let s3Kind: 's3' | 'r2' = 's3';

async function getS3Client(): Promise<S3Client> {
  if (s3Client) return s3Client;
  const configuredEndpoint = env.S3_ENDPOINT;
  const accessKey = env.S3_ACCESS_KEY_ID;
  const secretKey = env.S3_SECRET_ACCESS_KEY;
  if (!configuredEndpoint || !accessKey || !secretKey) {
    throw AppError.unavailable('storage_not_configured', 'S3-compatible storage is not configured');
  }
  try {
    const { S3Client: Sdk } = await import('@aws-sdk/client-s3');
    const client = new Sdk({
      endpoint: configuredEndpoint,
      region: env.S3_REGION,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    }) as unknown as S3Client;
    s3Client = client;
    s3Bucket = env.S3_BUCKET;
    return client;
  } catch (err) {
    logger.error('failed to initialize S3 client', { error: (err as Error).message });
    throw AppError.unavailable('storage_init_failed', 'Failed to initialize S3-compatible storage');
  }
}

class S3Storage implements StorageAdapter {
  readonly kind: 's3' | 'r2';
  constructor(kind: 's3' | 'r2') {
    this.kind = kind;
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    const client = await getS3Client();
    await client.putObject({ Bucket: s3Bucket, Key: key, Body: data, ContentType: contentType });
  }

  async get(key: string): Promise<Buffer> {
    const client = await getS3Client();
    const object = await client.getObject({ Bucket: s3Bucket, Key: key });
    if (!object.Body) throw AppError.notFound('Object');
    return Buffer.from(await object.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.size(key);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const client = await getS3Client();
    await client.deleteObject({ Bucket: s3Bucket, Key: key });
  }

  async size(key: string): Promise<number> {
    const client = await getS3Client();
    const head = await client.headObject({ Bucket: s3Bucket, Key: key });
    return head.ContentLength ?? 0;
  }

  async health(): Promise<boolean> {
    try {
      const client = await getS3Client();
      await client.headObject({ Bucket: s3Bucket, Key: '__healthcheck__' });
      return true;
    } catch (err) {
      // Bucket may exist but the key missing — treat connection as healthy.
      const message = err instanceof Error ? err.message : '';
      return message.includes('NotFound') || message.includes('404');
    }
  }
}

/**
 * Postgres-backed blob store (durable, Rs 0 — reuses the existing Neon
 * database, no new infrastructure). Blobs live in `object_blobs`
 * (migration 0138); metadata/tenant scoping stays in the application
 * `files`/`artifacts` tables exactly as with the S3 adapter. Single objects
 * are capped so the free-tier database can never be bloated by one upload —
 * larger objects belong on S3/R2 and fail closed with a clear error.
 */
export const POSTGRES_MAX_OBJECT_BYTES = 10 * 1024 * 1024;

export class PostgresStorage implements StorageAdapter {
  readonly kind = 'postgres' as const;

  async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
    assertStorageKey(key);
    if (data.length > POSTGRES_MAX_OBJECT_BYTES) {
      throw AppError.badRequest(
        'storage_object_too_large',
        'Object exceeds the 10 MiB Postgres store limit (configure S3/R2 for larger objects)',
      );
    }
    const sha = sha256Hex(data);
    await withSystem((q) =>
      q.query(
        `INSERT INTO object_blobs (storage_key, bytes, sha256, size_bytes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (storage_key)
         DO UPDATE SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
                       size_bytes = EXCLUDED.size_bytes`,
        [key, data, sha, data.length],
      ),
    );
  }

  async get(key: string): Promise<Buffer> {
    assertStorageKey(key);
    const row = await queryOne<{ bytes: Buffer; sha256: string }>(
      'SELECT bytes, sha256 FROM object_blobs WHERE storage_key = $1',
      [key],
    );
    if (!row) throw AppError.notFound('Object');
    const buf = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
    if (sha256Hex(buf) !== row.sha256) {
      throw AppError.conflict('storage_hash_mismatch', 'Stored object failed integrity verification');
    }
    return buf;
  }

  async exists(key: string): Promise<boolean> {
    assertStorageKey(key);
    const row = await queryOne<{ one: number }>('SELECT 1 AS one FROM object_blobs WHERE storage_key = $1', [key]);
    return row !== null;
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await withSystem((q) => q.query('DELETE FROM object_blobs WHERE storage_key = $1', [key]));
  }

  async size(key: string): Promise<number> {
    assertStorageKey(key);
    const row = await queryOne<{ size_bytes: number }>('SELECT size_bytes FROM object_blobs WHERE storage_key = $1', [key]);
    if (!row) throw AppError.notFound('Object');
    return Number(row.size_bytes);
  }

  async health(): Promise<boolean> {
    try {
      await queryOne('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }
}

export async function createStorage(): Promise<StorageAdapter> {
  switch (env.STORAGE_PROVIDER) {
    case 'postgres':
      return new PostgresStorage();
    case 's3':
      return new S3Storage('s3');
    case 'r2':
      // R2 is deferred: it requires billing-activated credentials. Until then
      // we report honestly and fall back to the local adapter.
      if (!env.CLOUDFLARE_R2_ACCESS_KEY_ID || !env.CLOUDFLARE_R2_SECRET_ACCESS_KEY) {
        r2RequestedButNotConfigured = true;
        logger.warn('R2 requested but credentials unavailable (billing not activated) — falling back to local storage adapter');
        return new MemoryStorage();
      }
      return new S3Storage('r2');
    case 'memory':
    default:
      return new MemoryStorage();
  }
}

export let storage: StorageAdapter = new MemoryStorage();

export async function initStorage(): Promise<void> {
  storage = await createStorage();
  const healthy = await storage.health();
  logger.info('storage initialized', { kind: storage.kind, healthy });
}

let r2RequestedButNotConfigured = false;

/**
 * Honest provider status (Phase 8). R2 requires billing-activated credentials
 * that are NOT available in this environment; when requested without
 * credentials the adapter falls back to local storage and we report
 * R2_NOT_CONFIGURED instead of pretending R2 is active. POSTGRES_PERSISTENT
 * is the durable Rs 0 default (object_blobs on the existing database).
 */
export function storageMode(): StorageProviderStatus {
  if (r2RequestedButNotConfigured) return StorageProviderStatus.R2_NOT_CONFIGURED;
  if (storage.kind === 's3') return StorageProviderStatus.S3_COMPATIBLE;
  if (storage.kind === 'postgres') return StorageProviderStatus.POSTGRES_PERSISTENT;
  return StorageProviderStatus.LOCAL_STORAGE;
}

export function storageEncryptionEnabled(): boolean {
  return env.STORAGE_AT_REST_ENCRYPTION === 'true';
}

/**
 * Live adapter health for the Data Centre (Phase 8). Real probe only: the
 * adapter's own health check, never a fabricated result.
 */
export async function storageHealth(): Promise<{ ok: boolean; checkedAt: string }> {
  const ok = await storage.health();
  return { ok, checkedAt: new Date().toISOString() };
}