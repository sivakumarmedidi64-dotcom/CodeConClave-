/**
 * CodeConClave Desktop — auth vault tests. Metadata only: no credential
 * material is ever stored, tampered files fail closed to defaults, unknown
 * keys are dropped, permissions stay 0600-shaped via injected io.
 */
import { describe, it, expect } from 'vitest';
import { AuthVaultStore, VAULT_DEFAULTS, type VaultIo } from './auth-vault.js';

function memIo(files: Map<string, string>): VaultIo & { writes: Array<{ p: string; data: string }> } {
  const writes: Array<{ p: string; data: string }> = [];
  return {
    writes,
    read: (p) => files.get(p) ?? null,
    write: (p, data) => {
      writes.push({ p, data });
      files.set(p, data);
    },
  };
}

describe('AuthVaultStore', () => {
  it('returns defaults when absent and round-trips metadata', () => {
    const io = memIo(new Map());
    const vault = new AuthVaultStore({ path: 'v.json' }, io);
    expect(vault.read()).toEqual(VAULT_DEFAULTS);
    vault.patch({ handle: 'alice_01', keySavedConfirmed: true });
    expect(vault.read()).toMatchObject({ handle: 'alice_01', keySavedConfirmed: true });
  });

  it('never stores credential material', () => {
    const io = memIo(new Map());
    const vault = new AuthVaultStore({ path: 'v.json' }, io);
    vault.patch({ handle: 'alice_01' });
    const raw = io.writes[0]!.data;
    expect(raw).not.toMatch(/keyword|password|secret|token|hash/i);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(
      ['deviceId', 'handle', 'keyEnabled', 'keySavedConfirmed', 'lastLoginAt'].sort(),
    );
  });

  it('drops unknown keys and fails closed on corrupt files', () => {
    const files = new Map([['v.json', '{"handle":"bob","sessionToken":"steal-me","admin":true}']]);
    const vault = new AuthVaultStore({ path: 'v.json' }, memIo(files));
    expect(vault.read()).toMatchObject({ handle: 'bob', keySavedConfirmed: false });
    expect(vault.read()).not.toHaveProperty('sessionToken');
    const bad = new AuthVaultStore({ path: 'missing.json' }, memIo(new Map([['missing.json', 'not-json{{{']])));
    expect(bad.read()).toEqual(VAULT_DEFAULTS);
  });

  it('clear() resets to defaults', () => {
    const io = memIo(new Map());
    const vault = new AuthVaultStore({ path: 'v.json' }, io);
    vault.patch({ handle: 'alice_01' });
    vault.clear();
    expect(vault.read()).toEqual(VAULT_DEFAULTS);
  });
});
