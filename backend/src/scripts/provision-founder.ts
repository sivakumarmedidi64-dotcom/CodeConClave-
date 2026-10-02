/**
 * CodeConClave — explicit founder account provisioning.
 *
 * SECURITY MODEL (B2): founder entitlement requires ALL of
 *   1. users.email = PAYMENT_FOUNDER_EMAIL
 *   2. users.email_verified = true
 *   3. users.is_founder = true
 *
 * This script is the ONLY thing that sets is_founder = true. Self-service
 * registration explicitly writes false and additionally refuses to register the
 * configured founder address, so nobody can claim the founder inbox.
 *
 * Idempotent: safe to re-run. It never prints the password or any secret.
 *
 * Usage (interactive, no secret on the command line):
 *   npm run founder:provision
 * Then type the keyword when prompted.
 *
 * Verification state is intentionally NOT fabricated: this script does not mark
 * the email verified on its own. Confirm inbox control out-of-band, then run
 * with --verified to flip email_verified, or set it directly in the admin UI.
 *
 * CONDITION 2 IS ENFORCED HERE, NOT JUST DOCUMENTED: while email_verified is
 * false the account is provisioned (is_founder = true) but is left on the FREE
 * plan with no live Team entitlement, because the workspace gate reads the
 * entitlement row, not is_founder. Granting a Team PRO_VERIFIED entitlement to
 * an unverified account would unlock the Team product while condition 2 was
 * still unmet — the exact failure B2 exists to prevent.
 */
import readline from 'node:readline';
import crypto from 'node:crypto';
import { pool } from '../shared/db.js';
import { env } from '../config/env.js';
import { hashSecret } from '../shared/crypto.js';
import { logger } from '../shared/logger.js';

const argv = new Set(process.argv.slice(2));

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function validateKeyword(keyword: string): string {
  if (keyword.length < 12) {
    throw new Error('Founder keyword must be at least 12 characters.');
  }
  if (!/[a-z]/.test(keyword) || !/[A-Z]/.test(keyword) || !/[0-9]/.test(keyword)) {
    throw new Error('Founder keyword must include a lowercase letter, an uppercase letter, and a digit.');
  }
  return keyword;
}

export async function provisionFounder(opts: {
  email: string;
  keyword: string;
  markVerified: boolean;
}): Promise<{ created: boolean; alreadyProvisioned: boolean; emailVerified: boolean }> {
  const email = opts.email.trim().toLowerCase();
  const expected = env.PAYMENT_FOUNDER_EMAIL?.trim().toLowerCase();
  if (!expected) {
    throw new Error('PAYMENT_FOUNDER_EMAIL is not configured; refusing to provision.');
  }
  if (email !== expected) {
    // Never reveal the configured address.
    throw new Error('Provided email does not match the configured PAYMENT_FOUNDER_EMAIL.');
  }
  const keyword = validateKeyword(opts.keyword);

  const existing = await pool.query(
    'SELECT id, is_founder, email_verified, password_hash FROM users WHERE lower(email) = $1',
    [email],
  );
  const row = existing.rows[0];

  if (row?.is_founder) {
    // Already provisioned. Still fall through when this run can make progress:
    // an account provisioned WITHOUT --verified is exactly the state the
    // remediation path has to be able to finish, so re-running with --verified
    // must unlock it rather than short-circuit as a no-op.
    if (Boolean(row.email_verified) === opts.markVerified) {
      logger.info('founder already provisioned', { founderId: row.id, emailVerified: row.email_verified });
      return { created: false, alreadyProvisioned: true, emailVerified: Boolean(row.email_verified) };
    }
    if (!opts.markVerified) {
      // Never de-verify an already-verified founder on a plain re-run.
      logger.info('founder already provisioned', { founderId: row.id, emailVerified: row.email_verified });
      return { created: false, alreadyProvisioned: true, emailVerified: true };
    }
  }

  const passwordHash = hashSecret(keyword);
  let founderId = row?.id as string | undefined;
  // Plan + entitlement follow email_verified: an unverified founder is
  // provisioned but locked on FREE, and any stale Team grant is demoted so no
  // other code path can read past the unverified state.
  const plan = opts.markVerified ? 'team' : 'free';
  const entitlementState = opts.markVerified ? 'PRO_VERIFIED' : 'FREE';

  const writeEntitlement = async (userId: string): Promise<void> => {
    if (opts.markVerified) {
      await pool.query(
        `INSERT INTO entitlements (id, user_id, plan_id, state, verified_at)
         VALUES ($1,$2,'team','PRO_VERIFIED', now())
         ON CONFLICT (user_id, plan_id) DO UPDATE
           SET state = 'PRO_VERIFIED', verified_at = now(), expires_at = NULL, updated_at = now()`,
        [`ent_${crypto.randomBytes(12).toString('hex')}`, userId],
      );
      return;
    }
    // Unverified: make sure no live Team entitlement exists.
    await pool.query(
      `UPDATE entitlements SET state = 'FREE', verified_at = NULL, updated_at = now()
        WHERE user_id = $1 AND plan_id = 'team' AND state = 'PRO_VERIFIED'`,
      [userId],
    );
  };

  if (!row) {
    founderId = `usr_${crypto.randomBytes(12).toString('hex')}`;
    await pool.query(
      `INSERT INTO users (id, email, password_hash, display_name, email_verified, is_founder, plan_id, entitlement_state)
       VALUES ($1,$2,$3,'Founder',$4,true,$5,$6)`,
      [founderId, email, passwordHash, opts.markVerified, plan, entitlementState],
    );
    await writeEntitlement(founderId);
    logger.info('founder account provisioned', { founderId, workspaceUnlocked: opts.markVerified });
    return { created: true, alreadyProvisioned: false, emailVerified: opts.markVerified };
  }

  // Account already exists (e.g. pre-fix squat). Promote it explicitly.
  await pool.query(
    `UPDATE users
        SET password_hash = $1, is_founder = true, email_verified = $2,
            plan_id = $3, entitlement_state = $4
      WHERE id = $5`,
    [passwordHash, opts.markVerified, plan, entitlementState, row.id],
  );
  await writeEntitlement(row.id);
  logger.info('existing account promoted to provisioned founder', {
    founderId: row.id,
    workspaceUnlocked: opts.markVerified,
  });
  return { created: false, alreadyProvisioned: Boolean(row.is_founder), emailVerified: opts.markVerified };
}

async function main(): Promise<void> {
  if (!env.PAYMENT_FOUNDER_EMAIL) {
    console.error('PAYMENT_FOUNDER_EMAIL is not set. Refusing to provision.');
    process.exitCode = 1;
    return;
  }
  const email = await prompt('Founder email (must match PAYMENT_FOUNDER_EMAIL): ');
  const keyword = await prompt('Founder keyword (min 12 chars, mixed case + digit): ');
  const markVerified = argv.has('--verified');
  if (!markVerified) {
    console.log(
      'NOTE: email will NOT be marked verified. Founder entitlement also requires\n' +
      '      users.email_verified = true. Re-run with --verified once you have\n' +
      '      confirmed inbox control out-of-band.',
    );
  }
  const result = await provisionFounder({ email, keyword, markVerified });
  console.log(
    result.alreadyProvisioned
      ? 'Founder already provisioned; nothing changed.'
      : 'Founder provisioned. No secret was printed.',
  );
  console.log(`email_verified = ${result.emailVerified}`);
  await pool.end();
}

if (process.argv[1]?.includes('provision-founder')) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
