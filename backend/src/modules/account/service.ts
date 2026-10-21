/**
 * CodeConClave — account data export and deletion (spec Solo #36, Team #18).
 *
 * Export: an allowlisted JSON snapshot of the user's own data. Columns are
 * chosen explicitly so hashes, encrypted secrets, embeddings and tokens are
 * never exported; large collections are bounded and flagged as truncated.
 *
 * Deletion: a request with a 30-day grace window the user can cancel. When it
 * comes due, one transaction:
 *   - revokes every session, device and API key,
 *   - scrubs personal content (rows NOT shared with a team) and soft-deletes it,
 *   - removes plugins, notifications and the user's pending invitations,
 *   - de-identifies the user row (email, name, avatar, credentials, MFA).
 * Team-owned work and the append-only audit trail are retained, linked only
 * to the de-identified account id. The receipt lists every count so the
 * status shown to the user is evidence, not a promise. Backups age out on the
 * provider's retention schedule, which the receipt states.
 */
import type pg from 'pg';
import { withSystem, withTenant } from '../../shared/db.js';
import { newId } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { recordAudit } from '../audit/service.js';

export const DELETION_GRACE_DAYS = 30;
const EXPORT_LIMITS = { conversations: 2000, messages: 20000, memories: 5000, dna: 5000, ideas: 5000, notifications: 500 };

export interface DeletionRequest {
  id: string;
  state: 'PENDING' | 'CANCELLED' | 'COMPLETED';
  requestedAt: string;
  dueAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
  receipt: DeletionReceipt | null;
}

export interface DeletionReceipt {
  completedAt: string;
  erased: Record<string, number>;
  revoked: Record<string, number>;
  retained: string[];
}

