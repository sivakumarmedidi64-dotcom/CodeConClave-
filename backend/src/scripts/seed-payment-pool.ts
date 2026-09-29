/**
 * CodeConClave — standalone PAYMENT LINK-POOL seeder.
 *
 * Idempotently provisions `payment_link_pool` from the deployment catalogue
 * (PAYMENT_POOL_LINKS or the generated placeholder catalogue). Safe to run at
 * any time; rerunning never duplicates rows and never mutates live RESERVED
 * links. Exits non-zero (fail-loud) when explicit configuration cannot produce
 * a usable pool.
 *
 * Usage: npm run db:seed:pool
 */
import { pool } from '../shared/db.js';
import { seedPaymentPool, assertPoolUsable } from '../modules/payments/pool/seeder.js';

async function main(): Promise<void> {
  const report = await seedPaymentPool();
  await assertPoolUsable(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[payment-pool] seeding failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});