/**
 * CodeConClave — plugin credential vault (Phase 10).
 * Secrets are AES-256-GCM encrypted at rest (encryptAtRest, SESSION_SECRET
 * derived key), stored in plugin_credentials, never returned through normal
 * API responses, never logged, and revocable. credential_ref on
 * plugin_connections stays an opaque marker — never the secret itself.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { encryptAtRest, decryptAtRest } from '../../shared/crypto.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import type { PluginCredentials } from './sdk.js';

const CREDENTIAL_KINDS = ['token', 'api_key', 'refresh_token', 'access_token', 'secret', 'oauth_scopes'];

export interface PluginCredentialRow {
  id: string;
  connection_id: string;
  kind: string;
  value_encrypted: string;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

export function validCredentialKind(kind: string): boolean {
  return CREDENTIAL_KINDS.includes(kind);
}

/** Store (or refresh) one encrypted credential value for a connection. */
export async function storePluginCredential(
  ownerUserId: string,
  connectionId: string,
  kind: string,
  value: string,
  actorUserId?: string,
): Promise<void> {
  if (!validCredentialKind(kind)) throw new Error(`Invalid credential kind: ${kind}`);
  await withTenant(ownerUserId, (q) =>
    q.query(
      `INSERT INTO plugin_credentials (id, connection_id, kind, value_encrypted)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (connection_id, kind) WHERE revoked_at IS NULL
       DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = now()`,
      [newId(PREFIX.PLUGIN + '_cred'), connectionId, kind, encryptAtRest(value)],
    ),
  );
  if (actorUserId) {
    await recordAudit({
      action: AuditAction.PLUGIN_CREDENTIAL_STORED,
      actorUserId,
      scope: 'USER',
      tenantId: actorUserId,
      resourceType: 'plugin_connection',
      resourceId: connectionId,
      detail: { kind },
    });
  }
}

/** Decrypt all active credentials for server-side use. NEVER expose the result. */
export async function readPluginCredentials(ownerUserId: string, connectionId: string): Promise<PluginCredentials> {
  const rows = await withTenant<PluginCredentialRow[]>(ownerUserId, async (q) =>
    (await q.query<PluginCredentialRow>(
      'SELECT * FROM plugin_credentials WHERE connection_id = $1 AND revoked_at IS NULL',
      [connectionId],
    )).rows,
  );
  const kinds: Record<string, string> = {};
  for (const row of rows) {
    try {
      kinds[row.kind] = decryptAtRest(row.value_encrypted);
    } catch {
      // A malformed ciphertext must never take down the engine.
    }
  }
  return { kinds };
}

/** Credential kinds only (safe for responses/tests — never values). */
export async function credentialKinds(ownerUserId: string, connectionId: string): Promise<string[]> {
  const rows = await withTenant<PluginCredentialRow[]>(ownerUserId, async (q) =>
    (await q.query<PluginCredentialRow>(
      'SELECT kind FROM plugin_credentials WHERE connection_id = $1 AND revoked_at IS NULL',
      [connectionId],
    )).rows,
  );
  return rows.map((r) => r.kind);
}

/** Revoke every credential row for a connection (revocation support). */
export async function revokePluginCredentials(ownerUserId: string, connectionId: string): Promise<void> {
  await withTenant(ownerUserId, (q) =>
    q.query(
      `UPDATE plugin_credentials SET revoked_at = now() WHERE connection_id = $1 AND revoked_at IS NULL`,
      [connectionId],
    ),
  );
}

export async function hasPluginCredential(ownerUserId: string, connectionId: string, kind: string): Promise<boolean> {
  const rows = await withTenant<PluginCredentialRow[]>(ownerUserId, async (q) =>
    (await q.query<PluginCredentialRow>(
      'SELECT 1 FROM plugin_credentials WHERE connection_id = $1 AND kind = $2 AND revoked_at IS NULL',
      [connectionId, kind],
    )).rows,
  );
  return rows.length > 0;
}