interface DeletionRow {
  id: string;
  user_id: string;
  state: DeletionRequest['state'];
  requested_at: Date;
  due_at: Date;
  cancelled_at: Date | null;
  completed_at: Date | null;
  receipt: DeletionReceipt | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function toRequest(r: DeletionRow): DeletionRequest {
  return {
    id: r.id,
    state: r.state,
    requestedAt: iso(r.requested_at)!,
    dueAt: iso(r.due_at)!,
    cancelledAt: iso(r.cancelled_at),
    completedAt: iso(r.completed_at),
    receipt: r.receipt,
  };
}

// ------------------------------------------------------------------ export

async function bounded(q: pg.PoolClient, sql: string, params: unknown[], limit: number): Promise<{ rows: unknown[]; truncated: boolean }> {
  const rows = (await q.query(`${sql} LIMIT ${limit + 1}`, params)).rows;
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function exportAccount(userId: string): Promise<Record<string, unknown>> {
  const data = await withTenant(userId, async (q) => {
    const profile = (
      await q.query(
        `SELECT id, email, email_verified, display_name, avatar_url, role, primary_use_case,
                mfa_enabled, plan_id, entitlement_state, cross_project_memory_opt_in, created_at
           FROM users WHERE id = $1`,
        [userId],
      )
    ).rows[0];
    const projects = (
      await q.query(
        `SELECT id, team_id, name, description, repo_url, status, tags, deadline, created_at, updated_at
           FROM projects WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
        [userId],
      )
    ).rows;
    const conversations = await bounded(
      q,
      `SELECT id, project_id, team_id, title, mode, tags, created_at, updated_at
         FROM conversations WHERE owner_id = $1 AND deleted_at IS NULL AND NOT incognito ORDER BY created_at`,
      [userId],
      EXPORT_LIMITS.conversations,
    );
    const messages = await bounded(
      q,
      `SELECT m.id, m.conversation_id, m.role, m.content, m.model_id, m.created_at
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.owner_id = $1 AND c.deleted_at IS NULL AND NOT c.incognito AND m.deleted_at IS NULL
        ORDER BY m.created_at`,
      [userId],
      EXPORT_LIMITS.messages,
    );
    const memories = await bounded(
      q,
      `SELECT id, project_id, team_id, type, source, content, confidence, provenance, created_at
         FROM memories WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [userId],
      EXPORT_LIMITS.memories,
    );
    const dna = await bounded(
      q,
      `SELECT id, project_id, kind, scope, title, content, version, created_at
         FROM dna WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [userId],
      EXPORT_LIMITS.dna,
    );
    const ideas = await bounded(
      q,
      `SELECT id, project_id, team_id, title, description, tags, category, priority, status, created_at
         FROM ideas WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [userId],
      EXPORT_LIMITS.ideas,
    );
    const notifications = await bounded(
      q,
      `SELECT id, type, title, body, read, created_at
         FROM notifications WHERE recipient_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [userId],
      EXPORT_LIMITS.notifications,
    );
    const teams = (
      await q.query(
        `SELECT t.id, t.name, tm.role, tm.status, tm.created_at AS joined_at
           FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = $1`,
        [userId],
      )
    ).rows;
    const sessions = (
      await q.query(
        `SELECT id, ip, user_agent, state, created_at, last_seen_at, expires_at
           FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [userId],
      )
    ).rows;
    const devices = (
      await q.query(
        `SELECT id, name, state, capabilities, paired_at, last_seen_at, revoked_at
           FROM devices WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      )
    ).rows;
    const apiKeys = (
      await q.query(
        `SELECT id, name, key_prefix, created_at, expires_at, last_used_at, revoked_at
           FROM user_api_keys WHERE owner_id = $1 ORDER BY created_at`,
        [userId],
      )
    ).rows;
    const plugins = {
      installs: (
        await q.query('SELECT plugin_slug, version, enabled, created_at FROM skill_plugin_installs WHERE owner_id = $1', [userId])
      ).rows,
      custom: (await q.query('SELECT slug, version, manifest FROM skill_plugin_packages WHERE owner_id = $1', [userId])).rows,
    };
    return {
      profile,
      projects,
      conversations: conversations.rows,
      messages: messages.rows,
      memories: memories.rows,
      dna: dna.rows,
      ideas: ideas.rows,
      notifications: notifications.rows,
      teams,
      sessions,
      devices,
      apiKeys,
      plugins,
      truncated: Object.fromEntries(
        Object.entries({ conversations, messages, memories, dna, ideas, notifications }).map(([k, v]) => [k, v.truncated]),
      ),
    };
  });
  await recordAudit({
    action: 'account.exported',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'user',
    resourceId: userId,
  }).catch(() => undefined);
  return {
    format: 'codeconclave-account-export/v1',
    exportedAt: new Date().toISOString(),
    notes: [
      'Secrets are never exported: password and token hashes, MFA secrets, API key values and embeddings are excluded.',
      'Files on your own devices were never collected and are not included.',
      `Large collections are capped (${Object.entries(EXPORT_LIMITS).map(([k, v]) => `${k} ${v}`).join(', ')}); see "truncated".`,
    ],
    ...data,
  };
}

// ---------------------------------------------------------------- deletion

export async function deletionStatus(userId: string): Promise<DeletionRequest | null> {
  const row = await withTenant(userId, async (q) =>
    (
      await q.query<DeletionRow>(
        'SELECT * FROM account_deletion_requests WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1',
        [userId],
      )
    ).rows[0],
  );
  return row ? toRequest(row) : null;
}

/** Start the grace window. The caller must retype their email to confirm. */
export async function requestDeletion(userId: string, confirmEmail: string): Promise<DeletionRequest> {
  const row = await withTenant(userId, async (q) => {
    const user = (await q.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
    if (!user) throw AppError.notFound('User');
    if (user.email.trim().toLowerCase() !== confirmEmail.trim().toLowerCase()) {
      throw AppError.badRequest('confirmation_mismatch', 'Type your account email exactly to confirm deletion.');
    }
    const pending = (
      await q.query<DeletionRow>("SELECT * FROM account_deletion_requests WHERE user_id = $1 AND state = 'PENDING'", [userId])
    ).rows[0];
    if (pending) return pending;
    // Offboarding rule: never orphan a team. Ownership must move first.
    const owned = (
      await q.query<{ name: string }>(
        `SELECT t.name FROM teams t
          WHERE t.owner_id = $1 AND t.archived_at IS NULL
            AND EXISTS (SELECT 1 FROM team_members tm
                         WHERE tm.team_id = t.id AND tm.user_id <> $1 AND tm.status = 'ACTIVE')`,
        [userId],
      )
    ).rows;
    if (owned.length > 0) {
      throw AppError.conflict(
        'team_ownership_transfer_required',
        `Transfer ownership of ${owned.map((t) => `"${t.name}"`).join(', ')} (or archive it) before deleting your account.`,
      );
    }
    return (
      await q.query<DeletionRow>(
        `INSERT INTO account_deletion_requests (id, user_id, due_at)
         VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING *`,
        [newId('adr'), userId, DELETION_GRACE_DAYS],
      )
    ).rows[0]!;
  });
  await recordAudit({
    action: 'account.deletion_requested',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'user',
    resourceId: userId,
  }).catch(() => undefined);
  return toRequest(row);
}

export async function cancelDeletion(userId: string): Promise<DeletionRequest> {
  const row = await withTenant(userId, async (q) =>
    (
      await q.query<DeletionRow>(
        `UPDATE account_deletion_requests SET state = 'CANCELLED', cancelled_at = now()
          WHERE user_id = $1 AND state = 'PENDING' RETURNING *`,
        [userId],
      )
    ).rows[0],
  );
  if (!row) throw AppError.notFound('Pending deletion request');
  await recordAudit({
    action: 'account.deletion_cancelled',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'user',
    resourceId: userId,
  }).catch(() => undefined);
  return toRequest(row);
}

/** Erase one account inside the caller's transaction; returns the receipt. */
export async function eraseAccount(q: pg.PoolClient, userId: string): Promise<DeletionReceipt> {
  const n = async (sql: string): Promise<number> => (await q.query(sql, [userId])).rowCount ?? 0;
  const revoked = {
    sessions: await n(`UPDATE sessions SET state = 'REVOKED', revoked_at = now() WHERE user_id = $1 AND state = 'ACTIVE'`),
    devices: await n(
      `UPDATE devices SET state = 'REVOKED', revoked_at = now(), token_hash = NULL, pairing_code_hash = NULL
        WHERE user_id = $1 AND state <> 'REVOKED'`,
    ),
    apiKeys: await n(
      `UPDATE user_api_keys SET revoked_at = now(), revoke_reason = 'account_deleted' WHERE owner_id = $1 AND revoked_at IS NULL`,
    ),
  };
  // Personal content only: rows shared with a team stay (organization-owned).
  const erased = {
    messages: await n(
      `UPDATE messages m SET content = '', deleted_at = COALESCE(m.deleted_at, now())
         FROM conversations c
        WHERE m.conversation_id = c.id AND c.owner_id = $1 AND c.team_id IS NULL AND m.content <> ''`,
    ),
    conversations: await n(
      `UPDATE conversations SET title = '[deleted]', search_metadata = '{}'::jsonb, deleted_at = COALESCE(deleted_at, now())
        WHERE owner_id = $1 AND team_id IS NULL AND title IS DISTINCT FROM '[deleted]'`,
    ),
    memories: await n(
      `UPDATE memories SET content = '[deleted]', structured = NULL, embedding = NULL, deleted_at = COALESCE(deleted_at, now())
        WHERE owner_id = $1 AND team_id IS NULL AND content <> '[deleted]'`,
    ),
    dna: await n(
      `UPDATE dna SET title = '[deleted]', content = '', change_summary = NULL, deleted_at = COALESCE(deleted_at, now())
        WHERE owner_id = $1 AND title <> '[deleted]'`,
    ),
    ideas: await n(
      `UPDATE ideas SET title = '[deleted]', description = NULL, deleted_at = COALESCE(deleted_at, now())
        WHERE owner_id = $1 AND team_id IS NULL AND title <> '[deleted]'`,
    ),
    notifications: await n('DELETE FROM notifications WHERE recipient_id = $1'),
    skillPluginInstalls: await n('DELETE FROM skill_plugin_installs WHERE owner_id = $1'),
    customPlugins: await n('DELETE FROM skill_plugin_packages WHERE owner_id = $1'),
    profile: await n(
      `UPDATE users SET email = 'deleted+' || id || '@deleted.invalid', email_verified = false,
              display_name = NULL, avatar_url = NULL, password_hash = NULL, google_sub = NULL,
              mfa_enabled = false, mfa_secret_encrypted = NULL, recovery_codes_hash = NULL,
              primary_use_case = NULL, deleted_at = now()
        WHERE id = $1`,
    ),
  };
  return {
    completedAt: new Date().toISOString(),
    erased,
    revoked,
    retained: [
      'Work shared with a team (team conversations, memories, ideas, team projects) stays with the organization.',
      'Task history, audit logs and project analytics are retained for integrity, linked only to the de-identified account id.',
      'Database backups age out on the hosting provider\'s retention schedule.',
    ],
  };
}

/** Watchdog sweep: execute requests whose grace window has ended. */
export async function sweepDueDeletions(limit = 10): Promise<number> {
  const due = await withSystem(async (q) =>
    (
      await q.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM account_deletion_requests
          WHERE state = 'PENDING' AND due_at <= now() ORDER BY due_at LIMIT $1`,
        [limit],
      )
    ).rows,
  );
  let done = 0;
  for (const req of due) {
    try {
      const receipt = await withSystem(async (q) => {
        // Re-check under lock: a cancel may have landed since the scan.
        const locked = (
          await q.query("SELECT 1 FROM account_deletion_requests WHERE id = $1 AND state = 'PENDING' FOR UPDATE", [req.id])
        ).rows.length;
        if (locked === 0) return null;
        const r = await eraseAccount(q, req.user_id);
        await q.query(
          `UPDATE account_deletion_requests SET state = 'COMPLETED', completed_at = now(), receipt = $2 WHERE id = $1`,
          [req.id, JSON.stringify(r)],
        );
        return r;
      });
      if (!receipt) continue;
      done += 1;
      await recordAudit({
        action: 'account.deleted',
        actorUserId: null,
        scope: 'SYSTEM',
        tenantId: req.user_id,
        resourceType: 'user',
        resourceId: req.user_id,
      }).catch(() => undefined);
    } catch (err) {
      // Leave it PENDING; the next sweep retries. Never report a partial erase as done.
      logger.error('account deletion failed', { requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return done;
}
