/**
 * CodeConClave — Postgres object-storage regression tests.
 * The `memory` adapter is local disk, which hosted deployments wipe on every
 * redeploy. PostgresStorage keeps the same StorageAdapter contract with blobs
 * in `object_blobs` (migration 0138): put/get/exists/size/delete round-trip,
 * sha256 integrity on read, 10 MiB cap, strict key validation, and health().
 * shared/db is mocked with an in-memory Map; crypto/env are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const blobs = vi.hoisted(() => new Map<string, { bytes: Buffer; sha256: string; size: number }>());

vi.mock('../shared/db.js', () => {
  const rowsFor = (text: string, params: unknown[]): Record<string, unknown>[] => {
    if (text.includes('INSERT INTO object_blobs')) {
      const [key, bytes, sha, size] = params as [string, Buffer, string, number];
      blobs.set(key, { bytes: Buffer.from(bytes), sha256: sha, size });
      return [];
    }
    if (text.includes('DELETE FROM object_blobs')) {
      blobs.delete(params[0] as string);
      return [];
    }
    if (text.includes('SELECT bytes, sha256')) {
      const b = blobs.get(params[0] as string);
      return b ? [{ bytes: b.bytes, sha256: b.sha256 }] : [];
    }
    if (text.includes('SELECT size_bytes')) {
      const b = blobs.get(params[0] as string);
      return b ? [{ size_bytes: b.size }] : [];
    }
    if (text.includes('SELECT 1 AS one')) {
      return blobs.has(params[0] as string) ? [{ one: 1 }] : [];
    }
    if (text.includes('SELECT 1 AS ok')) return [{ ok: 1 }];
    throw new Error(`unexpected query: ${text}`);
  };
  const query = async (text: string, params: unknown[] = []) => ({ rows: rowsFor(text, params), rowCount: 0 });
  return {
    pool: { query },
    queryOne: async (text: string, params: unknown[] = []) => rowsFor(text, params)[0] ?? null,
    queryMany: async (text: string, params: unknown[] = []) => rowsFor(text, params),
    withTenant: async (_u: unknown, fn: (q: unknown) => unknown) => fn({ query }),
    withSystem: async (fn: (q: unknown) => unknown) => fn({ query }),
  };
});

import { PostgresStorage, POSTGRES_MAX_OBJECT_BYTES, assertStorageKey } from './storage.js';

beforeEach(() => {
  blobs.clear();
});

describe('PostgresStorage — durable Rs 0 object store', () => {
  it('round-trips put/get/exists/size/delete', async () => {
    const s = new PostgresStorage();
    expect(s.kind).toBe('postgres');
    const data = Buffer.from('hello persistent world');
    await s.put('codeconclave/projects/p1/f1', data);
    expect(await s.exists('codeconclave/projects/p1/f1')).toBe(true);
    expect((await s.get('codeconclave/projects/p1/f1')).toString()).toBe('hello persistent world');
    expect(await s.size('codeconclave/projects/p1/f1')).toBe(data.length);
    await s.delete('codeconclave/projects/p1/f1');
    expect(await s.exists('codeconclave/projects/p1/f1')).toBe(false);
  });

  it('missing objects fail closed (get/size throw, exists false)', async () => {
    const s = new PostgresStorage();
    await expect(s.get('nope/missing')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(s.size('nope/missing')).rejects.toMatchObject({ errorCode: 'not_found' });
    expect(await s.exists('nope/missing')).toBe(false);
  });

  it('overwrites replace bytes atomically (upsert)', async () => {
    const s = new PostgresStorage();
    await s.put('k', Buffer.from('v1'));
    await s.put('k', Buffer.from('v2-longer'));
    expect((await s.get('k')).toString()).toBe('v2-longer');
    expect(await s.size('k')).toBe(Buffer.from('v2-longer').length);
  });

  it('rejects objects over 10 MiB to protect the free-tier database', async () => {
    const s = new PostgresStorage();
    expect(POSTGRES_MAX_OBJECT_BYTES).toBe(10 * 1024 * 1024);
    const big = Buffer.alloc(POSTGRES_MAX_OBJECT_BYTES + 1, 7);
    await expect(s.put('k/big', big)).rejects.toMatchObject({ errorCode: 'storage_object_too_large' });
    expect(await s.exists('k/big')).toBe(false);
  });

  it('detects tampered bytes via sha256 on read', async () => {
    const s = new PostgresStorage();
    await s.put('k', Buffer.from('original'));
    blobs.get('k')!.bytes = Buffer.from('tampered!!');
    await expect(s.get('k')).rejects.toMatchObject({ errorCode: 'storage_hash_mismatch' });
  });

  it('health() is true when the database answers', async () => {
    expect(await new PostgresStorage().health()).toBe(true);
  });
});

describe('assertStorageKey — traversal / UNC / drive rejection', () => {
  it('rejects hostile keys', () => {
    const hostile = [
      '../x',
      'a/../../x',
      '/abs',
      'C:/x',
      'C:\\x',
      '\\\\server\\share',
      '//server/share',
      '',
    ];
    for (const bad of hostile) {
      expect(() => assertStorageKey(bad), bad).toThrow(/Invalid storage key/);
    }
  });

  it('accepts server-generated keys', () => {
    expect(() => assertStorageKey('codeconclave/projects/p1/abc123')).not.toThrow();
    expect(() => assertStorageKey('codeconclave/artifacts/p/t/id')).not.toThrow();
  });
});
