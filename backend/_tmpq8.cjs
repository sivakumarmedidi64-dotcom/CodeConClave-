const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROBE, ssl: { rejectUnauthorized: false } });
(async () => {
  const rows = await pool.query(`SELECT provider_id, state, last_check_at, last_error, consecutive_failures FROM provider_health ORDER BY provider_id`);
  for (const r of rows.rows) console.log(JSON.stringify(r));
  await pool.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
