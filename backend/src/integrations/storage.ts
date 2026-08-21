/**
 * CodeConClave — storage abstraction (provider-agnostic).
 * memory = local disk (dev); s3 = S3-compatible (MinIO dev); r2 = Cloudflare R2
 * (deferred until billing is activated — adapter is config-driven and ready).
 * Never fakes a provider: when no production store is configured, operations
 * use the honest local adapter and large-file ops are labeled accordingly.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { StorageProviderStatus } from '@codeconclave/shared';

export interface StorageAdapter {
  readonly kind: 'memory' | 's3' | 'r2';
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  size(key: string): Promise<number>;
  health(): Promise<boolean>;
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
    if (key.includes('..') || key.startsWith('/') || key.includes('\\')) {
      throw AppError.badRequest('storage_key_invalid', 'Invalid storage key');
    }
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

export async function createStorage(): Promise<StorageAdapter> {
  switch (env.STORAGE_PROVIDER) {
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
 * R2_NOT_CONFIGURED instead of pretending R2 is active.
 */
export function storageMode(): StorageProviderStatus {
  if (r2RequestedButNotConfigured) return StorageProviderStatus.R2_NOT_CONFIGURED;
  if (storage.kind === 's3') return StorageProviderStatus.S3_COMPATIBLE;
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