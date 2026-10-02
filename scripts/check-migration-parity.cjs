const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const url = process.env.CHECK_PG_URL;
  if (!url) { console.error('CHECK_PG_URL missing'); process.exit(2); }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let applied = 0;
  try {
    const r = await client.query('SELECT count(*)::int AS n FROM schema_migrations');
    applied = r.rows[0].n;
  } catch (e) {
    console.error('no schema_migrations table:', e.message);
  }
  const migrationsDir = path.resolve(__dirname, '..', 'database', 'migrations');
  const local = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length;
  console.log(`MIGRATION_PARITY applied=${applied} local=${local}`);
  await client.end();
}
main().catch(async (e) => { console.error(e.message); try { await (await import('pg')).Client.prototype.end?.call(); } catch {} process.exit(1); });