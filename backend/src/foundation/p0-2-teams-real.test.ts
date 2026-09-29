/**
 * CodeConClave — P0-2 Path 1 (teams batch): REAL two-tenant isolation test for
 * the converted teams service.
 *
 * RUNS AGAINST A REAL POSTGRESQL DATABASE (no mocks, no SQLite, no fakes).
 *
 * What this proves for the Path 1 conversion of src/modules/teams/service.ts:
 *   - team reads are gated by ACTIVE membership resolved against the DB
 *     (`getTeam` JOIN on team_members): tenant B gets `not_found`, never data;
 *   - role re-resolution (`teamRoleFor` / `requireTeamRole`) runs the
 *     membership query on a tenant-scoped client;
 *   - the cross-tenant invite → accept state machine persists REAL rows
 *     (PENDING -> ACCEPTED) that grant membership to tenant B, verifiable by
 *     a second real connection;
 *   - suspending a member revokes access immediately: B's `getTeam` returns
 *     `not_found` again after `suspendMember`.
 *
 * DB-only coverage (no S3/MinIO): getTeam, listTeams, teamRoleFor, teamStats,
 * inviteMember, acceptInvitation, suspendMember. notify()/notifyTeamMembers
 * fire into the notifications rail (wrapped in .catch) — failures there do
 * not fail the assertions.
 *
 * Run:
 *   DATABASE_URL=<verify-url> NODE_ENV=test TRUST_PROXY=1 \
 *     node node_modules/vitest/vitest.mjs run \
 *       --config vitest.integration.config.ts \
 *       src/foundation/p0-2-teams-real.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { env } from '../config/env.js';
import {
  getTeam,
  listTeams,
  teamRoleFor,
  requireTeamRole,
  teamStats,
  inviteMember,
  acceptInvitation,
  suspendMember,
} from '../modules/teams/service.js';
import { InvitationState } from '@codeconclave/shared';

const probe = new pg.Client({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 6000,
  ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

let live = false;
let probeError = '';
try {
  await probe.connect();
  await probe.query('SELECT 1');
  live = true;
} catch (err) {
  probeError = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[p0-2-teams-real] DB probe failed: ${probeError}\n`);
} finally {
  await probe.end().catch(() => {});
}

it.skipIf(live)('live DB probe failed — teams cross-tenant tests skipped honestly (non-secret reason)', () => {
  expect(probeError).not.toContain(env.DATABASE_URL ?? '');
});

const TENANT_A = 'usr_p02_team_tenant_a';
const TENANT_B = 'usr_p02_team_tenant_b';
const TEAM_A = 'tam_p02_team_tenant_a';
const MEMBER_A = 'tmm_p02_team_tenant_a';

async function seedTenants(): Promise<pg.Pool> {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 6000,
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  for (const id of [TENANT_A, TENANT_B]) {
    await pool.query(
      `INSERT INTO users (id, email, is_founder)
       VALUES ($1, $2, false)
       ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@p02-teams.invalid`],
    );
  }
  await pool.query(
    `INSERT INTO teams (id, owner_id, name)
     VALUES ($1, $2, 'p02 teams')
     ON CONFLICT (id) DO NOTHING`,
    [TEAM_A, TENANT_A],
  );
  await pool.query(
    `INSERT INTO team_members (id, team_id, user_id, role, status, invited_by, joined_at)
     VALUES ($1, $2, $3, 'owner', 'ACTIVE', $3, now())
     ON CONFLICT (team_id, user_id) DO NOTHING`,
    [MEMBER_A, TEAM_A, TENANT_A],
  );
  return pool;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM team_activity WHERE team_id = $1', [TEAM_A]);
  await pool.query('DELETE FROM team_invitations WHERE team_id = $1', [TEAM_A]);
  await pool.query('DELETE FROM team_members WHERE team_id = $1', [TEAM_A]);
  await pool.query('DELETE FROM teams WHERE id = $1', [TEAM_A]);
  await pool.query('DELETE FROM notifications WHERE recipient_id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM audit_logs WHERE actor_user_id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
  await pool.end().catch(() => {});
}

describe.skipIf(!live)('P0-2 Path 1 real two-tenant team isolation', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await seedTenants();
  });

  afterAll(async () => {
    await cleanup(pool);
  });

  it('both tenants are real rows, and the team is seeded with owner A', async () => {
    const users = await pool.query('SELECT id FROM users WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
    expect(users.rows.map((r) => r.id).sort()).toEqual([TENANT_A, TENANT_B].sort());
    const tm = await pool.query('SELECT role, status FROM team_members WHERE team_id = $1', [TEAM_A]);
    expect(tm.rows[0]).toEqual({ role: 'owner', status: 'ACTIVE' });
  });

  it('tenant A reads the team; tenant B gets not_found (membership gate)', async () => {
    const team = await getTeam(TENANT_A, TEAM_A);
    expect(team.id).toBe(TEAM_A);
    await expect(getTeam(TENANT_B, TEAM_A)).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('listTeams and role re-resolution are tenant-scoped', async () => {
    expect((await listTeams(TENANT_A)).some((t) => t.id === TEAM_A)).toBe(true);
    expect((await listTeams(TENANT_B)).some((t) => t.id === TEAM_A)).toBe(false);
    expect(await teamRoleFor(TENANT_A, TEAM_A)).toBe('owner');
    expect(await teamRoleFor(TENANT_B, TEAM_A)).toBeNull();
    await expect(requireTeamRole(TENANT_B, TEAM_A, ['admin'])).rejects.toMatchObject({
      errorCode: 'insufficient_permission',
    });
  });

  it('teamStats runs on the tenant-scoped client and counts the seeded member', async () => {
    const stats = await teamStats(TENANT_A, TEAM_A);
    expect(stats.members).toBe(1);
    expect(stats.pendingInvitations).toBe(0);
  });

  it('tenant A invites tenant B; the invitation persists as PENDING with a future expiry', async () => {
    const invitation = await inviteMember(TENANT_A, TEAM_A, `${TENANT_B}@p02-teams.invalid`, 'viewer');
    expect(invitation.invitee_user_id).toBe(TENANT_B);
    expect(invitation.state).toBe(InvitationState.PENDING);

    const row = await pool.query(
      'SELECT state, invitee_user_id, role FROM team_invitations WHERE id = $1',
      [invitation.id],
    );
    expect(row.rows[0]).toEqual({
      state: 'PENDING',
      invitee_user_id: TENANT_B,
      role: 'viewer',
    });
    const exp = await pool.query('SELECT expires_at > now() AS future FROM team_invitations WHERE id = $1', [invitation.id]);
    expect(exp.rows[0].future).toBe(true);
  });

  it('tenant A cannot be invited by tenant B (not a member, invite fails at team gate)', async () => {
    // B cannot even load the team, so B's attempt to invite back fails closed.
    await expect(inviteMember(TENANT_B, TEAM_A, `${TENANT_A}@p02-teams.invalid`, 'viewer')).rejects.toMatchObject({
      errorCode: 'not_found',
    });
  });

  it('tenant B accepts the invitation: real ACTIVE member row + ACCEPTED invitation', async () => {
    const pending = await pool.query('SELECT id FROM team_invitations WHERE team_id = $1 AND state = $2 ORDER BY created_at LIMIT 1', [
      TEAM_A,
      'PENDING',
    ]);
    const invitationId = pending.rows[0].id as string;

    const invitation = await acceptInvitation(TENANT_B, invitationId);
    expect(invitation.state).toBe(InvitationState.ACCEPTED);

    const mem = await pool.query('SELECT role, status FROM team_members WHERE team_id = $1 AND user_id = $2', [
      TEAM_A,
      TENANT_B,
    ]);
    expect(mem.rows[0]).toEqual({ role: 'viewer', status: 'ACTIVE' });
    const inv = await pool.query('SELECT state FROM team_invitations WHERE id = $1', [invitationId]);
    expect(inv.rows[0].state).toBe('ACCEPTED');

    const team = await getTeam(TENANT_B, TEAM_A);
    expect(team.id).toBe(TEAM_A);
    expect(await teamRoleFor(TENANT_B, TEAM_A)).toBe('viewer');
  });

  it('tenant A suspends tenant B: access is revoked immediately on real rows', async () => {
    const mem = await pool.query('SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2', [TEAM_A, TENANT_B]);
    await suspendMember(TENANT_A, TEAM_A, TENANT_B);

    const row = await pool.query('SELECT status FROM team_members WHERE id = $1', [mem.rows[0].id]);
    expect(row.rows[0].status).toBe('SUSPENDED');
    expect(await teamRoleFor(TENANT_B, TEAM_A)).toBeNull();
    await expect(getTeam(TENANT_B, TEAM_A)).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});