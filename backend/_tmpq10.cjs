const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROBE, ssl: { rejectUnauthorized: false } });
(async () => {
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position`);
  console.log("USERS_COLS", JSON.stringify(cols.rows.map(r=>r.column_name)));
  const u = await pool.query(`SELECT id FROM users ORDER BY created_at LIMIT 5`);
  console.log("USERS", JSON.stringify(u.rows));
  const d = await pool.query(`SELECT id, name, state, user_id, capabilities, last_seen_at FROM devices ORDER BY created_at LIMIT 10`);
  console.log("DEVICES", JSON.stringify(d.rows));
  await pool.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
