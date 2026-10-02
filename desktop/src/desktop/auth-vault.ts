/**
 * CodeConClave Desktop — zero-domain auth vault (LOCAL ONLY, metadata only).
 *
 * Deliberately stores NO credential material: no keywords, no account keys,
 * no verifiers, no session tokens. The server is the sole authority for
 * credentials; this vault keeps only UX/device state (which handle signed in
 * here, whether the user confirmed saving their key, last login) so the
 * desktop can render honest auth UI. There is nothing in this file an
 * attacker can reuse — copying or tampering with it grants zero access.
 *
 * File permissions are 0600 (same as SettingsStore). A future revision may
 * layer Electron safeStorage encryption via the injected VaultIo without
 * changing this contract.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sep } from 'node:path';

export interface AuthVaultState {
  handle: string | null;
  deviceId: string | null;
  keySavedConfirmed: boolean;
  keyEnabled: boolean | null;
  lastLoginAt: string | null;
}

export const VAULT_DEFAULTS: AuthVaultState = {
  handle: null,
  deviceId: null,
  keySavedConfirmed: false,
  keyEnabled: null,
  lastLoginAt: null,
};

export function defaultVaultPath(userDataDir: string): string {
  return `${userDataDir.replace(/[\\/]+$/, '')}${sep}auth-vault.json`;
}

export interface VaultIo {
  read(p: string): string | null;
  write(p: string, data: string): void;
}

export const realVaultIo: VaultIo = {
  read: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  write: (p, data) => {
    const dir = p.split(/[\\/]/).slice(0, -1).join(sep);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* best-effort */
      }
    }
    writeFileSync(p, data, { mode: 0o600 });
  },
};

const VAULT_KEYS = ['handle', 'deviceId', 'keySavedConfirmed', 'keyEnabled', 'lastLoginAt'] as const;

export class AuthVaultStore {
  constructor(
    private readonly file: { path: string },
    private readonly io: VaultIo = realVaultIo,
  ) {}

  read(): AuthVaultState {
    const raw = this.io.read(this.file.path);
    if (!raw) return { ...VAULT_DEFAULTS };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Only known keys are read: a tampered file cannot smuggle state in.
      const out: AuthVaultState = { ...VAULT_DEFAULTS };
      for (const key of VAULT_KEYS) {
        const value = parsed[key];
        if (key === 'handle' && typeof value === 'string') out.handle = value.slice(0, 64);
        else if (key === 'deviceId' && typeof value === 'string') out.deviceId = value.slice(0, 128);
        else if (key === 'keySavedConfirmed' && typeof value === 'boolean') out.keySavedConfirmed = value;
        else if (key === 'keyEnabled' && typeof value === 'boolean') out.keyEnabled = value;
        else if (key === 'lastLoginAt' && typeof value === 'string') out.lastLoginAt = value.slice(0, 64);
      }
      return out;
    } catch {
      return { ...VAULT_DEFAULTS };
    }
  }

  patch(patch: Partial<AuthVaultState>): AuthVaultState {
    const merged: AuthVaultState = { ...this.read(), ...patch };
    this.io.write(this.file.path, JSON.stringify(merged));
    return merged;
  }

  clear(): void {
    this.io.write(this.file.path, JSON.stringify(VAULT_DEFAULTS));
  }
}
